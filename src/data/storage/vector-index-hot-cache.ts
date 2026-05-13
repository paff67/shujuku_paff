import type { ChatSummaryVectorIndexChunk_ACU, ChatSummaryVectorIndexManifest_ACU } from '../../shared/models/summary-vector-index';

const DB_NAME_ACU = 'TavernDB_ACU_VectorHotCache';
const DB_VERSION_ACU = 2;
const STORE_NAME_ACU = 'chunks';
const FLUSH_TASK_STORE_NAME_ACU = 'flushTasks';

export type SummaryVectorIndexFlushTaskStatus_ACU = 'dirty' | 'queued' | 'flushing' | 'ready' | 'failed_retryable' | 'failed_terminal';
export type SummaryVectorIndexFlushTaskMode_ACU = 'append' | 'sync';

export interface VectorIndexHotCacheScope_ACU {
    chatKey?: string;
    isolationKey?: string;
    sourceTableKey?: string;
}

export interface VectorIndexHotCacheWriteOptions_ACU {
    manifest: ChatSummaryVectorIndexManifest_ACU;
    chunks: ChatSummaryVectorIndexChunk_ACU[];
}

export interface VectorIndexHotCacheLoadOptions_ACU {
    manifest: ChatSummaryVectorIndexManifest_ACU;
}

export interface SummaryVectorIndexFlushTaskRecord_ACU {
    scopeKey: string;
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
    targetMessageIndex?: number;
    mode: SummaryVectorIndexFlushTaskMode_ACU;
    status: SummaryVectorIndexFlushTaskStatus_ACU;
    requestedAt: number;
    debounceUntil: number;
    attemptCount: number;
    lastAttemptAt?: number;
    lastSuccessAt?: number;
    lastError?: string;
    updatedAt: number;
}

export interface SummaryVectorIndexFlushTaskUpsert_ACU {
    scopeKey: string;
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
    targetMessageIndex?: number;
    mode: SummaryVectorIndexFlushTaskMode_ACU;
    status: SummaryVectorIndexFlushTaskStatus_ACU;
    requestedAt?: number;
    debounceUntil?: number;
    lastError?: string;
}

export interface SummaryVectorIndexFlushTaskEstimate_ACU {
    total: number;
    dirty: number;
    queued: number;
    flushing: number;
    ready: number;
    failedRetryable: number;
    failedTerminal: number;
    lastError?: string;
}

interface VectorIndexHotCacheChunkRecord_ACU {
    key: string;
    chatKey: string;
    isolationKey: string;
    sourceTableKey: string;
    indexId: string;
    checkpointId: string;
    chunkKey: string;
    chunkId: string;
    rowKey: string;
    embeddingModel: string;
    dimension: number;
    checksum: string;
    chunk: ChatSummaryVectorIndexChunk_ACU;
    byteSize: number;
    createdAt: number;
    updatedAt: number;
    lastAccessAt: number;
}

function isIdbAvailable_ACU(): boolean {
    return typeof indexedDB !== 'undefined';
}

function normalizeKeyPart_ACU(value: any): string {
    return String(value || '').trim();
}

function buildRecordKey_ACU(indexId: string, chunkId: string, chunkKey: string): string {
    return `${normalizeKeyPart_ACU(indexId)}::${normalizeKeyPart_ACU(chunkId)}::${normalizeKeyPart_ACU(chunkKey)}`;
}

function openDb_ACU(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (!isIdbAvailable_ACU()) {
            reject(new Error('IndexedDB 不可用'));
            return;
        }
        const request = indexedDB.open(DB_NAME_ACU, DB_VERSION_ACU);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME_ACU)) {
                const store = db.createObjectStore(STORE_NAME_ACU, { keyPath: 'key' });
                store.createIndex('indexId', 'indexId', { unique: false });
                store.createIndex('checkpointId', 'checkpointId', { unique: false });
                store.createIndex('scope', ['chatKey', 'isolationKey', 'sourceTableKey'], { unique: false });
                store.createIndex('lastAccessAt', 'lastAccessAt', { unique: false });
            }
            if (!db.objectStoreNames.contains(FLUSH_TASK_STORE_NAME_ACU)) {
                const taskStore = db.createObjectStore(FLUSH_TASK_STORE_NAME_ACU, { keyPath: 'scopeKey' });
                taskStore.createIndex('scope', ['chatKey', 'isolationKey', 'sourceTableKey'], { unique: true });
                taskStore.createIndex('status', 'status', { unique: false });
                taskStore.createIndex('debounceUntil', 'debounceUntil', { unique: false });
                taskStore.createIndex('updatedAt', 'updatedAt', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('打开交火向量热缓存失败'));
    });
}

