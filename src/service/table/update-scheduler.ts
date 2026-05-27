/**
 * service/table/update-scheduler.ts — 自动更新调度核心逻辑
 * 从 presentation/triggers/settings-ui-sync/settings-ui-trigger.ts 的 triggerAutomaticUpdateIfNeeded_ACU 中提取
 * 
 * 只负责「遍历表格检查更新条件 + 构建 tablesToUpdate 列表 + 分组」，不涉及 UI（toast/status）。
 */

import { isSummaryOrOutlineTable_ACU, logDebug_ACU, logWarn_ACU } from '../../shared/utils';
import { getSortedSheetKeys_ACU } from '../template/chat-scope';
import { applyMergedEdits_ACU, extractEditsFromAiResponse_ACU, mergeAiEditContents_ACU, generateDeferredResponsesForPreparedCalls_ACU, buildFillRoundsFromUpdateGroups_ACU, buildRoundPersistenceTargets_ACU } from './update-orchestrator';
import { isSqliteMode } from './storage-mode';
import { wasStoppedByUser_ACU } from '../runtime/state-manager';
import { resolveTableHistoryStateFromChat_ACU } from './table-history';

export interface TableUpdateItem {
    sheetKey: string;
    sheetName: string;
    indices: number[];
    groupId: number;
    batchSize: number;
    scheduleSignature: string;
}

export interface UpdateGroup {
    indices: number[];
    batchSize: number;
    groupId: number;
    scheduleSignature: string;
    sheetKeys: string[];
    sheetNames: string[];
}

export interface AutoUpdatePlan {
    tablesToUpdate: TableUpdateItem[];
    updateGroups: Record<string, UpdateGroup>;
}

/**
 * 构建自动更新计划：遍历所有表格，检查每个表的独立更新条件，返回需要更新的表列表和分组
 * 
 * @param liveChat - 当前聊天记录数组
 * @param tableData - 当前表格数据（currentJsonTableData_ACU）
 * @param settings - 当前设置
 * @param isolationKey - 当前隔离标签键名
 * @returns AutoUpdatePlan 包含 tablesToUpdate 和 updateGroups
 */
