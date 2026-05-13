import { describe, expect, it } from 'vitest';

import { purgeSheetKeysFromMessage_ACU } from '../../../src/data/repositories/chat-message-data-repo';

describe('purgeSheetKeysFromMessage_ACU — V2 persistence cleanup', () => {
  it('removes purged sheet from V2 checkpoint and delta while preserving other sheets and non-table tag fields', () => {
    const msg: any = {
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          independentData: {
            sheet_0: { name: '旧独立表', content: [['row_id'], ['1']] },
            sheet_1: { name: '保留独立表', content: [['row_id'], ['2']] },
          },
          modifiedKeys: ['sheet_0', 'sheet_1'],
          updateGroupKeys: ['sheet_0', 'sheet_1'],
          summaryVectorIndexManifest: { indexId: 'manifest-1' },
          tablePersistenceV2: {
            version: 2,
            checkpoint: {
              kind: 'checkpoint',
              version: 2,
              checkpointId: 'cp-1',
              createdAt: '2026-05-08T00:00:00.000Z',
              source: 'manual-rebase',
              isolationKey: '',
              data: {
                mate: { type: 'chatSheets' },
                sheet_0: { name: '删除表', content: [['row_id'], ['1']] },
                sheet_1: { name: '保留表', content: [['row_id'], ['2']] },
              },
            },
            delta: {
              kind: 'delta',
              version: 2,
              deltaId: 'delta-1',
              createdAt: '2026-05-08T00:00:00.000Z',
              isolationKey: '',
              changedSheets: ['sheet_0', 'sheet_1'],
              modifiedKeys: ['sheet_0', 'sheet_1'],
              updateGroupKeys: ['sheet_0', 'sheet_1'],
              changesBySheet: {
                sheet_0: {
                  sheetKey: 'sheet_0',
                  rowChanges: [{ op: 'delete', rowId: '1' }],
                },
                sheet_1: {
                  sheetKey: 'sheet_1',
                  rowChanges: [{ op: 'upsert', rowId: '2', row: ['2'] }],
                },
              },
            },
          },
        },
      },
    };

    const changed = purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);

    expect(changed).toBe(true);
    const tagData = msg.TavernDB_ACU_IsolatedData[''];
    expect(tagData.independentData.sheet_0).toBeUndefined();
    expect(tagData.independentData.sheet_1).toBeDefined();
    expect(tagData.modifiedKeys).toEqual(['sheet_1']);
    expect(tagData.updateGroupKeys).toEqual(['sheet_1']);
    expect(tagData.summaryVectorIndexManifest).toEqual({ indexId: 'manifest-1' });

    const layer = tagData.tablePersistenceV2;
    expect(layer.version).toBe(2);
    expect(layer.checkpoint.data.sheet_0).toBeUndefined();
    expect(layer.checkpoint.data.sheet_1).toBeDefined();
    expect(layer.checkpoint.data.mate).toEqual({ type: 'chatSheets' });
    expect(layer.delta.changedSheets).toEqual(['sheet_1']);
    expect(layer.delta.modifiedKeys).toEqual(['sheet_1']);
    expect(layer.delta.updateGroupKeys).toEqual(['sheet_1']);
    expect(layer.delta.changesBySheet.sheet_0).toBeUndefined();
    expect(layer.delta.changesBySheet.sheet_1).toBeDefined();
  });

  it('removes empty V2 layer but keeps vector manifest and tag slot', () => {
    const msg: any = {
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        tagA: {
          independentData: {},
          modifiedKeys: ['sheet_0'],
          updateGroupKeys: ['sheet_0'],
          summaryVectorIndexManifest: { indexId: 'manifest-2' },
          tablePersistenceV2: {
            version: 2,
            checkpoint: {
              kind: 'checkpoint',
              version: 2,
              checkpointId: 'cp-2',
              createdAt: '2026-05-08T00:00:00.000Z',
              source: 'manual-rebase',
              isolationKey: 'tagA',
              data: {
                mate: { type: 'chatSheets' },
                sheet_0: { name: '删除表', content: [['row_id'], ['1']] },
              },
            },
            delta: {
              kind: 'delta',
              version: 2,
              deltaId: 'delta-2',
              createdAt: '2026-05-08T00:00:00.000Z',
              isolationKey: 'tagA',
              changedSheets: ['sheet_0'],
              modifiedKeys: ['sheet_0'],
              updateGroupKeys: ['sheet_0'],
              changesBySheet: {
                sheet_0: {
                  sheetKey: 'sheet_0',
                  rowChanges: [{ op: 'clearSheet' }],
                },
              },
            },
          },
        },
      },
    };

    const changed = purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);

    expect(changed).toBe(true);
    const tagData = msg.TavernDB_ACU_IsolatedData.tagA;
    expect(tagData.tablePersistenceV2).toBeUndefined();
    expect(tagData.summaryVectorIndexManifest).toEqual({ indexId: 'manifest-2' });
    expect(tagData.modifiedKeys).toEqual([]);
    expect(tagData.updateGroupKeys).toEqual([]);
  });

  it('returns false when purged sheets are absent from V2 and legacy fields', () => {
    const msg: any = {
      is_user: false,
      TavernDB_ACU_IsolatedData: {
        '': {
          independentData: {},
          modifiedKeys: ['sheet_1'],
          updateGroupKeys: ['sheet_1'],
          tablePersistenceV2: {
            version: 2,
            delta: {
              kind: 'delta',
              version: 2,
              deltaId: 'delta-3',
              createdAt: '2026-05-08T00:00:00.000Z',
              isolationKey: '',
              changedSheets: ['sheet_1'],
              modifiedKeys: ['sheet_1'],
              updateGroupKeys: ['sheet_1'],
              changesBySheet: {
                sheet_1: {
                  sheetKey: 'sheet_1',
                  rowChanges: [{ op: 'upsert', rowId: '1', row: ['1'] }],
                },
              },
            },
          },
        },
      },
    };

    const changed = purgeSheetKeysFromMessage_ACU(msg, ['sheet_0']);

    expect(changed).toBe(false);
    expect(msg.TavernDB_ACU_IsolatedData[''].tablePersistenceV2.delta.changedSheets).toEqual(['sheet_1']);
  });
});
