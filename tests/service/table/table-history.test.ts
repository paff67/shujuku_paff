import { describe, expect, it } from 'vitest';

import { resolveTableHistoryStateFromChat_ACU } from '../../../src/service/table/table-history';

function makeOptions(overrides: Record<string, any> = {}) {
  return {
    sheetKey: 'sheet_0',
    isSummaryTable: false,
    isolationKey: '',
    settings: { dataIsolationEnabled: false, dataIsolationCode: '' },
    ...overrides,
  };
}

function makeV2Message(layer: any, isolationKey = ''): any {
  return {
    is_user: false,
    TavernDB_ACU_IsolatedData: {
      [isolationKey]: {
        independentData: {},
        modifiedKeys: [],
        updateGroupKeys: [],
        tablePersistenceV2: layer,
      },
    },
  };
}

describe('resolveTableHistoryStateFromChat_ACU — V2 table persistence', () => {
  it('识别 V2 checkpoint 中的目标表数据', () => {
    const chat = [
      { is_user: true },
      makeV2Message({
        version: 2,
        checkpoint: {
          kind: 'checkpoint',
          version: 2,
          checkpointId: 'checkpoint-1',
          createdAt: '2026-05-08T00:00:00.000Z',
          source: 'legacy-migration',
          isolationKey: '',
          data: {
            mate: { type: 'chatSheets' },
            sheet_0: { name: '物品表', content: [['row_id'], ['1']] },
          },
        },
      }),
    ];

    const state = resolveTableHistoryStateFromChat_ACU(chat, makeOptions());

    expect(state.latestAiMessageIndex).toBe(1);
    expect(state.latestDataMessageIndex).toBe(1);
    expect(state.latestDataAiFloor).toBe(1);
    expect(state.hasAnyData).toBe(true);
  });

  it('识别 V2 delta changedSheets / changesBySheet 中的目标表数据', () => {
    const chat = [
      makeV2Message({
        version: 2,
        delta: {
          kind: 'delta',
          version: 2,
          deltaId: 'delta-1',
          createdAt: '2026-05-08T00:00:00.000Z',
          isolationKey: '',
          changedSheets: ['sheet_0'],
          modifiedKeys: [],
          updateGroupKeys: [],
          changesBySheet: {
            sheet_0: { sheetKey: 'sheet_0', rowChanges: [{ op: 'upsert', rowId: '1', row: ['1'] }] },
          },
        },
      }),
      { is_user: false },
    ];

    const state = resolveTableHistoryStateFromChat_ACU(chat, makeOptions());

    expect(state.latestDataMessageIndex).toBe(0);
    expect(state.latestDataAiFloor).toBe(1);
    expect(state.hasAnyData).toBe(true);
  });

  it('识别 V2 delta modifiedKeys / updateGroupKeys 中的 tracked update', () => {
    const chat = [
      { is_user: false },
      makeV2Message({
        version: 2,
        delta: {
          kind: 'delta',
          version: 2,
          deltaId: 'delta-1',
          createdAt: '2026-05-08T00:00:00.000Z',
          isolationKey: '',
          changedSheets: [],
          modifiedKeys: ['sheet_0'],
          updateGroupKeys: ['sheet_0'],
          changesBySheet: {},
        },
      }),
    ];

    const state = resolveTableHistoryStateFromChat_ACU(chat, makeOptions());

    expect(state.lastTrackedUpdateMessageIndex).toBe(1);
    expect(state.lastTrackedUpdateAiFloor).toBe(2);
    expect(state.hasTrackedUpdate).toBe(true);
  });

  it('识别 V2 deltas 中任一记录的目标表数据', () => {
    const chat = [
      makeV2Message({
        version: 2,
        delta: {
          kind: 'delta',
          version: 2,
          deltaId: 'delta-latest',
          createdAt: '2026-05-08T00:00:01.000Z',
          isolationKey: '',
          changedSheets: ['sheet_1'],
          modifiedKeys: [],
          updateGroupKeys: [],
          changesBySheet: {
            sheet_1: { sheetKey: 'sheet_1', rowChanges: [{ op: 'upsert', rowId: 'x', row: ['x'] }] },
          },
          sequence: 1,
        },
        deltas: [
          {
            kind: 'delta',
            version: 2,
            deltaId: 'delta-target',
            createdAt: '2026-05-08T00:00:00.000Z',
            isolationKey: '',
            changedSheets: ['sheet_0'],
            modifiedKeys: [],
            updateGroupKeys: [],
            changesBySheet: {
              sheet_0: { sheetKey: 'sheet_0', rowChanges: [{ op: 'upsert', rowId: '1', row: ['1'] }] },
            },
            sequence: 0,
          },
        ],
      }),
    ];

    const state = resolveTableHistoryStateFromChat_ACU(chat, makeOptions());

    expect(state.latestDataMessageIndex).toBe(0);
    expect(state.hasAnyData).toBe(true);
  });

  it('识别 V2 deltas 中任一记录的 tracked update', () => {
    const chat = [
      makeV2Message({
        version: 2,
        deltas: [
          {
            kind: 'delta',
            version: 2,
            deltaId: 'delta-tracked',
            createdAt: '2026-05-08T00:00:00.000Z',
            isolationKey: '',
            changedSheets: [],
            modifiedKeys: ['sheet_0'],
            updateGroupKeys: ['sheet_0'],
            changesBySheet: {},
            sequence: 0,
          },
        ],
      }),
    ];

    const state = resolveTableHistoryStateFromChat_ACU(chat, makeOptions());

    expect(state.lastTrackedUpdateMessageIndex).toBe(0);
    expect(state.hasTrackedUpdate).toBe(true);
  });

  it('按 isolationKey 只识别当前标签的 V2 layer', () => {
    const chat = [
      makeV2Message({
        version: 2,
        checkpoint: {
          kind: 'checkpoint',
          version: 2,
          checkpointId: 'checkpoint-a',
          createdAt: '2026-05-08T00:00:00.000Z',
          source: 'legacy-migration',
          isolationKey: 'tag_A',
          data: { sheet_0: { name: '标签A', content: [['row_id'], ['A']] } },
        },
      }, 'tag_A'),
      makeV2Message({
        version: 2,
        checkpoint: {
          kind: 'checkpoint',
          version: 2,
          checkpointId: 'checkpoint-b',
          createdAt: '2026-05-08T00:00:00.000Z',
          source: 'legacy-migration',
          isolationKey: 'tag_B',
          data: { sheet_0: { name: '标签B', content: [['row_id'], ['B']] } },
        },
      }, 'tag_B'),
    ];

    const state = resolveTableHistoryStateFromChat_ACU(chat, makeOptions({ isolationKey: 'tag_A' }));

    expect(state.latestDataMessageIndex).toBe(0);
    expect(state.hasAnyData).toBe(true);
  });

  it('保留 legacy fallback 数据与 tracking 判断', () => {
    const chat = [
      {
        is_user: false,
        TavernDB_ACU_Data: { sheet_0: { name: '旧数据', content: [['row_id'], ['1']] } },
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
        TavernDB_ACU_UpdateGroupKeys: ['sheet_0'],
      },
    ];

    const state = resolveTableHistoryStateFromChat_ACU(chat, makeOptions());

    expect(state.latestDataMessageIndex).toBe(0);
    expect(state.lastTrackedUpdateMessageIndex).toBe(0);
    expect(state.hasAnyData).toBe(true);
    expect(state.hasTrackedUpdate).toBe(true);
  });
});
