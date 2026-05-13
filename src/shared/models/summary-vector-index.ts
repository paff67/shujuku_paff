export type SummaryVectorIndexBackend_ACU = 'embedded' | 'st-files';

export type SummaryVectorIndexManifestStatus_ACU =
    | 'building'
    | 'uploading'
    | 'ready'
    | 'missing'
    | 'corrupt'
    | 'incompatible'
    | 'upload_failed'
    | 'rebuild_required'
    | 'delete_pending'
    | 'delete_failed'
    | 'superseded';

export type SummaryVectorIndexExternalFileRole_ACU =
    | 'manifest'
    | 'row_index'
    | 'tombstone'
    | 'base_shard'
    | 'delta_shard'
    | 'vector_chunk'
    | 'vector_pack'
    | 'registry';

export interface ChatSummaryVectorIndexChunk_ACU {
    chunkId: string;
    rowKey: string;
    rowOrder: number;
    text: string;
    vector: number[];
    sequence: number;
    sourceFingerprint?: string;
    textHash?: string;
    shardId?: string;
    shardRole?: 'base' | 'delta';
    chunkKeys?: string[];
}

export interface SummaryVectorIndexChunkRef_ACU {
    chunkKey: string;
    chunkId: string;
    rowKey: string;
    /**
     * 兼容字段：旧 content_addressed_chunks 下指向单 chunk 文件；
     * content_addressed_packs 下指向所属 pack 文件，不表示 chunk 级文件。
     */
    path: string;
    /** chunk blob 级校验值，不得替换为 pack 文件级 checksum。 */
    checksum: string;
    /** chunk blob 级大小，不得替换为 pack 文件大小。 */
    byteSize: number;
    embeddingModel: string;
    dimension: number;
    sourceFingerprint?: string;
    textHash?: string;
    packKey?: string;
    packPath?: string;
    createdAt: string;
    updatedAt: string;
    status: SummaryVectorIndexManifestStatus_ACU;
}

export interface SummaryVectorIndexPackRef_ACU {
    packKey: string;
    path: string;
    checksum: string;
    byteSize: number;
    chunkKeys: string[];
    chunkCount: number;
    rowCount: number;
    embeddingModel: string;
    dimension: number;
    createdAt: string;
    updatedAt: string;
    status: SummaryVectorIndexManifestStatus_ACU;
}

export interface SummaryVectorIndexContentAddressedInfo_ACU {
    version: number;
    mode: 'content_addressed_chunks' | 'content_addressed_packs';
    chunkRefs: SummaryVectorIndexChunkRef_ACU[];
    activeChunkKeys: string[];
    packRefs?: SummaryVectorIndexPackRef_ACU[];
}

export interface SummaryVectorIndexCheckpoint_ACU {
    version: number;
    checkpointId: string;
    manifestKey: string;
    sourceTableKey: string;
    snapshotMessageId: string;
    rowCount: number;
    chunkCount: number;
    activeRowKeys: string[];
    createdAt: string;
}

export interface ChatSummaryVectorIndexRow_ACU {
    rowKey: string;
    rowId: string;
    rowOrder: number;
    timeSpan: string;
    location: string;
    summary: string;
    indexCode: string;
    vectorSourceText: string;
    chunkIds: string[];
    sourceFingerprint?: string;
    shardIds?: string[];
    chunkKeys?: string[];
    status?: 'active' | 'removed' | 'replaced';
    updatedAt?: string;
}

export interface ChatSummaryVectorIndexState_ACU {
    version?: number;
    backend?: SummaryVectorIndexBackend_ACU;
    status?: SummaryVectorIndexManifestStatus_ACU;
    indexId?: string;
    snapshotMessageId: string;
    sourceTableKey: string;
    sourceTableName: string;
    indexedAt: string;
    rowCount: number;
    chunkCount: number;
    skippedRowCount: number;
    rows: ChatSummaryVectorIndexRow_ACU[];
    /**
     * 兼容旧版内嵌向量。新外置模式下聊天记录不应再写入该字段。
     */
    chunks?: ChatSummaryVectorIndexChunk_ACU[];
    manifest?: ChatSummaryVectorIndexManifest_ACU;
}

export interface SummaryVectorIndexExternalFileRef_ACU {
    role: SummaryVectorIndexExternalFileRole_ACU;
    path: string;
    shardId?: string;
    byteSize: number;
    checksum: string;
    chunkCount?: number;
    rowCount?: number;
    createdAt: string;
    updatedAt: string;
    status: SummaryVectorIndexManifestStatus_ACU;
}

