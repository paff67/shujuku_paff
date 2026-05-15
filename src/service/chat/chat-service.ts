/**
 * service/chat/chat-service.ts — 聊天数据服务
 *
 * 中转 data/gateways/chat-gateway 的所有方法。
 * presentation 层通过本模块访问聊天数据，不再直接调用 gateway。
 * 后续可在此层统一添加日志、埋点、缓存等增值逻辑。
 */

export {
    getChatArray_ACU,
    getChatLength_ACU,
    getLastMessageIndex_ACU,
    saveChatToHost_ACU,
    stopGeneration_ACU,
    deleteLastMessage_ACU,
    setChatMessages_ACU,
    emitMessageUpdated_ACU,
} from '../../data/gateways/chat-gateway';

import { getChatArray_ACU, saveChatToHost_ACU, setChatMessages_ACU, emitMessageUpdated_ACU } from '../../data/gateways/chat-gateway';
import { logDebug_ACU, logError_ACU, logWarn_ACU, isSummaryOrOutlineTable_ACU } from '../../shared/utils';
import { getLastOptimizationBase_ACU, setLastOptimizationBase_ACU } from '../optimization/content-optimization';
import { settings_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU } from '../runtime/state-manager';
import { sanitizeSheetForStorage_ACU } from '../template/chat-scope';
import { persistTablesToChatMessage_ACU } from '../table/table-service';
import { getLatestAiMessageIndexFromChat_ACU, resolveTableHistoryStateFromChat_ACU } from '../table/table-history';
import { rollupCheckpointBeforePurge_ACU } from '../table/table-delta-retention';
import { deleteSummaryVectorIndexExternal_ACU } from '../vector/summary-vector-index-storage-service';
import { assignSummaryVectorIndexStateToTagData_ACU } from '../vector/summary-vector-index-state-service';
import { pruneTablePersistenceLayerSheetKeysV2_ACU } from '../../shared/models/table-persistence-v2-utils';

// ─── 业务逻辑函数（从 presentation 层搬迁） ───

async function deleteVectorIndexManifestFromTagData_ACU(tagData: any): Promise<boolean> {
    if (!tagData || typeof tagData !== 'object') return false;
    const manifest = tagData.summaryVectorIndexManifest || tagData.summaryVectorIndexState?.manifest || null;
    if (manifest) {
        await deleteSummaryVectorIndexExternal_ACU(manifest);
    }
    const hadState = !!tagData.summaryVectorIndexState || !!tagData.summaryVectorIndexManifest;
    if (hadState) {
        assignSummaryVectorIndexStateToTagData_ACU(tagData, null);
    }
    return hadState || !!manifest;
}

function messageHasLocalLayerData_ACU(msg: any): boolean {
    if (!msg || typeof msg !== 'object') return false;
    return !!(
        msg.TavernDB_ACU_Data ||
        msg.TavernDB_ACU_SummaryData ||
        msg.TavernDB_ACU_IndependentData ||
        msg.TavernDB_ACU_ModifiedKeys ||
        msg.TavernDB_ACU_UpdateGroupKeys ||
        msg.TavernDB_ACU_IsolatedData ||
        msg.TavernDB_ACU_Identity ||
        msg.qrf_plot ||
        msg.qrf_plot_preset ||
        msg.qrf_plot_tasks
    );
}

async function deleteVectorIndexManifestsFromMessage_ACU(msg: any): Promise<number> {
    if (!msg || typeof msg !== 'object') return 0;
    const isolatedData = msg.TavernDB_ACU_IsolatedData;
    if (!isolatedData || typeof isolatedData !== 'object' || Array.isArray(isolatedData)) return 0;

    let deletedCount = 0;
    for (const isolationKey of Object.keys(isolatedData)) {
        try {
            if (await deleteVectorIndexManifestFromTagData_ACU(isolatedData[isolationKey])) {
                deletedCount++;
            }
        } catch (error) {
            logWarn_ACU(`[数据清理] 删除隔离标签 ${isolationKey} 的交火向量索引外置文件失败:`, error);
        }
    }
    return deletedCount;
}

