import { describe, expect, it, vi } from 'vitest';
import { reconstructTablesFromChatDeltas_ACU } from '../../../src/service/table/table-delta-reconstruct';
import { rollupCheckpointBeforePurge_ACU } from '../../../src/service/table/table-delta-retention';
import type { TableLayerDeltaV2_ACU } from '../../../src/service/table/table-delta-types';

vi.mock('../../../src/shared/utils', async () => {
  const actual = await vi.importActual<any>('../../../src/shared/utils');
  return {
    ...actual,
    logWarn_ACU: vi.fn(),
  };
});

const isolationConfig = {
  dataIsolationEnabled: false,
  dataIsolationCode: '',
} as any;

function checkpointLayer(id: string, rows: string[][], source: 'template-seed' | 'retention-rollup' | 'legacy-migration' = 'template-seed') {
  return {
    version: 2,
    checkpoint: {
      kind: 'checkpoint',
      version: 2,
      checkpointId: id,
      createdAt: '2026-05-08T00:00:00.000Z',
      source,
      isolationKey: '',
      data: {
        mate: { type: 'chatSheets', version: 1 },
        sheet_0: { name: '物品表', content: [['row_id', '物品名'], ...rows] },
      },
    },
  };
}

function deltaLayer(id: string, rows: string[][]): { version: 2; delta: TableLayerDeltaV2_ACU } {
  return {
    version: 2,
    delta: {
      kind: 'delta',
      version: 2,
      deltaId: id,
      createdAt: '2026-05-08T00:00:00.000Z',
      isolationKey: '',
      messageIndexHint: 0,
      changedSheets: ['sheet_0'],
      modifiedKeys: ['sheet_0'],
      updateGroupKeys: ['sheet_0'],
      changesBySheet: {
        sheet_0: {
          sheetKey: 'sheet_0',
          sheetName: '物品表',
          rowChanges: rows.map((row, index) => ({
            op: 'upsert' as const,
            rowId: row[0],
            rowIndexHint: index + 1,
            row,
          })),
        },
      },
    },
  };
}

function v2Message(layer: any, extra: Record<string, any> = {}) {
  return {
    is_user: false,
    TavernDB_ACU_IsolatedData: {
      '': {
        tablePersistenceV2: layer,
        ...extra,
      },
    },
  };
}

function getSheetContent_ACU(data: any, sheetKey: string) {
  const sheet = data?.[sheetKey];
  return sheet && Array.isArray(sheet.content) ? sheet.content : undefined;
}

function reconstructRows(chat: any[]) {
  const result = reconstructTablesFromChatDeltas_ACU(chat, {
    isolationKey: '',
    isolationConfig,
  }, {
    allowLegacyMigration: false,
  });
  return getSheetContent_ACU(result.data, 'sheet_0');
}

