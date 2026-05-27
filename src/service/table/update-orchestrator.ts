/**
 * service/table/update-orchestrator.ts — 表格更新编排（service 层：纯业务逻辑）
 * 从 presentation/triggers/update-process.ts 提取。
 * service 层不驱动 UI，只返回结果/状态，presentation 层根据返回值自行决定 UI 操作。
 */

import { isAutoUpdatingCard_ACU, wasStoppedByUser_ACU, _set_isAutoUpdatingCard_ACU, _set_manualExtraHint_ACU, _set_wasStoppedByUser_ACU } from '../runtime/state-manager';
import { callCustomOpenAI_ACU } from '../ai/prompt-builder';
import { getChatArray_ACU } from '../chat/chat-service';
import { coreApisAreReady_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU, settings_ACU, _set_currentJsonTableData_ACU } from '../runtime/state-manager';
import { checkAutoMergeTrigger_ACU, prepareAutoMergeBatches_ACU, executeAutoMergeBatch_ACU, finalizeAutoMerge_ACU } from '../summary/merge-logic';
import { getChatSheetGuideDataForIsolationKey_ACU } from '../template/chat-scope';
import { loadAllChatMessages_ACU, updateReadableLorebookEntry_ACU } from '../worldbook/pipeline';
import { enqueueSummaryVectorIndexFlush_ACU } from '../vector/summary-vector-index-flush-queue';
import { getCurrentWorldbookConfig_ACU } from '../settings/settings-readers';

import { isSummaryOrOutlineTable_ACU, logDebug_ACU, logError_ACU, logWarn_ACU, parseTableTemplateJson_ACU } from '../../shared/utils';

/**
 * 表名标准化：trim 后空串视为无效键
 */
function normalizeTableNameForPresetLookup_ACU(name: any): string {
    const trimmed = String(name ?? '').trim();
    return trimmed;
}

/**
 * 根据起始表的名称，查找表级 API 预设覆盖
 * @returns 预设名称，空字符串表示使用全局 tableApiPreset
 */
function resolveTableApiPresetOverride_ACU(tableName: any): string {
    const normalizedName = normalizeTableNameForPresetLookup_ACU(tableName);
    if (!normalizedName) return '';
    const overrides = settings_ACU.tableApiPresetOverridesByName;
    if (!overrides || typeof overrides !== 'object') return '';
    const preset = overrides[normalizedName];
    return (typeof preset === 'string' && preset.trim()) ? preset.trim() : '';
}
import { checkIfFirstTimeInit_ACU, persistTablesToChatMessage_ACU } from './table-service';
import { parseAndApplyTableEdits_ACU, prepareAIInput_ACU } from '../ai/prompt-builder';
import { extractTableEditInner_ACU } from '../ai/prompt-builder/table-edit-parser';

// ═══ Task 1: 提取和合并 AI 响应编辑内容 ═══

/**
 * 从单个 AI 响应中提取编辑内容（去掉 <tableEdit> 标签和注释标记）。
 * 返回原始编辑文本，不执行。
 * 注意：默认 useLastPairOnly=true，只提取最后一个 <tableEdit> 块。
 */
export function extractEditsFromAiResponse_ACU(aiResponse: string): string | null {
    if (!aiResponse || typeof aiResponse !== 'string') return null;
    const extracted = extractTableEditInner_ACU(aiResponse, { allowNoTableEditTags: true, useLastPairOnly: true });
    if (!extracted?.inner) return null;
    return extracted.inner.replace(/<!--|-->/g, '').trim();
}

/**
 * 合并多个 AI 响应的编辑内容为一个统一文本。
 * SQL 模式和原生模式都能处理。
 */
export function mergeAiEditContents_ACU(editBlocks: string[]): string {
    if (!Array.isArray(editBlocks)) return '';
    const nonEmpty = editBlocks.filter(s => typeof s === 'string' && s.trim());
    if (nonEmpty.length === 0) return '';
    if (nonEmpty.length === 1) return nonEmpty[0];
    // 统一用双换行分隔（SQL 的分号自然断句，原生模式的指令行也各自独立）
    return nonEmpty.join('\n\n');
}

// ═══ 批次 round 构建模型 ═══
// 将 updateGroups 按 group.batchSize 拆分为上下文子批次，
// 然后按子批次索引对齐为 round。round 间严格串行，round 内各 group 可并发。

/**
 * 一个 round 内的单个执行项：某个 group 的第 N 个子批次。
 */
export interface FillRoundItem_ACU {
    /** 分组 key */
    groupKey: string;
    /** 原始 group 对象引用（含 indices/batchSize/sheetKeys 等） */
    group: any;
    /** 本次子批次的上下文消息索引 */
    batchIndices: number[];
    /** 该子批次在所属 group 内的序号（1-based） */
    batchNumberInGroup: number;
    /** 本次子批次的保存目标楼层（batchIndices 的最后一个） */
    saveTargetIndex: number;
    /** 该 group 在 groupKeys 中的顺序 */
    groupOrder: number;
}

/**
 * 将 updateGroups 按 group.batchSize 拆分为上下文子批次，按子批次索引对齐为 round。
 *
 * 对齐规则：取所有 group 的最大子批次数作为总 round 数。
 * 如果某 group 的子批次数不够，后面的 round 不包含该 group。
 *
 * 示例：groupA 有 3 个子批次，groupB 有 1 个子批次 →
 *   round[0] = [groupA_batch1, groupB_batch1]
 *   round[1] = [groupA_batch2]
 *   round[2] = [groupA_batch3]
 */
export function buildFillRoundsFromUpdateGroups_ACU(
    updateGroups: Record<string, any>,
    groupKeys: string[],
): FillRoundItem_ACU[][] {
    // 根对象防御：updateGroups 或 groupKeys 无效时直接返回空数组
    if (!updateGroups || typeof updateGroups !== 'object' || !Array.isArray(groupKeys) || groupKeys.length === 0) {
        return [];
    }
    // 1. 对每个 group 按 batchSize 拆分为子批次
    const groupBatchesMap: Map<string, number[][]> = new Map();
    let maxRounds = 0;
    for (let gIdx = 0; gIdx < groupKeys.length; gIdx++) {
        const gKey = groupKeys[gIdx];
        const group = updateGroups[gKey];
        if (!group || typeof group !== 'object') continue;
        const rawIndices = group.indices;
        if (!Array.isArray(rawIndices) || rawIndices.length === 0) continue;
        const indices: number[] = rawIndices;
        const rawBatchSize = group.batchSize;
        const batchSize: number = Number.isFinite(rawBatchSize) && rawBatchSize >= 1 ? Math.floor(rawBatchSize) : 1;
        const batches: number[][] = [];
        for (let i = 0; i < indices.length; i += batchSize) {
            batches.push(indices.slice(i, i + batchSize));
        }
        groupBatchesMap.set(gKey, batches);
        if (batches.length > maxRounds) maxRounds = batches.length;
    }

    // 2. 按 roundIndex 对齐
    const rounds: FillRoundItem_ACU[][] = [];
    for (let roundIndex = 0; roundIndex < maxRounds; roundIndex++) {
        const roundItems: FillRoundItem_ACU[] = [];
        for (let gIdx = 0; gIdx < groupKeys.length; gIdx++) {
            const gKey = groupKeys[gIdx];
            const batches = groupBatchesMap.get(gKey);
            if (!batches || roundIndex >= batches.length) continue;
            const batchIndices = batches[roundIndex];
            if (batchIndices.length === 0) continue;
            roundItems.push({
                groupKey: gKey,
                group: updateGroups[gKey],
                batchIndices,
                batchNumberInGroup: roundIndex + 1,
                saveTargetIndex: batchIndices[batchIndices.length - 1],
                groupOrder: gIdx,
            });
        }
        if (roundItems.length > 0) {
            rounds.push(roundItems);
        }
    }

    logDebug_ACU(`[Round Builder] ${groupKeys.length} groups → ${rounds.length} rounds, maxSubBatches=${maxRounds}`);
    for (let r = 0; r < rounds.length; r++) {
        const items = rounds[r];
        logDebug_ACU(`  Round ${r + 1}: ${items.length} items — ${items.map(it => `${it.groupKey}[batch${it.batchNumberInGroup}:${it.batchIndices[0]}..${it.saveTargetIndex}]`).join(', ')}`);
    }

    return rounds;
}

// ═══ Task 2: 单次执行合并后的编辑 ═══

import type { TableDataObject_ACU } from '../../shared/models/table-data';

/**
 * 在当前状态上执行合并后的 AI 编辑。
 *
 * - SQLite 模式：
 *   1. 调用 provider._ensureInitialized() + _ensureTablesFromTemplate() 建表（如果表不存在）
 *   2. provider.applyEdits(sql) 执行 SQL
 * - 原生模式：
 *   将编辑内容包装在 <tableEdit>...</tableEdit> 中，调用 parseAndApplyTableEdits_ACU
 *
 * 返回 beforeData / afterData / modifiedKeys。
 * 不调用 replaceCurrentData，不触发 persistTablesToChatMessage。
 *
 * @param mergedEditContent 合并后的编辑文本（SQL 或原生指令）
 * @param updateMode 更新模式（'standard' | 'auto' | 'manual_summary' 等）
 * @param targetSheetKeys 目标表键列表（用于过滤 modifiedKeys）
 */
