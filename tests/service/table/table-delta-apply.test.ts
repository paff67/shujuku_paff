import { describe, expect, it, vi } from 'vitest';
import type { Sheet_ACU, TableDataObject_ACU } from '../../../src/shared/models/table-data';
import { applyTableDelta_ACU } from '../../../src/service/table/table-delta-apply';
import type { TableLayerDeltaV2_ACU } from '../../../src/service/table/table-delta-types';

vi.mock('../../../src/shared/utils', () => ({
  logWarn_ACU: vi.fn(),
}));

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

function makeDelta(changesBySheet: TableLayerDeltaV2_ACU['changesBySheet']): TableLayerDeltaV2_ACU {
  return {
    kind: 'delta',
    version: 2,
    deltaId: 'delta-test',
    createdAt: '2026-05-08T00:00:00.000Z',
    isolationKey: '',
    changedSheets: Object.keys(changesBySheet),
    modifiedKeys: Object.keys(changesBySheet),
    updateGroupKeys: Object.keys(changesBySheet),
    changesBySheet,
  };
}

describe('applyTableDelta_ACU', () => {
  it('upsert 根据 row_id 替换已有行且不污染 base', () => {
    const base = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑'], ['2', '木盾']]));
    const delta = makeDelta({
      sheet_0: {
        sheetKey: 'sheet_0',
        rowChanges: [{ op: 'upsert', rowId: '1', rowIndexHint: 1, row: ['1', '银剑'] }],
      },
    });

    const result = applyTableDelta_ACU(base, delta);

    expect((result.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '银剑'],
      ['2', '木盾'],
    ]);
    expect((base.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '铁剑'],
      ['2', '木盾'],
    ]);
  });

  it('upsert 新行时按 rowIndexHint 恢复顺序', () => {
    const base = makeData(makeSheet([['row_id', '名称'], ['2', '木盾']]));
    const delta = makeDelta({
      sheet_0: {
        sheetKey: 'sheet_0',
        rowChanges: [{ op: 'upsert', rowId: '1', rowIndexHint: 1, row: ['1', '铁剑'] }],
      },
    });

    const result = applyTableDelta_ACU(base, delta);

    expect((result.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['1', '铁剑'],
      ['2', '木盾'],
    ]);
  });

  it('delete 根据 row_id 删除数据行', () => {
    const base = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑'], ['2', '木盾']]));
    const delta = makeDelta({
      sheet_0: {
        sheetKey: 'sheet_0',
        rowChanges: [{ op: 'delete', rowId: '1', rowIndexHint: 1 }],
      },
    });

    const result = applyTableDelta_ACU(base, delta);

    expect((result.sheet_0 as Sheet_ACU).content).toEqual([
      ['row_id', '名称'],
      ['2', '木盾'],
    ]);
  });

  it('clearSheet 保留表头并清空数据行', () => {
    const base = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]));
    const delta = makeDelta({
      sheet_0: {
        sheetKey: 'sheet_0',
        rowChanges: [{ op: 'clearSheet' }],
      },
    });

    const result = applyTableDelta_ACU(base, delta);

    expect((result.sheet_0 as Sheet_ACU).content).toEqual([['row_id', '名称']]);
  });

  it('header 和 sheetMeta 会更新表结构元数据', () => {
    const base = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']], { name: '旧名', orderNo: 1 }));
    const delta = makeDelta({
      sheet_0: {
        sheetKey: 'sheet_0',
        sheetName: '新名',
        header: ['row_id', '物品名'],
        sheetMeta: { orderNo: 9 },
        rowChanges: [],
      },
    });

    const result = applyTableDelta_ACU(base, delta);
    const sheet = result.sheet_0 as Sheet_ACU;

    expect(sheet.name).toBe('新名');
    expect(sheet.orderNo).toBe(9);
    expect(sheet.content).toEqual([
      ['row_id', '物品名'],
      ['1', '铁剑'],
    ]);
  });

  it('base 缺失目标表时可由 delta 创建新表', () => {
    const base = makeData();
    const delta = makeDelta({
      sheet_0: {
        sheetKey: 'sheet_0',
        sheetName: '新表',
        header: ['row_id', '名称'],
        sheetMeta: { uid: 'sheet_0', name: '新表', orderNo: 3 },
        rowChanges: [{ op: 'upsert', rowId: '1', rowIndexHint: 1, row: ['1', '铁剑'] }],
      },
    });

    const result = applyTableDelta_ACU(base, delta);
    const sheet = result.sheet_0 as Sheet_ACU;

    expect(sheet.name).toBe('新表');
    expect(sheet.orderNo).toBe(3);
    expect(sheet.content).toEqual([
      ['row_id', '名称'],
      ['1', '铁剑'],
    ]);
  });

  it('无效 delta 返回 base 深拷贝', () => {
    const base = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]));
    const invalidDelta = { kind: 'unknown', version: 2, changesBySheet: {} } as unknown as TableLayerDeltaV2_ACU;

    const result = applyTableDelta_ACU(base, invalidDelta);

    expect(result).toEqual(base);
    expect(result).not.toBe(base);
    expect(result.sheet_0).not.toBe(base.sheet_0);
  });
});