function tableListContainsSummaryOrOutline_ACU(targetSheetKeys: string[]): boolean {
    if (!Array.isArray(targetSheetKeys) || targetSheetKeys.length === 0) return false;
    return targetSheetKeys.some((sheetKey) => {
        const table = currentJsonTableData_ACU?.[sheetKey];
        return !!table?.name && isSummaryOrOutlineTable_ACU(String(table.name || ''));
    });
}

/**
 * 替换聊天消息内容（正文优化核心逻辑）
 * 从 presentation/components/optimization-ui/optimization-ui-exec.ts 搬迁
 */
export async function replaceChatMessage_ACU(messageIndex: number, newContent: string, options: any = {}) {
    try {
        logDebug_ACU(`[正文优化] replaceChatMessage_ACU 开始执行, messageIndex=${messageIndex}, newContent长度=${newContent?.length || 0}`);

        const chat = getChatArray_ACU();
        if (!chat || !chat[messageIndex]) {
            logError_ACU('[正文优化] 消息不存在, chat存在=', !!chat, 'messageIndex=', messageIndex);
            throw new Error('消息不存在');
        }

        const oldContent = chat[messageIndex].mes;
        logDebug_ACU(`[正文优化] 原内容长度: ${oldContent?.length || 0}, 新内容长度: ${newContent?.length || 0}`);

        // 保存原始内容到 extra 字段，用于"重新优化"功能
        // 只有当 extra._acu_original_content 不存在时才保存（避免覆盖最初的原始内容）
        const extra = chat[messageIndex].extra || {};
        if (!extra._acu_original_content) {
            extra._acu_original_content = options.originalContent ?? oldContent;
            logDebug_ACU(`[正文优化] 保存原始内容到 extra._acu_original_content，长度: ${extra._acu_original_content?.length || 0}`);
        }
        extra._acu_last_optimized_at = Date.now();
        extra._acu_last_optimized_message_id = chat[messageIndex].message_id;
        setLastOptimizationBase_ACU({
            messageIndex,
            messageId: chat[messageIndex].message_id,
            baseContent: extra._acu_original_content || options.originalContent || oldContent || ''
        });

        // 使用酒馆的 setChatMessages API 来更新消息内容，确保渲染及时生效
        const success = await setChatMessages_ACU(
            [{ message_id: chat[messageIndex].message_id, mes: newContent, extra: extra }],
            { refresh: 'affected' }
        );
        if (success) {
            logDebug_ACU('[正文优化] 消息已通过 setChatMessages API 更新');
        } else {
            // 降级方案：如果 setChatMessages 不可用，使用原有逻辑
            logDebug_ACU('[正文优化] setChatMessages API 不可用，使用降级方案...');

            chat[messageIndex].mes = newContent;
            chat[messageIndex].extra = extra;

            const verifyContent = chat[messageIndex].mes;
            logDebug_ACU(`[正文优化] 修改后验证 - 内容长度: ${verifyContent?.length || 0}, 是否匹配: ${verifyContent === newContent}`);

            await saveChatToHost_ACU();
            logDebug_ACU('[正文优化] 聊天已保存');

            emitMessageUpdated_ACU(messageIndex);
        }

        logDebug_ACU(`[正文优化] 消息 ${messageIndex} 已更新完成`);
        return true;

    } catch (error) {
        logError_ACU('[正文优化] 替换消息失败:', error);
        return false;
    }
}

/**
 * 获取消息的原始内容（用于重新优化）
 * 从 presentation/components/optimization-ui/optimization-ui-exec.ts 搬迁
 */
export function getOriginalContent_ACU(messageIndex: number) {
    const cachedBase = getLastOptimizationBase_ACU();
    if (cachedBase?.baseContent) {
        const chat = getChatArray_ACU();
        if (cachedBase.messageId != null) {
            const matchedIndex = chat.findIndex(msg => msg && !msg.is_user && msg.message_id === cachedBase.messageId);
            if (matchedIndex === messageIndex) {
                return cachedBase.baseContent;
            }
        }
        if (cachedBase.messageIndex === messageIndex) {
            return cachedBase.baseContent;
        }
    }

    const chat = getChatArray_ACU();
    if (!chat || !chat[messageIndex]) {
        return null;
    }
    const extra = chat[messageIndex].extra || {};
    return extra._acu_original_content || null;
}

/**
 * 保存当前表格数据到聊天记录
 * 从 presentation/triggers/update-process.ts 搬迁
 */