export async function applyMergedEdits_ACU(
    mergedEditContent: string,
    updateMode: string,
    targetSheetKeys: string[] | null,
): Promise<{
    success: boolean;
    beforeData: TableDataObject_ACU | null;
    afterData: TableDataObject_ACU | null;
    modifiedKeys: string[];
    error?: string;
}> {
    if (!mergedEditContent || !mergedEditContent.trim()) {
        return { success: false, beforeData: null, afterData: null, modifiedKeys: [], error: '无有效编辑内容' };
    }
    if (!currentJsonTableData_ACU) {
        return { success: false, beforeData: null, afterData: null, modifiedKeys: [], error: 'currentJsonTableData_ACU 未加载' };
    }

    // 克隆 beforeData
    const beforeData = JSON.parse(JSON.stringify(currentJsonTableData_ACU)) as TableDataObject_ACU;

    try {
        if (isSqliteMode()) {
            const provider = getStorageProvider();
            // 1. 建表（如果表不存在）
            try {
                (provider as any)._ensureInitialized?.();
                (provider as any)._ensureTablesFromTemplate?.();
            } catch (e: any) {
                logWarn_ACU('[applyMergedEdits] 建表失败，继续执行编辑:', e?.message);
            }

            // 2. 执行编辑
            const result = provider.applyEdits(mergedEditContent, updateMode);
            if (!result.success) {
                return {
                    success: false,
                    beforeData,
                    afterData: null,
                    modifiedKeys: [],
                };
            }

            // 3. 克隆 afterData
            const afterData = JSON.parse(JSON.stringify(currentJsonTableData_ACU)) as TableDataObject_ACU;

            // 4. 收集 modifiedKeys
            const modifiedKeys = Array.isArray(result.modifiedKeys)
                ? (targetSheetKeys
                    ? result.modifiedKeys.filter((k: string) => targetSheetKeys.includes(k))
                    : result.modifiedKeys)
                : (targetSheetKeys || []);

            return { success: true, beforeData, afterData, modifiedKeys };
        } else {
            // 原生模式：将编辑内容包装在 <tableEdit>...</tableEdit> 中
            const wrappedContent = `<tableEdit>${mergedEditContent}</tableEdit>`;
            const result = parseAndApplyTableEdits_ACU(wrappedContent, updateMode, false);

            if (!result || (typeof result === 'object' && result.success === false)) {
                return {
                    success: false,
                    beforeData,
                    afterData: null,
                    modifiedKeys: [],
                    error: typeof result === 'object' ? (result as any).error || '原生模式执行失败' : '原生模式执行失败',
                };
            }

            // 克隆 afterData
            const afterData = JSON.parse(JSON.stringify(currentJsonTableData_ACU)) as TableDataObject_ACU;

            // 收集 modifiedKeys
            const modifiedKeys = Array.isArray((result as any).modifiedKeys)
                ? (targetSheetKeys
                    ? (result as any).modifiedKeys.filter((k: string) => targetSheetKeys.includes(k))
                    : (result as any).modifiedKeys)
                : (targetSheetKeys || []);

            return { success: true, beforeData, afterData, modifiedKeys };
        }
    } catch (e: any) {
        logError_ACU('[applyMergedEdits] 执行合并编辑失败:', e);
        return {
            success: false,
            beforeData,
            afterData: null,
            modifiedKeys: [],
            error: e?.message || String(e),
        };
    }
}
import { buildGuidedBaseDataFromSheetGuide_ACU, getSortedSheetKeys_ACU } from '../template/chat-scope';
import { getStorageProvider, reloadStorageProvider } from './table-storage-strategy';
import { isSqliteMode } from './storage-mode';
import { applySpecialIndexSequenceToSummaryTables_ACU } from '../runtime/helpers-remaining';
import { clearTableDataAtFloors_ACU } from '../chat/chat-service';
import { reconstructTablesFromChatDeltas_ACU } from './table-delta-reconstruct';

// ============================================================
// 类型定义：返回值 + 进度事件（service 层不驱动 UI）
// ============================================================

/** 卡片更新进度事件阶段 */
export type CardUpdatePhase =
    | 'preparing'        // 准备 AI 输入
    | 'calling_ai'       // 调用 AI（含重试信息）
    | 'parsing'          // 解析 AI 返回
    | 'saving'           // 保存到聊天记录
    | 'chunk_done'       // 分块处理成功（import 模式）
    | 'complete'         // 完成
    | 'retry'            // 重试中
    | 'error';           // 出错

/** 卡片更新进度事件 */
export interface CardUpdateProgressEvent {
    phase: CardUpdatePhase;
    attempt?: number;
    maxRetries?: number;
    message?: string;
    currentBatch?: number;
    totalBatches?: number;
}

/** 批处理进度上下文 */
export interface BatchUpdateProgressContext {
    currentBatch: number;
    totalBatches: number;
}

export interface DeferredAiResponse_ACU {
    aiResponse: string;
    targetMessageIndex: number;
    /** Stable per prepared batch call. Required when multiple groups target the same message. */
    preparedCallId?: string;
    /** Original order inside the current manual chunk; used only for deterministic merged commit ordering. */
    chunkOrder?: number;
    batchNumber?: number;
    groupKey?: string;
    groupOrder?: number;
    updateMode: string;
    targetSheetKeys: string[] | null;
    requestOptions: Record<string, any> | null;
}

export interface PreparedAiCall_ACU {
    preparedCallId: string;
    targetMessageIndex: number;
    batchNumber: number;
    updateMode: string;
    targetSheetKeys: string[] | null;
    requestOptions: Record<string, any> | null;
    dynamicContent: any;
}

export interface DeferredCommitPayload_ACU {
    targetMessageIndex: number;
    /** Stable per prepared batch call. Required when multiple groups target the same message. */
    preparedCallId?: string;
    /** Original order inside the current manual chunk; used only for deterministic merged commit ordering. */
    chunkOrder?: number;
    batchNumber?: number;
    groupKey?: string;
    groupOrder?: number;
    targetSheetKeys: string[];
    updateGroupKeys: string[] | null;
    trackingSheetKeys: string[];
    beforeData: TableDataObject_ACU;
    afterData: TableDataObject_ACU;
    modifiedKeys: string[];
}

export interface ExecuteCardUpdateOptions_ACU {
    /**
     * Prepare immutable AI-call payload only. This may run after serial runtime base preparation,
     * but must not call AI, parse, apply, persist, update lorebook, or enqueue vector flushes.
     */
    prepareAiCallOnly?: boolean;
    /**
     * Generate and validate the AI response only. This must not parse, mutate runtime table data,
     * persist to chat messages, update readable lorebook entries, or enqueue vector flushes.
     */
    deferApply?: boolean;
    /**
     * Parse/apply the response but return a commit payload instead of writing to chat persistence.
     */
    deferPersistence?: boolean;
    /**
     * Previously generated response used by the serial replay/apply phase.
     */
    deferredAiResponse?: DeferredAiResponse_ACU | null;
}

/** executeCardUpdateCore 的返回值 */
export interface CardUpdateResult {
    success: boolean;
    modifiedKeys: string[];
    error?: string;
    aborted?: boolean;
    preparedAiCall?: PreparedAiCall_ACU;
    deferredResponse?: DeferredAiResponse_ACU;
    deferredCommit?: DeferredCommitPayload_ACU;
}

/** processUpdatesBatch 的返回值 */
export interface BatchUpdateResult {
    success: boolean;
    failedBatch?: number;
    error?: string;
    preparedAiCalls?: PreparedAiCall_ACU[];
    deferredResponses?: DeferredAiResponse_ACU[];
    deferredCommits?: DeferredCommitPayload_ACU[];
}

/** orchestrateManualUpdate 的返回值 */
export interface ManualUpdateResult {
    success: boolean;
    error?: string;
    /** 是否触发了自动合并 */
    autoMergeTriggered?: boolean;
    autoMergeSuccess?: boolean;
}

// ============================================================
// 核心业务函数
// ============================================================

function cloneTableDataForDelta_ACU(data: any): TableDataObject_ACU | null {
    if (!data || typeof data !== 'object') return null;
    return JSON.parse(JSON.stringify(data)) as TableDataObject_ACU;
}

async function replaceRuntimeTableDataForDeferredApply_ACU(data: TableDataObject_ACU | null, label: string): Promise<void> {
    if (isSqliteMode()) {
        const provider = getStorageProvider();
        await provider.replaceCurrentData(data);
        const providerCurrentData = provider.getCurrentData();
        _set_currentJsonTableData_ACU(providerCurrentData || data);
        if (!providerCurrentData && data) {
            logWarn_ACU(`${label} SQLite provider returned null current data after replace; falling back to provided data.`);
        }
        return;
    }
    _set_currentJsonTableData_ACU(data ? cloneTableDataForDelta_ACU(data) : null);
}


function hasRealDataRows_ACU(sheet: any): boolean {
    const content = sheet?.content;
    return Array.isArray(content) && content.length > 1;
}

function isHeaderOnlySheet_ACU(sheet: any): boolean {
    const content = sheet?.content;
    return Array.isArray(content) && content.length <= 1;
}

function cloneJson_ACU<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function resolveRowIdentityColumnIndex_ACU(header: any): number {
    if (!Array.isArray(header) || header.length === 0) return 0;
    const rowIdIndex = header.findIndex((cell: any) => String(cell ?? '').trim().toLowerCase() === 'row_id');
    return rowIdIndex >= 0 ? rowIdIndex : 0;
}

function getRowIdentity_ACU(row: any, identityColumnIndex: number): string | null {
    if (!Array.isArray(row)) return null;
    const value = row[identityColumnIndex];
    if (value === null || value === undefined) return null;
    const identity = String(value).trim();
    return identity ? identity : null;
}