export interface SummaryVectorIndexBatchRef_ACU {
    batchId: string;
    indexId: string;
    createdAt: string;
    updatedAt: string;
    rowKeys: string[];
    chunkIds: string[];
    files: SummaryVectorIndexExternalFileRef_ACU[];
    rowCount: number;
    chunkCount: number;
    sourceMessageIndex?: number;
    sourceSnapshotMessageId?: string;
    status: SummaryVectorIndexManifestStatus_ACU;
}

export interface SummaryVectorIndexSnapshotInfo_ACU {
    revision: number;
    mode: 'snapshot' | 'single_file_snapshot';
    parentIndexIds: string[];
    activeRowKeys: string[];
    activeChunkIds?: string[];
    removedRowKeys: string[];
    replacedRowKeys: string[];
    batchIds: string[];
}

export interface ChatSummaryVectorIndexManifest_ACU {
    version: number;
    backend: 'st-files';
    status: SummaryVectorIndexManifestStatus_ACU;
    indexId: string;
    chatKey: string;
    isolationKey: string;
    snapshotMessageId: string;
    sourceTableKey: string;
    sourceTableName: string;
    indexedAt: string;
    updatedAt: string;
    rowCount: number;
    chunkCount: number;
    skippedRowCount: number;
    embeddingModel: string;
    dimension: number;
    rowsFile: string;
    tombstoneFile: string;
    manifestFile: string;
    files: SummaryVectorIndexExternalFileRef_ACU[];
    baseShardCount: number;
    deltaShardCount: number;
    tombstoneRowCount: number;
    tombstoneChunkCount: number;
    externalTotalBytes: number;
    cacheTotalBytes?: number;
    lastCompactAt?: string;
    error?: string;
    /**
     * v2 快照协议：最新楼层 manifest 可引用多个批次文件，召回时按该列表拼接完整向量库。
     * 旧版 manifest 没有该字段，读取端必须回退到 files 中的 base_shard/delta_shard。
     */
    snapshot?: SummaryVectorIndexSnapshotInfo_ACU;
    batchRefs?: SummaryVectorIndexBatchRef_ACU[];
    /**
     * v3 内容寻址协议：聊天楼层保存轻量 checkpoint，manifest 保存 row -> chunkKey 引用，
     * 向量 chunk 按内容 hash 外置去重。旧版读取端忽略该字段，新版读取端优先使用该字段。
     */
    checkpoint?: SummaryVectorIndexCheckpoint_ACU;
    contentAddressed?: SummaryVectorIndexContentAddressedInfo_ACU;
}

export interface SummaryVectorIndexRowIndexEntry_ACU {
    rowKey: string;
    rowId: string;
    rowOrder: number;
    summaryKey: string;
    sourceFingerprint: string;
    indexCode: string;
    chunkIds: string[];
    shardIds: string[];
    chunkKeys?: string[];
    status: 'active' | 'removed' | 'replaced';
    updatedAt: string;
}

export interface SummaryVectorIndexRowIndex_ACU {
    version: number;
    indexId: string;
    updatedAt: string;
    rows: Record<string, SummaryVectorIndexRowIndexEntry_ACU>;
}

export interface SummaryVectorIndexTombstoneEntry_ACU {
    rowKey: string;
    chunkIds: string[];
    reason: 'row_deleted' | 'row_replaced' | 'index_deleted' | 'compact';
    removedAt: string;
}

export interface SummaryVectorIndexTombstone_ACU {
    version: number;
    indexId: string;
    updatedAt: string;
    removedRows: Record<string, SummaryVectorIndexTombstoneEntry_ACU>;
    removedChunks: Record<string, { rowKey: string; removedAt: string }>;
}

export interface SummaryVectorIndexShard_ACU {
    version: number;
    indexId: string;
    shardId: string;
    role: 'base' | 'delta';
    createdAt: string;
    updatedAt: string;
    chunks: ChatSummaryVectorIndexChunk_ACU[];
}

export interface SummaryVectorIndexRegistryFile_ACU {
    version: number;
    updatedAt: string;
    files: SummaryVectorIndexExternalFileRef_ACU[];
}

export interface SummaryVectorIndexSnapshotTagData_ACU {
    summaryVectorIndexState?: ChatSummaryVectorIndexState_ACU | null;
    summaryVectorIndexManifest?: ChatSummaryVectorIndexManifest_ACU | null;
}