export async function saveCurrentDataForTable_ACU(sheetKey: string) {
    try {
        if (!currentJsonTableData_ACU || !currentJsonTableData_ACU[sheetKey]) {
            logWarn_ACU('saveCurrentDataForTable_ACU: No data to save.');
            return;
        }

        const chat = getChatArray_ACU();
        if (!chat || chat.length === 0) {
            logWarn_ACU('saveCurrentDataForTable_ACU: No chat history.');
            return;
        }

        const sheet = currentJsonTableData_ACU[sheetKey];
        const history = resolveTableHistoryStateFromChat_ACU(chat, {
            sheetKey,
            isSummaryTable: isSummaryOrOutlineTable_ACU(sheet.name),
            isolationKey: getCurrentIsolationKey_ACU(),
            settings: settings_ACU,
        });
        const fallbackLatestAiIndex = getLatestAiMessageIndexFromChat_ACU(chat);
        const targetMessageIndex = history.latestDataMessageIndex !== -1
            ? history.latestDataMessageIndex
            : fallbackLatestAiIndex;

        if (targetMessageIndex === -1) {
            logWarn_ACU('saveCurrentDataForTable_ACU: No AI message available for persistence.');
            return;
        }

        await persistTablesToChatMessage_ACU({
            targetMessageIndex,
            targetSheetKeys: [sheetKey],
            updateGroupKeys: null,
            trackAsUpdate: history.latestDataMessageIndex === -1,
        });
    } catch (e) {
        logError_ACU('saveCurrentDataForTable_ACU failed:', e);
    }
}

/**
 * 清理超出保留层数的旧本地数据（表格数据 + 剧情推进数据）
 * 从 presentation/triggers/settings-ui-sync/settings-ui-config.ts 搬迁
 * 
 * 按消息计数，仅保留最近N层的数据，更早楼层的 TavernDB_ACU_* 和 qrf_plot 字段将被删除。
 * 不会删除聊天第一层的"空白指导表"（TavernDB_ACU_InternalSheetGuide）。
 */
export async function purgeOldLayerData_ACU() {
    const retainCount = settings_ACU.retainRecentLayers || 0;
    if (retainCount <= 0) {
        logDebug_ACU('[数据清理] retainRecentLayers 为 0 或未设置，跳过清理。');
        return;
    }

    const chat = getChatArray_ACU();
    if (!chat || !Array.isArray(chat) || chat.length === 0) {
        logDebug_ACU('[数据清理] 聊天记录为空，跳过清理。');
        return;
    }

    // 收集所有包含本地数据的消息索引（排除 chat[0]，保护指导表）
    const dataMessageIndices = [];
    for (let i = 1; i < chat.length; i++) {
        const msg = chat[i];
        if (messageHasLocalLayerData_ACU(msg)) {
            dataMessageIndices.push(i);
        }
    }

    if (dataMessageIndices.length <= retainCount) {
        logDebug_ACU(`[数据清理] 含数据消息总数(${dataMessageIndices.length}) <= 保留层数(${retainCount})，无需清理。`);
        return;
    }

    const cutoffIndex = dataMessageIndices.length - retainCount;
    const indicesToPurge = dataMessageIndices.slice(0, cutoffIndex);

    if (indicesToPurge.length === 0) {
        logDebug_ACU('[数据清理] 无需清理的楼层。');
        return;
    }

    logDebug_ACU(`[数据清理] 将清理 ${indicesToPurge.length} 层消息的本地数据（保留最近 ${retainCount} 层）...`);

    const retentionResult = rollupCheckpointBeforePurge_ACU({
        chat,
        isolationKey: getCurrentIsolationKey_ACU(),
        isolationConfig: settings_ACU,
        retainCount,
        dataMessageIndices,
    });

    let purgedCount = 0;
    let changed = retentionResult.changed;
    const plotKeysToDelete = [
        'qrf_plot',
        'qrf_plot_preset',
        'qrf_plot_tasks'
    ];

    for (const idx of indicesToPurge) {
        const msg = chat[idx];
        if (!msg) continue;

        let modified = false;
        for (const key of plotKeysToDelete) {
            if (Object.prototype.hasOwnProperty.call(msg, key)) {
                delete msg[key];
                modified = true;
            }
        }

        if (modified) {
            purgedCount++;
            changed = true;
        }
    }

    if (changed) {
        try {
            await saveChatToHost_ACU();
            logDebug_ACU(`[数据清理] 已清理 ${retentionResult.purgedMessageIndices.length} 层表格数据与 ${purgedCount} 层剧情推进数据，boundary=${retentionResult.boundaryMessageIndex ?? 'none'}，聊天记录已保存。`);
        } catch (e) {
            logError_ACU('[数据清理] 保存聊天记录失败:', e);
        }
    } else {
        logDebug_ACU('[数据清理] 目标楼层中未发现需要清理的数据字段。');
    }
}

