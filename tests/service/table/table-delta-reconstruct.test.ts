import { describe, expect, it, vi } from 'vitest';
import type { Sheet_ACU, TableDataObject_ACU } from '../../../src/shared/models/table-data';
import { reconstructTablesFromChatDeltas_ACU } from '../../../src/service/table/table-delta-reconstruct';
import type { TableCheckpointV2_ACU, TableLayerDeltaV2_ACU } from '../../../src/service/table/table-delta-types';

vi.mock('../../../src/shared/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/shared/utils')>();
  return {
    ...actual,
    logWarn_ACU: vi.fn(),
  };
});

function makeSheet(content: (string | null)[][], overrides: Partial<Sheet_ACU> = {}): Sheet_ACU {
  return {
    uid: 'sheet_0',
    name: '测试表',
    sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '' },
    content,
    updateConfig: { uiSentinel: -1, contextDepth: -1, updateFrequency: -1, batchSize: -1, skipFloors: -1 },
    exportConfig: {
      enabled: false,
      splitByRow: false,
      entryName: '',
      entryType: '',
      keywords: '',
      preventRecursion: false,
      injectionTemplate: '',
      extraIndexEnabled: false,
      extraIndexEntryName: '',
      extraIndexColumns: [],
      extraIndexColumnModes: {},
      extraIndexInjectionTemplate: '',
      entryPlacement: { position: '', depth: 0, order: 0 },
      extraIndexPlacement: { position: '', depth: 0, order: 0 },
      fixedEntryPlacement: { position: '', depth: 0, order: 0 },
      fixedIndexPlacement: { position: '', depth: 0, order: 0 },
    },
    orderNo: 0,
    ...overrides,
  };
}

function makeData(sheet?: Sheet_ACU): TableDataObject_ACU {
  const data: TableDataObject_ACU = {
    mate: {
      type: 'chatSheets',
      version: 1,
      updateConfigUiSentinel: -1,
      globalInjectionConfig: {
        readableEntryPlacement: { position: '', depth: 0, order: 0 },
        wrapperPlacement: { position: '', depth: 0, order: 0 },
      },
    },
  };
  if (sheet) data.sheet_0 = sheet;
  return data;
}

function checkpoint(data: TableDataObject_ACU): TableCheckpointV2_ACU {
  return {
    kind: 'checkpoint',
    version: 2,
    checkpointId: 'checkpoint-test',
    createdAt: '2026-05-08T00:00:00.000Z',
    source: 'legacy-migration',
    isolationKey: '',
    data,
  };
}

function delta(rowChanges: TableLayerDeltaV2_ACU['changesBySheet']['sheet_0']['rowChanges']): TableLayerDeltaV2_ACU {
  return {
    kind: 'delta',
    version: 2,
    deltaId: 'delta-test',
    createdAt: '2026-05-08T00:00:00.000Z',
    isolationKey: '',
    changedSheets: ['sheet_0'],
    modifiedKeys: ['sheet_0'],
    updateGroupKeys: ['sheet_0'],
    changesBySheet: {
      sheet_0: {
        sheetKey: 'sheet_0',
        rowChanges,
      },
    },
  };
}

function aiMessage(layer: any = null): any {
  const msg: any = { is_user: false };
  if (layer) {
    msg.TavernDB_ACU_IsolatedData = {
      '': {
        independentData: {},
        modifiedKeys: [],
        updateGroupKeys: [],
        tablePersistenceV2: layer,
      },
    };
  }
  return msg;
}

