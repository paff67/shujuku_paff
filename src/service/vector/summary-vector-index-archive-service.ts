import {
    cloneIsolatedData_ACU,
    readIsolatedTagData_ACU,
    writeIsolatedTagData_ACU,
    writeMessageIdentity_ACU,
    writeLegacyCompatData_ACU,
} from '../../data/repositories/chat-message-data-repo';
import type {
    ChatSummaryVectorIndexChunk_ACU,
    ChatSummaryVectorIndexRow_ACU,
    ChatSummaryVectorIndexState_ACU,
} from '../../data/models/chat-message-data';
import { createEmbeddings_ACU } from '../../data/gateways/vector-embedding-gateway';
import type { VectorEmbeddingResult_ACU } from '../../data/gateways/vector-embedding-gateway';
import { saveChatToHost_ACU } from '../../data/gateways/chat-gateway';
import { currentChatFileIdentifier_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU, settings_ACU } from '../runtime/state-manager';
import { getChatArray_ACU } from '../chat/chat-service';
import { getLatestAiMessageIndexFromChat_ACU } from '../table/table-history';
import {
    persistRemoteMemorySnapshotAnchorIfNeeded_ACU,
    resolveRemoteMemorySnapshotAnchor_ACU,
} from './remote-memory-snapshot-anchor';
import {
    getEffectiveSummaryVectorIndexConfig_ACU,
    validateSummaryVectorIndexConfig_ACU,
} from './vector-memory-config';
import {
    assignSummaryVectorIndexStateToTagData_ACU,
    getAggregatedSummaryVectorIndexSnapshot_ACU,
} from './summary-vector-index-state-service';
import {
    deleteSummaryVectorIndexExternal_ACU,
    isLegacySummaryVectorIndexManifest_ACU,
    loadSummaryVectorIndexChunksFromManifest_ACU,
    normalizeSummaryVectorIndexManifestForRead_ACU,
    persistSummaryVectorIndexSnapshot_ACU,
} from './summary-vector-index-storage-service';
import { hashUserInput_ACU, isSummaryOrOutlineTable_ACU, logDebug_ACU, logWarn_ACU } from '../../shared/utils';

type SummaryVectorIndexArchiveMode_ACU = 'append' | 'sync';

type SummaryVectorIndexArchiveOptions_ACU = {
    targetMessageIndex?: number;
    mode?: SummaryVectorIndexArchiveMode_ACU;
    saveChatAfterWrite?: boolean;
    /** 为 true 时跳过 "无变更" 检测，强制执行归档写入（含外置文件上传） */
    force?: boolean;
    /**
     * 为 true 时只执行向量化阶段（embedding），不立即写入外置文件。
     * 向量化结果存入 pending state，由防抖定时器触发归档。
     * 这实现了"纪要表变动→增量向量化→向量数据变动→防抖→本地归档"的正确触发链。
     */
    vectorizeOnly?: boolean;
};

export interface SummaryVectorIndexArchiveResult_ACU {
    success: boolean;
    skipped: boolean;
    indexedRowCount: number;
    skippedRowCount: number;
    chunkCount: number;
    messageIndex?: number;
    summaryKey?: string;
    reason?: string;
    errors: string[];
}

interface SummaryTableSelection_ACU {
    summaryKey: string;
    table: any;
}

interface SummaryVectorArchivePreparedRow_ACU {
    rowKey: string;
    rowId: string;
    rowOrder: number;
    timeSpan: string;
    location: string;
    summary: string;
    indexCode: string;
    vectorSourceText: string;
    sourceFingerprint: string;
}

const summaryVectorIndexArchiveLocks_ACU = new Map<string, Promise<void>>();
const summaryVectorIndexArchivePendingTasks_ACU = new Map<string, Promise<any>>();

function cloneJson_ACU<T>(value: T): T {
    if (value == null) return value;
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return value;
    }
}

export function cloneIsolationTagDataForSummaryVectorWrite_ACU(existingTagData: any): any {
    const cloned = cloneJson_ACU(existingTagData && typeof existingTagData === 'object' ? existingTagData : {} as any) || {};
    return {
        ...cloned,
        independentData: cloned.independentData && typeof cloned.independentData === 'object' ? cloned.independentData : {},
        modifiedKeys: Array.isArray(cloned.modifiedKeys) ? [...cloned.modifiedKeys] : [],
        updateGroupKeys: Array.isArray(cloned.updateGroupKeys) ? [...cloned.updateGroupKeys] : [],
    };
}

// ============================================================
// 向量化→防抖归档 pipeline（参考 Engram 数据层 hook 触发模式）
// 向量化阶段立即执行，归档阶段由向量数据变更触发防抖
// ============================================================

const VECTOR_INDEX_PERSIST_DEBOUNCE_MS_ACU = 2500;

interface SummaryVectorIndexPendingArchive_ACU {
    chat: any[];
    aggregatedSnapshot: ReturnType<typeof getAggregatedSummaryVectorIndexSnapshot_ACU>;
    embeddingModel: string;
    preparedRows: SummaryVectorArchivePreparedRow_ACU[];
    finalRows: ChatSummaryVectorIndexRow_ACU[];
    finalChunks: ChatSummaryVectorIndexChunk_ACU[];
    targetMessageIndex: number;
    snapshotMessageId: string;
    sourceTableKey: string;
    sourceTableName: string;
    indexedAt: string;
    skippedRowCount: number;
    mode: SummaryVectorIndexArchiveMode_ACU;
}

const pendingVectorIndexArchives_ACU = new Map<string, SummaryVectorIndexPendingArchive_ACU>();
const vectorIndexPersistTimers_ACU = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleDebouncedVectorIndexPersist_ACU(scopeKey: string): void {
    const existing = vectorIndexPersistTimers_ACU.get(scopeKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        vectorIndexPersistTimers_ACU.delete(scopeKey);
        void persistPendingVectorIndexArchive_ACU(scopeKey);
    }, VECTOR_INDEX_PERSIST_DEBOUNCE_MS_ACU);
    vectorIndexPersistTimers_ACU.set(scopeKey, timer);
    logDebug_ACU(`[纪要向量索引] 防抖归档已调度：scope=${scopeKey}, debounceMs=${VECTOR_INDEX_PERSIST_DEBOUNCE_MS_ACU}`);
}

async function persistPendingVectorIndexArchive_ACU(scopeKey: string): Promise<void> {
    const pending = pendingVectorIndexArchives_ACU.get(scopeKey);
    if (!pending) {
        logDebug_ACU(`[纪要向量索引] 防抖归档触发但无 pending 数据：scope=${scopeKey}`);
        return;
    }
    pendingVectorIndexArchives_ACU.delete(scopeKey);
    try {
        logDebug_ACU(`[纪要向量索引] 防抖归档开始：scope=${scopeKey}, rows=${pending.finalRows.length}, chunks=${pending.finalChunks.length}`);
        await writeSummaryVectorIndexCheckpoint_ACU({
            chat: pending.chat,
            aggregatedSnapshot: pending.aggregatedSnapshot,
            embeddingModel: pending.embeddingModel,
            preparedRows: pending.preparedRows,
            finalRows: pending.finalRows,
            finalChunks: pending.finalChunks,
            targetMessageIndex: pending.targetMessageIndex,
            snapshotMessageId: pending.snapshotMessageId,
            sourceTableKey: pending.sourceTableKey,
            sourceTableName: pending.sourceTableName,
            indexedAt: pending.indexedAt,
            skippedRowCount: pending.skippedRowCount,
            mode: pending.mode,
            saveChatAfterWrite: true,
        });
        logDebug_ACU(`[纪要向量索引] 防抖归档完成：scope=${scopeKey}, rows=${pending.finalRows.length}, chunks=${pending.finalChunks.length}`);
    } catch (error) {
        logWarn_ACU('[纪要向量索引] 防抖归档失败:', error);
    }
}

