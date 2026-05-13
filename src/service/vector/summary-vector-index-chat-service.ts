import { currentChatFileIdentifier_ACU, currentJsonTableData_ACU, getCurrentIsolationKey_ACU } from '../runtime/state-manager';
import { getChatArray_ACU, saveChatToHost_ACU } from '../chat/chat-service';
import { getCurrentCharacterCardName_ACU } from '../../shared/template-preset-utils';
import { isSummaryOrOutlineTable_ACU, logDebug_ACU } from '../../shared/utils';
import { readIsolatedTagData_ACU, writeIsolatedTagData_ACU } from '../../data/repositories/chat-message-data-repo';
import {
    buildLegacyVectorIndexSingleSnapshotFilePath_ACU,
    buildVectorIndexSingleSnapshotFilePath_ACU,
    readVectorIndexJsonFile_ACU,
} from '../../data/storage/vector-index-st-files-storage';
import type { SummaryVectorIndexSafeGcScopeHint_ACU } from './summary-vector-index-types';
import { clearSummaryVectorIndexScopeCaches_ACU } from './summary-vector-index-cache-service';
import { cleanupUnreachableSummaryVectorIndexFiles_ACU } from './summary-vector-index-storage-service';
import { assignSummaryVectorIndexStateToTagData_ACU, getAggregatedSummaryVectorIndexSnapshot_ACU } from './summary-vector-index-state-service';

interface SummaryVectorIndexSingleSnapshotBlob_ACU {
    schema: string;
    manifest: any;
    rows: any[];
    chunks: any[];
}

function getCurrentSummaryVectorIndexSourceTableKey_ACU(): string {
    const tables = currentJsonTableData_ACU && typeof currentJsonTableData_ACU === 'object'
        ? currentJsonTableData_ACU
        : null;
    if (!tables) return 'summary';
    return Object.keys(tables).find((key) => {
        const table = tables[key];
        return !!table?.name && isSummaryOrOutlineTable_ACU(String(table.name || ''));
    }) || 'summary';
}

function collectSummaryVectorIndexCandidateTableKeys_ACU(): string[] {
    const candidateTableKeys = new Set<string>();
    candidateTableKeys.add(getCurrentSummaryVectorIndexSourceTableKey_ACU());
    candidateTableKeys.add('summary');
    const tables = currentJsonTableData_ACU && typeof currentJsonTableData_ACU === 'object' ? currentJsonTableData_ACU : null;
    if (tables) {
        for (const key of Object.keys(tables)) {
            const table = tables[key];
            if (table?.name && isSummaryOrOutlineTable_ACU(String(table.name || ''))) {
                candidateTableKeys.add(key);
            }
        }
    }
    return Array.from(candidateTableKeys.values()).filter(Boolean);
}

async function tryReadSingleSnapshotBlob_ACU(params: {
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
    chatName: string;
}): Promise<SummaryVectorIndexSingleSnapshotBlob_ACU | null> {
    const namedPath = buildVectorIndexSingleSnapshotFilePath_ACU(params);
    const unnamedPath = buildVectorIndexSingleSnapshotFilePath_ACU({
        chatKey: params.chatKey,
        isolationKey: params.isolationKey,
        sourceTableKey: params.sourceTableKey,
    });
    let loaded = await readVectorIndexJsonFile_ACU<SummaryVectorIndexSingleSnapshotBlob_ACU>(namedPath);
    if ((!loaded.ok || !loaded.data || loaded.data.schema !== 'single_file_snapshot') && namedPath !== unnamedPath) {
        loaded = await readVectorIndexJsonFile_ACU<SummaryVectorIndexSingleSnapshotBlob_ACU>(unnamedPath);
    }
    if (!loaded.ok || !loaded.data || loaded.data.schema !== 'single_file_snapshot') {
        const legacyPath = buildLegacyVectorIndexSingleSnapshotFilePath_ACU({
            chatKey: params.chatKey,
            isolationKey: params.isolationKey,
            sourceTableKey: params.sourceTableKey,
        });
        if (legacyPath !== namedPath && legacyPath !== unnamedPath) {
            loaded = await readVectorIndexJsonFile_ACU<SummaryVectorIndexSingleSnapshotBlob_ACU>(legacyPath);
        }
    }
    if (!loaded.ok || !loaded.data || loaded.data.schema !== 'single_file_snapshot') return null;
    return loaded.data;
}