/**
 * 删除聊天记录中的本地数据（核心业务逻辑）
 * 从 presentation/triggers/data-admin-ui.ts 的 deleteLocalDataInChat_ACU 中提取
 * 
 * 只负责数据操作（遍历 chat 删除字段 + saveChatToHost），不涉及 UI（toast/status display）。
 * @returns 删除的消息数量
 */
export async function deleteLocalDataInChatCore_ACU(
    mode: 'current' | 'all' = 'current',
    startFloor: number | null = null,
    endFloor: number | null = null
): Promise<number> {
    const chat = getChatArray_ACU();
    if (!chat || chat.length === 0) {
        return 0;
    }

    let deletedCount = 0;
    const targetIdentity = settings_ACU.dataIsolationEnabled ? settings_ACU.dataIsolationCode : null;

    // 计算AI消息索引列表（只计算AI楼层）
    const aiMessageIndices = chat
        .map((msg: any, index: number) => (!msg.is_user) ? index : -1)
        .filter((index: number) => index !== -1);

    if (aiMessageIndices.length === 0) {
        return 0;
    }

    // 转换AI楼层范围为AI消息索引范围
    const startAiIndex = startFloor ? Math.max(0, startFloor - 1) : 0;
    const endAiIndex = endFloor ? Math.min(aiMessageIndices.length - 1, endFloor - 1) : aiMessageIndices.length - 1;

    // 获取要处理的AI消息的物理索引
    const targetIndices = aiMessageIndices.slice(startAiIndex, endAiIndex + 1);

    for (const physicalIndex of targetIndices) {
        const msg = chat[physicalIndex];
        let shouldDelete = false;

        if (mode === 'all') {
            shouldDelete = true;
        } else {
            if (settings_ACU.dataIsolationEnabled) {
                if (msg.TavernDB_ACU_Identity === targetIdentity) {
                    shouldDelete = true;
                }
            } else {
                if (msg.TavernDB_ACU_Data || msg.TavernDB_ACU_SummaryData || msg.TavernDB_ACU_IndependentData || msg.TavernDB_ACU_IsolatedData) {
                    shouldDelete = true;
                }
            }
        }

        if (shouldDelete) {
            let modified = false;

            if (msg.TavernDB_ACU_Data) {
                delete msg.TavernDB_ACU_Data;
                modified = true;
            }
            if (msg.TavernDB_ACU_SummaryData) {
                delete msg.TavernDB_ACU_SummaryData;
                modified = true;
            }
            if (msg.TavernDB_ACU_IndependentData) {
                delete msg.TavernDB_ACU_IndependentData;
                modified = true;
            }
            if (msg.TavernDB_ACU_Identity !== undefined) {
                delete msg.TavernDB_ACU_Identity;
                modified = true;
            }
            if (msg.TavernDB_ACU_IsolatedData) {
                if (mode === 'all') {
                    const isolatedData = msg.TavernDB_ACU_IsolatedData;
                    for (const key of Object.keys(isolatedData)) {
                        await deleteVectorIndexManifestFromTagData_ACU(isolatedData[key]);
                    }
                    delete msg.TavernDB_ACU_IsolatedData;
                    modified = true;
                } else {
                    const currentIsolationKey = getCurrentIsolationKey_ACU();
                    if (msg.TavernDB_ACU_IsolatedData[currentIsolationKey]) {
                        await deleteVectorIndexManifestFromTagData_ACU(msg.TavernDB_ACU_IsolatedData[currentIsolationKey]);
                        delete msg.TavernDB_ACU_IsolatedData[currentIsolationKey];
                        if (Object.keys(msg.TavernDB_ACU_IsolatedData).length === 0) {
                            delete msg.TavernDB_ACU_IsolatedData;
                        }
                        modified = true;
                    }
                }
            }
            if (msg.TavernDB_ACU_ModifiedKeys) {
                delete msg.TavernDB_ACU_ModifiedKeys;
            }
            if (msg.TavernDB_ACU_UpdateGroupKeys) {
                delete msg.TavernDB_ACU_UpdateGroupKeys;
            }

            if (modified) {
                deletedCount++;
            }
        }
    }

    if (deletedCount > 0) {
        await saveChatToHost_ACU();
    }

    return deletedCount;
}