export function buildAutoUpdatePlan_ACU(
    liveChat: any[],
    tableData: Record<string, any>,
    settings: any,
    isolationKey: string
): AutoUpdatePlan {
    const tablesToUpdate: TableUpdateItem[] = [];
    const sheetKeys = getSortedSheetKeys_ACU(tableData);

    // 预计算所有 AI 消息索引
    const allAiMessageIndices = liveChat
        .map((msg: any, index: number) => !msg.is_user ? index : -1)
        .filter((index: number) => index !== -1);

    const totalAiMessages = allAiMessageIndices.length;

    // 统一的全局默认参数
    const globalFrequency = settings.autoUpdateFrequency || 1;
    const globalSkip = settings.skipUpdateFloors || 0;

    for (const sheetKey of sheetKeys) {
        const table = tableData[sheetKey];
        if (!table) continue;

        const tableConfig = table.updateConfig || {};
        const isSummary = isSummaryOrOutlineTable_ACU(table.name);

        // 获取该表的更新配置 (优先使用表内配置，否则使用全局默认)
        const rawDepth = Number.isFinite(tableConfig.contextDepth) ? tableConfig.contextDepth : -1;
        const rawFreq = Number.isFinite(tableConfig.updateFrequency) ? tableConfig.updateFrequency : -1;
        const rawSkip = Number.isFinite(tableConfig.skipFloors) ? tableConfig.skipFloors : -1;
        const rawBatch = Number.isFinite(tableConfig.batchSize) ? tableConfig.batchSize : -1;
        const rawGroupId = Number.isFinite(tableConfig.groupId) ? Math.trunc(tableConfig.groupId) : -1;

        const threshold = (rawDepth === -1 || rawDepth === 0) ? (settings.autoUpdateThreshold || 3) : Math.max(0, rawDepth);
        const frequency = (rawFreq === -1) ? globalFrequency : rawFreq;
        const skipFloors = Math.max(0, (rawSkip === -1) ? globalSkip : rawSkip);
        const groupId = rawGroupId;

        const history = resolveTableHistoryStateFromChat_ACU(liveChat, {
            sheetKey,
            isSummaryTable: isSummary,
            isolationKey,
            settings,
        });
        const lastUpdatedAiFloor = history.lastTrackedUpdateAiFloor;

        // 计算未记录楼层数
        const effectiveUnrecordedFloors = Math.max(0, (totalAiMessages - skipFloors) - lastUpdatedAiFloor);

        logDebug_ACU(`[Trigger Check] Table: ${table.name}, TotalAI: ${totalAiMessages}, Skip: ${skipFloors}, LastUpdated: ${lastUpdatedAiFloor}, Unrecorded: ${effectiveUnrecordedFloors}, Freq: ${frequency}`);

        // updateFrequency=0：该表不参与自动更新
        if (frequency > 0 && effectiveUnrecordedFloors >= frequency && threshold > 0) {
            const effectiveAiIndices = skipFloors > 0
                ? allAiMessageIndices.slice(0, -skipFloors)
                : allAiMessageIndices;

            const startIndexInAiArray = lastUpdatedAiFloor;

            logDebug_ACU(`[Trigger Check] EffIndicesLen: ${effectiveAiIndices.length}, StartIndex: ${startIndexInAiArray}`);

            if (startIndexInAiArray < effectiveAiIndices.length) {
                const unupdatedAiIndices = effectiveAiIndices.slice(startIndexInAiArray);
                const contextScopeIndices = effectiveAiIndices.slice(-threshold);
                const contextScopeSet = new Set(contextScopeIndices);

                logDebug_ACU(`[Trigger Check] Unupdated: ${unupdatedAiIndices.length}, ContextScope: ${contextScopeIndices.length}`);

                const indicesToUpdate = unupdatedAiIndices.filter((idx: number) => contextScopeSet.has(idx));

                if (indicesToUpdate.length > 0) {
                    tablesToUpdate.push({
                        sheetKey,
                        sheetName: table.name,
                        indices: indicesToUpdate,
                        groupId,
                        batchSize: (rawBatch === -1) ? (settings.updateBatchSize || 3) : ((rawBatch > 0) ? rawBatch : (settings.updateBatchSize || 3)),
                        scheduleSignature: [groupId, threshold, frequency, skipFloors, rawBatch].join('|'),
                    });
                }
            }
        }
    }

    // 分组：将待更新的表按 (groupId + indices + batchSize) 进行分组
    const updateGroups: Record<string, UpdateGroup> = {};

    tablesToUpdate.forEach(item => {
        const key = item.scheduleSignature + '|' + item.indices.join(',') + '|' + item.batchSize;
        if (!updateGroups[key]) {
            updateGroups[key] = {
                indices: item.indices,
                batchSize: item.batchSize,
                groupId: item.groupId,
                scheduleSignature: item.scheduleSignature,
                sheetKeys: [],
                sheetNames: []
            };
        }
        updateGroups[key].sheetKeys.push(item.sheetKey);
        updateGroups[key].sheetNames.push(item.sheetName);
    });

    return { tablesToUpdate, updateGroups };
}

// ============================================================
// 前置检查
// ============================================================

/**
 * 检查自动更新的前置条件
 * 纯业务逻辑：不涉及 UI
 */
export function checkAutoUpdatePreConditions_ACU(
    settings: any,
    coreApisAreReady: boolean,
    isAutoUpdatingCard: boolean,
    currentJsonTableData: any,
    allChatMessagesLength: number
): { canProceed: boolean; reason?: string } {
    if (!settings.autoUpdateEnabled) {
        return { canProceed: false, reason: 'Auto update is disabled via settings.' };
    }

    const apiIsConfigured = (settings.apiMode === 'custom' && (settings.apiConfig.useMainApi || (settings.apiConfig.url && settings.apiConfig.model))) || (settings.apiMode === 'tavern' && settings.tavernProfile);

    if (!coreApisAreReady || isAutoUpdatingCard || !apiIsConfigured || !currentJsonTableData) {
        return { canProceed: false, reason: 'Pre-flight checks failed.' };
    }

    if (allChatMessagesLength < 2) {
        return { canProceed: false, reason: 'Chat history too short.' };
    }

    return { canProceed: true };
}