function cloneChunk_ACU(chunk: ChatSummaryVectorIndexChunk_ACU): ChatSummaryVectorIndexChunk_ACU {
    return {
        ...chunk,
        vector: Array.isArray(chunk.vector) ? chunk.vector.map((value) => Number(value) || 0) : [],
        chunkKeys: Array.isArray(chunk.chunkKeys) ? [...chunk.chunkKeys] : chunk.chunkKeys,
    };
}

function getManifestCheckpointId_ACU(manifest: ChatSummaryVectorIndexManifest_ACU): string {
    return normalizeKeyPart_ACU(manifest.checkpoint?.checkpointId || manifest.indexId);
}

function getActiveChunkRefs_ACU(manifest: ChatSummaryVectorIndexManifest_ACU) {
    const refs = Array.isArray(manifest.contentAddressed?.chunkRefs) ? manifest.contentAddressed!.chunkRefs : [];
    const activeChunkKeys = new Set((manifest.contentAddressed?.activeChunkKeys || []).map((item) => normalizeKeyPart_ACU(item)).filter(Boolean));
    return refs.filter((ref) => {
        const chunkKey = normalizeKeyPart_ACU(ref?.chunkKey);
        return chunkKey && (activeChunkKeys.size === 0 || activeChunkKeys.has(chunkKey));
    });
}

function isSingleFileSnapshotManifest_ACU(manifest: ChatSummaryVectorIndexManifest_ACU): boolean {
    return manifest.snapshot?.mode === 'single_file_snapshot';
}

function isRecordCompatible_ACU(record: VectorIndexHotCacheChunkRecord_ACU | null | undefined, manifest: ChatSummaryVectorIndexManifest_ACU, ref: ReturnType<typeof getActiveChunkRefs_ACU>[number]): boolean {
    if (!record?.chunk) return false;
    if (record.chatKey !== normalizeKeyPart_ACU(manifest.chatKey)) return false;
    if (record.isolationKey !== normalizeKeyPart_ACU(manifest.isolationKey)) return false;
    if (record.sourceTableKey !== normalizeKeyPart_ACU(manifest.sourceTableKey)) return false;
    if (record.indexId !== normalizeKeyPart_ACU(manifest.indexId)) return false;
    if (record.checkpointId !== getManifestCheckpointId_ACU(manifest)) return false;
    if (record.chunkKey !== normalizeKeyPart_ACU(ref.chunkKey)) return false;
    if (record.chunkId !== normalizeKeyPart_ACU(ref.chunkId)) return false;
    if (record.rowKey !== normalizeKeyPart_ACU(ref.rowKey)) return false;
    if (record.dimension !== Math.max(0, Number(ref.dimension) || 0)) return false;
    if (ref.checksum && record.checksum && record.checksum !== ref.checksum) return false;
    const vector = Array.isArray(record.chunk.vector) ? record.chunk.vector : [];
    return vector.length > 0 && (!ref.dimension || vector.length === ref.dimension);
}