export function flushPendingVectorIndexArchives_ACU(): void {
    for (const [scopeKey] of pendingVectorIndexArchives_ACU) {
        const timer = vectorIndexPersistTimers_ACU.get(scopeKey);
        if (timer) clearTimeout(timer);
        vectorIndexPersistTimers_ACU.delete(scopeKey);
        void persistPendingVectorIndexArchive_ACU(scopeKey);
    }
}

function buildSummaryVectorIndexArchiveScopeKey_ACU(parts: {
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
}): string {
    return [
        String(parts.chatKey || 'current-chat'),
        String(parts.isolationKey || 'default'),
        String(parts.sourceTableKey || 'summary'),
    ].join('::');
}

async function runSummaryVectorIndexArchiveWithScopeLock_ACU<T>(
    scopeKey: string,
    task: () => Promise<T>,
): Promise<T> {
    const active = summaryVectorIndexArchiveLocks_ACU.get(scopeKey);
    if (active) {
        const existingPending = summaryVectorIndexArchivePendingTasks_ACU.get(scopeKey) as Promise<T> | undefined;
        if (existingPending) {
            logDebug_ACU(`[纪要向量索引] 同一 scope 已有归档任务和合并补跑任务，复用 pending：${scopeKey}`);
            return existingPending;
        }

        const pending = (async (): Promise<T> => {
            logDebug_ACU(`[纪要向量索引] 同一 scope 已有归档任务运行，合并后续请求为一次补跑：${scopeKey}`);
            await active.catch((error) => {
                logWarn_ACU('[纪要向量索引] 前序归档任务失败，继续执行合并补跑任务:', error);
            });
            logDebug_ACU(`[纪要向量索引] scope 合并补跑开始，重新读取最新状态后执行：${scopeKey}`);
            return await runSummaryVectorIndexArchiveWithScopeLock_ACU(scopeKey, task);
        })();
        summaryVectorIndexArchivePendingTasks_ACU.set(scopeKey, pending);
        void pending.then(
            () => {
                if (summaryVectorIndexArchivePendingTasks_ACU.get(scopeKey) === pending) {
                    summaryVectorIndexArchivePendingTasks_ACU.delete(scopeKey);
                }
            },
            () => {
                if (summaryVectorIndexArchivePendingTasks_ACU.get(scopeKey) === pending) {
                    summaryVectorIndexArchivePendingTasks_ACU.delete(scopeKey);
                }
            },
        );
        return pending;
    }

    let releaseLock!: () => void;
    const current = new Promise<void>((resolve) => {
        releaseLock = resolve;
    });
    summaryVectorIndexArchiveLocks_ACU.set(scopeKey, current);
    try {
        return await task();
    } finally {
        releaseLock();
        if (summaryVectorIndexArchiveLocks_ACU.get(scopeKey) === current) {
            summaryVectorIndexArchiveLocks_ACU.delete(scopeKey);
        }
    }
}

function buildResult_ACU(partial: Partial<SummaryVectorIndexArchiveResult_ACU> = {}): SummaryVectorIndexArchiveResult_ACU {
    return {
        success: false,
        skipped: false,
        indexedRowCount: 0,
        skippedRowCount: 0,
        chunkCount: 0,
        errors: [],
        ...partial,
    };
}

function normalizeText_ACU(value: any): string {
    return String(value ?? '').trim();
}

function resolveColumnIndexByAliases_ACU(headerRow: any[], aliases: string[], fallbackIndex = -1): number {
    const normalizedAliases = aliases.map((item) => normalizeText_ACU(item).replace(/\s+/g, ''));
    const index = (Array.isArray(headerRow) ? headerRow : []).findIndex((header) => normalizedAliases.includes(normalizeText_ACU(header).replace(/\s+/g, '')));
    return index >= 0 ? index : fallbackIndex;
}

function buildStableSummaryRowKey_ACU(summaryKey: string, rowId: string, indexCode: string): string {
    const source = `${summaryKey}:${rowId}:${indexCode}`;
    return `summary-row:${hashUserInput_ACU(source)}`;
}

function buildPreparedRowFingerprint_ACU(row: SummaryVectorArchivePreparedRow_ACU): string {
    return hashUserInput_ACU([
        row.rowId,
        row.timeSpan,
        row.location,
        row.summary,
        row.indexCode,
        row.vectorSourceText,
    ].join('\n'));
}

export function findSummaryTable_ACU(): SummaryTableSelection_ACU | null {
    if (!currentJsonTableData_ACU || typeof currentJsonTableData_ACU !== 'object') {
        return null;
    }

    const summaryKey = Object.keys(currentJsonTableData_ACU).find((key) => {
        const table = currentJsonTableData_ACU[key];
        return !!table?.name && isSummaryOrOutlineTable_ACU(String(table.name || ''));
    });

    if (!summaryKey) return null;
    const table = currentJsonTableData_ACU[summaryKey];
    if (!table || !Array.isArray(table.content)) return null;

    return {
        summaryKey,
        table,
    };
}

function splitSentences_ACU(text: string): string[] {
    const normalized = normalizeText_ACU(text);
    if (!normalized) return [];
    const matches = normalized.match(/[^。！？!?；;\n]+[。！？!?；;]?/g);
    const sentences = Array.isArray(matches)
        ? matches.map((item) => normalizeText_ACU(item)).filter(Boolean)
        : [normalized];
    return sentences.length > 0 ? sentences : [normalized];
}

function chunkTextBySentenceCount_ACU(text: string, sentenceCount: number): string[] {
    const sentences = splitSentences_ACU(text);
    const normalizedSentenceCount = Math.max(1, Math.floor(Number(sentenceCount) || 2));
    const chunks: string[] = [];
    for (let index = 0; index < sentences.length; index += normalizedSentenceCount) {
        const chunkText = normalizeText_ACU(sentences.slice(index, index + normalizedSentenceCount).join(''));
        if (chunkText) chunks.push(chunkText);
    }
    return chunks;
}

function buildPreparedRows_ACU(table: any, summaryKey: string): {
    rows: SummaryVectorArchivePreparedRow_ACU[];
    skippedRowCount: number;
    error: string;
} {
    const content = Array.isArray(table?.content) ? table.content : [];
    const headerRow = Array.isArray(content[0]) ? content[0] : [];
    const timeSpanColIdx = resolveColumnIndexByAliases_ACU(headerRow, ['时间跨度', '时间', '阶段', '时段'], 0);
    const locationColIdx = resolveColumnIndexByAliases_ACU(headerRow, ['地点', '位置', '场景', '场所'], 1);
    const summaryColIdx = resolveColumnIndexByAliases_ACU(headerRow, ['概要', '概览', '概述', '摘要']);
    const indexColIdx = resolveColumnIndexByAliases_ACU(headerRow, ['编码索引']);
    if (summaryColIdx < 0) {
        return { rows: [], skippedRowCount: 0, error: '纪要表缺少概要列，无法构建纪要向量索引。' };
    }
    if (indexColIdx < 0) {
        return { rows: [], skippedRowCount: 0, error: '纪要表缺少编码索引列，无法构建纪要向量索引。' };
    }

    const dataRows = content.slice(1).filter((row: any) => Array.isArray(row));
    const preparedRows: SummaryVectorArchivePreparedRow_ACU[] = [];
    let skippedRowCount = 0;
    dataRows.forEach((row: any[], rowIndex: number) => {
        const rowId = normalizeText_ACU(row?.[0]) || String(rowIndex + 1);
        const timeSpan = timeSpanColIdx >= 0 ? normalizeText_ACU(row?.[timeSpanColIdx]) : '';
        const location = locationColIdx >= 0 ? normalizeText_ACU(row?.[locationColIdx]) : '';
        const summary = normalizeText_ACU(row?.[summaryColIdx]);
        const indexCode = normalizeText_ACU(row?.[indexColIdx]);
        const vectorSourceText = summary;
        if (!summary || !indexCode || !vectorSourceText) {
            skippedRowCount += 1;
            return;
        }
        const preparedRow: SummaryVectorArchivePreparedRow_ACU = {
            rowKey: buildStableSummaryRowKey_ACU(summaryKey, rowId, indexCode),
            rowId,
            rowOrder: rowIndex,
            timeSpan,
            location,
            summary,
            indexCode,
            vectorSourceText,
            sourceFingerprint: '',
        };
        preparedRow.sourceFingerprint = buildPreparedRowFingerprint_ACU(preparedRow);
        preparedRows.push(preparedRow);
    });

    return { rows: preparedRows, skippedRowCount, error: '' };
}