describe('reconstructTablesFromChatDeltas_ACU', () => {
  const context = {
    isolationKey: '',
    isolationConfig: { enabled: false, code: '' },
    templateSheetKeys: ['sheet_0'],
  };

  it('从 checkpoint 后正序回放 delta', () => {
    const chat = [
      aiMessage({ version: 2, checkpoint: checkpoint(makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]))) }),
      { is_user: true },
      aiMessage({ version: 2, delta: delta([{ op: 'upsert', rowId: '1', rowIndexHint: 1, row: ['1', '银剑'] }]) }),
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { allowLegacyMigration: false });

    expect(result.usedLegacyMigration).toBe(false);
    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '银剑'],
    ]);
  });

  it('同一消息同时存在 checkpoint 和 delta 时先 checkpoint 后 delta', () => {
    const chat = [
      aiMessage({
        version: 2,
        checkpoint: checkpoint(makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]))),
        delta: delta([{ op: 'upsert', rowId: '2', rowIndexHint: 2, row: ['2', '木盾'] }]),
      }),
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { allowLegacyMigration: false });

    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '铁剑'],
      ['2', '木盾'],
    ]);
  });

  it('同一消息的 deltas 按 sequence 顺序累计回放，并保留 delta 最新镜像兼容', () => {
    const firstDelta = {
      ...delta([{ op: 'upsert', rowId: '1', rowIndexHint: 1, row: ['1', '银剑'] }]),
      deltaId: 'delta-first',
      sequence: 0,
    };
    const secondDelta = {
      ...delta([{ op: 'upsert', rowId: '2', rowIndexHint: 2, row: ['2', '木盾'] }]),
      deltaId: 'delta-second',
      sequence: 1,
    };
    const chat = [
      aiMessage({
        version: 2,
        checkpoint: checkpoint(makeData(makeSheet([['row_id', '名称'], ['base', '铁剑']]))),
        deltas: [secondDelta, firstDelta],
        delta: secondDelta,
      }),
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { allowLegacyMigration: false });

    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '银剑'],
      ['2', '木盾'],
      ['base', '铁剑'],
    ]);
  });

  it('存在 deltas 时不重复应用 delta 最新镜像', () => {
    const mirroredDelta = delta([{ op: 'upsert', rowId: '1', rowIndexHint: 1, row: ['1', '银剑'] }]);
    const chat = [aiMessage({ version: 2, deltas: [mirroredDelta], delta: mirroredDelta })];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { allowLegacyMigration: false });

    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([['row_id'], ['1', '银剑']]);
  });

  it('targetMessageIndexExclusive 会排除目标层之后的 delta', () => {
    const chat = [
      aiMessage({ version: 2, checkpoint: checkpoint(makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]))) }),
      aiMessage({ version: 2, delta: delta([{ op: 'upsert', rowId: '1', rowIndexHint: 1, row: ['1', '银剑'] }]) }),
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, {
      allowLegacyMigration: false,
      targetMessageIndexExclusive: 1,
    });

    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '铁剑'],
    ]);
  });

  it('无 V2 但存在 legacy 快照时懒迁移为首个 AI 消息 checkpoint 且保留 legacy 源', () => {
    const chat: any[] = [
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: makeSheet([['row_id', '名称'], ['1', '铁剑']]),
        },
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
        TavernDB_ACU_UpdateGroupKeys: ['sheet_0'],
      },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.checkpointMessageIndex).toBe(0);
    expect(result.checkpoint?.messageIndexHint).toBe(0);
    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '铁剑'],
    ]);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.kind).toBe('checkpoint');
    expect(chat[0].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.messageIndexHint).toBe(0);
    expect(chat[0].TavernDB_ACU_IndependentData?.sheet_0).toBeDefined();
    expect(chat[0].TavernDB_ACU_ModifiedKeys).toEqual(['sheet_0']);
    expect(chat[0].TavernDB_ACU_UpdateGroupKeys).toEqual(['sheet_0']);
  });

  it('只有 V2 delta 没有 checkpoint 时先从 legacy 迁移到首楼 checkpoint 再回放 delta', () => {
    const chat: any[] = [
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: makeSheet([['row_id', '名称'], ['1', '铁剑']]),
        },
      },
      aiMessage({ version: 2, delta: delta([{ op: 'upsert', rowId: '2', rowIndexHint: 1, row: ['2', '木盾'] }]) }),
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.checkpointMessageIndex).toBe(0);
    expect(result.checkpoint?.messageIndexHint).toBe(0);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.source).toBe('legacy-migration');
    expect(chat[0].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.messageIndexHint).toBe(0);
    expect(chat[0].TavernDB_ACU_IndependentData?.sheet_0).toBeDefined();
    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['2', '木盾'],
      ['1', '铁剑'],
    ]);
  });

  it('legacy 快照不在首楼时迁移到首个 AI 消息 checkpoint 且保留原 legacy 源', () => {
    const chat: any[] = [
      aiMessage(),
      { is_user: true },
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: makeSheet([['row_id', '名称'], ['1', '后置旧快照']]),
        },
        TavernDB_ACU_ModifiedKeys: ['sheet_0'],
      },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.checkpointMessageIndex).toBe(0);
    expect(result.checkpoint?.messageIndexHint).toBe(0);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.data.sheet_0.content).toEqual([
      ['row_id', '名称'],
      ['1', '后置旧快照'],
    ]);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.messageIndexHint).toBe(0);
    expect(chat[2].TavernDB_ACU_IndependentData?.sheet_0).toBeDefined();
    expect(chat[2].TavernDB_ACU_ModifiedKeys).toEqual(['sheet_0']);
  });

  it('legacy 数据层超过保留数量时迁移到最早保留层 checkpoint', () => {
    const chat: any[] = [
      aiMessage(),
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: makeSheet([['row_id', '名称'], ['1', '旧层1']]),
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: makeSheet([['row_id', '名称'], ['2', '旧层2']]),
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: makeSheet([['row_id', '名称'], ['3', '最新旧快照']]),
        },
      },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, {
      saveChatAfterMigration: true,
      retainRecentLayers: 2,
    });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.checkpointMessageIndex).toBe(2);
    expect(result.checkpoint?.messageIndexHint).toBe(2);
    expect(chat[0].TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(chat[2].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.source).toBe('legacy-migration');
    expect(chat[2].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.messageIndexHint).toBe(2);
    expect(chat[1].TavernDB_ACU_IndependentData?.sheet_0).toBeDefined();
    expect(chat[2].TavernDB_ACU_IndependentData?.sheet_0).toBeDefined();
    expect(chat[3].TavernDB_ACU_IndependentData?.sheet_0).toBeDefined();
  });

  it('legacy 数据层未超过保留数量时仍迁移到首个 AI 消息 checkpoint', () => {
    const chat: any[] = [
      aiMessage(),
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: makeSheet([['row_id', '名称'], ['1', '旧层1']]),
        },
      },
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: makeSheet([['row_id', '名称'], ['2', '旧层2']]),
        },
      },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, {
      saveChatAfterMigration: true,
      retainRecentLayers: 5,
    });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.checkpointMessageIndex).toBe(0);
    expect(result.checkpoint?.messageIndexHint).toBe(0);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.source).toBe('legacy-migration');
    expect(chat[1].TavernDB_ACU_IndependentData?.sheet_0).toBeDefined();
    expect(chat[2].TavernDB_ACU_IndependentData?.sheet_0).toBeDefined();
  });

  it('已有 V2 checkpoint 时不再用更早 legacy 快照污染 V2 链', () => {
    const chat: any[] = [
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: makeSheet([['row_id', '名称'], ['legacy', '旧剑']]),
        },
      },
      aiMessage({ version: 2, checkpoint: checkpoint(makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]))) }),
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(false);
    expect(result.changed).toBe(false);
    expect(chat[0].TavernDB_ACU_IsolatedData).toBeUndefined();
    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '铁剑'],
    ]);
  });

  it('空 V2 checkpoint 不应遮蔽后续有效 legacy 快照', () => {
    const chat: any[] = [
      aiMessage({ version: 2, checkpoint: checkpoint(makeData()) }),
      {
        is_user: false,
        TavernDB_ACU_Data: {
          mate: { type: 'chatSheets', version: 1 },
          sheet_0: makeSheet([['row_id', '名称'], ['1', '旧聊天铁剑']]),
        },
      },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.checkpointMessageIndex).toBe(0);
    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '旧聊天铁剑'],
    ]);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.data.sheet_0.content).toEqual([
      ['row_id', '名称'],
      ['1', '旧聊天铁剑'],
    ]);
    expect(chat[1].TavernDB_ACU_Data?.sheet_0).toBeDefined();
  });

  it('有效 V2 checkpoint 仍保持最高优先级，不被后续 legacy 快照覆盖', () => {
    const chat: any[] = [
      aiMessage({ version: 2, checkpoint: checkpoint(makeData(makeSheet([['row_id', '名称'], ['v2', '新链路铁剑']]))) }),
      {
        is_user: false,
        TavernDB_ACU_Data: {
          mate: { type: 'chatSheets', version: 1 },
          sheet_0: makeSheet([['row_id', '名称'], ['legacy', '旧聊天木盾']]),
        },
      },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(false);
    expect(result.changed).toBe(false);
    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['v2', '新链路铁剑'],
    ]);
    expect(chat[1].TavernDB_ACU_Data.sheet_0.content[1][1]).toBe('旧聊天木盾');
  });

  it('saveChatAfterMigration=false 时可读取 legacy 但不写回 checkpoint', () => {
    const chat: any[] = [
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: makeSheet([['row_id', '名称'], ['1', '铁剑']]),
        },
      },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { saveChatAfterMigration: false });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(false);
    expect(chat[0].TavernDB_ACU_IsolatedData).toBeUndefined();
    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '铁剑'],
    ]);
  });

  it('模板 key 不匹配时仍从 legacy 标准表生成首楼 checkpoint，避免旧聊天被显示为空', () => {
    const chat: any[] = [
      {
        is_user: false,
        TavernDB_ACU_Data: {
          mate: { type: 'chatSheets', version: 1 },
          sheet_0: makeSheet([['row_id', '名称'], ['1', '旧聊天铁剑']]),
        },
      },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, {
      ...context,
      templateSheetKeys: ['sheet_9'],
    }, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.checkpointMessageIndex).toBe(0);
    expect(result.checkpoint?.messageIndexHint).toBe(0);
    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '旧聊天铁剑'],
    ]);
    expect(chat[0].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.kind).toBe('checkpoint');
    expect(chat[0].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.data.sheet_0.content).toEqual([
      ['row_id', '名称'],
      ['1', '旧聊天铁剑'],
    ]);
    expect(chat[0].TavernDB_ACU_Data?.sheet_0).toBeDefined();
  });

  it('只有根 chat_metadata.sheets 且无消息级数据时，fallback 只生成表头 checkpoint', () => {
    const chat: any[] = [
      {
        chat_metadata: {
          sheets: [
            {
              uid: 'sheet_meta_global',
              name: '全局数据表',
              hashSheet: [['cell_origin_global', 'cell_place', 'cell_time']],
              cellHistory: [
                {
                  uid: 'cell_origin_global',
                  type: 'sheet_origin',
                  data: {
                    note: '记录地点和时间',
                    initNode: '初始化地点',
                    deleteNode: '',
                    updateNode: '地点变化时更新',
                    insertNode: '禁止操作',
                  },
                },
                { uid: 'cell_time', type: 'column_header', data: { value: '当前时间' } },
                { uid: 'cell_place', type: 'column_header', data: { value: '主角当前所在地点' } },
              ],
            },
            {
              uid: 'sheet_meta_outline',
              name: '总体大纲',
              cellHistory: [
                { uid: 'cell_outline_origin', type: 'sheet_origin', data: { note: '大纲表' } },
                { uid: 'cell_outline', type: 'column_header', data: { value: '大纲' } },
                { uid: 'cell_code', type: 'column_header', data: { value: '编码索引' } },
              ],
            },
          ],
        },
      },
      { is_user: true, mes: '开始' },
      { is_user: false, mes: 'AI 回复但没有旧表格字段' },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.checkpointMessageIndex).toBe(2);
    expect((result.data?.sheet_meta_global as Sheet_ACU).content).toEqual([
      ['row_id', '主角当前所在地点', '当前时间'],
    ]);
    expect((result.data?.sheet_meta_outline as Sheet_ACU).content).toEqual([
      ['row_id', '大纲', '编码索引'],
    ]);
    expect((result.data?.sheet_meta_global as Sheet_ACU).sourceData).toEqual({
      note: '记录地点和时间',
      initNode: '初始化地点',
      deleteNode: '',
      updateNode: '地点变化时更新',
      insertNode: '禁止操作',
    });
    expect((result.data?.sheet_meta_global as Sheet_ACU).content).toHaveLength(1);
    expect(chat[2].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.data.sheet_meta_global.content).toEqual([
      ['row_id', '主角当前所在地点', '当前时间'],
    ]);
    expect(chat[0].TavernDB_ACU_IsolatedData).toBeUndefined();
  });

  it('根 chat_metadata.sheets 不在第 0 位时仍可 fallback，且不会写入 root metadata 对象', () => {
    const chat: any[] = [
      { is_user: true, mes: '开始' },
      {
        chat_metadata: {
          sheets: [
            {
              uid: 'sheet_meta_late',
              name: '后置元数据表',
              cellHistory: [
                { uid: 'cell_late_origin', type: 'sheet_origin', data: { note: '后置 metadata' } },
                { uid: 'cell_late_name', type: 'column_header', data: { value: '名称' } },
              ],
            },
          ],
        },
      },
      { is_user: false, mes: 'AI 回复但没有旧表格字段' },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.checkpointMessageIndex).toBe(2);
    expect((result.data?.sheet_meta_late as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
    ]);
    expect((result.data?.sheet_meta_late as Sheet_ACU).sourceData.note).toBe('后置 metadata');
    expect(chat[1].TavernDB_ACU_IsolatedData).toBeUndefined();
    expect(chat[2].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.data.sheet_meta_late.content).toEqual([
      ['row_id', '名称'],
    ]);
  });

  it('只有 root metadata 且没有可写 AI 消息时不应把 checkpoint 写回 metadata 对象', () => {
    const chat: any[] = [
      {
        chat_metadata: {
          sheets: [
            {
              uid: 'sheet_meta_only',
              name: '孤立元数据表',
              cellHistory: [{ uid: 'cell_only_name', type: 'column_header', data: { value: '名称' } }],
            },
          ],
        },
      },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, context, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.checkpointMessageIndex).toBeUndefined();
    expect((result.data?.sheet_meta_only as Sheet_ACU).content).toEqual([['row_id', '名称']]);
    expect(chat[0].TavernDB_ACU_IsolatedData).toBeUndefined();
  });

  it('真实样本风格：根 chat_metadata.sheets 与消息级 TavernDB_ACU_Data 共存时优先迁移历史行', () => {
    const metadataSheetKeys = ['sheet_vxHmOjru', 'sheet_ZCsAnd6o', 'sheet_e8Uv1Zd7', 'sheet_sc7EcAj0'];
    const chat: any[] = [
      {
        user_name: '阿不思',
        character_name: '娇妻沦为仇敌性奴',
        chat_metadata: {
          sheets: metadataSheetKeys.map((uid, index) => ({
            uid,
            name: ['全局数据表', '主角信息', '总结表', '总体大纲'][index],
            hashSheet: [[`cell_${uid}_origin`, `cell_${uid}_header`]],
            cellHistory: [
              {
                uid: `cell_${uid}_origin`,
                type: 'sheet_origin',
                data: { note: 'metadata only', initNode: '', deleteNode: '', updateNode: '', insertNode: '' },
              },
              {
                uid: `cell_${uid}_header`,
                type: 'column_header',
                data: { value: 'metadata header only' },
              },
            ],
          })),
        },
      },
      { is_user: true, mes: '敲门' },
      {
        is_user: false,
        TavernDB_ACU_Data: {
          mate: { type: 'chatSheets', version: 1 },
          sheet_dCudvUnH: makeSheet(
            [
              [null, '主角当前所在地点', '当前时间'],
              [null, '老旧公寓楼三楼家门口', '20XX-09-25 14:30'],
            ],
            { uid: 'sheet_dCudvUnH', name: '全局数据表', orderNo: 0 },
          ),
          sheet_DpKcVGqg: makeSheet(
            [
              [null, '人物名称', '性别/年龄', '过往经历'],
              [null, '陈默', '男/30岁', '因保护妻子入狱三年，刚出狱回家。'],
            ],
            { uid: 'sheet_DpKcVGqg', name: '主角信息', orderNo: 1 },
          ),
          sheet_3NoMc1wI: makeSheet(
            [
              [null, '时间跨度', '纪要', '编码索引'],
              [null, '20XX-09-25 午后', '陈默出狱回到家门口，犹豫如何面对苏婉。', 'AM01'],
            ],
            { uid: 'sheet_3NoMc1wI', name: '总结表', orderNo: 6 },
          ),
          sheet_PfzcX5v2: makeSheet(
            [
              [null, '大纲', '编码索引'],
              [null, '陈默出狱回家，面对熟悉旧居与未知妻子。', 'AM01'],
            ],
            { uid: 'sheet_PfzcX5v2', name: '总体大纲', orderNo: 7 },
          ),
        },
        TavernDB_ACU_ModifiedKeys: ['sheet_dCudvUnH', 'sheet_DpKcVGqg', 'sheet_3NoMc1wI', 'sheet_PfzcX5v2'],
        TavernDB_ACU_UpdateGroupKeys: ['sheet_dCudvUnH', 'sheet_DpKcVGqg'],
      },
    ];

    const result = reconstructTablesFromChatDeltas_ACU(chat, {
      ...context,
      templateSheetKeys: metadataSheetKeys,
    }, { saveChatAfterMigration: true });

    expect(result.usedLegacyMigration).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.checkpointMessageIndex).toBe(2);

    expect((result.data?.sheet_dCudvUnH as Sheet_ACU).content).toEqual([
      ['row_id', '主角当前所在地点', '当前时间'],
      ['1', '老旧公寓楼三楼家门口', '20XX-09-25 14:30'],
    ]);
    expect((result.data?.sheet_DpKcVGqg as Sheet_ACU).content).toEqual([
      ['row_id', '人物名称', '性别/年龄', '过往经历'],
      ['1', '陈默', '男/30岁', '因保护妻子入狱三年，刚出狱回家。'],
    ]);
    expect((result.data?.sheet_3NoMc1wI as Sheet_ACU).content[1]).toEqual([
      '1',
      '20XX-09-25 午后',
      '陈默出狱回到家门口，犹豫如何面对苏婉。',
      'AM01',
    ]);
    expect((result.data?.sheet_PfzcX5v2 as Sheet_ACU).content[1]).toEqual([
      '1',
      '陈默出狱回家，面对熟悉旧居与未知妻子。',
      'AM01',
    ]);

    const migratedData = chat[2].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.data;
    expect(migratedData.sheet_dCudvUnH.content[1][1]).toBe('老旧公寓楼三楼家门口');
    expect(migratedData.sheet_DpKcVGqg.content[1][1]).toBe('陈默');
    expect(migratedData.sheet_3NoMc1wI.content[1][3]).toBe('AM01');
    expect(migratedData.sheet_PfzcX5v2.content[1][2]).toBe('AM01');
    expect(chat[2].TavernDB_ACU_Data?.sheet_dCudvUnH).toBeDefined();
    expect(chat[2].TavernDB_ACU_IsolatedData[''].tablePersistenceV2.checkpoint.data.sheet_vxHmOjru).toBeUndefined();
  });

});