export async function putSummaryVectorHotCacheChunks_ACU(options: VectorIndexHotCacheWriteOptions_ACU): Promise<void> {
    try {
        const manifest = options.manifest;
        if (!manifest?.indexId || manifest.status !== 'ready') return;
        if (!Array.isArray(options.chunks) || options.chunks.length === 0) return;

        // ── 单文件快照模式：直接写入所有 chunks，不依赖 contentAddressed.chunkRefs ──
        if (isSingleFileSnapshotManifest_ACU(manifest)) {
            const db = await openDb_ACU();
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE_NAME_ACU, 'readwrite');
                const store = tx.objectStore(STORE_NAME_ACU);
                const now = Date.now();
                options.chunks.forEach((chunk) => {
                    const chunkId = normalizeKeyPart_ACU(chunk?.chunkId);
                    const vector = Array.isArray(chunk?.vector) ? chunk.vector : [];
                    if (!chunkId || vector.length === 0) return;
                    const chunkKey = normalizeKeyPart_ACU((Array.isArray(chunk.chunkKeys) && chunk.chunkKeys[0]) || chunkId);
                    const normalizedChunk = cloneChunk_ACU({
                        ...chunk,
                        chunkKeys: Array.from(new Set([...(Array.isArray(chunk.chunkKeys) ? chunk.chunkKeys : []), chunkKey].filter(Boolean))),
                    });
                    const json = JSON.stringify(normalizedChunk);
                    const record: VectorIndexHotCacheChunkRecord_ACU = {
                        key: buildRecordKey_ACU(manifest.indexId, chunkId, chunkKey),
                        chatKey: normalizeKeyPart_ACU(manifest.chatKey),
                        isolationKey: normalizeKeyPart_ACU(manifest.isolationKey),
                        sourceTableKey: normalizeKeyPart_ACU(manifest.sourceTableKey),
                        indexId: normalizeKeyPart_ACU(manifest.indexId),
                        checkpointId: getManifestCheckpointId_ACU(manifest),
                        chunkKey,
                        chunkId,
                        rowKey: normalizeKeyPart_ACU(chunk.rowKey),
                        embeddingModel: normalizeKeyPart_ACU(manifest.embeddingModel),
                        dimension: Math.max(0, vector.length),
                        checksum: '',
                        chunk: normalizedChunk,
                        byteSize: new Blob([json]).size,
                        createdAt: now,
                        updatedAt: now,
                        lastAccessAt: now,
                    };
                    store.put(record);
                });
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); reject(tx.error || new Error('写入交火向量热缓存事务失败（单文件快照）')); };
            });
            return;
        }

        // ── 旧版内容寻址模式：通过 chunkRefs 匹配写入 ──
        const refs = getActiveChunkRefs_ACU(manifest);
        if (refs.length === 0) return;
        const refsByChunkId = new Map(refs.map((ref) => [normalizeKeyPart_ACU(ref.chunkId), ref]));
        const db = await openDb_ACU();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME_ACU, 'readwrite');
            const store = tx.objectStore(STORE_NAME_ACU);
            const now = Date.now();
            options.chunks.forEach((chunk) => {
                const chunkId = normalizeKeyPart_ACU(chunk?.chunkId);
                const ref = refsByChunkId.get(chunkId);
                const vector = Array.isArray(chunk?.vector) ? chunk.vector : [];
                if (!ref || vector.length === 0) return;
                const chunkKey = normalizeKeyPart_ACU(ref.chunkKey);
                const normalizedChunk = cloneChunk_ACU({
                    ...chunk,
                    chunkKeys: Array.from(new Set([...(Array.isArray(chunk.chunkKeys) ? chunk.chunkKeys : []), chunkKey].filter(Boolean))),
                });
                const json = JSON.stringify(normalizedChunk);
                const record: VectorIndexHotCacheChunkRecord_ACU = {
                    key: buildRecordKey_ACU(manifest.indexId, ref.chunkId, chunkKey),
                    chatKey: normalizeKeyPart_ACU(manifest.chatKey),
                    isolationKey: normalizeKeyPart_ACU(manifest.isolationKey),
                    sourceTableKey: normalizeKeyPart_ACU(manifest.sourceTableKey),
                    indexId: normalizeKeyPart_ACU(manifest.indexId),
                    checkpointId: getManifestCheckpointId_ACU(manifest),
                    chunkKey,
                    chunkId: normalizeKeyPart_ACU(ref.chunkId),
                    rowKey: normalizeKeyPart_ACU(ref.rowKey),
                    embeddingModel: normalizeKeyPart_ACU(ref.embeddingModel || manifest.embeddingModel),
                    dimension: Math.max(0, Number(ref.dimension || vector.length) || 0),
                    checksum: normalizeKeyPart_ACU(ref.checksum),
                    chunk: normalizedChunk,
                    byteSize: new Blob([json]).size,
                    createdAt: now,
                    updatedAt: now,
                    lastAccessAt: now,
                };
                store.put(record);
            });
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('写入交火向量热缓存事务失败'));
            };
        });
    } catch {
        // 热缓存只是可丢失加速层，失败不能影响外置权威链路。
    }
}