/**
 * 使用模板覆盖最新层的表格数据（核心业务逻辑）
 * 从 presentation/triggers/data-admin-ui.ts 的 overrideLatestLayerWithTemplate_ACU 中提取
 * 
 * 只负责数据操作（遍历 chat 用模板覆盖 + saveChatToHost），不涉及 UI（confirm/toast）。
 * @param templateData 解析后的模板数据
 * @returns 覆盖的表格数量，0 表示没有修改
 */
export async function overrideLatestLayerWithTemplateCore_ACU(templateData: any): Promise<number> {
    const chat = getChatArray_ACU();
    if (!chat || chat.length === 0) {
        return 0;
    }

    const currentIsolationKey = getCurrentIsolationKey_ACU();

    // 找到最新的一条AI消息
    let latestAiIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user) {
            latestAiIndex = i;
            break;
        }
    }

    if (latestAiIndex === -1) {
        return 0;
    }

    const latestMessage = chat[latestAiIndex];
    let modifiedCount = 0;

    // 初始化或获取按标签分组的数据结构
    if (!latestMessage.TavernDB_ACU_IsolatedData) {
        latestMessage.TavernDB_ACU_IsolatedData = {};
    }
    if (!latestMessage.TavernDB_ACU_IsolatedData[currentIsolationKey]) {
        latestMessage.TavernDB_ACU_IsolatedData[currentIsolationKey] = {};
    }

    const tagData = latestMessage.TavernDB_ACU_IsolatedData[currentIsolationKey];
    if (!tagData.independentData) {
        tagData.independentData = {};
    }

    // 遍历模板中的所有表格，使用模板数据覆盖本地数据
    Object.keys(templateData).forEach(sheetKey => {
        if (!sheetKey.startsWith('sheet_')) return;

        const templateTable = templateData[sheetKey];
        if (!templateTable || !templateTable.name) return;

        // 创建覆盖数据：保留表头，清空数据行
        const overrideTable = JSON.parse(JSON.stringify(templateTable));
        if (overrideTable.content && overrideTable.content.length > 1) {
            overrideTable.content = [overrideTable.content[0]]; // 只保留表头
        }

        // 覆盖本地数据
        tagData.independentData[sheetKey] = overrideTable;
        modifiedCount++;

        logDebug_ACU(`Overrode table "${templateTable.name}" (${sheetKey}) in latest layer with template data.`);
    });

    if (modifiedCount > 0) {
        // 更新修改标记
        tagData.modifiedKeys = Object.keys(tagData.independentData);
        tagData.updateGroupKeys = tagData.modifiedKeys;

        // 保存聊天记录
        await saveChatToHost_ACU();
    }

    return modifiedCount;
}

/**
 * 按消息索引列表清空指定 AI 楼层上的当前隔离标签表格数据，并保存聊天。
 *
 * 用于手动填表前的"预清空"步骤：先清除目标楼层上的旧表格数据，
 * 再执行新的手动填表，防止 SQL 严格填表逻辑因旧数据残留导致写入失败。
 *
 * 清理范围：当前隔离标签下的新版 IsolatedData 槽 + 旧版兼容字段。
 * 不影响同一消息上其他隔离标签的数据。
 * 不删除消息正文或非表格业务字段。
 *
 * @param targetMessageIndices 需要清空的目标 AI 消息物理索引列表（已去重）
 * @returns 实际被清空的消息数量
 */
