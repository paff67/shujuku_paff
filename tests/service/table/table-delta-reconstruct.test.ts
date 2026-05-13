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

  it('无 V2 但存在 legacy 快照时懒迁移为首个 AI 消息 checkpoint 并清理 legacy 源', () => {
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
    expect(chat[0].TavernDB_ACU_IndependentData).toBeUndefined();
    expect(chat[0].TavernDB_ACU_ModifiedKeys).toBeUndefined();
    expect(chat[0].TavernDB_ACU_UpdateGroupKeys).toBeUndefined();
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
    expect(chat[0].TavernDB_ACU_IndependentData).toBeUndefined();
    expect((result.data?.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['2', '木盾'],
      ['1', '铁剑'],
    ]);
  });

  it('legacy 快照不在首楼时迁移到首个 AI 消息 checkpoint 并清理原 legacy 源', () => {
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
    expect(chat[2].TavernDB_ACU_IndependentData).toBeUndefined();
    expect(chat[2].TavernDB_ACU_ModifiedKeys).toBeUndefined();
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
    expect(chat[1].TavernDB_ACU_IndependentData).toBeUndefined();
    expect(chat[2].TavernDB_ACU_IndependentData).toBeUndefined();
    expect(chat[3].TavernDB_ACU_IndependentData).toBeUndefined();
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
    expect(chat[1].TavernDB_ACU_IndependentData).toBeUndefined();
    expect(chat[2].TavernDB_ACU_IndependentData).toBeUndefined();
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
    expect(chat[0].TavernDB_ACU_Data).toBeUndefined();
  });
});