export async function getSummaryVectorHotCacheChunks_ACU(options: VectorIndexHotCacheLoadOptions_ACU): Promise<ChatSummaryVectorIndexChunk_ACU[] | null> {
    try {
        const manifest = options.manifest;
        if (!manifest?.indexId || manifest.status !== 'ready') return null;

        // ── 单文件快照模式：通过 indexId 索引扫描所有匹配记录 ──
        if (isSingleFileSnapshotManifest_ACU(manifest)) {
            const targetIndexId = normalizeKeyPart_ACU(manifest.indexId);
            const targetCheckpointId = getManifestCheckpointId_ACU(manifest);
            const targetChatKey = normalizeKeyPart_ACU(manifest.chatKey);
            const targetIsolationKey = normalizeKeyPart_ACU(manifest.isolationKey);
            const targetSourceTableKey = normalizeKeyPart_ACU(manifest.sourceTableKey);
            const db = await openDb_ACU();
            const records = await new Promise<Array<VectorIndexHotCacheChunkRecord_ACU>>((resolve, reject) => {
                const tx = db.transaction(STORE_NAME_ACU, 'readwrite');
                const store = tx.objectStore(STORE_NAME_ACU);
                const index = store.index('indexId');
                const loaded: Array<VectorIndexHotCacheChunkRecord_ACU> = [];
                const now = Date.now();
                const request = index.openCursor(IDBKeyRange.only(targetIndexId));
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (cursor) {
                        const record = cursor.value as VectorIndexHotCacheChunkRecord_ACU;
                        if (record.chatKey === targetChatKey
                            && record.isolationKey === targetIsolationKey
                            && record.sourceTableKey === targetSourceTableKey
                            && record.checkpointId === targetCheckpointId
                            && record.chunk?.vector?.length > 0) {
                            record.lastAccessAt = now;
                            store.put(record);
                            loaded.push(record);
                        }
                        cursor.continue();
                    }
                };
                request.onerror = () => reject(request.error || new Error('读取交火向量热缓存失败（单文件快照）'));
                tx.oncomplete = () => { db.close(); resolve(loaded); };
                tx.onerror = () => { db.close(); reject(tx.error || new Error('读取交火向量热缓存事务失败（单文件快照）')); };
            });
            if (records.length === 0) return null;
            return records
                .map((record) => cloneChunk_ACU(record.chunk))
                .sort((left, right) => left.sequence - right.sequence || left.chunkId.localeCompare(right.chunkId));
        }

        // ── 旧版内容寻址模式：通过 chunkRefs 逐条读取 ──
        const refs = getActiveChunkRefs_ACU(manifest);
        if (refs.length === 0) return null;
        const db = await openDb_ACU();
        const records = await new Promise<Array<VectorIndexHotCacheChunkRecord_ACU | undefined>>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME_ACU, 'readwrite');
            const store = tx.objectStore(STORE_NAME_ACU);
            const loaded: Array<VectorIndexHotCacheChunkRecord_ACU | undefined> = [];
            let pending = refs.length;
            const finishOne = (): void => {
                pending -= 1;
                if (pending === 0) resolve(loaded);
            };
            refs.forEach((ref, index) => {
                const request = store.get(buildRecordKey_ACU(manifest.indexId, ref.chunkId, ref.chunkKey)) as IDBRequest<VectorIndexHotCacheChunkRecord_ACU | undefined>;
                request.onsuccess = () => {
                    const record = request.result;
                    if (record && isRecordCompatible_ACU(record, manifest, ref)) {
                        record.lastAccessAt = Date.now();
                        store.put(record);
                        loaded[index] = record;
                    }
                    finishOne();
                };
                request.onerror = () => reject(request.error || new Error('读取交火向量热缓存失败'));
            });
            tx.oncomplete = () => db.close();
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('读取交火向量热缓存事务失败'));
            };
        });
        if (records.length !== refs.length || records.some((record) => !record)) return null;
        return records
            .map((record) => cloneChunk_ACU(record!.chunk))
            .sort((left, right) => left.sequence - right.sequence || left.chunkId.localeCompare(right.chunkId));
    } catch {
        return null;
    }
}