function resolveTargetMessageIndex_ACU(preferredIndex?: number): number {
    const chat = getChatArray_ACU();
    if (!Array.isArray(chat) || chat.length === 0) {
        return -1;
    }

    const normalizedPreferredIndex = Math.floor(Number(preferredIndex));
    if (Number.isFinite(normalizedPreferredIndex)) {
        const preferredMessage = chat[normalizedPreferredIndex];
        if (preferredMessage && !preferredMessage.is_user) {
            return normalizedPreferredIndex;
        }
        logWarn_ACU('[纪要向量索引] 指定归档目标楼层无效，回退到最新 AI 楼层:', preferredIndex);
    }

    return getLatestAiMessageIndexFromChat_ACU(chat);
}

function cloneSummaryVectorIndexState_ACU(state: ChatSummaryVectorIndexState_ACU | null | undefined): ChatSummaryVectorIndexState_ACU | null {
    if (!state) return null;
    try {
        return JSON.parse(JSON.stringify(state));
    } catch (_error) {
        return null;
    }
}

function getSummaryRowFingerprintFromStateRow_ACU(row: ChatSummaryVectorIndexRow_ACU): string {
    return hashUserInput_ACU([
        row.rowId,
        row.timeSpan,
        row.location,
        row.summary,
        row.indexCode,
        row.vectorSourceText,
    ].join('\n'));
}

function buildLayerStateWithRows_ACU(
    baseState: ChatSummaryVectorIndexState_ACU | null | undefined,
    rows: ChatSummaryVectorIndexRow_ACU[],
    chunks: ChatSummaryVectorIndexChunk_ACU[],
    options: {
        snapshotMessageId: string;
        sourceTableKey: string;
        sourceTableName: string;
        indexedAt: string;
        skippedRowCount?: number;
    },
): ChatSummaryVectorIndexState_ACU | null {
    const normalizedRows = (Array.isArray(rows) ? rows : [])
        .map((row) => ({
            ...row,
            chunkIds: Array.isArray(row.chunkIds) ? row.chunkIds.filter(Boolean) : [],
        }))
        .filter((row) => row.rowKey && row.rowId && row.summary && row.indexCode && row.chunkIds.length > 0)
        .sort((left, right) => left.rowOrder - right.rowOrder || left.rowKey.localeCompare(right.rowKey));
    const validRowKeys = new Set(normalizedRows.map((row) => row.rowKey));
    const validChunkIds = new Set(normalizedRows.flatMap((row) => row.chunkIds));
    const normalizedChunks = (Array.isArray(chunks) ? chunks : [])
        .filter((chunk) => chunk?.chunkId && chunk?.rowKey && validRowKeys.has(chunk.rowKey) && validChunkIds.has(chunk.chunkId))
        .map((chunk, index) => ({ ...chunk, sequence: index }));
    if (normalizedRows.length === 0 || normalizedChunks.length === 0) {
        return null;
    }
    return {
        version: 1,
        snapshotMessageId: options.snapshotMessageId || baseState?.snapshotMessageId || '',
        sourceTableKey: options.sourceTableKey || baseState?.sourceTableKey || '',
        sourceTableName: options.sourceTableName || baseState?.sourceTableName || '纪要表',
        indexedAt: options.indexedAt || baseState?.indexedAt || new Date().toISOString(),
        rowCount: normalizedRows.length,
        chunkCount: normalizedChunks.length,
        skippedRowCount: Math.max(0, Math.floor(Number(options.skippedRowCount ?? baseState?.skippedRowCount ?? 0) || 0)),
        rows: normalizedRows,
        chunks: normalizedChunks,
    };
}

function getSummaryVectorIndexActiveRowKeys_ACU(state: ChatSummaryVectorIndexState_ACU | null | undefined): string[] {
    if (!state) return [];
    const manifestActiveRowKeys = Array.isArray(state.manifest?.snapshot?.activeRowKeys)
        ? state.manifest!.snapshot!.activeRowKeys
        : [];
    if (manifestActiveRowKeys.length > 0) {
        return Array.from(new Set(manifestActiveRowKeys.map((rowKey) => String(rowKey || '')).filter(Boolean)));
    }
    return Array.isArray(state.rows)
        ? Array.from(new Set(state.rows.filter((row) => row && row.status !== 'removed').map((row) => String(row.rowKey || '')).filter(Boolean)))
        : [];
}

function areSummaryVectorActiveRowKeysSame_ACU(
    preparedRows: SummaryVectorArchivePreparedRow_ACU[],
    existingState: ChatSummaryVectorIndexState_ACU | null,
): boolean {
    const preparedKeys = Array.from(new Set((Array.isArray(preparedRows) ? preparedRows : []).map((row) => String(row?.rowKey || '')).filter(Boolean))).sort();
    const existingKeys = getSummaryVectorIndexActiveRowKeys_ACU(existingState).sort();
    if (preparedKeys.length !== existingKeys.length) return false;
    for (let index = 0; index < preparedKeys.length; index += 1) {
        if (preparedKeys[index] !== existingKeys[index]) return false;
    }
    return true;
}

function buildExistingReusableRows_ACU(
    preparedRows: SummaryVectorArchivePreparedRow_ACU[],
    existingState: ChatSummaryVectorIndexState_ACU | null,
): { reusableRows: ChatSummaryVectorIndexRow_ACU[]; reusableChunks: ChatSummaryVectorIndexChunk_ACU[]; rowsNeedingEmbedding: SummaryVectorArchivePreparedRow_ACU[] } {
    const preparedByKey = new Map(preparedRows.map((row) => [row.rowKey, row]));
    const existingRows = Array.isArray(existingState?.rows) ? existingState!.rows : [];
    const existingChunks = Array.isArray(existingState?.chunks) ? existingState!.chunks : [];
    const existingChunksByRowKey = new Map<string, ChatSummaryVectorIndexChunk_ACU[]>();
    existingChunks.forEach((chunk) => {
        if (!chunk?.rowKey || !chunk?.chunkId || !Array.isArray(chunk.vector) || chunk.vector.length === 0) return;
        const list = existingChunksByRowKey.get(chunk.rowKey) || [];
        list.push({ ...chunk });
        existingChunksByRowKey.set(chunk.rowKey, list);
    });

    const reusableRows: ChatSummaryVectorIndexRow_ACU[] = [];
    const reusableChunks: ChatSummaryVectorIndexChunk_ACU[] = [];
    const reusableKeySet = new Set<string>();
    existingRows.forEach((existingRow) => {
        const prepared = preparedByKey.get(existingRow.rowKey);
        const chunks = existingChunksByRowKey.get(existingRow.rowKey) || [];
        const existingFingerprint = hashUserInput_ACU([
            existingRow.rowId,
            existingRow.timeSpan,
            existingRow.location,
            existingRow.summary,
            existingRow.indexCode,
            existingRow.vectorSourceText,
        ].join('\n'));
        if (!prepared || chunks.length === 0 || existingFingerprint !== prepared.sourceFingerprint) {
            return;
        }
        const chunkIds = chunks.map((chunk) => chunk.chunkId).filter(Boolean);
        if (chunkIds.length === 0) return;
        reusableRows.push({
            rowKey: prepared.rowKey,
            rowId: prepared.rowId,
            rowOrder: prepared.rowOrder,
            timeSpan: prepared.timeSpan,
            location: prepared.location,
            summary: prepared.summary,
            indexCode: prepared.indexCode,
            vectorSourceText: prepared.vectorSourceText,
            chunkIds,
        });
        chunks.forEach((chunk) => reusableChunks.push({ ...chunk }));
        reusableKeySet.add(prepared.rowKey);
    });

    const rowsNeedingEmbedding = preparedRows.filter((row) => !reusableKeySet.has(row.rowKey));
    return { reusableRows, reusableChunks, rowsNeedingEmbedding };
}