describe('rollupCheckpointBeforePurge_ACU', () => {
  it('retainRecentLayers 未超过时不清理也不写 checkpoint', () => {
    const chat: any[] = [
      { is_user: false },
      v2Message(checkpointLayer('cp-1', [['1', '剑']])),
      v2Message(deltaLayer('d-1', [['2', '盾']])),
    ];

    const result = rollupCheckpointBeforePurge_ACU({
      chat,
      isolationKey: '',
      isolationConfig,
      retainCount: 5,
      dataMessageIndices: [1, 2],
    });

    expect(result.changed).toBe(false);
    expect(result.purgedMessageIndices).toEqual([]);
    expect(chat[2].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint).toBeUndefined();
  });

  it('超过保留层后生成 boundary checkpoint 并清理旧表格层', () => {
    const chat: any[] = [
      { is_user: false },
      v2Message(checkpointLayer('cp-1', [['1', '剑']])),
      v2Message(deltaLayer('d-1', [['2', '盾']])),
      v2Message(deltaLayer('d-2', [['3', '药水']])),
    ];
    const beforeRows = reconstructRows(chat);

    const result = rollupCheckpointBeforePurge_ACU({
      chat,
      isolationKey: '',
      isolationConfig,
      retainCount: 1,
      dataMessageIndices: [1, 2, 3],
    });

    expect(result.changed).toBe(true);
    expect(result.boundaryMessageIndex).toBe(3);
    expect(result.purgedMessageIndices).toEqual([1, 2]);
    expect(chat[1].TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(chat[2].TavernDB_ACU_IsolatedData).toBeUndefined();
    const boundaryLayer = chat[3].TavernDB_ACU_IsolatedData[''].tablePersistenceV2;
    expect(boundaryLayer.checkpoint.source).toBe('retention-rollup');
    expect(boundaryLayer.checkpoint.data.sheet_0.content).toEqual([
      ['row_id', '物品名'],
      ['2', '盾'],
      ['1', '剑'],
    ]);
    expect(reconstructRows(chat)).toEqual(beforeRows);
  });

  it('boundary 原本有 delta 时保留 delta 并按 checkpoint 后 delta 重建', () => {
    const chat: any[] = [
      { is_user: false },
      v2Message(checkpointLayer('cp-1', [['1', '剑']])),
      v2Message(deltaLayer('d-1', [['2', '盾']])),
      v2Message(deltaLayer('d-2', [['3', '药水']])),
    ];

    rollupCheckpointBeforePurge_ACU({
      chat,
      isolationKey: '',
      isolationConfig,
      retainCount: 1,
      dataMessageIndices: [1, 2, 3],
    });

    const boundaryLayer = chat[3].TavernDB_ACU_IsolatedData[''].tablePersistenceV2;
    expect(boundaryLayer.delta.deltaId).toBe('d-2');
    expect(reconstructRows(chat)).toEqual([
      ['row_id', '物品名'],
      ['3', '药水'],
      ['2', '盾'],
      ['1', '剑'],
    ]);
  });

  it('连续多次 retention 推进后仍能重建完整数据', () => {
    const chat: any[] = [
      { is_user: false },
      v2Message(checkpointLayer('cp-1', [['1', '剑']])),
      v2Message(deltaLayer('d-1', [['2', '盾']])),
      v2Message(deltaLayer('d-2', [['3', '药水']])),
      v2Message(deltaLayer('d-3', [['4', '金币']])),
    ];
    const beforeRows = reconstructRows(chat);

    rollupCheckpointBeforePurge_ACU({
      chat,
      isolationKey: '',
      isolationConfig,
      retainCount: 2,
      dataMessageIndices: [1, 2, 3, 4],
    });
    rollupCheckpointBeforePurge_ACU({
      chat,
      isolationKey: '',
      isolationConfig,
      retainCount: 1,
      dataMessageIndices: [3, 4],
    });

    expect(chat[3].TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(chat[4].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.source).toBe('retention-rollup');
    expect(reconstructRows(chat)).toEqual(beforeRows);
  });

  it('legacy 数据在 retention 前被 rollup 为 boundary checkpoint 后再清理', () => {
    const chat: any[] = [
      { is_user: false },
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] },
        },
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
      },
      v2Message(deltaLayer('d-1', [['2', '盾']])),
    ];

    const result = rollupCheckpointBeforePurge_ACU({
      chat,
      isolationKey: '',
      isolationConfig,
      retainCount: 1,
      dataMessageIndices: [1, 2],
    });

    expect(result.changed).toBe(true);
    expect(chat[1].TavernDB_ACU_IndependentData).toBeUndefined();
    expect(chat[2].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.source).toBe('retention-rollup');
    expect(reconstructRows(chat)).toEqual([
      ['row_id', '物品名'],
      ['2', '盾'],
      ['1', '剑'],
    ]);
  });

  it('retention 前遇到 legacy + delta-only 链路时 rollup checkpoint 包含完整迁移基线', () => {
    const chat: any[] = [
      { is_user: false },
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: { name: '物品表', content: [['row_id', '物品名'], ['1', '剑']] },
        },
      },
      v2Message(deltaLayer('d-1', [['2', '盾']])),
      v2Message(deltaLayer('d-2', [['3', '药水']])),
    ];

    rollupCheckpointBeforePurge_ACU({
      chat,
      isolationKey: '',
      isolationConfig,
      retainCount: 1,
      dataMessageIndices: [1, 2, 3],
    });

    const boundaryLayer = chat[3].TavernDB_ACU_IsolatedData[''].tablePersistenceV2;
    expect(boundaryLayer.checkpoint.source).toBe('retention-rollup');
    expect(boundaryLayer.checkpoint.data.sheet_0.content).toEqual([
      ['row_id', '物品名'],
      ['2', '盾'],
      ['1', '剑'],
    ]);
    expect(reconstructRows(chat)).toEqual([
      ['row_id', '物品名'],
      ['3', '药水'],
      ['2', '盾'],
      ['1', '剑'],
    ]);
  });

  it('清理表格层时保留 summary vector manifest', () => {
    const chat: any[] = [
      { is_user: false },
      v2Message(checkpointLayer('cp-1', [['1', '剑']]), {
        summaryVectorIndexManifest: { file: 'manifest.json' },
        summaryVectorIndexState: { manifest: { file: 'manifest.json' } },
      }),
      v2Message(deltaLayer('d-1', [['2', '盾']])),
    ];

    rollupCheckpointBeforePurge_ACU({
      chat,
      isolationKey: '',
      isolationConfig,
      retainCount: 1,
      dataMessageIndices: [1, 2],
    });

    expect(chat[1].TavernDB_ACU_IsolatedData[''].tablePersistenceV2).toBeUndefined();
    expect(chat[1].TavernDB_ACU_IsolatedData[''].summaryVectorIndexManifest).toEqual({ file: 'manifest.json' });
    expect(chat[1].TavernDB_ACU_IsolatedData[''].summaryVectorIndexState).toEqual({ manifest: { file: 'manifest.json' } });
  });
});