export async function deleteSummaryVectorHotCacheByIndex_ACU(indexId: string): Promise<void> {
    try {
        const targetIndexId = normalizeKeyPart_ACU(indexId);
        if (!targetIndexId) return;
        const db = await openDb_ACU();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME_ACU, 'readwrite');
            const store = tx.objectStore(STORE_NAME_ACU);
            const index = store.index('indexId');
            const request = index.openCursor(IDBKeyRange.only(targetIndexId));
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
            request.onerror = () => reject(request.error || new Error('清理交火向量热缓存失败'));
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('清理交火向量热缓存事务失败'));
            };
        });
    } catch {}
}

export async function deleteSummaryVectorHotCacheByScope_ACU(scope: VectorIndexHotCacheScope_ACU): Promise<void> {
    try {
        const chatKey = normalizeKeyPart_ACU(scope.chatKey);
        const isolationKey = normalizeKeyPart_ACU(scope.isolationKey);
        const sourceTableKey = normalizeKeyPart_ACU(scope.sourceTableKey);
        if (!chatKey && !isolationKey && !sourceTableKey) return;
        const db = await openDb_ACU();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME_ACU, 'readwrite');
            const store = tx.objectStore(STORE_NAME_ACU);
            const request = store.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    const record = cursor.value as VectorIndexHotCacheChunkRecord_ACU;
                    const matches = (!chatKey || record.chatKey === chatKey)
                        && (!isolationKey || record.isolationKey === isolationKey)
                        && (!sourceTableKey || record.sourceTableKey === sourceTableKey);
                    if (matches) cursor.delete();
                    cursor.continue();
                }
            };
            request.onerror = () => reject(request.error || new Error('按作用域清理交火向量热缓存失败'));
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('按作用域清理交火向量热缓存事务失败'));
            };
        });
    } catch {}
}

export async function clearSummaryVectorHotCache_ACU(): Promise<void> {
    try {
        const db = await openDb_ACU();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME_ACU, 'readwrite');
            const store = tx.objectStore(STORE_NAME_ACU);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error('清空交火向量热缓存失败'));
            tx.oncomplete = () => db.close();
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('清空交火向量热缓存事务失败'));
            };
        });
    } catch {}
}

export async function estimateSummaryVectorHotCache_ACU(indexId?: string): Promise<{ bytes: number; count: number }> {
    try {
        const targetIndexId = normalizeKeyPart_ACU(indexId);
        const db = await openDb_ACU();
        return await new Promise((resolve, reject) => {
            let bytes = 0;
            let count = 0;
            const tx = db.transaction(STORE_NAME_ACU, 'readonly');
            const store = tx.objectStore(STORE_NAME_ACU);
            const source = targetIndexId ? store.index('indexId') : store;
            const request = targetIndexId
                ? source.openCursor(IDBKeyRange.only(targetIndexId))
                : source.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    const record = cursor.value as VectorIndexHotCacheChunkRecord_ACU;
                    bytes += Math.max(0, Number(record.byteSize) || 0);
                    count += 1;
                    cursor.continue();
                }
            };
            request.onerror = () => reject(request.error || new Error('估算交火向量热缓存失败'));
            tx.oncomplete = () => {
                db.close();
                resolve({ bytes, count });
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('估算交火向量热缓存事务失败'));
            };
        });
    } catch {
        return { bytes: 0, count: 0 };
    }
}

function normalizeFlushTaskStatus_ACU(status: any): SummaryVectorIndexFlushTaskStatus_ACU {
    return status === 'queued'
        || status === 'flushing'
        || status === 'ready'
        || status === 'failed_retryable'
        || status === 'failed_terminal'
        ? status
        : 'dirty';
}

function normalizeFlushTaskMode_ACU(mode: any): SummaryVectorIndexFlushTaskMode_ACU {
    return mode === 'append' ? 'append' : 'sync';
}