async function buildChunksWithEmbeddings_ACU(
    rows: SummaryVectorArchivePreparedRow_ACU[],
    options: {
        snapshotMessageId: string;
        sentenceCount: number;
        embeddingEndpoint: string;
        embeddingApiKey: string;
        embeddingModel: string;
        existingSequenceBase?: number;
    },
): Promise<{ rows: ChatSummaryVectorIndexRow_ACU[]; chunks: ChatSummaryVectorIndexChunk_ACU[] }> {
    const sequenceBase = Math.max(0, Math.floor(Number(options.existingSequenceBase) || 0));
    const chunkSources: Array<{ chunkId: string; rowKey: string; rowIndex: number; text: string; sequence: number }> = [];
    rows.forEach((row, rowIndex) => {
        const rowChunkTexts = chunkTextBySentenceCount_ACU(row.vectorSourceText, options.sentenceCount);
        rowChunkTexts.forEach((text, chunkIndex) => {
            chunkSources.push({
                chunkId: `${row.rowKey}:chunk:${chunkIndex}`,
                rowKey: row.rowKey,
                rowIndex,
                text,
                sequence: sequenceBase + chunkSources.length,
            });
        });
    });

    if (chunkSources.length === 0) {
        return { rows: [], chunks: [] };
    }

    const embeddings: VectorEmbeddingResult_ACU[] = await createEmbeddings_ACU({
        endpoint: options.embeddingEndpoint,
        apiKey: options.embeddingApiKey,
        model: options.embeddingModel,
        input: chunkSources.map((item) => item.text),
    });

    const embeddingMap = new Map<number, number[]>();
    embeddings.forEach((item: VectorEmbeddingResult_ACU): void => {
        if (Array.isArray(item.embedding) && item.embedding.length > 0) {
            embeddingMap.set(item.index, item.embedding);
        }
    });

    const chunks: ChatSummaryVectorIndexChunk_ACU[] = [];
    const rowChunkIds = new Map<string, string[]>();
    chunkSources.forEach((source, index) => {
        const vector = embeddingMap.get(index) || [];
        if (vector.length === 0) return;
        chunks.push({
            chunkId: source.chunkId,
            rowKey: source.rowKey,
            rowOrder: source.rowIndex,
            text: source.text,
            vector,
            sequence: source.sequence,
        });
        const ids = rowChunkIds.get(source.rowKey) || [];
        ids.push(source.chunkId);
        rowChunkIds.set(source.rowKey, ids);
    });

    const indexedRows: ChatSummaryVectorIndexRow_ACU[] = rows
        .map((row) => ({
            rowKey: row.rowKey,
            rowId: row.rowId,
            rowOrder: row.rowOrder,
            timeSpan: row.timeSpan,
            location: row.location,
            summary: row.summary,
            indexCode: row.indexCode,
            vectorSourceText: row.vectorSourceText,
            chunkIds: rowChunkIds.get(row.rowKey) || [],
        }))
        .filter((row) => row.chunkIds.length > 0);

    return { rows: indexedRows, chunks };
}

function buildFinalSummaryVectorIndexRowsAndChunks_ACU(
    rows: ChatSummaryVectorIndexRow_ACU[],
    chunks: ChatSummaryVectorIndexChunk_ACU[],
): { rows: ChatSummaryVectorIndexRow_ACU[]; chunks: ChatSummaryVectorIndexChunk_ACU[] } {
    const finalRows = (Array.isArray(rows) ? rows : [])
        .filter((row) => row?.rowKey && Array.isArray(row.chunkIds) && row.chunkIds.length > 0)
        .sort((a, b) => a.rowOrder - b.rowOrder || a.rowKey.localeCompare(b.rowKey));
    const validRowChunkPairs = new Set<string>();
    finalRows.forEach((row) => {
        row.chunkIds.forEach((chunkId) => validRowChunkPairs.add(`${row.rowKey}:${chunkId}`));
    });
    const finalChunks = (Array.isArray(chunks) ? chunks : [])
        .filter((chunk) => chunk?.rowKey && chunk?.chunkId && validRowChunkPairs.has(`${chunk.rowKey}:${chunk.chunkId}`))
        .map((chunk, index) => ({ ...chunk, sequence: index }));
    return { rows: finalRows, chunks: finalChunks };
}

async function hydrateAggregatedSummaryVectorIndexSnapshot_ACU(
    snapshot: ReturnType<typeof getAggregatedSummaryVectorIndexSnapshot_ACU>,
): Promise<ReturnType<typeof getAggregatedSummaryVectorIndexSnapshot_ACU>> {
    if (!snapshot) return snapshot;
    const hydratedLayers = [] as NonNullable<typeof snapshot>['layers'];
    const rowOwners = new Map<string, { messageIndex: number; row: ChatSummaryVectorIndexRow_ACU }>();
    const mergedRows = new Map<string, ChatSummaryVectorIndexRow_ACU>();
    const mergedChunks = new Map<string, ChatSummaryVectorIndexChunk_ACU>();
    let latestState: ChatSummaryVectorIndexState_ACU | null = null;

    for (const layer of snapshot.layers) {
        const state = cloneSummaryVectorIndexState_ACU(layer.summaryVectorIndexState);
        if (!state) continue;
        if (state.manifest && (!Array.isArray(state.chunks) || state.chunks.length === 0)) {
            try {
                const externalChunks = await loadSummaryVectorIndexChunksFromManifest_ACU(state.manifest);
                if (externalChunks.length > 0) {
                    state.chunks = externalChunks;
                }
            } catch (error) {
                logWarn_ACU('[纪要向量索引] 加载历史外置分片失败，保留该层 manifest，禁止因缺失 chunks 清理旧层:', error);
            }
        }
        hydratedLayers.push({ ...layer, summaryVectorIndexState: state });
        latestState = state;
        state.rows.forEach((row) => {
            if (row.status === 'removed') {
                mergedRows.delete(row.rowKey);
                rowOwners.delete(row.rowKey);
                return;
            }
            mergedRows.set(row.rowKey, row);
            rowOwners.set(row.rowKey, { messageIndex: layer.messageIndex, row });
        });
        (state.chunks || []).forEach((chunk) => mergedChunks.set(chunk.chunkId, chunk));
    }

    if (hydratedLayers.length === 0 || !latestState) return snapshot;
    const rows = Array.from(mergedRows.values());
    const chunks = Array.from(mergedChunks.values()).filter((chunk) => mergedRows.has(chunk.rowKey));
    return {
        summaryVectorIndexState: {
            ...latestState,
            rows,
            ...(chunks.length > 0 ? { chunks } : {}),
            rowCount: rows.length || latestState.rowCount,
            chunkCount: chunks.length || latestState.chunkCount,
        },
        layers: hydratedLayers,
        rowOwners,
    };
}