function mergeSheetContentPreservingBatchRows_ACU(batchSheet: any, providerSheet: any): any[][] | null {
    const batchContent = batchSheet?.content;
    const providerContent = providerSheet?.content;
    if (!Array.isArray(providerContent) || providerContent.length <= 1) return null;

    const batchHeader = Array.isArray(batchContent?.[0]) ? batchContent[0] : null;
    const providerHeader = Array.isArray(providerContent[0]) ? providerContent[0] : null;
    const headerToKeep = batchHeader || providerHeader;
    if (!headerToKeep) return null;

    const identityColumnIndex = resolveRowIdentityColumnIndex_ACU(headerToKeep);
    const mergedRows: any[][] = [];
    const seenIdentities = new Set<string>();

    if (Array.isArray(batchContent) && batchContent.length > 1) {
        for (const row of batchContent.slice(1)) {
            if (!Array.isArray(row)) continue;
            const clonedRow = cloneJson_ACU(row);
            mergedRows.push(clonedRow);
            const identity = getRowIdentity_ACU(clonedRow, identityColumnIndex);
            if (identity) seenIdentities.add(identity);
        }
    }

    for (const row of providerContent.slice(1)) {
        if (!Array.isArray(row)) continue;
        const identity = getRowIdentity_ACU(row, identityColumnIndex);
        if (identity && seenIdentities.has(identity)) continue;
        const clonedRow = cloneJson_ACU(row);
        mergedRows.push(clonedRow);
        if (identity) seenIdentities.add(identity);
    }

    return cloneJson_ACU([headerToKeep, ...mergedRows]);
}

function mergeProviderRowsIntoBatchSheets_ACU(
    mergedBatchData: Record<string, any>,
    providerCurrentData: TableDataObject_ACU | null,
    batchSheetKeys: string[],
): number {
    if (!providerCurrentData || typeof providerCurrentData !== 'object') return 0;

    let patchedCount = 0;
    for (const sheetKey of batchSheetKeys) {
        const batchSheet = mergedBatchData[sheetKey];
        const providerSheet = (providerCurrentData as Record<string, any>)[sheetKey];
        if (!batchSheet || !providerSheet) continue;
        if (!hasRealDataRows_ACU(providerSheet)) continue;

        const mergedContent = mergeSheetContentPreservingBatchRows_ACU(batchSheet, providerSheet);
        if (!mergedContent) continue;

        const originalContent = JSON.stringify(batchSheet.content || []);
        const nextContent = JSON.stringify(mergedContent);
        if (originalContent === nextContent) continue;

        mergedBatchData[sheetKey] = {
            ...cloneJson_ACU(providerSheet),
            ...batchSheet,
            content: mergedContent,
        };
        patchedCount++;
    }
    return patchedCount;
}

/**
 * 加载批次基础数据：从聊天记录中为每个表格查找最新数据
 * 纯业务逻辑，不涉及任何 UI 操作
 */
/**
 * [辅助] 从聊天记录加载旧数据覆盖 sheet 后，恢复指导表基底中的关键结构字段。
 *
 * 背景：loadBatchBaseData_ACU 从聊天记录中加载旧数据时，会整体覆盖 mergedBatchData[sheetKey]。
 * 但指导表基底中可能包含用户在可视化编辑器中修改过的 sourceData.ddl 和表头（content[0]），
 * 这些结构信息不应该被聊天记录中的旧数据覆盖。
 *
 * 只恢复 sourceData（含 DDL）和表头（content[0]），其他字段（name/uid/updateConfig/exportConfig）
 * 保留聊天记录中的值，因为它们可能在聊天过程中被合法修改。
 */
function restoreGuideStructure(mergedSheet: any, guideSheet: any): void {
    if (!guideSheet || typeof guideSheet !== 'object') return;
    if (!mergedSheet || typeof mergedSheet !== 'object') return;

    // 恢复指导表/模板的结构配置。历史数据只负责提供行内容与可演进元信息，不应污染当前模板配置。
    const structuralKeys = ['sourceData', 'updateConfig', 'exportConfig'];
    for (const key of structuralKeys) {
        if (Object.prototype.hasOwnProperty.call(guideSheet, key)) {
            mergedSheet[key] = JSON.parse(JSON.stringify(guideSheet[key]));
        }
    }

    // 恢复表头（content[0]）——指导表中的表头是用户最新编辑的，但不能覆盖历史数据行。
    if (Array.isArray(guideSheet.content) && guideSheet.content.length > 0 &&
        Array.isArray(mergedSheet.content) && mergedSheet.content.length > 0) {
        mergedSheet.content[0] = JSON.parse(JSON.stringify(guideSheet.content[0]));
    }
}

export function loadBatchBaseData_ACU(
    chatHistory: any[],
    firstMessageIndexOfBatch: number,
    batchIsolationKey: string,
    batchSheetKeys: string[],
    mergedBatchData: Record<string, any>
): { foundCount: number; totalCount: number } {
    const batchFoundSheets: Record<string, boolean> = {};
    batchSheetKeys.forEach(k => batchFoundSheets[k] = false);

    // [修复] 保存指导表基底中每个 sheet 的结构快照（sourceData/DDL/表头/表名等），
    // 以便从聊天记录加载旧数据覆盖后恢复。防止旧数据中的旧 DDL/旧表头覆盖用户在可视化编辑器中的修改。
    const guideSnapshots: Record<string, any> = {};
    batchSheetKeys.forEach(k => {
        if (mergedBatchData[k] && typeof mergedBatchData[k] === 'object') {
            guideSnapshots[k] = mergedBatchData[k];
        }
    });

    const reconstructed = reconstructTablesFromChatDeltas_ACU(chatHistory, {
        isolationKey: batchIsolationKey,
        isolationConfig: {
            enabled: settings_ACU.dataIsolationEnabled,
            code: settings_ACU.dataIsolationCode,
        },
        templateSheetKeys: batchSheetKeys,
    }, {
        targetMessageIndexExclusive: firstMessageIndexOfBatch,
        saveChatAfterMigration: false,
        retainRecentLayers: settings_ACU.retainRecentLayers,
    });

    const reconstructedData: Record<string, any> = reconstructed.data || {};
    batchSheetKeys.forEach(sheetKey => {
        const reconstructedSheet = reconstructedData[sheetKey];
        if (reconstructedSheet && mergedBatchData[sheetKey]) {
            mergedBatchData[sheetKey] = JSON.parse(JSON.stringify(reconstructedSheet));
            restoreGuideStructure(mergedBatchData[sheetKey], guideSnapshots[sheetKey]);
            batchFoundSheets[sheetKey] = true;
        }
    });

    const foundCount = Object.values(batchFoundSheets).filter(v => v === true).length;
    const totalCount = batchSheetKeys.length;
    return { foundCount, totalCount };
}

/**
 * 构建批次合并基底数据
 * 纯业务逻辑，不涉及任何 UI 操作
 */
export function buildBatchMergeBase_ACU(batchNumber: number): { data: Record<string, any> | null; error: string | null } {
    try {
        const batchIsoKey = getCurrentIsolationKey_ACU();
        const sheetGuideForBatch = getChatSheetGuideDataForIsolationKey_ACU(batchIsoKey);
        if (sheetGuideForBatch && typeof sheetGuideForBatch === 'object' && Object.keys(sheetGuideForBatch).some(k => k.startsWith('sheet_'))) {
            const data = buildGuidedBaseDataFromSheetGuide_ACU(sheetGuideForBatch);
            logDebug_ACU(`[Batch ${batchNumber}] Using chat sheet guide as merge base.`);
            return { data, error: null };
        } else {
            const data = parseTableTemplateJson_ACU({ stripSeedRows: true });
            logDebug_ACU(`[Batch ${batchNumber}] No chat sheet guide found, using template as merge base.`);
            return { data, error: null };
        }
    } catch (e) {
        logError_ACU(`[Batch ${batchNumber}] Failed to build merge base from guide/template.`, e);
        return { data: null, error: '无法构建合并基底，操作已终止。' };
    }
}

/**
 * 确定更新模式
 * 纯业务逻辑
 */
export function resolveUpdateMode_ACU(mode: string): string {
    if (mode === 'auto_unified' || mode === 'manual_unified' || mode === 'full') {
        return mode;
    } else if (mode === 'auto_summary_silent') {
        return 'auto_summary_silent';
    } else if (mode && mode.startsWith('manual')) {
        if (mode.includes('summary')) return 'manual_summary';
        else if (mode === 'manual_independent') return 'manual_independent';
        else return 'manual_standard';
    } else {
        if (mode && mode.includes('summary')) return 'auto_summary';
        else return 'auto_standard';
    }
}

/**
 * 执行单次卡片更新的核心逻辑（AI调用 + 重试 + 解析 + 保存）
 * 纯业务逻辑，不驱动 UI。通过可选的 onProgress 回调传递纯数据进度事件。
 * presentation 层根据返回值和进度事件自行决定 UI 操作。
 */