export async function clearTableDataAtFloors_ACU(targetMessageIndices: number[], targetSheetKeys: string[] | null = null): Promise<number> {
    if (!targetMessageIndices || targetMessageIndices.length === 0) return 0;

    const chat = getChatArray_ACU();
    if (!chat || chat.length === 0) return 0;

    const isolationKey = getCurrentIsolationKey_ACU();
    const isolationConfig = {
        enabled: settings_ACU.dataIsolationEnabled,
        code: settings_ACU.dataIsolationCode,
    };
    const clearsSummaryOrOutline = Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0
        ? tableListContainsSummaryOrOutline_ACU(targetSheetKeys)
        : true;

    let clearedCount = 0;

    for (const idx of targetMessageIndices) {
        if (idx < 0 || idx >= chat.length) continue;
        const msg = chat[idx];
        // 只处理 AI 消息（跳过用户消息）
        if (!msg || msg.is_user) continue;

        const changed = Array.isArray(targetSheetKeys) && targetSheetKeys.length > 0
            ? purgeTargetSheetKeysFromMessage_ACU(msg, targetSheetKeys)
            : purgeAllTableDeltaFromMessage_ACU(msg, isolationKey, isolationConfig);
        if (clearsSummaryOrOutline) {
            const tagData = msg?.TavernDB_ACU_IsolatedData?.[isolationKey];
            if (await deleteVectorIndexManifestFromTagData_ACU(tagData)) {
                logDebug_ACU(`[清空楼层] 已删除消息索引 ${idx} 上的交火向量索引外置文件引用。`);
            }
        }
        if (changed) {
            clearedCount++;
            logDebug_ACU(`[清空楼层] 已清空消息索引 ${idx} 上的表格数据 (标签: ${isolationKey || '无'})`);
        }
    }

    if (clearedCount > 0) {
        await saveChatToHost_ACU();
        logDebug_ACU(`[清空楼层] 共清空 ${clearedCount} 条消息的表格数据，聊天已保存。`);
    }

    return clearedCount;
}

function purgeAllTableDeltaFromMessage_ACU(msg: any, isolationKey: string, isolationConfig: { enabled: boolean; code: string }): boolean {
    if (!msg || typeof msg !== 'object') return false;

    let changed = false;
    const tagData = msg?.TavernDB_ACU_IsolatedData?.[isolationKey];
    const layer = tagData?.tablePersistenceV2;
    if (layer && typeof layer === 'object' && (layer.delta || Array.isArray(layer.deltas))) {
        if (layer.delta) delete layer.delta;
        if (Array.isArray(layer.deltas)) delete layer.deltas;
        const checkpointHasSheets = !!layer.checkpoint?.data
            && typeof layer.checkpoint.data === 'object'
            && Object.keys(layer.checkpoint.data).some((key: string) => key.startsWith('sheet_'));
        if (!checkpointHasSheets) {
            delete tagData.tablePersistenceV2;
        }
        changed = true;
    }

    if (tagData && typeof tagData === 'object') {
        if (tagData.independentData && Object.keys(tagData.independentData).length > 0) {
            tagData.independentData = {};
            changed = true;
        }
        if (Array.isArray(tagData.modifiedKeys) && tagData.modifiedKeys.length > 0) {
            tagData.modifiedKeys = [];
            changed = true;
        }
        if (Array.isArray(tagData.updateGroupKeys) && tagData.updateGroupKeys.length > 0) {
            tagData.updateGroupKeys = [];
            changed = true;
        }
    }

    const legacyMatches = isolationConfig.enabled
        ? msg?.TavernDB_ACU_Identity === isolationConfig.code
        : !msg?.TavernDB_ACU_Identity;
    if (legacyMatches) {
        if (msg?.TavernDB_ACU_IndependentData) {
            delete msg.TavernDB_ACU_IndependentData;
            changed = true;
        }
        if (msg?.TavernDB_ACU_Data) {
            delete msg.TavernDB_ACU_Data;
            changed = true;
        }
        if (msg?.TavernDB_ACU_SummaryData) {
            delete msg.TavernDB_ACU_SummaryData;
            changed = true;
        }
        if (Array.isArray(msg?.TavernDB_ACU_ModifiedKeys) && msg.TavernDB_ACU_ModifiedKeys.length > 0) {
            msg.TavernDB_ACU_ModifiedKeys = [];
            changed = true;
        }
        if (Array.isArray(msg?.TavernDB_ACU_UpdateGroupKeys) && msg.TavernDB_ACU_UpdateGroupKeys.length > 0) {
            msg.TavernDB_ACU_UpdateGroupKeys = [];
            changed = true;
        }
    }

    return changed;
}