async function writeSummaryVectorIndexCheckpoint_ACU(options: {
    chat: any[];
    aggregatedSnapshot: ReturnType<typeof getAggregatedSummaryVectorIndexSnapshot_ACU>;
    embeddingModel: string;
    preparedRows: SummaryVectorArchivePreparedRow_ACU[];
    finalRows: ChatSummaryVectorIndexRow_ACU[];
    finalChunks: ChatSummaryVectorIndexChunk_ACU[];
    targetMessageIndex: number;
    snapshotMessageId: string;
    sourceTableKey: string;
    sourceTableName: string;
    indexedAt: string;
    skippedRowCount: number;
    mode: SummaryVectorIndexArchiveMode_ACU;
    saveChatAfterWrite?: boolean;
}): Promise<void> {
    const message = options.chat[options.targetMessageIndex];
    if (!message || message.is_user) return;

    const preparedByKey = new Map(options.preparedRows.map((row) => [row.rowKey, row]));
    const finalRowsByKey = new Map(options.finalRows.map((row) => [row.rowKey, row]));
    const previousState = cloneSummaryVectorIndexState_ACU(options.aggregatedSnapshot?.summaryVectorIndexState);
    const previousRows = Array.isArray(previousState?.rows) ? previousState!.rows.filter((row) => row.status !== 'removed') : [];
    const previousChunks = Array.isArray(previousState?.chunks) ? previousState!.chunks : [];
    const previousChunksByRowKey = new Map<string, ChatSummaryVectorIndexChunk_ACU[]>();
    previousChunks.forEach((chunk) => {
        const list = previousChunksByRowKey.get(chunk.rowKey) || [];
        list.push({ ...chunk });
        previousChunksByRowKey.set(chunk.rowKey, list);
    });

    const nextRowsByKey = new Map<string, ChatSummaryVectorIndexRow_ACU>();
    const nextChunksById = new Map<string, ChatSummaryVectorIndexChunk_ACU>();
    if (options.mode === 'append') {
        previousRows.forEach((row) => nextRowsByKey.set(row.rowKey, { ...row }));
        previousChunks.forEach((chunk) => nextChunksById.set(chunk.chunkId, { ...chunk }));
    } else {
        previousRows.forEach((row) => {
            if (preparedByKey.has(row.rowKey)) nextRowsByKey.set(row.rowKey, { ...row });
        });
        previousChunks.forEach((chunk) => {
            if (preparedByKey.has(chunk.rowKey)) nextChunksById.set(chunk.chunkId, { ...chunk });
        });
    }

    options.finalRows.forEach((row) => {
        nextRowsByKey.set(row.rowKey, { ...row });
        const validChunkIds = new Set(row.chunkIds || []);
        Array.from(nextChunksById.values()).forEach((chunk) => {
            if (chunk.rowKey === row.rowKey && !validChunkIds.has(chunk.chunkId)) nextChunksById.delete(chunk.chunkId);
        });
    });
    options.finalChunks.forEach((chunk) => nextChunksById.set(chunk.chunkId, { ...chunk }));

    const removedRowKeys: string[] = [];
    if (options.mode === 'sync') {
        previousRows.forEach((row) => {
            if (!preparedByKey.has(row.rowKey)) {
                removedRowKeys.push(row.rowKey);
                nextRowsByKey.delete(row.rowKey);
                (previousChunksByRowKey.get(row.rowKey) || []).forEach((chunk) => nextChunksById.delete(chunk.chunkId));
            }
        });
    }
    const replacedRowKeys = options.finalRows
        .filter((row) => {
            const previous = previousRows.find((item) => item.rowKey === row.rowKey);
            return !!previous && getSummaryRowFingerprintFromStateRow_ACU(previous) !== getSummaryRowFingerprintFromStateRow_ACU(row);
        })
        .map((row) => row.rowKey);

    const nextRows = Array.from(nextRowsByKey.values())
        .filter((row) => row.rowKey && row.rowId && row.summary && row.indexCode && Array.isArray(row.chunkIds) && row.chunkIds.length > 0)
        .sort((left, right) => left.rowOrder - right.rowOrder || left.rowKey.localeCompare(right.rowKey));
    const validRowKeys = new Set(nextRows.map((row) => row.rowKey));
    const validChunkIds = new Set(nextRows.flatMap((row) => row.chunkIds));
    const nextChunks = Array.from(nextChunksById.values())
        .filter((chunk) => validRowKeys.has(chunk.rowKey) && validChunkIds.has(chunk.chunkId) && Array.isArray(chunk.vector) && chunk.vector.length > 0)
        .map((chunk, index) => ({ ...chunk, sequence: index }));
    const nextState = buildLayerStateWithRows_ACU(previousState, nextRows, nextChunks, {
        snapshotMessageId: options.snapshotMessageId,
        sourceTableKey: options.sourceTableKey,
        sourceTableName: options.sourceTableName,
        indexedAt: options.indexedAt,
        skippedRowCount: options.skippedRowCount,
    });
    const isolationKey = getCurrentIsolationKey_ACU();
    const existingTagData = readIsolatedTagData_ACU(message, isolationKey) || {
        independentData: {},
        modifiedKeys: [],
        updateGroupKeys: [],
    };
    const nextIsolatedData = cloneIsolatedData_ACU(message);
    const nextTagData = cloneIsolationTagDataForSummaryVectorWrite_ACU(existingTagData);
    if (nextState) {
        const previousManifest = existingTagData.summaryVectorIndexManifest || previousState?.manifest || null;
        const persisted = await persistSummaryVectorIndexSnapshot_ACU({
            chatKey: currentChatFileIdentifier_ACU,
            isolationKey,
            previousManifest,
            rows: nextState.rows,
            chunks: nextChunks,
            snapshotMessageId: options.snapshotMessageId,
            sourceTableKey: options.sourceTableKey,
            sourceTableName: options.sourceTableName,
            indexedAt: options.indexedAt,
            skippedRowCount: nextState.skippedRowCount,
            embeddingModel: options.embeddingModel,
            activeRowKeys: nextState.rows.map((row) => row.rowKey),
            activeChunkIds: nextChunks.map((chunk) => chunk.chunkId),
            removedRowKeys,
            replacedRowKeys,
            parentIndexIds: previousManifest?.indexId ? [previousManifest.indexId] : [],
            snapshotRevision: previousManifest?.snapshot?.revision || 0,
            sourceMessageIndex: options.targetMessageIndex,
        });
        assignSummaryVectorIndexStateToTagData_ACU(nextTagData, persisted.state, persisted.manifest);
        logDebug_ACU(`[纪要向量索引] 已写入最新层内容寻址 manifest：rows=${persisted.manifest.rowCount}, chunks=${persisted.manifest.chunkCount}, chunkRefs=${persisted.manifest.contentAddressed?.chunkRefs?.length || 0}`);
    } else {
        assignSummaryVectorIndexStateToTagData_ACU(nextTagData, null);
    }
    nextIsolatedData[isolationKey] = nextTagData;
    message.TavernDB_ACU_IsolatedData = nextIsolatedData;
    writeIsolatedTagData_ACU(message, isolationKey, nextTagData);
    const anchorForMessage = resolveRemoteMemorySnapshotAnchor_ACU(options.chat, options.targetMessageIndex);
    if (anchorForMessage?.anchor) {
        persistRemoteMemorySnapshotAnchorIfNeeded_ACU(message, anchorForMessage);
    }
    writeMessageIdentity_ACU(message, {
        enabled: settings_ACU.dataIsolationEnabled,
        code: settings_ACU.dataIsolationCode,
    });
    writeLegacyCompatData_ACU(
        message,
        nextTagData.independentData || {},
        nextTagData.modifiedKeys || [],
        nextTagData.updateGroupKeys || [],
    );
    if (options.saveChatAfterWrite !== false) {
        await saveChatToHost_ACU();
    }
}

