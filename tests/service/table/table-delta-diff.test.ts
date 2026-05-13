import { describe, expect, it, vi } from 'vitest';
import type { Sheet_ACU, TableDataObject_ACU } from '../../../src/shared/models/table-data';
import { createTableDeltaFromBeforeAfter_ACU } from '../../../src/service/table/table-delta-diff';

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

function createDelta(before: TableDataObject_ACU | null, after: TableDataObject_ACU | null) {
  return createTableDeltaFromBeforeAfter_ACU({
    before,
    after,
    targetSheetKeys: ['sheet_0'],
    modifiedKeys: ['sheet_0'],
    updateGroupKeys: ['sheet_0'],
    isolationKey: '',
    targetMessageIndex: 3,
  });
}

describe('createTableDeltaFromBeforeAfter_ACU', () => {
  it('无变化时返回 null', () => {
    const before = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]));
    const after = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]));

    expect(createDelta(before, after)).toBeNull();
  });

  it('新增行时生成 upsert', () => {
    const before = makeData(makeSheet([['row_id', '名称']]));
    const after = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]));

    const delta = createDelta(before, after)!;

    expect(delta.changedSheets).toEqual(['sheet_0']);
    expect(delta.changesBySheet.sheet_0.rowChanges).toEqual([
      { op: 'upsert', rowId: '1', rowIndexHint: 1, row: ['1', '铁剑'] },
    ]);
  });

  it('修改行时生成 upsert', () => {
    const before = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]));
    const after = makeData(makeSheet([['row_id', '名称'], ['1', '银剑']]));

    const delta = createDelta(before, after)!;

    expect(delta.changesBySheet.sheet_0.rowChanges).toEqual([
      { op: 'upsert', rowId: '1', rowIndexHint: 1, row: ['1', '银剑'] },
    ]);
  });

  it('删除行时生成 delete', () => {
    const before = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]));
    const after = makeData(makeSheet([['row_id', '名称']]));

    const delta = createDelta(before, after)!;

    expect(delta.changesBySheet.sheet_0.rowChanges).toEqual([
      { op: 'delete', rowId: '1', rowIndexHint: 1 },
    ]);
  });

  it('表从存在变为不存在时生成 clearSheet', () => {
    const before = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]));
    const after = makeData();

    const delta = createDelta(before, after)!;

    expect(delta.changesBySheet.sheet_0.rowChanges).toEqual([{ op: 'clearSheet' }]);
  });

  it('表头变化时记录 header', () => {
    const before = makeData(makeSheet([['row_id', '名称'], ['1', '铁剑']]));
    const after = makeData(makeSheet([['row_id', '物品名'], ['1', '铁剑']]));

    const delta = createDelta(before, after)!;

    expect(delta.changesBySheet.sheet_0.header).toEqual(['row_id', '物品名']);
  });

  it('sheet meta 变化时记录 sheetMeta', () => {
    const before = makeData(makeSheet([['row_id', '名称']], { name: '旧名' }));
    const after = makeData(makeSheet([['row_id', '名称']], { name: '新名' }));

    const delta = createDelta(before, after)!;

    expect(delta.changesBySheet.sheet_0.sheetMeta?.name).toBe('新名');
  });
});
