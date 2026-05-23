/**
 * service/table/update-scheduler.ts — 自动更新调度核心逻辑
 * 从 presentation/triggers/settings-ui-sync/settings-ui-trigger.ts 的 triggerAutomaticUpdateIfNeeded_ACU 中提取
 * 
 * 只负责「遍历表格检查更新条件 + 构建 tablesToUpdate 列表 + 分组」，不涉及 UI（toast/status）。
 */

import { isSummaryOrOutlineTable_ACU, logDebug_ACU, logWarn_ACU } from '../../shared/utils';
import { getSortedSheetKeys_ACU } from '../template/chat-scope';
import { applyMergedEdits_ACU, extractEditsFromAiResponse_ACU, mergeAiEditContents_ACU, generateDeferredResponsesForPreparedCalls_ACU } from './update-orchestrator';
import { isSqliteMode } from './storage-mode';
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
): Promise<AutoUpdateResult> {
    const { tablesToUpdate, updateGroups } = plan;
    const groupKeys = Object.keys(updateGroups);
    if (groupKeys.length === 0) {
        setAutoUpdating(false);
        return { success: true, failedGroups: 0, totalGroups: 0 };
    }

    const totalGroups = groupKeys.length;
    const maxConcurrentGroups = Math.max(1, settings.maxConcurrentGroups || 1);
    const failedGroupKeys: string[] = [];

    setAutoUpdating(true);

    try {
        // ═══ Task 4: 合并前置架构 ═══
        // 阶段1: 按 chunk 并发准备 AI 请求（所有组）
        const allPreparedCalls: any[] = [];
        for (let start = 0; start < groupKeys.length; start += maxConcurrentGroups) {
            const chunkKeys = groupKeys.slice(start, start + maxConcurrentGroups);
            for (const gKey of chunkKeys) {
                const group = updateGroups[gKey];
                const prepareResult = await ops.processUpdates(group.indices, 'auto_independent', {
                    targetSheetKeys: group.sheetKeys,
                    batchSize: group.batchSize,
                    requestOptions: { skipProfileSwitch: true, forceDirectApi: true },
                    groupKey: gKey,
                    prepareAiCallOnly: true,
                });
                if (!prepareResult.success) {
                    failedGroupKeys.push(gKey);
                } else if (prepareResult.preparedAiCalls) {
                    allPreparedCalls.push(...prepareResult.preparedAiCalls);
                }
            }
            if (failedGroupKeys.length > 0) break;
        }

        if (failedGroupKeys.length === 0 && allPreparedCalls.length > 0) {
            // 阶段2: 并发 AI 生成
            const generationResult = await generateDeferredResponsesForPreparedCalls_ACU(allPreparedCalls, undefined);
            if (!generationResult.success) {
                logWarn_ACU(`[Auto] AI 生成失败: ${generationResult.error}`);
                failedGroupKeys.push('__generation_failed__');
            } else {
                // 阶段3: 提取并合并所有编辑内容
                const allEditBlocks: string[] = [];
                for (const resp of generationResult.responses) {
                    const edits = extractEditsFromAiResponse_ACU(resp.aiResponse);
                    if (edits) allEditBlocks.push(edits);
                }

                if (allEditBlocks.length > 0) {
                    // 收集所有 sheetKeys 并集
                    const allSheetKeys: string[] = [];
                    for (const key of groupKeys) {
                        const group = updateGroups[key];
                        if (Array.isArray(group.sheetKeys)) {
                            for (const sk of group.sheetKeys) {
                                if (!allSheetKeys.includes(sk)) allSheetKeys.push(sk);
                            }
                        }
                    }

                    const mergedEdits = mergeAiEditContents_ACU(allEditBlocks);
                    logDebug_ACU(`[Auto] 合并 ${allEditBlocks.length} 个编辑块，执行 applyMergedEdits...`);

                    // 阶段4: 单次执行合并编辑
                    const applyResult = await applyMergedEdits_ACU(mergedEdits, 'auto', allSheetKeys);
                    if (!applyResult.success) {
                        failedGroupKeys.push('__apply_failed__');
                    } else {
                        // 阶段5: 单次持久化（保存到最远楼层）
                        let primarySaveTargetIndex = -1;
                        for (const key of groupKeys) {
                            const group = updateGroups[key];
                            if (Array.isArray(group.indices) && group.indices.length > 0) {
                                const last = group.indices[group.indices.length - 1];
                                if (last > primarySaveTargetIndex) primarySaveTargetIndex = last;
                            }
                        }
                        if (primarySaveTargetIndex < 0) primarySaveTargetIndex = 0;

                        const { persistTablesToChatMessage_ACU } = await import('../table/table-service');
                        await persistTablesToChatMessage_ACU({
                            targetMessageIndex: primarySaveTargetIndex,
                            targetSheetKeys: applyResult.modifiedKeys,
                            updateGroupKeys: allSheetKeys,
                            trackingSheetKeys: applyResult.modifiedKeys,
                            trackAsUpdate: true,
                            beforeData: applyResult.beforeData,
                            afterData: applyResult.afterData,
                        });
                    }
                }
            }
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