async function clearSummaryVectorIndexCheckpoint_ACU(params: {
    chat: any[];
    targetMessageIndex: number;
}): Promise<boolean> {
    const message = params.chat?.[params.targetMessageIndex];
    if (!message || message.is_user) return false;
    const isolationKey = getCurrentIsolationKey_ACU();
    const existingTagData = readIsolatedTagData_ACU(message, isolationKey);
    const manifest = existingTagData?.summaryVectorIndexManifest || existingTagData?.summaryVectorIndexState?.manifest || null;
    if (manifest) {
        await deleteSummaryVectorIndexExternal_ACU(manifest);
    }
    if (!existingTagData?.summaryVectorIndexState && !existingTagData?.summaryVectorIndexManifest) return !!manifest;

    const nextIsolatedData = cloneIsolatedData_ACU(message);
    const nextTagData = cloneIsolationTagDataForSummaryVectorWrite_ACU(existingTagData);
    assignSummaryVectorIndexStateToTagData_ACU(nextTagData, null);
    nextIsolatedData[isolationKey] = nextTagData;
    message.TavernDB_ACU_IsolatedData = nextIsolatedData;
    writeIsolatedTagData_ACU(message, isolationKey, nextTagData);
    writeMessageIdentity_ACU(message, {
        enabled: settings_ACU.dataIsolationEnabled,
        code: settings_ACU.dataIsolationCode,
    });
    writeLegacyCompatData_ACU(
        message,
        nextTagData.independentData || {},
        nextTagData.modifiedKeys || [],
        nextTagData.updateGroupKeys || [],
    );
    await saveChatToHost_ACU();
    logDebug_ACU(`[纪要向量索引] 当前纪要表无有效条目，已清理目标楼层交火索引 manifest: messageIndex=${params.targetMessageIndex}`);
    return true;
}

export async function migrateLegacySummaryVectorIndexToContentAddressed_ACU(options: { saveChatAfterWrite?: boolean } = {}): Promise<SummaryVectorIndexArchiveResult_ACU> {
    const config = getEffectiveSummaryVectorIndexConfig_ACU();
    const validation = validateSummaryVectorIndexConfig_ACU(config);
    if (!validation.valid) {
        return buildResult_ACU({
            success: false,
            reason: 'summary_vector_index_config_invalid',
            errors: validation.errors,
        });
    }

    const aggregatedSnapshot = await hydrateAggregatedSummaryVectorIndexSnapshot_ACU(getAggregatedSummaryVectorIndexSnapshot_ACU());
    const latestLayer = aggregatedSnapshot?.layers?.[aggregatedSnapshot.layers.length - 1] || null;
    const latestState = cloneSummaryVectorIndexState_ACU(latestLayer?.summaryVectorIndexState || aggregatedSnapshot?.summaryVectorIndexState);
    const manifest = normalizeSummaryVectorIndexManifestForRead_ACU(latestState?.manifest || latestLayer?.tagData?.summaryVectorIndexManifest || null);
    if (!latestLayer || !latestState || !manifest) {
        return buildResult_ACU({
            success: true,
            skipped: true,
            reason: 'no_manifest',
        });
    }
    if (!isLegacySummaryVectorIndexManifest_ACU(manifest)) {
        return buildResult_ACU({
            success: true,
            skipped: true,
            indexedRowCount: latestState.rowCount || 0,
            chunkCount: latestState.chunkCount || 0,
            messageIndex: latestLayer.messageIndex,
            summaryKey: manifest.sourceTableKey,
            reason: 'already_content_addressed',
        });
    }

    const chunks = await loadSummaryVectorIndexChunksFromManifest_ACU(manifest, { preferExternalFiles: true });
    const chunksById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
    const activeRowKeys = new Set(manifest.snapshot?.activeRowKeys || []);
    const activeChunkIds = new Set(manifest.snapshot?.activeChunkIds || []);
    const rows = (Array.isArray(latestState.rows) ? latestState.rows : [])
        .filter((row) => row && row.status !== 'removed')
        .filter((row) => activeRowKeys.size === 0 || activeRowKeys.has(row.rowKey))
        .map((row) => {
            const chunkIds = (Array.isArray(row.chunkIds) ? row.chunkIds : [])
                .filter((chunkId) => chunksById.has(chunkId))
                .filter((chunkId) => activeChunkIds.size === 0 || activeChunkIds.has(chunkId));
            return { ...row, chunkIds };
        })
        .filter((row) => row.rowKey && row.rowId && row.summary && row.indexCode && row.chunkIds.length > 0);
    const validChunkIds = new Set(rows.flatMap((row) => row.chunkIds));
    const finalChunks = chunks
        .filter((chunk) => validChunkIds.has(chunk.chunkId))
        .map((chunk, index) => ({ ...chunk, sequence: index }));

    if (rows.length === 0 || finalChunks.length === 0) {
        return buildResult_ACU({
            success: false,
            messageIndex: latestLayer.messageIndex,
            summaryKey: manifest.sourceTableKey,
            reason: 'legacy_manifest_missing_rows_or_chunks',
            errors: ['旧交火索引可读取外置分片，但楼层缺少可迁移的行状态；为避免破坏旧数据，已拒绝半迁移。'],
        });
    }

    const chat = getChatArray_ACU();
    const message = chat?.[latestLayer.messageIndex];
    if (!message || message.is_user) {
        return buildResult_ACU({
            success: false,
            reason: 'target_message_invalid',
            errors: ['旧交火索引所在楼层不存在或不是 AI 楼层，无法安全写入迁移 manifest。'],
        });
    }

    const isolationKey = latestLayer.isolationKey || getCurrentIsolationKey_ACU();
    const existingTagData = readIsolatedTagData_ACU(message, isolationKey) || {
        independentData: {},
        modifiedKeys: [],
        updateGroupKeys: [],
    };
    const indexedAt = new Date().toISOString();
    const persisted = await persistSummaryVectorIndexSnapshot_ACU({
        chatKey: manifest.chatKey || currentChatFileIdentifier_ACU,
        isolationKey,
        previousManifest: manifest,
        rows,
        chunks: finalChunks,
        snapshotMessageId: manifest.snapshotMessageId || latestState.snapshotMessageId || String(latestLayer.messageIndex),
        sourceTableKey: manifest.sourceTableKey || latestState.sourceTableKey || 'summary',
        sourceTableName: manifest.sourceTableName || latestState.sourceTableName || '纪要表',
        indexedAt,
        skippedRowCount: latestState.skippedRowCount || manifest.skippedRowCount || 0,
        embeddingModel: manifest.embeddingModel || config.embeddingModel,
        activeRowKeys: rows.map((row) => row.rowKey),
        activeChunkIds: finalChunks.map((chunk) => chunk.chunkId),
        removedRowKeys: manifest.snapshot?.removedRowKeys || [],
        replacedRowKeys: [],
        parentIndexIds: manifest.indexId ? [manifest.indexId] : [],
        snapshotRevision: manifest.snapshot?.revision || 0,
        sourceMessageIndex: latestLayer.messageIndex,
    });

    const nextIsolatedData = cloneIsolatedData_ACU(message);
    const nextTagData = {
        independentData: existingTagData.independentData || {},
        modifiedKeys: Array.isArray(existingTagData.modifiedKeys) ? [...existingTagData.modifiedKeys] : [],
        updateGroupKeys: Array.isArray(existingTagData.updateGroupKeys) ? [...existingTagData.updateGroupKeys] : [],
        ...(existingTagData.vectorMemoryState ? { vectorMemoryState: existingTagData.vectorMemoryState } : {}),
        ...(existingTagData._acu_base_state ? { _acu_base_state: existingTagData._acu_base_state } : {}),
    } as any;
    assignSummaryVectorIndexStateToTagData_ACU(nextTagData, persisted.state, persisted.manifest);
    nextIsolatedData[isolationKey] = nextTagData;
    message.TavernDB_ACU_IsolatedData = nextIsolatedData;
    writeIsolatedTagData_ACU(message, isolationKey, nextTagData);
    writeMessageIdentity_ACU(message, {
        enabled: settings_ACU.dataIsolationEnabled,
        code: settings_ACU.dataIsolationCode,
    });
    writeLegacyCompatData_ACU(
        message,
        nextTagData.independentData || {},
        nextTagData.modifiedKeys || [],
        nextTagData.updateGroupKeys || [],
    );
    if (options.saveChatAfterWrite !== false) {
        await saveChatToHost_ACU();
    }
    logDebug_ACU(`[纪要向量索引] 已非破坏迁移旧 shard manifest 到内容寻址协议：old=${manifest.indexId}, new=${persisted.manifest.indexId}, rows=${persisted.manifest.rowCount}, chunks=${persisted.manifest.chunkCount}`);
    return buildResult_ACU({
        success: true,
        skipped: false,
        indexedRowCount: persisted.manifest.rowCount,
        skippedRowCount: persisted.manifest.skippedRowCount,
        chunkCount: persisted.manifest.chunkCount,
        messageIndex: latestLayer.messageIndex,
        summaryKey: persisted.manifest.sourceTableKey,
        reason: 'legacy_manifest_migrated_non_destructive',
    });
}