function cloneFlushTask_ACU(task: SummaryVectorIndexFlushTaskRecord_ACU): SummaryVectorIndexFlushTaskRecord_ACU {
    return {
        scopeKey: normalizeKeyPart_ACU(task.scopeKey),
        chatKey: normalizeKeyPart_ACU(task.chatKey),
        isolationKey: normalizeKeyPart_ACU(task.isolationKey),
        sourceTableKey: normalizeKeyPart_ACU(task.sourceTableKey),
        ...(Number.isFinite(Number(task.targetMessageIndex)) ? { targetMessageIndex: Number(task.targetMessageIndex) } : {}),
        mode: normalizeFlushTaskMode_ACU(task.mode),
        status: normalizeFlushTaskStatus_ACU(task.status),
        requestedAt: Math.max(0, Number(task.requestedAt) || 0),
        debounceUntil: Math.max(0, Number(task.debounceUntil) || 0),
        attemptCount: Math.max(0, Number(task.attemptCount) || 0),
        ...(Number.isFinite(Number(task.lastAttemptAt)) ? { lastAttemptAt: Number(task.lastAttemptAt) } : {}),
        ...(Number.isFinite(Number(task.lastSuccessAt)) ? { lastSuccessAt: Number(task.lastSuccessAt) } : {}),
        ...(task.lastError ? { lastError: String(task.lastError) } : {}),
        updatedAt: Math.max(0, Number(task.updatedAt) || 0),
    };
}

export async function upsertSummaryVectorFlushTask_ACU(input: SummaryVectorIndexFlushTaskUpsert_ACU): Promise<SummaryVectorIndexFlushTaskRecord_ACU | null> {
    try {
        const scopeKey = normalizeKeyPart_ACU(input.scopeKey);
        const chatKey = normalizeKeyPart_ACU(input.chatKey);
        const isolationKey = normalizeKeyPart_ACU(input.isolationKey);
        const sourceTableKey = normalizeKeyPart_ACU(input.sourceTableKey);
        if (!scopeKey || !chatKey) return null;
        const now = Date.now();
        const db = await openDb_ACU();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(FLUSH_TASK_STORE_NAME_ACU, 'readwrite');
            const store = tx.objectStore(FLUSH_TASK_STORE_NAME_ACU);
            const getRequest = store.get(scopeKey) as IDBRequest<SummaryVectorIndexFlushTaskRecord_ACU | undefined>;
            let nextRecord: SummaryVectorIndexFlushTaskRecord_ACU | null = null;
            getRequest.onsuccess = () => {
                const previous = getRequest.result ? cloneFlushTask_ACU(getRequest.result) : null;
                const previousAttemptCount = previous?.attemptCount || 0;
                const nextStatus = normalizeFlushTaskStatus_ACU(input.status);
                nextRecord = {
                    scopeKey,
                    chatKey,
                    isolationKey,
                    sourceTableKey,
                    ...(Number.isFinite(Number(input.targetMessageIndex)) ? { targetMessageIndex: Number(input.targetMessageIndex) } : previous?.targetMessageIndex != null ? { targetMessageIndex: previous.targetMessageIndex } : {}),
                    mode: normalizeFlushTaskMode_ACU(input.mode),
                    status: nextStatus,
                    requestedAt: Math.max(0, Number(input.requestedAt ?? previous?.requestedAt ?? now) || now),
                    debounceUntil: Math.max(0, Number(input.debounceUntil ?? previous?.debounceUntil ?? now) || now),
                    attemptCount: nextStatus === 'flushing' ? previousAttemptCount + 1 : previousAttemptCount,
                    ...(nextStatus === 'flushing' ? { lastAttemptAt: now } : previous?.lastAttemptAt ? { lastAttemptAt: previous.lastAttemptAt } : {}),
                    ...(nextStatus === 'ready' ? { lastSuccessAt: now } : previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
                    ...(input.lastError ? { lastError: String(input.lastError) } : nextStatus === 'ready' ? {} : previous?.lastError ? { lastError: previous.lastError } : {}),
                    updatedAt: now,
                };
                store.put(nextRecord);
            };
            getRequest.onerror = () => reject(getRequest.error || new Error('读取交火向量 flush task 失败'));
            tx.oncomplete = () => {
                db.close();
                resolve(nextRecord ? cloneFlushTask_ACU(nextRecord) : null);
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('写入交火向量 flush task 事务失败'));
            };
        });
    } catch {
        return null;
    }
}