export async function recoverSummaryVectorIndexFromExternalSnapshotForCurrentChat_ACU(): Promise<boolean> {
    const chatKey = String(currentChatFileIdentifier_ACU || '').trim();
    const isolationKey = String(getCurrentIsolationKey_ACU() || '').trim();
    if (!chatKey || !isolationKey) return false;

    const chatName = getCurrentCharacterCardName_ACU();
    for (const sourceTableKey of collectSummaryVectorIndexCandidateTableKeys_ACU()) {
        try {
            const blob = await tryReadSingleSnapshotBlob_ACU({ chatKey, isolationKey, sourceTableKey, chatName });
            if (!blob) continue;
            const manifest = blob.manifest;
            if (!manifest?.indexId || manifest.status !== 'ready') continue;

            const chat = getChatArray_ACU();
            if (!Array.isArray(chat) || chat.length === 0) continue;

            let targetIndex = -1;
            for (let index = chat.length - 1; index >= 0; index -= 1) {
                if (chat[index] && !chat[index].is_user) {
                    targetIndex = index;
                    break;
                }
            }
            if (targetIndex < 0) continue;

            const message = chat[targetIndex];
            const tagData = readIsolatedTagData_ACU(message, isolationKey) || { independentData: {}, modifiedKeys: {}, updateGroupKeys: {} } as any;
            if (tagData.summaryVectorIndexState?.manifest?.indexId) return false;

            const rows = Array.isArray(blob.rows) ? blob.rows : [];
            const chunks = Array.isArray(blob.chunks) ? blob.chunks : [];
            assignSummaryVectorIndexStateToTagData_ACU(tagData, {
                manifest,
                rows,
                chunks,
                rowCount: rows.filter((row: any) => row?.status !== 'removed').length,
                chunkCount: chunks.length,
                snapshotMessageId: String(manifest.snapshotMessageId || message.mesId || ''),
                sourceTableKey: String(manifest.sourceTableKey || sourceTableKey),
                sourceTableName: String(manifest.sourceTableName || sourceTableKey),
                indexedAt: String(manifest.indexedAt || new Date().toISOString()),
                skippedRowCount: 0,
            } as any);
            writeIsolatedTagData_ACU(message, isolationKey, tagData);
            await saveChatToHost_ACU();
            logDebug_ACU(`[ACU交火向量索引] 已从外部快照自动恢复 state 到消息 #${targetIndex}（indexId=${manifest.indexId}，${rows.length} 行，${chunks.length} 块，sourceTableKey=${sourceTableKey}）`);
            return true;
        } catch {
            // 单个候选表键失败不能阻断后续候选路径恢复。
        }
    }
    return false;
}

export async function deleteCurrentSummaryVectorIndexFromChat_ACU(): Promise<boolean> {
    const snapshot = getAggregatedSummaryVectorIndexSnapshot_ACU();
    const chat = getChatArray_ACU();
    const scopeHints = new Map<string, SummaryVectorIndexSafeGcScopeHint_ACU>();
    let changed = false;

    if (snapshot?.layers?.length) {
        for (const layer of snapshot.layers) {
            const message = chat[layer.messageIndex];
            if (!message || message.is_user) continue;
            const tagData = readIsolatedTagData_ACU(message, layer.isolationKey);
            if (!tagData) continue;
            const manifest = tagData.summaryVectorIndexManifest || tagData.summaryVectorIndexState?.manifest || null;
            if (manifest) {
                const hint: SummaryVectorIndexSafeGcScopeHint_ACU = {
                    chatKey: manifest.chatKey || currentChatFileIdentifier_ACU,
                    isolationKey: manifest.isolationKey || layer.isolationKey,
                    sourceTableKey: manifest.sourceTableKey || getCurrentSummaryVectorIndexSourceTableKey_ACU(),
                };
                scopeHints.set(`${hint.chatKey || ''}\n${hint.isolationKey}\n${hint.sourceTableKey}`, hint);
            }
            assignSummaryVectorIndexStateToTagData_ACU(tagData, null);
            writeIsolatedTagData_ACU(message, layer.isolationKey, tagData);
            changed = true;
        }
    }

    if (changed) {
        await saveChatToHost_ACU();
    }

    const scopeHintList = Array.from(scopeHints.values());
    for (const hint of scopeHintList) {
        await clearSummaryVectorIndexScopeCaches_ACU(hint);
    }
    const gcResult = await cleanupUnreachableSummaryVectorIndexFiles_ACU({ scopeHints: scopeHintList });
    return changed || gcResult.deletedPaths.length > 0 || gcResult.failedDeletes.length > 0;
}
