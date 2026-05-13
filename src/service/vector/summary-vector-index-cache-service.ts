import { logDebug_ACU, logWarn_ACU } from '../../shared/utils';
import { clearVectorIndexTempCache_ACU, deleteVectorIndexCacheByIndex_ACU } from '../../data/storage/vector-index-temp-cache';
import {
    clearSummaryVectorFlushTasksByScope_ACU,
    clearSummaryVectorHotCache_ACU,
    deleteSummaryVectorHotCacheByIndex_ACU,
    deleteSummaryVectorHotCacheByScope_ACU,
} from '../../data/storage/vector-index-hot-cache';
import type { SummaryVectorIndexSafeGcScopeHint_ACU } from './summary-vector-index-types';
import { getLatestSummaryVectorIndexSnapshotState_ACU } from './summary-vector-index-state-service';
import { loadSummaryVectorIndexChunksFromManifest_ACU } from './summary-vector-index-storage-service';

export interface SummaryVectorIndexCachePreloadResult_ACU {
    success: boolean;
    skipped: boolean;
    reason?: string;
    chunkCount: number;
    indexId?: string;
    error?: string;
    cacheCleared?: boolean;
    chatStateCleared?: boolean;
}

function normalizeErrorMessage_ACU(error: unknown): string {
    if (error instanceof Error) return error.message || error.name || '未知错误';
    if (typeof error === 'string') return error;
    try {
        const json = JSON.stringify(error);
        return json && json !== '{}' ? json : String(error || '未知错误');
    } catch (_jsonError) {
        return String(error || '未知错误');
    }
}

export function isMissingExternalVectorFileError_ACU(message: string): boolean {
    const text = String(message || '').toLowerCase();
    const isVectorFileReadFailure = text.includes('交火向量索引分片读取失败')
        || text.includes('交火向量索引内容块读取失败');
    return isVectorFileReadFailure
        && (text.includes('404') || text.includes('not found') || text.includes('读取失败'));
}

export async function clearLatestSummaryVectorIndexStateForMissingExternalFiles_ACU(params: {
    messageIndex: number;
    isolationKey: string;
    indexId: string;
}): Promise<boolean> {
    void params.messageIndex;
    void params.isolationKey;
    await deleteVectorIndexCacheByIndex_ACU(params.indexId);
    await deleteSummaryVectorHotCacheByIndex_ACU(params.indexId);
    return false;
}

export async function clearLatestSummaryVectorIndexStateForInvalidExternalFiles_ACU(params: {
    messageIndex: number;
    isolationKey: string;
    indexId: string;
}): Promise<boolean> {
    void params.messageIndex;
    void params.isolationKey;
    await deleteVectorIndexCacheByIndex_ACU(params.indexId);
    await deleteSummaryVectorHotCacheByIndex_ACU(params.indexId);
    return false;
}

export async function clearAllSummaryVectorIndexCaches_ACU(): Promise<void> {
    await clearVectorIndexTempCache_ACU();
    await clearSummaryVectorHotCache_ACU();
}

export async function clearSummaryVectorIndexScopeCaches_ACU(scope: SummaryVectorIndexSafeGcScopeHint_ACU): Promise<void> {
    await deleteSummaryVectorHotCacheByScope_ACU(scope);
    await clearSummaryVectorFlushTasksByScope_ACU(scope);
}

export function isInvalidExternalVectorFileError_ACU(message: string): boolean {
    const text = String(message || '').toLowerCase();
    return text.includes('交火向量索引分片身份不匹配')
        || text.includes('交火向量索引分片校验失败')
        || text.includes('交火向量索引内容块身份不匹配')
        || text.includes('交火向量索引内容块校验失败');
}

export async function preloadSummaryVectorIndexCacheForCurrentChat_ACU(): Promise<SummaryVectorIndexCachePreloadResult_ACU> {
    const snapshot = getLatestSummaryVectorIndexSnapshotState_ACU();
    const latestLayer = snapshot?.layers?.[0] || null;
    const manifest = snapshot?.summaryVectorIndexState?.manifest || null;
    if (!manifest) {
        return {
            success: true,
            skipped: true,
            reason: 'no_manifest',
            chunkCount: 0,
        };
    }

    if (manifest.status !== 'ready') {
        return {
            success: true,
            skipped: true,
            reason: `manifest_status_${manifest.status || 'unknown'}`,
            chunkCount: 0,
            indexId: manifest.indexId,
        };
    }

    try {
        const chunks = await loadSummaryVectorIndexChunksFromManifest_ACU(manifest, {
            preferExternalFiles: true,
        });
        logDebug_ACU(`[交火向量索引] 当前聊天向量缓存预热完成：indexId=${manifest.indexId}, chunks=${chunks.length}，已从外置文件恢复热缓存。`);
        return {
            success: true,
            skipped: false,
            chunkCount: chunks.length,
            indexId: manifest.indexId,
        };
    } catch (error) {
        const message = normalizeErrorMessage_ACU(error);
        if (isMissingExternalVectorFileError_ACU(message)) {
            const chatStateCleared = latestLayer
                ? await clearLatestSummaryVectorIndexStateForMissingExternalFiles_ACU({
                    messageIndex: latestLayer.messageIndex,
                    isolationKey: latestLayer.isolationKey,
                    indexId: manifest.indexId,
                })
                : false;
            logWarn_ACU('[交火向量索引] 当前聊天外置向量文件缺失，已清空对应缓存并保留聊天索引状态:', message);
            return {
                success: true,
                skipped: true,
                reason: 'external_files_missing_cache_cleared_state_retained',
                chunkCount: 0,
                indexId: manifest.indexId,
                error: message,
                cacheCleared: true,
                chatStateCleared,
            };
        }
        if (isInvalidExternalVectorFileError_ACU(message)) {
            const chatStateCleared = latestLayer
                ? await clearLatestSummaryVectorIndexStateForInvalidExternalFiles_ACU({
                    messageIndex: latestLayer.messageIndex,
                    isolationKey: latestLayer.isolationKey,
                    indexId: manifest.indexId,
                })
                : false;
            logWarn_ACU('[交火向量索引] 当前聊天外置向量文件校验失败，已清空对应缓存并保留聊天索引状态:', message);
            return {
                success: true,
                skipped: true,
                reason: 'external_files_invalid_cache_cleared_state_retained',
                chunkCount: 0,
                indexId: manifest.indexId,
                error: message,
                cacheCleared: true,
                chatStateCleared,
            };
        }
        logWarn_ACU('[交火向量索引] 当前聊天向量缓存预热失败:', message);
        return {
            success: false,
            skipped: false,
            reason: 'preload_failed',
            chunkCount: 0,
            indexId: manifest.indexId,
            error: message,
        };
    }
}