export async function archiveSummaryVectorIndexNow_ACU(options: SummaryVectorIndexArchiveOptions_ACU = {}): Promise<SummaryVectorIndexArchiveResult_ACU> {
    const config = getEffectiveSummaryVectorIndexConfig_ACU();
    const validation = validateSummaryVectorIndexConfig_ACU(config);
    if (!validation.valid) {
        return buildResult_ACU({
            success: false,
            reason: 'summary_vector_index_config_invalid',
            errors: validation.errors,
        });
    }

    const selectedSummary = findSummaryTable_ACU();
    if (!selectedSummary) {
        return buildResult_ACU({
            success: true,
            skipped: true,
            reason: 'summary_table_not_found',
        });
    }

    const targetMessageIndex = resolveTargetMessageIndex_ACU(options.targetMessageIndex);
    if (targetMessageIndex < 0) {
        return buildResult_ACU({
            success: false,
            reason: 'target_message_not_found',
            errors: ['未找到可写入纪要向量索引的 AI 楼层。'],
        });
    }

    const chat = getChatArray_ACU();
    const targetMessage = chat[targetMessageIndex];
    if (!targetMessage || targetMessage.is_user) {
        return buildResult_ACU({
            success: false,
            reason: 'target_message_invalid',
            errors: ['目标楼层不是可写入的 AI 消息。'],
        });
    }

    const isolationKey = getCurrentIsolationKey_ACU();
    const archiveScopeKey = buildSummaryVectorIndexArchiveScopeKey_ACU({
        chatKey: currentChatFileIdentifier_ACU,
        isolationKey,
        sourceTableKey: selectedSummary.summaryKey,
    });
    return runSummaryVectorIndexArchiveWithScopeLock_ACU(archiveScopeKey, () => archiveSummaryVectorIndexNowUnlocked_ACU(options));
}