function purgeTargetSheetKeysFromMessage_ACU(msg: any, targetSheetKeys: string[]): boolean {
    if (!msg || !Array.isArray(targetSheetKeys) || targetSheetKeys.length === 0) return false;

    let changed = false;
    const isolationKey = getCurrentIsolationKey_ACU();
    const tagData = msg?.TavernDB_ACU_IsolatedData?.[isolationKey];
    if (tagData && typeof tagData === 'object') {
        const layer = tagData.tablePersistenceV2;
        if (layer && typeof layer === 'object') {
            const pruneResult = pruneTablePersistenceLayerSheetKeysV2_ACU(layer, targetSheetKeys);
            if (pruneResult.changed) {
                if (pruneResult.layer) {
                    tagData.tablePersistenceV2 = pruneResult.layer;
                } else {
                    delete tagData.tablePersistenceV2;
                }
                changed = true;
            }
        }

        if (tagData.independentData && typeof tagData.independentData === 'object') {
            targetSheetKeys.forEach(sheetKey => {
                if (tagData.independentData[sheetKey]) {
                    delete tagData.independentData[sheetKey];
                    changed = true;
                }
            });
        }
        if (Array.isArray(tagData.modifiedKeys)) {
            const nextModifiedKeys = tagData.modifiedKeys.filter((key: string) => !targetSheetKeys.includes(key));
            if (nextModifiedKeys.length !== tagData.modifiedKeys.length) changed = true;
            tagData.modifiedKeys = nextModifiedKeys;
        }
        if (Array.isArray(tagData.updateGroupKeys)) {
            const nextUpdateGroupKeys = tagData.updateGroupKeys.filter((key: string) => !targetSheetKeys.includes(key));
            if (nextUpdateGroupKeys.length !== tagData.updateGroupKeys.length) changed = true;
            tagData.updateGroupKeys = nextUpdateGroupKeys;
        }
    }

    if (msg?.TavernDB_ACU_IndependentData && typeof msg.TavernDB_ACU_IndependentData === 'object') {
        targetSheetKeys.forEach(sheetKey => {
            if (msg.TavernDB_ACU_IndependentData[sheetKey]) {
                delete msg.TavernDB_ACU_IndependentData[sheetKey];
                changed = true;
            }
        });
    }

    if (msg?.TavernDB_ACU_Data && typeof msg.TavernDB_ACU_Data === 'object') {
        targetSheetKeys.forEach(sheetKey => {
            if (msg.TavernDB_ACU_Data[sheetKey]) {
                delete msg.TavernDB_ACU_Data[sheetKey];
                changed = true;
            }
        });
    }

    if (msg?.TavernDB_ACU_SummaryData && typeof msg.TavernDB_ACU_SummaryData === 'object') {
        targetSheetKeys.forEach(sheetKey => {
            if (msg.TavernDB_ACU_SummaryData[sheetKey]) {
                delete msg.TavernDB_ACU_SummaryData[sheetKey];
                changed = true;
            }
        });
    }

    if (Array.isArray(msg?.TavernDB_ACU_ModifiedKeys)) {
        const nextModifiedKeys = msg.TavernDB_ACU_ModifiedKeys.filter((key: string) => !targetSheetKeys.includes(key));
        if (nextModifiedKeys.length !== msg.TavernDB_ACU_ModifiedKeys.length) changed = true;
        msg.TavernDB_ACU_ModifiedKeys = nextModifiedKeys;
    }
    if (Array.isArray(msg?.TavernDB_ACU_UpdateGroupKeys)) {
        const nextUpdateGroupKeys = msg.TavernDB_ACU_UpdateGroupKeys.filter((key: string) => !targetSheetKeys.includes(key));
        if (nextUpdateGroupKeys.length !== msg.TavernDB_ACU_UpdateGroupKeys.length) changed = true;
        msg.TavernDB_ACU_UpdateGroupKeys = nextUpdateGroupKeys;
    }

    return changed;
}