export async function executeCardUpdateCore_ACU(
    messagesToUse: any[],
    saveTargetIndex: number,
    isImportMode: boolean,
    updateMode: string,
    isSilentMode: boolean,
    targetSheetKeys: string[] | null,
    requestOptions: Record<string, any> | null,
    abortController: AbortController,
    progressContext: BatchUpdateProgressContext | null = null,
    onProgress?: (event: CardUpdateProgressEvent) => void,
    executionOptions: ExecuteCardUpdateOptions_ACU = {},
): Promise<CardUpdateResult> {
    const emitProgress = (event: CardUpdateProgressEvent): void => {
        onProgress?.({
            ...event,
            ...(progressContext
                ? {
                    currentBatch: progressContext.currentBatch,
                    totalBatches: progressContext.totalBatches,
                }
                : {}),
        });
    };
    let success = false;
    let modifiedKeys: string[] = [];
    const maxRetries = settings_ACU.tableMaxRetries || 3;

    try {
        emitProgress({ phase: 'preparing' });

        const deferredAiResponse = executionOptions.deferredAiResponse || null;
        const dynamicContent = deferredAiResponse
            ? null
            : await prepareAIInput_ACU(messagesToUse, updateMode, targetSheetKeys, {
                excludeImportTaggedWorldbookEntries: isImportMode && settings_ACU.importPromptExcludeImportedWorldbookEntries !== false,
            });
        if (!deferredAiResponse && !dynamicContent) {
            return { success: false, modifiedKeys: [], error: '无法准备AI输入，数据库未加载。' };
        }

        if (executionOptions.prepareAiCallOnly) {
            if (deferredAiResponse) {
                return { success: false, modifiedKeys: [], error: 'prepareAiCallOnly 不能与 deferredAiResponse 同时使用。' };
            }
            return {
                success: true,
                modifiedKeys: [],
                preparedAiCall: {
                    preparedCallId: '',
                    targetMessageIndex: saveTargetIndex,
                    batchNumber: progressContext?.currentBatch || 1,
                    updateMode,
                    targetSheetKeys,
                    requestOptions,
                    dynamicContent,
                },
            };
        }

        const SQL_ERROR_MARKER = '\n\n<!-- SQL_ERROR_FEEDBACK -->\n';
        let lastSqlError: string | null = null;
        let successfulBeforeData: TableDataObject_ACU | null = null;
        let successfulAfterData: TableDataObject_ACU | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (wasStoppedByUser_ACU) {
                return { success: false, modifiedKeys: [], aborted: true };
            }

            emitProgress({ phase: 'calling_ai', attempt, maxRetries });

            if (lastSqlError && isSqliteMode() && dynamicContent) {
                const markerIndex = dynamicContent.tableDataText.indexOf(SQL_ERROR_MARKER);
                if (markerIndex !== -1) {
                    dynamicContent.tableDataText = dynamicContent.tableDataText.substring(0, markerIndex);
                }
                dynamicContent.tableDataText += `${SQL_ERROR_MARKER}[SQL执行错误，请修正后重新输出]\n错误信息: ${lastSqlError}`;
            }

            try {
                const aiResponse = deferredAiResponse?.aiResponse
                    || await callCustomOpenAI_ACU(dynamicContent, abortController, requestOptions);

                if (abortController.signal.aborted || wasStoppedByUser_ACU) {
                    return { success: false, modifiedKeys: [], aborted: true };
                }

                const minReplyLength = settings_ACU.autoUpdateTokenThreshold || 0;
                if (aiResponse && minReplyLength > 0 && aiResponse.length < minReplyLength) {
                    throw new Error(`AI回复过短 (${aiResponse.length} 字符)，低于阈值 (${minReplyLength} 字符)`);
                }

                if (!aiResponse || !aiResponse.includes('<tableEdit>') || !aiResponse.includes('</tableEdit>')) {
                    throw new Error('AI响应中未找到完整有效的 <tableEdit> 标签');
                }

                if (executionOptions.deferApply) {
                    return {
                        success: true,
                        modifiedKeys: [],
                        deferredResponse: {
                            aiResponse,
                            targetMessageIndex: saveTargetIndex,
                            updateMode,
                            targetSheetKeys,
                            requestOptions,
                        },
                    };
                }

                emitProgress({ phase: 'parsing' });

                const attemptBeforeData = cloneTableDataForDelta_ACU(currentJsonTableData_ACU);
                const parseResult = parseAndApplyTableEdits_ACU(aiResponse, updateMode, isImportMode);

                let parseSuccess = false;
                modifiedKeys = [];

                if (typeof parseResult === 'object' && parseResult !== null) {
                    parseSuccess = parseResult.success;
                    modifiedKeys = parseResult.modifiedKeys || [];
                } else {
                    parseSuccess = !!parseResult;
                    modifiedKeys = targetSheetKeys || [];
                }

                if (!parseSuccess) {
                    throw new Error('解析或应用AI更新时出错');
                }

                // [spv3.6.5] 填表完成后统一强制应用编码索引列特殊锁定（AM序列）
                // 无论 SQL 模式还是原生模式，都在这里兜底确保编码索引列被强制修正
                applySpecialIndexSequenceToSummaryTables_ACU(currentJsonTableData_ACU);

                successfulBeforeData = attemptBeforeData;
                successfulAfterData = cloneTableDataForDelta_ACU(currentJsonTableData_ACU);
                success = true;
                break;

            } catch (error: any) {
                logWarn_ACU(`第 ${attempt} 次尝试失败: ${error.message}`);

                if (isSqliteMode() && error.message) {
                    lastSqlError = error.message;
                }

                if (error?.name === 'AbortError' || String(error?.message || '').toLowerCase().includes('aborted') || wasStoppedByUser_ACU) {
                    return { success: false, modifiedKeys: [], aborted: true };
                }

                if (deferredAiResponse) {
                    return { success: false, modifiedKeys: [], error: `应用预生成填表结果失败: ${error.message}` };
                } else if (attempt < maxRetries) {
                    const waitTime = 5000;
                    logDebug_ACU(`等待 ${waitTime}ms 后重试...`);
                    emitProgress({ phase: 'retry', attempt, maxRetries, message: error.message?.substring(0, 50) });
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                    continue;
                } else {
                    return { success: false, modifiedKeys: [], error: `填表在 ${maxRetries} 次尝试后仍失败: ${error.message}` };
                }
            }
        }

        if (success) {
            if (!isImportMode) {
                emitProgress({ phase: 'saving' });

                let keysToPersist = modifiedKeys;
                if (targetSheetKeys && Array.isArray(targetSheetKeys)) {
                    keysToPersist = keysToPersist.filter((k: string) => targetSheetKeys.includes(k));
                }

                const isFirstTimeInit = await checkIfFirstTimeInit_ACU();

                if (keysToPersist.length > 0 || isFirstTimeInit) {
                    let keysToActuallySave = keysToPersist;
                    if (isFirstTimeInit) {
                        const allSheetKeys = getSortedSheetKeys_ACU(currentJsonTableData_ACU);
                        keysToActuallySave = allSheetKeys;

                        const fullTemplate = parseTableTemplateJson_ACU({ stripSeedRows: false });
                        if (fullTemplate) {
                            allSheetKeys.forEach(sheetKey => {
                                if (!keysToPersist.includes(sheetKey) && fullTemplate[sheetKey]) {
                                    currentJsonTableData_ACU[sheetKey] = JSON.parse(JSON.stringify(fullTemplate[sheetKey]));
                                    logDebug_ACU(`[Init] Table ${sheetKey} not modified by AI, using template data (may include seed rows).`);
                                }
                            });
                        }

                        logDebug_ACU('[Init] First time initialization detected. Saving complete template structure with all tables.');
                    }

                    const updateGroupKeysRaw = isFirstTimeInit ? keysToPersist : targetSheetKeys;
                    const keysToTrackAsUpdated = keysToPersist.filter((sheetKey: string) => keysToActuallySave.includes(sheetKey));
                    const updateGroupKeysToUse = Array.isArray(updateGroupKeysRaw)
                        ? updateGroupKeysRaw.filter(sheetKey => {
                            const table = currentJsonTableData_ACU?.[sheetKey];
                            if (!table || !isSummaryOrOutlineTable_ACU(table.name)) return true;
                            return keysToTrackAsUpdated.includes(sheetKey);
                        })
                        : updateGroupKeysRaw;
                    if (!successfulBeforeData || !successfulAfterData) {
                        return { success: false, modifiedKeys, error: '无法捕获填表前后数据库快照，已中止保存以避免生成错误 delta。' };
                    }

                    const finalAfterData = cloneTableDataForDelta_ACU(currentJsonTableData_ACU) || successfulAfterData;
                    if (executionOptions.deferPersistence) {
                        return {
                            success: true,
                            modifiedKeys,
                            deferredCommit: {
                                targetMessageIndex: saveTargetIndex,
                                preparedCallId: deferredAiResponse?.preparedCallId,
                                chunkOrder: deferredAiResponse?.chunkOrder,
                                batchNumber: deferredAiResponse?.batchNumber,
                                groupKey: deferredAiResponse?.groupKey,
                                groupOrder: deferredAiResponse?.groupOrder,
                                targetSheetKeys: keysToActuallySave,
                                updateGroupKeys: Array.isArray(updateGroupKeysToUse) ? updateGroupKeysToUse : null,
                                trackingSheetKeys: keysToTrackAsUpdated,
                                beforeData: successfulBeforeData,
                                afterData: finalAfterData,
                                modifiedKeys,
                            },
                        };
                    } else {
                        const saveResult = await persistTablesToChatMessage_ACU({
                            targetMessageIndex: saveTargetIndex,
                            targetSheetKeys: keysToActuallySave,
                            updateGroupKeys: updateGroupKeysToUse,
                            trackingSheetKeys: keysToTrackAsUpdated,
                            trackAsUpdate: true,
                            beforeData: successfulBeforeData,
                            afterData: finalAfterData,
                        });
                        if (!saveResult.saved) {
                            return { success: false, modifiedKeys, error: '无法将更新后的数据库保存到聊天记录。' };
                        }
                    }
                } else {
                    logDebug_ACU("No tables were modified by AI, skipping save to chat history.");
                }

                if (!executionOptions.deferPersistence) {
                    await updateReadableLorebookEntry_ACU(true);
                }

            } else {
                emitProgress({ phase: 'chunk_done' });
                logDebug_ACU("Import mode: skipping save to chat history for this chunk.");
            }

            emitProgress({ phase: 'complete' });

            // [spv3.6.6] 填表完成后异步触发交火向量索引防抖归档
            // 将 embedding + 归档写入从 saving 阶段移到 complete 之后，
            // 避免 embedding API 调用阻塞"正在保存"提示框。
            // 使用 flush queue 替代直接调用，由防抖定时器统一调度。
            // [spv3.6.9] 增加诊断日志，记录入队结果（queued/skipped）
            if (!isImportMode && !executionOptions.deferPersistence && success && getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled === true) {
                enqueueSummaryVectorIndexFlush_ACU({
                    targetMessageIndex: saveTargetIndex,
                    mode: 'sync',
                    reason: 'table_fill_complete',
                }).then(result => {
                    if (result.skipped) {
                        logWarn_ACU(`[交火模式纪要索引] 填表完成后防抖归档被跳过：${result.reason || 'unknown'}, scopeKey=${result.scopeKey || ''}`);
                    } else if (result.queued) {
                        logDebug_ACU(`[交火模式纪要索引] 填表完成后已入队防抖归档, scopeKey=${result.scopeKey}, debounceUntil=${result.debounceUntil}`);
                    }
                }).catch(err => {
                    logWarn_ACU('[交火模式纪要索引] 填表完成后防抖归档入队异常:', err);
                });
            }

        }
        return { success, modifiedKeys };

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logDebug_ACU('Fetch request was aborted by the user.');
            return { success: false, modifiedKeys: [], aborted: true };
        } else {
            logError_ACU(`数据库增量更新流程失败: ${error.message}`);
            return { success: false, modifiedKeys: [], error: error.message };
        }
    }
}