// ============================================================
// 执行编排
// ============================================================

/**
 * 自动更新计划的返回值
 */
export interface AutoUpdateResult {
    success: boolean;
    failedGroups: number;
    totalGroups: number;
    autoMergeTriggered?: boolean;
    autoMergeSuccess?: boolean;
}

/**
 * 自动更新进度事件（用于 UI 展示）
 */
export interface AutoUpdateProgressEvent {
    /** 总组数 */
    totalGroups: number;
    /** 当前阶段 */
    phase: 'preparing' | 'calling_ai' | 'merging' | 'applying' | 'saving' | 'complete' | 'error';
    /** 当前批次序号（1-based，round 模型下为 round 序号） */
    currentBatch?: number;
    /** 总批次数（round 模型下为总 round 数） */
    totalBatches?: number;
    /** 可选消息 */
    message?: string;
}

/**
 * 自动更新计划的业务操作委托接口
 * 只包含纯业务操作（数据处理），不包含 UI 操作（toast/状态显示）
 */
export interface AutoUpdateOperations {
    processUpdates: (indices: number[], mode: string, options: any) => Promise<any>;
    refreshData: () => Promise<any>;
    loadAllChatMessages: () => Promise<void>;
    purgeOldLayerData: () => Promise<void>;
}


/**
 * 执行自动更新计划（新架构：合并前置）
 */