export interface SummaryVectorIndexSnapshotLayer_ACU {
    messageIndex: number;
    isolationKey: string;
    summaryVectorIndexState: ChatSummaryVectorIndexState_ACU | null;
    tagData: SummaryVectorIndexSnapshotTagData_ACU | null;
}

export interface SummaryVectorIndexAggregatedSnapshot_ACU {
    summaryVectorIndexState: ChatSummaryVectorIndexState_ACU | null;
    layers: SummaryVectorIndexSnapshotLayer_ACU[];
    rowOwners: Map<string, { messageIndex: number; row: ChatSummaryVectorIndexRow_ACU }>;
}

export interface SummaryVectorIndexStats_ACU {
    status: SummaryVectorIndexManifestStatus_ACU | 'none';
    indexId: string;
    backend: SummaryVectorIndexBackend_ACU | 'none';
    rowCount: number;
    chunkCount: number;
    baseShardCount: number;
    deltaShardCount: number;
    tombstoneRowCount: number;
    tombstoneChunkCount: number;
    externalTotalBytes: number;
    cacheTotalBytes: number;
    tempCacheBytes?: number;
    tempCacheCount?: number;
    hotCacheBytes?: number;
    hotCacheCount?: number;
    flushTaskTotalCount?: number;
    flushTaskDirtyCount?: number;
    flushTaskQueuedCount?: number;
    flushTaskFlushingCount?: number;
    flushTaskFailedCount?: number;
    flushTaskLastError?: string;
    updatedAt: string;
    error?: string;
}

export interface SummaryVectorIndexReachableFile_ACU {
    path: string;
    role?: SummaryVectorIndexExternalFileRole_ACU;
    indexId?: string;
    messageIndex: number;
    isolationKey: string;
    sourceTableKey: string;
    manifestKey: string;
    checksum?: string;
    chunkKey?: string;
    chunkId?: string;
    rowKey?: string;
}

export interface SummaryVectorIndexReachabilityReport_ACU {
    chatKey: string;
    isolationKey?: string;
    sourceTableKey?: string;
    reachablePaths: string[];
    reachableFiles: SummaryVectorIndexReachableFile_ACU[];
    manifestCount: number;
}

export interface SummaryVectorIndexHealthIssue_ACU {
    severity: 'warning' | 'error';
    code: 'missing_file' | 'checksum_mismatch' | 'identity_mismatch' | 'legacy_manifest' | 'unreachable_registered_file' | 'read_error' | 'pack_chunk_missing';
    path: string;
    role?: SummaryVectorIndexExternalFileRole_ACU;
    rowKey?: string;
    chunkId?: string;
    chunkKey?: string;
    messageIndex?: number;
    isolationKey?: string;
    expected?: string;
    actual?: string;
    message: string;
}

export interface SummaryVectorIndexHealthReport_ACU {
    status: 'healthy' | 'degraded' | 'missing' | 'empty';
    checkedAt: string;
    manifestCount: number;
    reachableFileCount: number;
    registeredFileCount: number;
    missingFileCount: number;
    checksumMismatchCount: number;
    identityMismatchCount: number;
    legacyManifestCount: number;
    unreachableRegisteredFileCount: number;
    flushTaskTotalCount?: number;
    flushTaskDirtyCount?: number;
    flushTaskQueuedCount?: number;
    flushTaskFlushingCount?: number;
    flushTaskFailedCount?: number;
    flushTaskLastError?: string;
    repairableRowKeys?: string[];
    issues: SummaryVectorIndexHealthIssue_ACU[];
}

export interface SummaryVectorIndexSafeGcScopeHint_ACU {
    chatKey?: string;
    isolationKey: string;
    sourceTableKey: string;
}

export interface SummaryVectorIndexSafeGcOptions_ACU {
    scopeHints?: SummaryVectorIndexSafeGcScopeHint_ACU[];
}

export interface SummaryVectorIndexSafeGcResult_ACU {
    scannedRegisteredFileCount: number;
    reachableFileCount: number;
    deletedPaths: string[];
    retainedPaths: string[];
    blockedByReachability: string[];
    failedDeletes: Array<{ path: string; error: string }>;
}

export const SUMMARY_VECTOR_INDEX_MANIFEST_VERSION_ACU = 1;
export const SUMMARY_VECTOR_INDEX_REGISTRY_PATH_ACU = 'TavernDB_ACU_vector_registry';