/**
 * 批处理更新编排（纯业务逻辑）
 * 从 processUpdates_ACU 提取。不驱动 UI，只返回结果。
 */
export async function processUpdatesBatch_ACU(
    indicesToUpdate: number[],
    mode: string,
    options: any,
    executeUpdate: (
        messagesToUse: any[],
        saveTargetIndex: number,
        updateMode: string,
        isSilentMode: boolean,
        targetSheetKeys: string[] | null,
        requestOptions: Record<string, any> | null,
        progressContext: BatchUpdateProgressContext,
        executionOptions?: ExecuteCardUpdateOptions_ACU,
    ) => Promise<CardUpdateResult>
): Promise<BatchUpdateResult> {
    if (!indicesToUpdate || indicesToUpdate.length === 0) {
        return { success: true };
    }

    const { targetSheetKeys, batchSize: specificBatchSize, requestOptions } = options;
    const deferredResponsesInput: DeferredAiResponse_ACU[] = Array.isArray(options?.deferredResponses)
        ? options.deferredResponses
        : [];
    const deferApply = options?.deferApply === true;
    const deferPersistence = options?.deferPersistence === true;
    const prepareAiCallOnly = options?.prepareAiCallOnly === true;
    const groupKeyForDeferred = typeof options?.groupKey === 'string' ? options.groupKey : undefined;
    const groupOrderForDeferred = Number.isFinite(options?.groupOrder) ? Number(options.groupOrder) : undefined;
    const preparedAiCalls: PreparedAiCall_ACU[] = [];
    const deferredResponses: DeferredAiResponse_ACU[] = [];
    const deferredCommits: DeferredCommitPayload_ACU[] = [];

    _set_wasStoppedByUser_ACU(false);
    _set_isAutoUpdatingCard_ACU(true);

    try {
        const isSummaryMode = (mode && (mode.includes('summary') || mode === 'manual_summary')) || false;
        const batchSize = specificBatchSize || (settings_ACU.updateBatchSize || 2);

        const batches: number[][] = [];
        for (let i = 0; i < indicesToUpdate.length; i += batchSize) {
            batches.push(indicesToUpdate.slice(i, i + batchSize));
        }

        logDebug_ACU(`[${mode}] Processing ${indicesToUpdate.length} updates in ${batches.length} batches of size ${batchSize} (${isSummaryMode ? '总结表模式' : '标准表模式'}). Target Sheets: ${targetSheetKeys ? targetSheetKeys.length : 'All'}`);

        const chatHistory = getChatArray_ACU();
        const isAutoUpdateMode = mode && mode.startsWith('auto');
        const isSilentMode = !!(isAutoUpdateMode && settings_ACU.toastMuteEnabled) || prepareAiCallOnly;

        for (let i = 0; i < batches.length; i++) {
            const batchIndices = batches[i];
            const batchNumber = i + 1;
            const firstMessageIndexOfBatch = batchIndices[0];
            const lastMessageIndexOfBatch = batchIndices[batchIndices.length - 1];
            const finalSaveTargetIndex = lastMessageIndexOfBatch;

            // [修复] deferPersistence 模式下，不在 batch 循环中 replaceCurrentData——
            // 1. 避免 batch 之间丢弃前序 batch 已 applyEdits 到 SQLite 的修改
            // 2. 避免并发分组（手动/自动更新多组）时互相 dispose SQLite engine
            // 3. 避免 replaceCurrentData(空壳) 覆盖前序组已修改的 currentJsonTableData_ACU
            // 非 deferPersistence 时保持原有行为（每次 batch 重建基底）
            if (!deferPersistence) {
                // 构建合并基底
                const baseResult = buildBatchMergeBase_ACU(batchNumber);
                if (!baseResult.data) {
                    return { success: false, failedBatch: batchNumber, error: baseResult.error || '无法构建合并基底，操作已终止。' };
                }
                const mergedBatchData = baseResult.data;

                const batchSheetKeys = getSortedSheetKeys_ACU(mergedBatchData);
                const batchIsolationKey = getCurrentIsolationKey_ACU();

                // 加载历史数据
                const loadResult = loadBatchBaseData_ACU(chatHistory, firstMessageIndexOfBatch, batchIsolationKey, batchSheetKeys, mergedBatchData);
                if (isSqliteMode()) {
                    const provider = getStorageProvider();
                    const providerCurrentDataBeforeReplace = provider.getCurrentData();
                    const patchedCount = mergeProviderRowsIntoBatchSheets_ACU(
                        mergedBatchData,
                        providerCurrentDataBeforeReplace,
                        batchSheetKeys,
                    );
                    if (patchedCount > 0) {
                        logWarn_ACU(`[Batch ${batchNumber}] SQLite batch base preserved provider rows for ${patchedCount} sheet(s) before replacing runtime data.`);
                    }

                    await provider.replaceCurrentData(mergedBatchData as TableDataObject_ACU);
                    const providerCurrentData = provider.getCurrentData();
                    if (providerCurrentData) {
                        _set_currentJsonTableData_ACU(providerCurrentData);
                        logDebug_ACU(`[Batch ${batchNumber}] SQLite provider current data exported to JSON before prompt preparation.`);
                    } else {
                        _set_currentJsonTableData_ACU(mergedBatchData);
                        logWarn_ACU(`[Batch ${batchNumber}] SQLite provider returned null current data after replace; falling back to merged batch data.`);
                    }
                    logDebug_ACU(`[Batch ${batchNumber}] SQLite provider replaced with batch base before prompt preparation.`);
                } else {
                    _set_currentJsonTableData_ACU(mergedBatchData);
                }
                logDebug_ACU(`[Batch ${batchNumber}] Loaded ${loadResult.foundCount}/${loadResult.totalCount} tables from history before index ${firstMessageIndexOfBatch}. Missing tables will use template structure (header-only).`);
            } else {
                // deferPersistence 模式：跳过 replaceCurrentData，
                // 直接使用当前 provider 状态（已包含前序 batch 的修改）
                logDebug_ACU(`[Batch ${batchNumber}] deferPersistence mode: skipping base rebuild, using current provider state directly.`);
            }

            // 计算上下文范围
            let sliceStartIndex = firstMessageIndexOfBatch;
            if (sliceStartIndex > 0 && chatHistory[sliceStartIndex - 1]?.is_user) {
                sliceStartIndex--;
                logDebug_ACU(`[Batch ${batchNumber}] Adjusted slice start to ${sliceStartIndex} to include preceding user message.`);
            }
            const messagesForContext = chatHistory.slice(sliceStartIndex, lastMessageIndexOfBatch + 1);

            // 检查最新AI回复长度阈值
            const lastAiMessageInBatch = chatHistory[lastMessageIndexOfBatch];
            const lastAiMessageContent = lastAiMessageInBatch?.mes || lastAiMessageInBatch?.message || '';
            const lastAiMessageLength = lastAiMessageContent.length;
            const minReplyLength = settings_ACU.autoUpdateTokenThreshold || 0;

            if (isAutoUpdateMode && lastAiMessageLength < minReplyLength) {
                logDebug_ACU(`[Auto] Batch ${batchNumber}/${batches.length} skipped: Last AI reply length (${lastAiMessageLength}) is below threshold (${minReplyLength}).`);
                continue;
            }

            // 确定更新模式
            const updateMode = resolveUpdateMode_ACU(mode);

            // 决议 effective API preset：如果调用方未指定 tableApiPreset，
            // 则以 targetSheetKeys 中第一个表名为准查覆盖映射
            let effectiveRequestOptions = requestOptions;
            if (!effectiveRequestOptions?.tableApiPreset && targetSheetKeys && targetSheetKeys.length > 0) {
                const templateForLookup = parseTableTemplateJson_ACU({ stripSeedRows: true });
                const firstTableName = templateForLookup?.[targetSheetKeys[0]]?.name || '';
                const resolvedPreset = resolveTableApiPresetOverride_ACU(firstTableName);
                if (resolvedPreset) {
                    effectiveRequestOptions = { ...(effectiveRequestOptions || {}), tableApiPreset: resolvedPreset };
                }
            }

            const replayResponse = deferredResponsesInput.find(response =>
                response.targetMessageIndex === finalSaveTargetIndex
                && (!response.preparedCallId || response.preparedCallId === `${groupKeyForDeferred || 'batch'}:${batchNumber}:${finalSaveTargetIndex}`)
            );
            if (deferredResponsesInput.length > 0 && !replayResponse) {
                return { success: false, failedBatch: batchNumber, error: `第 ${batchNumber} 批缺少预生成 AI 响应，无法串行应用。` };
            }

            const result = await executeUpdate(
                messagesForContext,
                finalSaveTargetIndex,
                updateMode,
                isSilentMode,
                targetSheetKeys,
                effectiveRequestOptions,
                { currentBatch: batchNumber, totalBatches: batches.length },
                {
                    prepareAiCallOnly,
                    deferApply,
                    deferPersistence,
                    deferredAiResponse: replayResponse || null,
                },
            );

            if (!result.success) {
                return { success: false, failedBatch: batchNumber, error: result.error || `批处理在第 ${batchNumber} 批时失败或被终止。` };
            }
            if (result.preparedAiCall) {
                preparedAiCalls.push({
                    ...result.preparedAiCall,
                    preparedCallId: `${groupKeyForDeferred || 'batch'}:${batchNumber}:${finalSaveTargetIndex}`,
                });
            }
            if (result.deferredResponse) {
                deferredResponses.push({
                    ...result.deferredResponse,
                    preparedCallId: replayResponse?.preparedCallId || result.deferredResponse.preparedCallId,
                    chunkOrder: replayResponse?.chunkOrder ?? result.deferredResponse.chunkOrder,
                    batchNumber,
                    groupKey: groupKeyForDeferred,
                    groupOrder: groupOrderForDeferred,
                });
            }
            if (result.deferredCommit) {
                deferredCommits.push({
                    ...result.deferredCommit,
                    preparedCallId: replayResponse?.preparedCallId || result.deferredCommit.preparedCallId,
                    chunkOrder: replayResponse?.chunkOrder ?? result.deferredCommit.chunkOrder,
                    batchNumber,
                    groupKey: groupKeyForDeferred,
                    groupOrder: groupOrderForDeferred,
                });
            }
        }

        return { success: true, preparedAiCalls, deferredResponses, deferredCommits };
    } finally {
        _set_isAutoUpdatingCard_ACU(false);
    }
}

