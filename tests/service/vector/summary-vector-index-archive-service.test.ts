import { describe, expect, it } from 'vitest';

import { cloneIsolationTagDataForSummaryVectorWrite_ACU } from '../../../src/service/vector/summary-vector-index-archive-service';

describe('summary-vector-index-archive-service', () => {
  function makeTablePersistenceLayer() {
    return {
      version: 2,
      checkpoint: {
        kind: 'checkpoint',
        version: 2,
        checkpointId: 'cp-1',
        createdAt: '2026-05-09T00:00:00.000Z',
        source: 'ai-output',
        isolationKey: '',
        data: {
          mate: { type: 'chatSheets', version: 1 },
          sheet_0: {
            name: '角色状态',
            content: [
              ['row_id', 'name'],
              ['1', '艾莉丝'],
            ],
          },
        },
      },
    };
  }

  it('为纪要向量索引写入克隆隔离槽时保留 tablePersistenceV2 与未知兄弟字段', () => {
    const tablePersistenceV2 = makeTablePersistenceLayer();
    const existingTagData: any = {
      independentData: {},
      modifiedKeys: ['sheet_0'],
      updateGroupKeys: ['sheet_0'],
      tablePersistenceV2,
      vectorMemoryState: { enabled: true },
      _acu_base_state: 'seeded',
      customFutureField: { keep: 'me' },
      summaryVectorIndexManifest: { indexId: 'old-index' },
      summaryVectorIndexState: { manifest: { indexId: 'old-index' } },
    };

    const cloned = cloneIsolationTagDataForSummaryVectorWrite_ACU(existingTagData);

    expect(cloned.tablePersistenceV2).toEqual(tablePersistenceV2);
    expect(cloned.customFutureField).toEqual({ keep: 'me' });
    expect(cloned.vectorMemoryState).toEqual({ enabled: true });
    expect(cloned._acu_base_state).toBe('seeded');
    expect(cloned.modifiedKeys).toEqual(['sheet_0']);
    expect(cloned.updateGroupKeys).toEqual(['sheet_0']);
    expect(cloned.summaryVectorIndexManifest).toEqual({ indexId: 'old-index' });
    expect(cloned.summaryVectorIndexState).toEqual({ manifest: { indexId: 'old-index' } });
  });

  it('为纪要向量索引写入克隆隔离槽时规范化缺失的 legacy 兼容字段但不丢 V2 层', () => {
    const tablePersistenceV2 = makeTablePersistenceLayer();

    const cloned = cloneIsolationTagDataForSummaryVectorWrite_ACU({
      tablePersistenceV2,
      modifiedKeys: 'not-array',
      updateGroupKeys: null,
    });

    expect(cloned.independentData).toEqual({});
    expect(cloned.modifiedKeys).toEqual([]);
    expect(cloned.updateGroupKeys).toEqual([]);
    expect(cloned.tablePersistenceV2).toEqual(tablePersistenceV2);
  });
});