async function archiveSummaryVectorIndexNowUnlocked_ACU(options: SummaryVectorIndexArchiveOptions_ACU = {}): Promise<SummaryVectorIndexArchiveResult_ACU> {
    const config = getEffectiveSummaryVectorIndexConfig_ACU();
    const validation = validateSummaryVectorIndexConfig_ACU(config);
    if (!validation.valid) {
        return buildResult_ACU({
            success: false,
            reason: 'summary_vector_index_config_invalid',
            errors: validation.errors,
        });
    }

    const selectedSummary = findSummaryTable_ACU();
    if (!selectedSummary) {
        return buildResult_ACU({
            success: true,
            skipped: true,
            reason: 'summary_table_not_found',
        });
    }

    const targetMessageIndex = resolveTargetMessageIndex_ACU(options.targetMessageIndex);
    if (targetMessageIndex < 0) {
        return buildResult_ACU({
            success: false,
            reason: 'target_message_not_found',
            errors: ['未找到可写入纪要向量索引的 AI 楼层。'],
        });
    }

    const chat = getChatArray_ACU();
    const targetMessage = chat[targetMessageIndex];
    if (!targetMessage || targetMessage.is_user) {
        return buildResult_ACU({
            success: false,
            reason: 'target_message_invalid',
            errors: ['目标楼层不是可写入的 AI 消息。'],
        });
    }

    const snapshotAnchor = resolveRemoteMemorySnapshotAnchor_ACU(chat, targetMessageIndex);
    if (!snapshotAnchor?.anchor) {
        return buildResult_ACU({
            success: false,
            reason: 'snapshot_anchor_unresolved',
            errors: ['目标楼层缺少可用的本地聊天记录锚点，无法写入纪要向量索引。'],
        });
    }
    const snapshotMessageId = snapshotAnchor.anchor;

    const prepared = buildPreparedRows_ACU(selectedSummary.table, selectedSummary.summaryKey);
    if (prepared.error) {
        return buildResult_ACU({
            success: false,
            summaryKey: selectedSummary.summaryKey,
            messageIndex: targetMessageIndex,
            reason: 'summary_vector_index_prepare_failed',
            errors: [prepared.error],
        });
    }
    if (prepared.rows.length === 0) {
        const archiveMode: SummaryVectorIndexArchiveMode_ACU = options.mode === 'append' ? 'append' : 'sync';
        if (archiveMode === 'sync') {
            try {
                const cleared = await clearSummaryVectorIndexCheckpoint_ACU({ chat, targetMessageIndex });
                return buildResult_ACU({
                    success: true,
                    skipped: !cleared,
                    summaryKey: selectedSummary.summaryKey,
                    messageIndex: targetMessageIndex,
                    skippedRowCount: prepared.skippedRowCount,
                    reason: cleared ? 'summary_vector_index_cleared_no_effective_rows' : 'no_effective_rows',
                });
            } catch (error: any) {
                logWarn_ACU('[纪要向量索引] 清理空纪要表索引失败:', error);
                return buildResult_ACU({
                    success: false,
                    skipped: false,
                    summaryKey: selectedSummary.summaryKey,
                    messageIndex: targetMessageIndex,
                    skippedRowCount: prepared.skippedRowCount,
                    reason: 'summary_vector_index_clear_failed',
                    errors: [normalizeText_ACU(error?.message) || '纪要向量索引清理失败'],
                });
            }
        }
        return buildResult_ACU({
            success: true,
            skipped: true,
            summaryKey: selectedSummary.summaryKey,
            messageIndex: targetMessageIndex,
            skippedRowCount: prepared.skippedRowCount,
            reason: 'no_effective_rows',
        });
    }

    try {
        const archiveMode: SummaryVectorIndexArchiveMode_ACU = options.mode === 'append' ? 'append' : 'sync';
        logDebug_ACU(`[纪要向量索引] 本次归档模式: ${archiveMode}`);
        const aggregatedSnapshot = await hydrateAggregatedSummaryVectorIndexSnapshot_ACU(getAggregatedSummaryVectorIndexSnapshot_ACU());
        const existingState = cloneSummaryVectorIndexState_ACU(aggregatedSnapshot?.summaryVectorIndexState);
        const reusable = buildExistingReusableRows_ACU(prepared.rows, existingState);
        const reusableRowKeySet = new Set(reusable.reusableRows.map((row) => row.rowKey));
        const rowsNeedingEmbedding = prepared.rows.filter((row) => !reusableRowKeySet.has(row.rowKey));
        const activeRowKeysUnchanged = areSummaryVectorActiveRowKeysSame_ACU(prepared.rows, existingState);
        const existingActiveRowCount = existingState?.manifest?.snapshot?.activeRowKeys?.length || existingState?.rows?.length || 0;
        logDebug_ACU(`[纪要向量索引] 增量归档判定：prepared=${prepared.rows.length}, existingActive=${existingActiveRowCount}, reused=${reusable.reusableRows.length}, embedding=${rowsNeedingEmbedding.length}, activeRowsUnchanged=${activeRowKeysUnchanged}, skippedRows=${prepared.skippedRowCount}`);
        if (!options.force && rowsNeedingEmbedding.length === 0 && existingState?.manifest && activeRowKeysUnchanged) {
            logDebug_ACU('[纪要向量索引] 当前纪要表未发现新增、变更或删除条目，跳过重复覆盖上传。');
            return buildResult_ACU({
                success: true,
                skipped: true,
                summaryKey: selectedSummary.summaryKey,
                messageIndex: targetMessageIndex,
                skippedRowCount: prepared.skippedRowCount,
                reason: 'no_changes_skip_snapshot_upload',
            });
        }
        if (options.force) {
            logDebug_ACU('[纪要向量索引] force=true，强制执行归档写入（跳过无变更检测）。');
        }
        const indexedAt = new Date().toISOString();
        const sourceTableName = normalizeText_ACU(selectedSummary.table?.name) || '纪要表';
        const maxRowsPerBatch = Math.max(1, Math.floor(Number(config.summaryIndexArchiveMaxConcurrency) || 30));
        const embeddedRows: ChatSummaryVectorIndexRow_ACU[] = [];
        const embeddedChunks: ChatSummaryVectorIndexChunk_ACU[] = [];
        let checkpointResult = buildFinalSummaryVectorIndexRowsAndChunks_ACU(reusable.reusableRows, reusable.reusableChunks);

        for (let startIndex = 0; startIndex < rowsNeedingEmbedding.length; startIndex += maxRowsPerBatch) {
            const rowBatch = rowsNeedingEmbedding.slice(startIndex, startIndex + maxRowsPerBatch);
            if (rowBatch.length === 0) continue;
            const batchResult = await buildChunksWithEmbeddings_ACU(rowBatch, {
                snapshotMessageId,
                sentenceCount: config.summaryIndexChunkSentenceCount,
                embeddingEndpoint: config.embeddingEndpoint,
                embeddingApiKey: config.embeddingApiKey,
                embeddingModel: config.embeddingModel,
                existingSequenceBase: embeddedChunks.length,
            });
            embeddedRows.push(...batchResult.rows);
            embeddedChunks.push(...batchResult.chunks);
            checkpointResult = buildFinalSummaryVectorIndexRowsAndChunks_ACU(
                [...reusable.reusableRows, ...embeddedRows],
                [...reusable.reusableChunks, ...embeddedChunks],
            );
        }

        const finalResult = buildFinalSummaryVectorIndexRowsAndChunks_ACU(
            [...reusable.reusableRows, ...embeddedRows],
            [...reusable.reusableChunks, ...embeddedChunks],
        );
        if (finalResult.rows.length === 0 || finalResult.chunks.length === 0) {
            return buildResult_ACU({
                success: false,
                summaryKey: selectedSummary.summaryKey,
                messageIndex: targetMessageIndex,
                reason: 'embedding_empty',
                errors: ['纪要向量索引 embedding 结果为空。'],
            });
        }

        // ── vectorizeOnly 模式：只向量化，归档由防抖触发 ──
        if (options.vectorizeOnly) {
            const scopeKey = buildSummaryVectorIndexArchiveScopeKey_ACU({
                chatKey: currentChatFileIdentifier_ACU,
                isolationKey: getCurrentIsolationKey_ACU(),
                sourceTableKey: selectedSummary.summaryKey,
            });
            pendingVectorIndexArchives_ACU.set(scopeKey, {
                chat,
                aggregatedSnapshot,
                embeddingModel: config.embeddingModel,
                preparedRows: prepared.rows,
                finalRows: finalResult.rows,
                finalChunks: finalResult.chunks,
                targetMessageIndex,
                snapshotMessageId,
                sourceTableKey: selectedSummary.summaryKey,
                sourceTableName,
                indexedAt,
                skippedRowCount: prepared.skippedRowCount,
                mode: archiveMode,
            });
            scheduleDebouncedVectorIndexPersist_ACU(scopeKey);
            logDebug_ACU(`[纪要向量索引] 向量化完成，已存入待归档队列：scope=${scopeKey}, rows=${finalResult.rows.length}, chunks=${finalResult.chunks.length}`);
            return buildResult_ACU({
                success: true,
                skipped: false,
                indexedRowCount: finalResult.rows.length,
                skippedRowCount: prepared.skippedRowCount + (prepared.rows.length - finalResult.rows.length),
                chunkCount: finalResult.chunks.length,
                messageIndex: targetMessageIndex,
                summaryKey: selectedSummary.summaryKey,
                reason: 'vectorized_pending_debounced_archive',
            });
        }

        // ── 立即归档模式：向量化后直接写入外置文件 ──
        await writeSummaryVectorIndexCheckpoint_ACU({
            chat,
            aggregatedSnapshot,
            embeddingModel: config.embeddingModel,
            preparedRows: prepared.rows,
            finalRows: finalResult.rows,
            finalChunks: finalResult.chunks,
            targetMessageIndex,
            snapshotMessageId,
            sourceTableKey: selectedSummary.summaryKey,
            sourceTableName,
            indexedAt,
            skippedRowCount: prepared.skippedRowCount,
            mode: archiveMode,
            saveChatAfterWrite: options.saveChatAfterWrite !== false,
        });

        return buildResult_ACU({
            success: true,
            skipped: false,
            indexedRowCount: finalResult.rows.length,
            skippedRowCount: prepared.skippedRowCount + (prepared.rows.length - finalResult.rows.length),
            chunkCount: finalResult.chunks.length,
            messageIndex: targetMessageIndex,
            summaryKey: selectedSummary.summaryKey,
            reason: 'archived_summary_vector_index',
        });
    } catch (error: any) {
        logWarn_ACU('[纪要向量索引] 归档失败，未修改纪要表原条目:', error);
        return buildResult_ACU({
            success: false,
            skipped: false,
            summaryKey: selectedSummary.summaryKey,
            messageIndex: targetMessageIndex,
            reason: 'summary_vector_index_archive_failed',
            errors: [normalizeText_ACU(error?.message) || '纪要向量索引归档失败'],
        });
    }
}

export function buildSummaryVectorIndexBatchId_ACU(state: ChatSummaryVectorIndexState_ACU): string {
    const source = `${state.snapshotMessageId}:${state.sourceTableKey}:${state.indexedAt}:${state.rowCount}:${state.chunkCount}`;
    return `summary-vector-index:${hashUserInput_ACU(source)}`;
}