export async function generateDeferredResponsesForPreparedCalls_ACU(
    preparedCalls: PreparedAiCall_ACU[],
    onProgress?: (event: CardUpdateProgressEvent) => void,
): Promise<{ success: boolean; responses: DeferredAiResponse_ACU[]; error?: string }> {
    if (preparedCalls.length === 0) {
        return { success: true, responses: [] };
    }

    const settled = await Promise.allSettled(preparedCalls.map(async (prepared, chunkOrder) => {
        onProgress?.({
            phase: 'calling_ai',
            attempt: chunkOrder + 1,
            maxRetries: preparedCalls.length,
            message: `正在生成第 ${chunkOrder + 1}/${preparedCalls.length} 组 AI 响应...`,
        });
        const abortController = new AbortController();
        logDebug_ACU(`[Manual Two-Phase] Generating preparedCallId=${prepared.preparedCallId}, target=${prepared.targetMessageIndex}.`);
        const aiResponse = await callCustomOpenAI_ACU(prepared.dynamicContent, abortController, prepared.requestOptions);
        if (abortController.signal.aborted || wasStoppedByUser_ACU) {
            throw new Error('手动更新已终止。');
        }

        const minReplyLength = settings_ACU.autoUpdateTokenThreshold || 0;
        if (aiResponse && minReplyLength > 0 && aiResponse.length < minReplyLength) {
            throw new Error(`AI回复过短 (${aiResponse.length} 字符)，低于阈值 (${minReplyLength} 字符)`);
        }
        if (!aiResponse || !aiResponse.includes('<tableEdit>') || !aiResponse.includes('</tableEdit>')) {
            throw new Error('AI响应中未找到完整有效的 <tableEdit> 标签');
        }

        return {
            aiResponse,
            targetMessageIndex: prepared.targetMessageIndex,
            preparedCallId: prepared.preparedCallId,
            chunkOrder,
            batchNumber: prepared.batchNumber,
            updateMode: prepared.updateMode,
            targetSheetKeys: prepared.targetSheetKeys,
            requestOptions: prepared.requestOptions,
        } satisfies DeferredAiResponse_ACU;
    }));

    const responses: DeferredAiResponse_ACU[] = [];
    for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        if (result.status === 'fulfilled') {
            responses.push(result.value);
            continue;
        }
        const prepared = preparedCalls[index];
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason || '手动更新分组生成异常。');
        return {
            success: false,
            responses: [],
            error: `分组 AI 生成失败 (${prepared.preparedCallId}): ${error}`,
        };
    }

    return { success: true, responses };
}

function unionStrings_ACU(...groups: Array<Array<string> | null | undefined>): string[] {
    const merged = new Set<string>();
    groups.forEach(group => {
        if (!Array.isArray(group)) return;
        group.forEach(item => {
            if (typeof item === 'string' && item) merged.add(item);
        });
    });
    return Array.from(merged);
}

export interface RoundPersistenceTarget_ACU {
    targetMessageIndex: number;
    targetSheetKeys: string[];
    updateGroupKeys: string[];
    trackingSheetKeys: string[];
}

/**
 * 将 round 内多 group 的修改按各自 saveTargetIndex 分桶。
 *
 * round 内 AI 响应仍然合并 apply 一次，但持久化必须回到每个 group 对应的楼层。
 * 这里只记录实际修改过的 sheet，避免 updateGroupKeys 把未修改表误判为已更新。
 */
export function buildRoundPersistenceTargets_ACU(
    roundItems: FillRoundItem_ACU[],
    modifiedKeys: string[],
): RoundPersistenceTarget_ACU[] {
    if (!Array.isArray(roundItems) || roundItems.length === 0 || !Array.isArray(modifiedKeys) || modifiedKeys.length === 0) {
        return [];
    }

    const modifiedKeySet = new Set(modifiedKeys.filter(key => typeof key === 'string' && key.length > 0));
    const targetsByIndex = new Map<number, RoundPersistenceTarget_ACU>();

    for (const item of roundItems) {
        const targetMessageIndex = Number(item?.saveTargetIndex);
        if (!Number.isFinite(targetMessageIndex) || targetMessageIndex < 0) continue;

        const groupSheetKeys = Array.isArray(item?.group?.sheetKeys) ? item.group.sheetKeys : [];
        const changedSheetKeys = groupSheetKeys.filter((sheetKey: any): sheetKey is string =>
            typeof sheetKey === 'string' && modifiedKeySet.has(sheetKey),
        );
        if (changedSheetKeys.length === 0) continue;

        const existing = targetsByIndex.get(targetMessageIndex) || {
            targetMessageIndex,
            targetSheetKeys: [],
            updateGroupKeys: [],
            trackingSheetKeys: [],
        };
        existing.targetSheetKeys = unionStrings_ACU(existing.targetSheetKeys, changedSheetKeys);
        existing.updateGroupKeys = unionStrings_ACU(existing.updateGroupKeys, changedSheetKeys);
        existing.trackingSheetKeys = unionStrings_ACU(existing.trackingSheetKeys, changedSheetKeys);
        targetsByIndex.set(targetMessageIndex, existing);
    }

    return Array.from(targetsByIndex.values()).sort((a, b) => a.targetMessageIndex - b.targetMessageIndex);
}

function compareDeferredCommitOrder_ACU(a: DeferredCommitPayload_ACU, b: DeferredCommitPayload_ACU): number {
    return (Number.isFinite(a.groupOrder) ? Number(a.groupOrder) : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(b.groupOrder) ? Number(b.groupOrder) : Number.MAX_SAFE_INTEGER)
        || (Number.isFinite(a.batchNumber) ? Number(a.batchNumber) : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(b.batchNumber) ? Number(b.batchNumber) : Number.MAX_SAFE_INTEGER)
        || (Number.isFinite(a.chunkOrder) ? Number(a.chunkOrder) : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(b.chunkOrder) ? Number(b.chunkOrder) : Number.MAX_SAFE_INTEGER)
        || String(a.preparedCallId || '').localeCompare(String(b.preparedCallId || ''));
}

// @deprecated 新架构不再使用此函数（由 applyMergedEdits_ACU + persistTablesToChatMessage_ACU 替代）
export async function commitMergedDeferredCommits_ACU(
    commits: DeferredCommitPayload_ACU[],
): Promise<{ success: boolean; error?: string }> {
    if (!Array.isArray(commits) || commits.length === 0) {
        logDebug_ACU('[Manual Two-Phase] No deferred commits to persist; skipping merged commit.');
        return { success: true };
    }

    const commitsByTarget = new Map<number, DeferredCommitPayload_ACU[]>();
    commits.forEach(commit => {
        const bucket = commitsByTarget.get(commit.targetMessageIndex) || [];
        bucket.push(commit);
        commitsByTarget.set(commit.targetMessageIndex, bucket);
    });

    const sortedTargets = Array.from(commitsByTarget.keys()).sort((a, b) => a - b);
    for (const targetMessageIndex of sortedTargets) {
        const targetCommits = (commitsByTarget.get(targetMessageIndex) || [])
            .slice()
            .sort(compareDeferredCommitOrder_ACU);
        if (targetCommits.length === 0) continue;

        const firstCommit = targetCommits[0];
        const lastCommit = targetCommits[targetCommits.length - 1];
        const beforeData = cloneTableDataForDelta_ACU(firstCommit.beforeData);
        const afterData = cloneTableDataForDelta_ACU(lastCommit.afterData);
        if (!beforeData || !afterData) {
            return { success: false, error: `无法捕获目标楼层 ${targetMessageIndex} 的合并提交快照，已中止保存以避免生成错误 delta。` };
        }

        const targetSheetKeys = unionStrings_ACU(...targetCommits.map(commit => commit.targetSheetKeys));
        const trackingSheetKeys = unionStrings_ACU(...targetCommits.map(commit => commit.trackingSheetKeys));
        const updateGroupKeys = unionStrings_ACU(...targetCommits.map(commit => commit.updateGroupKeys || []));

        if (targetSheetKeys.length === 0 && trackingSheetKeys.length === 0) {
            logDebug_ACU(`[Manual Two-Phase] No changed sheets for target ${targetMessageIndex}; skipping merged commit.`);
            continue;
        }

        await replaceRuntimeTableDataForDeferredApply_ACU(afterData, `[Manual Two-Phase][Commit ${targetMessageIndex}]`);
        const saveResult = await persistTablesToChatMessage_ACU({
            targetMessageIndex,
            targetSheetKeys,
            updateGroupKeys,
            trackingSheetKeys,
            trackAsUpdate: true,
            beforeData,
            afterData,
        });
        if (!saveResult.saved) {
            return { success: false, error: `无法将目标楼层 ${targetMessageIndex} 的合并数据库保存到聊天记录。` };
        }

        await updateReadableLorebookEntry_ACU(true);

        if (getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled === true) {
            enqueueSummaryVectorIndexFlush_ACU({
                targetMessageIndex,
                mode: 'sync',
                reason: 'table_fill_complete',
            }).catch(err => {
                logWarn_ACU('[交火模式纪要索引] 手动两阶段填表完成后防抖归档入队异常:', err);
            });
        }
    }

    return { success: true };
}