export async function getSummaryVectorFlushTask_ACU(scopeKey: string): Promise<SummaryVectorIndexFlushTaskRecord_ACU | null> {
    try {
        const normalizedScopeKey = normalizeKeyPart_ACU(scopeKey);
        if (!normalizedScopeKey) return null;
        const db = await openDb_ACU();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(FLUSH_TASK_STORE_NAME_ACU, 'readonly');
            const store = tx.objectStore(FLUSH_TASK_STORE_NAME_ACU);
            const request = store.get(normalizedScopeKey) as IDBRequest<SummaryVectorIndexFlushTaskRecord_ACU | undefined>;
            request.onsuccess = () => resolve(request.result ? cloneFlushTask_ACU(request.result) : null);
            request.onerror = () => reject(request.error || new Error('读取交火向量 flush task 失败'));
            tx.oncomplete = () => db.close();
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('读取交火向量 flush task 事务失败'));
            };
        });
    } catch {
        return null;
    }
}

export async function listSummaryVectorFlushTasks_ACU(scope?: VectorIndexHotCacheScope_ACU): Promise<SummaryVectorIndexFlushTaskRecord_ACU[]> {
    try {
        const chatKey = normalizeKeyPart_ACU(scope?.chatKey);
        const isolationKey = normalizeKeyPart_ACU(scope?.isolationKey);
        const sourceTableKey = normalizeKeyPart_ACU(scope?.sourceTableKey);
        const db = await openDb_ACU();
        return await new Promise((resolve, reject) => {
            const records: SummaryVectorIndexFlushTaskRecord_ACU[] = [];
            const tx = db.transaction(FLUSH_TASK_STORE_NAME_ACU, 'readonly');
            const store = tx.objectStore(FLUSH_TASK_STORE_NAME_ACU);
            const request = store.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    const record = cloneFlushTask_ACU(cursor.value as SummaryVectorIndexFlushTaskRecord_ACU);
                    const matches = (!chatKey || record.chatKey === chatKey)
                        && (!isolationKey || record.isolationKey === isolationKey)
                        && (!sourceTableKey || record.sourceTableKey === sourceTableKey);
                    if (matches) records.push(record);
                    cursor.continue();
                }
            };
            request.onerror = () => reject(request.error || new Error('列出交火向量 flush task 失败'));
            tx.oncomplete = () => {
                db.close();
                resolve(records.sort((left, right) => left.debounceUntil - right.debounceUntil || left.scopeKey.localeCompare(right.scopeKey)));
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('列出交火向量 flush task 事务失败'));
            };
        });
    } catch {
        return [];
    }
}

export async function deleteSummaryVectorFlushTask_ACU(scopeKey: string): Promise<void> {
    try {
        const normalizedScopeKey = normalizeKeyPart_ACU(scopeKey);
        if (!normalizedScopeKey) return;
        const db = await openDb_ACU();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(FLUSH_TASK_STORE_NAME_ACU, 'readwrite');
            const store = tx.objectStore(FLUSH_TASK_STORE_NAME_ACU);
            const request = store.delete(normalizedScopeKey);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error || new Error('删除交火向量 flush task 失败'));
            tx.oncomplete = () => db.close();
            tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('删除交火向量 flush task 事务失败'));
            };
        });
    } catch {}
}

export async function clearSummaryVectorFlushTasksByScope_ACU(scope: VectorIndexHotCacheScope_ACU): Promise<void> {
    const tasks = await listSummaryVectorFlushTasks_ACU(scope);
    for (const task of tasks) {
        await deleteSummaryVectorFlushTask_ACU(task.scopeKey);
    }
}

export async function estimateSummaryVectorFlushTasks_ACU(scope?: VectorIndexHotCacheScope_ACU): Promise<SummaryVectorIndexFlushTaskEstimate_ACU> {
    const tasks = await listSummaryVectorFlushTasks_ACU(scope);
    const estimate: SummaryVectorIndexFlushTaskEstimate_ACU = {
        total: tasks.length,
        dirty: 0,
        queued: 0,
        flushing: 0,
        ready: 0,
        failedRetryable: 0,
        failedTerminal: 0,
    };
    tasks.forEach((task) => {
        if (task.status === 'dirty') estimate.dirty += 1;
        else if (task.status === 'queued') estimate.queued += 1;
        else if (task.status === 'flushing') estimate.flushing += 1;
        else if (task.status === 'ready') estimate.ready += 1;
        else if (task.status === 'failed_retryable') estimate.failedRetryable += 1;
        else if (task.status === 'failed_terminal') estimate.failedTerminal += 1;
        if (task.lastError) estimate.lastError = task.lastError;
    });
    return estimate;
}