export async function executeAutoUpdatePlan_ACU(
    plan: AutoUpdatePlan,
    settings: any,
    setAutoUpdating: (v: boolean) => void,
    ops: AutoUpdateOperations,
    onProgress?: (event: AutoUpdateProgressEvent) => void,
): Promise<AutoUpdateResult> {
    const { tablesToUpdate, updateGroups } = plan;
    const groupKeys = Object.keys(updateGroups);
    if (groupKeys.length === 0) {
        setAutoUpdating(false);
        return { success: true, failedGroups: 0, totalGroups: 0 };
    }

    const totalGroups = groupKeys.length;
    const failedGroupKeys: string[] = [];

    setAutoUpdating(true);

    try {

        // ═══ Round 串行填表模型（自动更新） ═══
        // 每个 round 基于上一轮 apply+persist+refresh 后的快照准备 prompt。
        // round 内多个 group 的 AI 请求可并发生成，但 round 间严格串行。
        const rounds = buildFillRoundsFromUpdateGroups_ACU(updateGroups, groupKeys);
        const totalRounds = rounds.length;
        const maxApplyRetries = settings.tableMaxRetries || 3;
        const SQL_RETRY_MARKER = '\n\n<!-- SQL_ERROR_FEEDBACK -->\n';

        for (let roundIndex = 0; roundIndex < rounds.length; roundIndex++) {
            const roundItems = rounds[roundIndex];
            const roundNumber = roundIndex + 1;

            if (wasStoppedByUser_ACU) {
                failedGroupKeys.push('__user_stopped__');
                break;
            }

            onProgress?.({
                totalGroups,
                phase: 'preparing',
                currentBatch: roundNumber,
                totalBatches: totalRounds,
                message: `准备第 ${roundNumber}/${totalRounds} 批自动填表（${roundItems.length} 组）...`,
            });

            // 收集本 round 涉及的 sheetKeys 并集
            const roundSheetKeys: string[] = [];
            for (const item of roundItems) {
                const group = item.group;
                if (Array.isArray(group.sheetKeys)) {
                    for (const sk of group.sheetKeys) {
                        if (!roundSheetKeys.includes(sk)) roundSheetKeys.push(sk);
                    }
                }
            }

            // ═══ Round 内：准备 AI 请求 ═══
            // 关键：传入 item.batchIndices（当前子批次），batchSize = batchIndices.length（保证只生成一个 prepared call）
            const preparedCalls: any[] = [];
            for (const item of roundItems) {
                const group = item.group;
                let prepareResult: any;
                try {
                    prepareResult = await ops.processUpdates(item.batchIndices, 'auto_independent', {
                        targetSheetKeys: group.sheetKeys,
                        batchSize: item.batchIndices.length, // 强制单子批次
                        requestOptions: { skipProfileSwitch: true, forceDirectApi: true },
                        groupKey: item.groupKey,
                        prepareAiCallOnly: true,
                    });
                } catch (err) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    failedGroupKeys.push(item.groupKey);
                    logWarn_ACU(`[Auto] Round ${roundNumber} 准备 group ${item.groupKey} 的 AI 请求失败: ${errorMessage}`);
                    onProgress?.({
                        totalGroups,
                        phase: 'error',
                        currentBatch: roundNumber,
                        totalBatches: totalRounds,
                        message: `准备自动填表请求失败: ${errorMessage}`,
                    });
                    break;
                }
                if (!prepareResult.success) {
                    failedGroupKeys.push(item.groupKey);
                } else if (prepareResult.preparedAiCalls) {
                    preparedCalls.push(...prepareResult.preparedAiCalls);
                }
            }

            if (failedGroupKeys.length > 0) break;
            if (preparedCalls.length === 0) {
                logWarn_ACU(`[Auto] Round ${roundNumber}: 无有效 prepared calls，跳过`);
                continue;
            }

            // ═══ Round 内：SQL 错误注入重试循环（作用域限定在本 round） ═══
            let lastApplyError: string | null = null;

            for (let retryAttempt = 0; retryAttempt < maxApplyRetries; retryAttempt++) {
                if (wasStoppedByUser_ACU) {
                    failedGroupKeys.push('__user_stopped__');
                    break;
                }

                // SQL 错误注入
                if (lastApplyError && isSqliteMode()) {
                    for (const call of preparedCalls) {
                        if (call.dynamicContent?.tableDataText) {
                            const markerIndex = call.dynamicContent.tableDataText.indexOf(SQL_RETRY_MARKER);
                            if (markerIndex !== -1) {
                                call.dynamicContent.tableDataText = call.dynamicContent.tableDataText.substring(0, markerIndex);
                            }
                            call.dynamicContent.tableDataText += `${SQL_RETRY_MARKER}[SQL执行错误，请修正后重新输出]\n错误信息: ${lastApplyError}`;
                        }
                    }
                }

                // AI 生成（round 内组间并发）
                const retryLabel = retryAttempt > 0 ? `（第 ${retryAttempt + 1} 次尝试）` : '';
                onProgress?.({ totalGroups, phase: 'calling_ai', currentBatch: roundNumber, totalBatches: totalRounds, message: `正在调用 AI 生成 ${preparedCalls.length} 组更新...${retryLabel}` });
                const generationResult = await generateDeferredResponsesForPreparedCalls_ACU(preparedCalls, undefined);
                if (!generationResult.success) {
                    logWarn_ACU(`[Auto] Round ${roundNumber} AI 生成失败: ${generationResult.error}`);
                    onProgress?.({ totalGroups, phase: 'error', currentBatch: roundNumber, totalBatches: totalRounds, message: `AI 生成失败: ${generationResult.error}` });
                    failedGroupKeys.push('__generation_failed__');
                    break;
                }

                // 提取并合并编辑内容
                onProgress?.({ totalGroups, phase: 'merging', currentBatch: roundNumber, totalBatches: totalRounds, message: `正在合并 ${generationResult.responses.length} 组 AI 编辑结果...` });
                const allEditBlocks: string[] = [];
                for (const resp of generationResult.responses) {
                    const edits = extractEditsFromAiResponse_ACU(resp.aiResponse);
                    if (edits) allEditBlocks.push(edits);
                }
                if (allEditBlocks.length === 0) {
                    failedGroupKeys.push('__no_valid_edits__');
                    onProgress?.({ totalGroups, phase: 'error', currentBatch: roundNumber, totalBatches: totalRounds, message: 'AI 响应均未包含有效编辑内容' });
                    break;
                }

                const mergedEdits = mergeAiEditContents_ACU(allEditBlocks);
                logDebug_ACU(`[Auto] Round ${roundNumber}: 合并 ${allEditBlocks.length} 个编辑块，执行 applyMergedEdits...`);

                // 执行合并编辑
                onProgress?.({ totalGroups, phase: 'applying', currentBatch: roundNumber, totalBatches: totalRounds, message: '正在执行合并编辑...' });
                const applyResult = await applyMergedEdits_ACU(mergedEdits, 'auto', roundSheetKeys);

                if (applyResult.success) {
                    // 按当前 round 内各 group 对应楼层分桶持久化
                    onProgress?.({ totalGroups, phase: 'saving', currentBatch: roundNumber, totalBatches: totalRounds, message: '正在保存更新到聊天记录...' });
                    const persistenceTargets = buildRoundPersistenceTargets_ACU(roundItems, applyResult.modifiedKeys);

                    const { persistTablesToChatMessage_ACU } = await import('../table/table-service');
                    if (persistenceTargets.length === 0) {
                        lastApplyError = '合并编辑成功但没有可持久化的目标楼层';
                        logWarn_ACU(`[Auto] Round ${roundNumber} 无可持久化目标: ${lastApplyError}`);
                        failedGroupKeys.push('__persist_failed__');
                        onProgress?.({ totalGroups, phase: 'error', currentBatch: roundNumber, totalBatches: totalRounds, message: lastApplyError });
                        break;
                    }

                    for (const target of persistenceTargets) {
                        const persistResult = await persistTablesToChatMessage_ACU({
                            targetMessageIndex: target.targetMessageIndex,
                            targetSheetKeys: target.targetSheetKeys,
                            updateGroupKeys: target.updateGroupKeys,
                            trackingSheetKeys: target.trackingSheetKeys,
                            trackAsUpdate: true,
                            beforeData: applyResult.beforeData,
                            afterData: applyResult.afterData,
                        });
                        if (!persistResult.saved) {
                            lastApplyError = persistResult.error || `目标楼层 ${target.targetMessageIndex} 数据持久化失败`;
                            logWarn_ACU(`[Auto] Round ${roundNumber} 持久化到目标楼层 ${target.targetMessageIndex} 失败: ${lastApplyError}`);
                            failedGroupKeys.push('__persist_failed__');
                            onProgress?.({ totalGroups, phase: 'error', currentBatch: roundNumber, totalBatches: totalRounds, message: lastApplyError });
                            break;
                        }
                    }
                    if (failedGroupKeys.length > 0) break;
                    break; // 成功，跳出重试循环
                }

                // 应用失败
                lastApplyError = applyResult.error || '合并编辑执行失败';

                // 非 SQL 模式或最后一次重试：直接记录失败
                if (!isSqliteMode() || retryAttempt >= maxApplyRetries - 1) {
                    failedGroupKeys.push('__apply_failed__');
                    onProgress?.({ totalGroups, phase: 'error', currentBatch: roundNumber, totalBatches: totalRounds, message: lastApplyError });
                    logWarn_ACU(`[Auto] Round ${roundNumber} 合并编辑在 ${retryAttempt + 1} 次尝试后仍失败: ${lastApplyError}`);
                    break;
                }

                // SQL 模式 + 仍有重试次数
                logWarn_ACU(`[Auto] Round ${roundNumber} 合并编辑第 ${retryAttempt + 1} 次尝试失败: ${lastApplyError}，将注入错误信息并重新生成`);
                onProgress?.({ totalGroups, phase: 'error', currentBatch: roundNumber, totalBatches: totalRounds, message: `SQL 执行失败，5秒后重试... (${retryAttempt + 1}/${maxApplyRetries})` });

                // 重试前刷新数据确保干净状态
                try {
                    await ops.loadAllChatMessages();
                    await ops.refreshData();
                } catch (refreshErr: any) {
                    logWarn_ACU(`[Auto] 重试前数据刷新失败: ${refreshErr?.message}`);
                }

                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            // Round 结束后检查状态
            if (failedGroupKeys.length > 0) break;

            // Round 成功完成后刷新数据，下一 round 基于新快照
            await ops.loadAllChatMessages();
            await ops.refreshData();
        }

        // 阶段全部成功完成
        if (failedGroupKeys.length === 0) {
            onProgress?.({ totalGroups, phase: 'complete', message: `${totalGroups} 组自动更新全部完成！` });
        }
    } finally {
        setAutoUpdating(false);
        // 并发更新完成后统一刷新数据链条
        logDebug_ACU(`All group updates completed. Forcing data refresh...`);
        await ops.loadAllChatMessages();
        await ops.refreshData();
        await new Promise(resolve => setTimeout(resolve, 500));
        await ops.refreshData();
    }

    let autoMergeTriggered = false;
    let autoMergeSuccess = false;
    try {
        const { checkAutoMergeTrigger_ACU, prepareAutoMergeBatches_ACU, executeAutoMergeBatch_ACU, finalizeAutoMerge_ACU } = await import('../summary/merge-logic');
        const trigger = checkAutoMergeTrigger_ACU();
        if (trigger.shouldTrigger) {
            autoMergeTriggered = true;
            const prepared = prepareAutoMergeBatches_ACU({
                startIndex: 0, endIndex: trigger.mergeCount, targetCount: 1,
                batchSize: 5, promptTemplate: '', isAutoMode: true,
            });
            let acc: any[] = [];
            for (let i = 0; i < prepared.batches.length; i++) {
                const batchResult = await executeAutoMergeBatch_ACU(prepared, prepared.batches[i], acc);
                acc = batchResult.accumulatedSummary;
            }
            await finalizeAutoMerge_ACU(prepared, acc);
            autoMergeSuccess = true;
        }
    } catch (e) {
        logWarn_ACU('自动合并总结检测失败:', e);
    }

    // 清理超出保留层数的旧数据
    try {
        await ops.purgeOldLayerData();
    } catch (e) {
        logWarn_ACU('清理旧层数据失败:', e);
    }

    return {
        success: failedGroupKeys.length === 0,
        failedGroups: failedGroupKeys.length,
        totalGroups,
        autoMergeTriggered,
        autoMergeSuccess,
    };
}

// ============================================================
// 楼层增加延迟逻辑
// ============================================================

/**
 * 处理楼层增加延迟：当 AI 消息数增加时等待一段时间再继续
 * 纯业务逻辑
 */
export async function handleFloorIncreaseDelay_ACU(
    totalAiMessages: number,
    lastTotalAiMessages: number,
    delayMs: number,
    getChatArray: () => any[],
    setLastTotalAiMessages: (v: number) => void
): Promise<{ liveChat: any[]; totalAiMessages: number } | null> {
    if (totalAiMessages > lastTotalAiMessages) {
        logDebug_ACU(`ACU: AI Message count increased (${lastTotalAiMessages} -> ${totalAiMessages}). Waiting ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));

        const liveChat = getChatArray();
        if (!liveChat || liveChat.length === 0) return null;
        const newTotal = liveChat.filter((m: any) => !m.is_user).length;
        setLastTotalAiMessages(newTotal);
        return { liveChat, totalAiMessages: newTotal };
    } else if (totalAiMessages < lastTotalAiMessages) {
        setLastTotalAiMessages(totalAiMessages);
    }
    return undefined as any; // 不需要更新
}