/**
 * 手动更新编排（纯业务逻辑）
 * 从 handleManualUpdate_ACU 提取。不驱动 UI，只返回结果。
 * presentation 层负责：收集 manualSelection、设置 manualExtraHint、刷新 UI、显示 toast、弹出确认框。
 *
 * @param targetKeys 手动选择的目标表格键列表
 * @param processBatch 批处理执行回调
 * @param refreshData 数据刷新回调
 * @param options 可选参数：
 *   - clearBeforeUpdate: 是否在手动填表前先清空目标楼层的表格数据（默认 false）。
 *     由 presentation 层根据用户确认框结果传入。当设为 true 时，
 *     会先计算所有 update group 的目标保存楼层，去重后逐个清空当前隔离标签的表格数据，
 *     再刷新内存状态，最后执行新的手动填表。
 */
export async function orchestrateManualUpdate_ACU(
    targetKeys: string[],
    processBatch: (indices: number[], mode: string, options: any) => Promise<BatchUpdateResult>,
    refreshData: () => Promise<void>,
    options: { clearBeforeUpdate?: boolean } = {},
    onProgress?: (event: CardUpdateProgressEvent) => void,
): Promise<ManualUpdateResult> {
    try {
        if (isAutoUpdatingCard_ACU) {
            return { success: false, error: '数据库更新正在进行中，请稍候...' };
        }

        if (!coreApisAreReady_ACU) {
            return { success: false, error: 'API未就绪。' };
        }

        const apiIsConfigured = (settings_ACU.apiMode === 'custom' && (settings_ACU.apiConfig.useMainApi || (settings_ACU.apiConfig.url && settings_ACU.apiConfig.model))) || (settings_ACU.apiMode === 'tavern' && settings_ACU.tavernProfile);
        if (!apiIsConfigured) {
            return { success: false, error: 'API未配置，无法更新数据库。' };
        }

        await loadAllChatMessages_ACU();
        await refreshData();

        if (!currentJsonTableData_ACU) {
            return { success: false, error: '数据库未加载。' };
        }
        const liveChat = getChatArray_ACU();
        if (!liveChat || liveChat.length === 0) {
            return { success: false, error: '聊天记录为空，无法更新。' };
        }

        const allAiMessageIndices = liveChat
            .map((msg: any, index: number) => !msg.is_user ? index : -1)
            .filter((index: number) => index !== -1);

        if (allAiMessageIndices.length === 0) {
            return { success: false, error: '尚未检测到AI回复，无法执行手动更新。' };
        }

        if (!targetKeys.length) {
            return { success: false, error: '未选择需要更新的表格。' };
        }

        const uiThreshold = settings_ACU.autoUpdateThreshold || 3;
        const uiBatchSize = settings_ACU.updateBatchSize || 3;
        const uiSkip = settings_ACU.skipUpdateFloors || 0;

        const effectiveAiIndices = uiSkip > 0 ? allAiMessageIndices.slice(0, -uiSkip) : allAiMessageIndices.slice();
        const contextScopeIndices = uiThreshold > 0 ? effectiveAiIndices.slice(-uiThreshold) : effectiveAiIndices;

        if (!contextScopeIndices.length) {
            return { success: false, error: '未找到可用的上下文进行手动更新，请检查阈值或跳过楼层设置。' };
        }

        const templateData = parseTableTemplateJson_ACU({ stripSeedRows: true }) || {};
        const updateGroups: Record<string, any> = {};
        targetKeys.forEach((sheetKey: string) => {
            const tableConfig = templateData?.[sheetKey]?.updateConfig || {};
            const tableGroupId = Number.isFinite(tableConfig?.groupId)
                ? Math.trunc(tableConfig.groupId)
                : -1;
            // 手动更新只尊重分组 ID。updateFrequency/contextDepth/skipFloors 属于自动更新调度参数，
            // 混入手动路径会让用户选择被模板参数悄悄改写，属于职责污染。
            const groupKey = `${tableGroupId}|${contextScopeIndices.join(',')}|${uiBatchSize}`;
            if (!updateGroups[groupKey]) {
                updateGroups[groupKey] = {
                    indices: contextScopeIndices,
                    batchSize: uiBatchSize,
                    groupId: tableGroupId,
                    sheetKeys: []
                };
            }
            updateGroups[groupKey].sheetKeys.push(sheetKey);
        });
        const groupKeys = Object.keys(updateGroups);

        // ── 手动填表前预清空目标楼层的表格数据 ──
        // 当 clearBeforeUpdate 为 true 时（用户已在 presentation 层确认），
        // 先计算每个 update group 的最终保存楼层（每批最后一条 AI 消息的物理索引），
        // 去重后逐个清空当前隔离标签下的表格数据，再刷新内存状态。
        // 这样可以防止 SQL 严格填表逻辑因目标楼层上的旧数据残留导致写入失败。
        if (options.clearBeforeUpdate) {
            const targetFloorSet = new Set<number>();
            const targetSheetKeySet = new Set<string>();
            for (const gKey of groupKeys) {
                const group = updateGroups[gKey];
                (group.sheetKeys || []).forEach((sheetKey: string) => targetSheetKeySet.add(sheetKey));
                // 每个 group 的 indices 按 batchSize 分批，每批的最后一条就是该批的 finalSaveTargetIndex。
                // 这里简化处理：取该 group 的 indices 列表中最后一个 index 作为最终保存目标。
                // （同一个 group 内所有 batch 的 contextScopeIndices 是相同的，
                //   processUpdatesBatch 会按 batchSize 切分后取每批最后一个作为保存目标，
                //   但对于"清空目标楼层"来说，只需要清空 indices 中涉及的最后几个楼层即可。
                //   考虑到 batch 切分逻辑较复杂，这里保守地清空所有 contextScopeIndices 涉及的楼层。）
                if (group.indices && group.indices.length > 0) {
                    // 取该 group 上下文范围内的最后 batchSize 个楼层作为清空目标
                    // 因为 processUpdatesBatch 会把 indices 按 batchSize 切分，
                    // 每批保存到该批最后一条消息。所以只需要清空 indices 列表中的楼层。
                    group.indices.forEach((idx: number) => targetFloorSet.add(idx));
                }
            }

            const targetFloors = Array.from(targetFloorSet);
            const targetSheetKeysForClear = Array.from(targetSheetKeySet);
            if (targetFloors.length > 0) {
                logDebug_ACU(`[Manual Update] 预清空目标楼层: ${targetFloors.join(', ')} (共 ${targetFloors.length} 层)`);
                const clearedCount = await clearTableDataAtFloors_ACU(targetFloors, targetSheetKeysForClear);
                logDebug_ACU(`[Manual Update] 预清空完成: ${clearedCount} 层已清空`);

                // 清空后必须刷新内存数据，确保后续填表基于干净状态
                await loadAllChatMessages_ACU();

                // [关键] 重建 Storage Provider（尤其是 SQLite 模式）
                // 只清空聊天消息字段是不够的——SQLite 引擎在内存中持有独立的数据库实例，
                // 必须先 dispose 旧引擎、创建新引擎、从已清空的聊天消息重新 loadFromChat，
                // 否则后续 applyEdits 仍会在旧内存数据库上执行 SQL，
                // 导致 UNIQUE constraint 等冲突。
                try {
                    await reloadStorageProvider();
                } catch (reloadError: any) {
                    logWarn_ACU(`[Manual Update] reloadStorageProvider 失败: ${reloadError?.message}，继续使用当前 provider`);
                }

                await refreshData();
            }
        }

        _set_isAutoUpdatingCard_ACU(true);
        const failedGroups: Array<{ key: string; error?: string }> = [];


        // ═══ Round 串行填表模型 ═══
        // 每个 round 基于上一轮 apply+persist+refresh 后的快照准备 prompt。
        // round 内多个 group 的 AI 请求可并发生成，但 round 间严格串行。
        const rounds = buildFillRoundsFromUpdateGroups_ACU(updateGroups, groupKeys);
        const totalRounds = rounds.length;
        const maxApplyRetries = settings_ACU.tableMaxRetries || 3;
        const SQL_RETRY_MARKER = '\n\n<!-- SQL_ERROR_FEEDBACK -->\n';

        for (let roundIndex = 0; roundIndex < rounds.length; roundIndex++) {
            const roundItems = rounds[roundIndex];
            const roundNumber = roundIndex + 1;

            if (wasStoppedByUser_ACU) {
                failedGroups.push({ key: roundItems[0].groupKey, error: '手动更新已终止。' });
                break;
            }

            onProgress?.({
                phase: 'preparing',
                currentBatch: roundNumber,
                totalBatches: totalRounds,
                message: `正在准备第 ${roundNumber}/${totalRounds} 批手动填表（${roundItems.length} 组）...`,
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
            const preparedCalls: PreparedAiCall_ACU[] = [];
            for (const item of roundItems) {
                const group = item.group;
                const primarySheetKey = Array.isArray(group.sheetKeys) && group.sheetKeys.length > 0 ? group.sheetKeys[0] : '';
                const primaryTableName = primarySheetKey ? templateData?.[primarySheetKey]?.name : '';
                const tableApiPreset = resolveTableApiPresetOverride_ACU(primaryTableName);
                const requestOptions = tableApiPreset ? { tableApiPreset } : null;

                const prepareResult = await processBatch(item.batchIndices, 'manual_independent', {
                    targetSheetKeys: group.sheetKeys,
                    batchSize: item.batchIndices.length, // 强制单子批次，避免 processUpdatesBatch_ACU 再拆分
                    requestOptions,
                    groupKey: item.groupKey,
                    groupOrder: item.groupOrder,
                    prepareAiCallOnly: true,
                    deferApply: true,
                    deferPersistence: true,
                });

                if (!prepareResult.success) {
                    failedGroups.push({
                        key: item.groupKey,
                        error: prepareResult.error || '手动更新分组准备 AI 请求失败。',
                    });
                    break;
                }
                preparedCalls.push(...(prepareResult.preparedAiCalls || []));
            }

            if (failedGroups.length > 0) {
                await loadAllChatMessages_ACU();
                await refreshData();
                break;
            }

            // ═══ Round 内：SQL 错误注入重试循环（作用域限定在本 round） ═══
            let lastApplyError: string | null = null;
            let applyResult: { success: boolean; beforeData: TableDataObject_ACU | null; afterData: TableDataObject_ACU | null; modifiedKeys: string[]; error?: string } | null = null;

            for (let retryAttempt = 0; retryAttempt < maxApplyRetries; retryAttempt++) {
                if (wasStoppedByUser_ACU) {
                    failedGroups.push({ key: roundItems[0].groupKey, error: '手动更新已终止。' });
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

                // AI 生成（round 内组间并发，重试时带 SQL 错误注入）
                const withRoundProgress = (event: CardUpdateProgressEvent) => onProgress?.({
                    ...event,
                    currentBatch: event.currentBatch ?? roundNumber,
                    totalBatches: event.totalBatches ?? totalRounds,
                });
                const generationResult = await generateDeferredResponsesForPreparedCalls_ACU(preparedCalls, withRoundProgress);
                if (!generationResult.success) {
                    failedGroups.push({
                        key: roundItems[0].groupKey,
                        error: generationResult.error || '手动更新分组 AI 生成失败。',
                    });
                    break;
                }

                // 提取并合并编辑内容
                const allEditBlocks: string[] = [];
                for (const resp of generationResult.responses) {
                    const edits = extractEditsFromAiResponse_ACU(resp.aiResponse);
                    if (edits) allEditBlocks.push(edits);
                }
                if (allEditBlocks.length === 0) {
                    failedGroups.push({ key: roundItems[0].groupKey, error: '所有 AI 响应均未包含有效编辑内容。' });
                    break;
                }
                const mergedEdits = mergeAiEditContents_ACU(allEditBlocks);

                // 执行合并后的编辑
                const retryLabel = retryAttempt > 0 ? `（第 ${retryAttempt + 1} 次尝试）` : '';
                onProgress?.({ phase: 'parsing', currentBatch: roundNumber, totalBatches: totalRounds, message: `正在应用合并后的编辑...${retryLabel}` });
                applyResult = await applyMergedEdits_ACU(mergedEdits, 'standard', roundSheetKeys);

                if (applyResult.success) {
                    break; // 成功，跳出重试循环
                }

                // 应用失败
                lastApplyError = applyResult.error || '应用合并编辑失败';

                // 非 SQL 模式或最后一次重试：直接记录失败
                if (!isSqliteMode() || retryAttempt >= maxApplyRetries - 1) {
                    failedGroups.push({ key: roundItems[0].groupKey, error: lastApplyError });
                    logWarn_ACU(`[Manual] Round ${roundNumber} 合并编辑在 ${retryAttempt + 1} 次尝试后仍失败: ${lastApplyError}`);
                    break;
                }

                // SQL 模式 + 仍有重试次数：注入错误信息，等待后重试
                logWarn_ACU(`[Manual] Round ${roundNumber} 合并编辑第 ${retryAttempt + 1} 次尝试失败: ${lastApplyError}，将注入错误信息并重新生成`);
                onProgress?.({
                    phase: 'retry',
                    attempt: retryAttempt + 1,
                    maxRetries: maxApplyRetries,
                    currentBatch: roundNumber,
                    totalBatches: totalRounds,
                    message: lastApplyError.substring(0, 50),
                });

                // 重试前刷新数据确保干净状态
                try {
                    await loadAllChatMessages_ACU();
                    await refreshData();
                } catch (refreshErr: any) {
                    logWarn_ACU(`[Manual] 重试前数据刷新失败: ${refreshErr?.message}`);
                }

                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            // 重试循环结束后安全检查
            if (!applyResult || !applyResult.success) {
                if (failedGroups.length === 0) {
                    failedGroups.push({ key: roundItems[0].groupKey, error: applyResult?.error || '应用合并编辑失败。' });
                }
                await loadAllChatMessages_ACU();
                await refreshData();
                break;
            }

            // ═══ Round 内：按 group 对应楼层分桶持久化 ═══
            const persistenceTargets = buildRoundPersistenceTargets_ACU(roundItems, applyResult.modifiedKeys);

            if (failedGroups.length === 0) {
                onProgress?.({ phase: 'saving', currentBatch: roundNumber, totalBatches: totalRounds, message: '正在保存合并后的更新到聊天记录...' });

                if (persistenceTargets.length === 0) {
                    failedGroups.push({ key: roundItems[0].groupKey, error: '合并编辑成功但没有可持久化的目标楼层。' });
                }

                const savedTargetIndices: number[] = [];
                for (const target of persistenceTargets) {
                    const saveResult = await persistTablesToChatMessage_ACU({
                        targetMessageIndex: target.targetMessageIndex,
                        targetSheetKeys: target.targetSheetKeys,
                        updateGroupKeys: target.updateGroupKeys,
                        trackingSheetKeys: target.trackingSheetKeys,
                        trackAsUpdate: true,
                        beforeData: applyResult.beforeData,
                        afterData: applyResult.afterData,
                    });
                    if (!saveResult.saved) {
                        failedGroups.push({ key: roundItems[0].groupKey, error: `无法将目标楼层 ${target.targetMessageIndex} 的更新后数据库保存到聊天记录。` });
                        break;
                    }
                    savedTargetIndices.push(target.targetMessageIndex);
                }

                if (failedGroups.length === 0) {
                    // 首次初始化补全（仅第一个 round）
                    if (roundIndex === 0) {
                        const isFirstTimeInit = await checkIfFirstTimeInit_ACU();
                        if (isFirstTimeInit) {
                            const fullTemplate = parseTableTemplateJson_ACU({ stripSeedRows: false });
                            if (fullTemplate) {
                                for (const sheetKey of roundSheetKeys) {
                                    if (!applyResult.modifiedKeys.includes(sheetKey) && fullTemplate[sheetKey]) {
                                        (currentJsonTableData_ACU as any)[sheetKey] = JSON.parse(JSON.stringify(fullTemplate[sheetKey]));
                                        logDebug_ACU(`[Init] Table ${sheetKey} not modified by AI, using template data.`);
                                    }
                                }
                            }
                        }
                    }

                    // 填表完成后强制应用编码索引列特殊锁定（AM序列）
                    applySpecialIndexSequenceToSummaryTables_ACU(currentJsonTableData_ACU);

                    // 向量索引防抖归档（交火模式）
                    if (getCurrentWorldbookConfig_ACU().summaryVectorIndexModeEnabled === true) {
                        for (const targetMessageIndex of savedTargetIndices) {
                            enqueueSummaryVectorIndexFlush_ACU({
                                targetMessageIndex,
                                mode: 'sync',
                                reason: 'table_fill_complete',
                            }).then(result => {
                                if (result.skipped) {
                                    logWarn_ACU(`[交火模式纪要索引] 填表完成后防抖归档被跳过：${result.reason || 'unknown'}`);
                                }
                            }).catch(err => {
                                logWarn_ACU('[交火模式纪要索引] 填表完成后防抖归档入队异常:', err);
                            });
                        }
                    }
                }
            }

            // Round 完成后刷新数据，下一 round 基于新快照
            await loadAllChatMessages_ACU();
            await refreshData();

            if (failedGroups.length > 0) {
                break;
            }
        }


        _set_isAutoUpdatingCard_ACU(false);

        if (failedGroups.length > 0) {
            // [修复] 填表失败时，processUpdatesBatch 内部的 loadBatchBaseData 已经用聊天记录中的旧数据
            // 覆盖了 currentJsonTableData_ACU（包括旧表头）。必须调用 refreshData 恢复到正确状态，
            // 否则用户重新打开可视化编辑器时会看到旧表头（指导表中的新表头不会被应用）。
            try {
                await loadAllChatMessages_ACU();
                await refreshData();
            } catch (e) {
                logWarn_ACU('[Manual Update] 填表失败后恢复数据时出错:', e);
            }
            const firstFailure = failedGroups[0];
            return { success: false, error: firstFailure.error || '手动更新失败或被终止。' };
        }

        // 手动更新完成后检测自动合并总结
        let autoMergeTriggered = false;
        let autoMergeSuccess = false;
        try {
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

        return { success: true, autoMergeTriggered, autoMergeSuccess };
    } finally {
        _set_manualExtraHint_ACU('');
        _set_isAutoUpdatingCard_ACU(false);
    }
}
