import type { Sheet_ACU, TableDataObject_ACU } from '../../shared/models/table-data';
import type { RowChangeV2_ACU, SheetDeltaV2_ACU, TableLayerDeltaV2_ACU } from './table-delta-types';
import { buildRowIdentityMap_ACU, cloneTableRow_ACU, getSheetHeader_ACU } from './table-row-identity';
import { parseDDLColumnComments, parseDDLColumnNames } from '../../shared/ddl-utils';

function cloneJson_ACU<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createEmptyTableData_ACU(base: TableDataObject_ACU | null): TableDataObject_ACU {
  const mate = base?.mate
    ? cloneJson_ACU(base.mate)
    : {
        type: 'chatSheets',
        version: 1,
        updateConfigUiSentinel: -1,
        globalInjectionConfig: {
          readableEntryPlacement: { position: '', depth: 0, order: 0 },
          wrapperPlacement: { position: '', depth: 0, order: 0 },
        },
      };
  return { mate } as TableDataObject_ACU;
}

function cloneTableData_ACU(base: TableDataObject_ACU | null): TableDataObject_ACU {
  if (!base || typeof base !== 'object') return createEmptyTableData_ACU(base);
  return cloneJson_ACU(base);
}

function canCreateSheetFromDelta_ACU(delta: SheetDeltaV2_ACU): boolean {
  return !!delta.header || !!delta.sheetMeta || delta.rowChanges.some(change => change.op === 'upsert');
}

function createSheetFromDelta_ACU(sheetKey: string, delta: SheetDeltaV2_ACU): Sheet_ACU {
  const meta = (delta.sheetMeta || {}) as Partial<Sheet_ACU>;
  let header = delta.header ? cloneTableRow_ACU(delta.header) : null;
  if (!header) {
    // delta 无 header → 尝试从 sourceData.ddl 推导表头行（中文名列）
    const ddl = (meta as any)?.sourceData?.ddl;
    if (ddl && typeof ddl === 'string') {
      try {
        const comments = parseDDLColumnComments(ddl);
        const colNames = parseDDLColumnNames(ddl);
        header = colNames.map(sqlName => comments.get(sqlName) || sqlName);
      } catch (_) { /* DDL 解析失败，回退 */ }
    }
    if (!header || header.length === 0) {
      header = ['row_id'];
    }
  }
  return {
    uid: String(meta.uid || sheetKey),
    name: String(meta.name || delta.sheetName || sheetKey),
    sourceData: cloneJson_ACU(meta.sourceData || { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '' }),
    content: [header],
    updateConfig: cloneJson_ACU(meta.updateConfig || { uiSentinel: -1, contextDepth: -1, updateFrequency: -1, batchSize: -1, skipFloors: -1 }),
    exportConfig: cloneJson_ACU(meta.exportConfig || {
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
    }),
    orderNo: Number.isFinite(meta.orderNo) ? Number(meta.orderNo) : 0,
  };
}

function applySheetMeta_ACU(sheet: Sheet_ACU, delta: SheetDeltaV2_ACU): Sheet_ACU {
  const next = cloneJson_ACU(sheet);
  if (delta.sheetMeta && typeof delta.sheetMeta === 'object') {
    Object.assign(next, cloneJson_ACU(delta.sheetMeta));
  }
  if (delta.sheetName) next.name = delta.sheetName;
  if (delta.header) {
    if (!Array.isArray(next.content)) next.content = [];
    next.content[0] = cloneTableRow_ACU(delta.header);
  } else if (!Array.isArray(next.content) || !Array.isArray(next.content[0])) {
    next.content = [getSheetHeader_ACU(sheet) || ['row_id']];
  }
  return next;
}

function removeRowById_ACU(rows: (string | null)[][], rowId: string): (string | null)[][] {
  return rows.filter(row => row[0] !== rowId).map(row => cloneTableRow_ACU(row));
}

function resolveInsertIndex_ACU(rowIndexHint: number | undefined, rowCount: number): number {
  if (!Number.isFinite(rowIndexHint)) return rowCount;
  const contentRowIndex = Math.trunc(Number(rowIndexHint));
  if (contentRowIndex <= 0) return rowCount;
  const dataRowIndex = contentRowIndex - 1;
  return Math.max(0, Math.min(dataRowIndex, rowCount));
}

function applyRowChanges_ACU(sheet: Sheet_ACU, rowChanges: RowChangeV2_ACU[]): Sheet_ACU {
  let next = cloneJson_ACU(sheet);
  const header = getSheetHeader_ACU(next) || ['row_id'];

  const rowMap = buildRowIdentityMap_ACU(next, next.uid || next.name);
  let orderedRows = Array.from(rowMap.values())
    .sort((a, b) => a.rowIndex - b.rowIndex)
    .map(entry => cloneTableRow_ACU(entry.row));

  for (const change of rowChanges) {
    if (change.op === 'clearSheet') {
      orderedRows = [];
      continue;
    }
    if (change.op === 'delete') {
      orderedRows = removeRowById_ACU(orderedRows, change.rowId);
      continue;
    }

    orderedRows = removeRowById_ACU(orderedRows, change.rowId);
    const insertIndex = resolveInsertIndex_ACU(change.rowIndexHint, orderedRows.length);
    orderedRows.splice(insertIndex, 0, cloneTableRow_ACU(change.row));
  }

  next.content = [header, ...orderedRows.map(row => cloneTableRow_ACU(row))];
  return next;
}

function applySheetDelta_ACU(baseSheet: Sheet_ACU | null, sheetKey: string, delta: SheetDeltaV2_ACU): Sheet_ACU | null {
  if (!baseSheet && !canCreateSheetFromDelta_ACU(delta)) return null;
  const initialSheet = baseSheet ? cloneJson_ACU(baseSheet) : createSheetFromDelta_ACU(sheetKey, delta);
  const withMeta = applySheetMeta_ACU(initialSheet, delta);
  return applyRowChanges_ACU(withMeta, delta.rowChanges || []);
}

export function applyTableDelta_ACU(base: TableDataObject_ACU | null, delta: TableLayerDeltaV2_ACU): TableDataObject_ACU {
  const next = cloneTableData_ACU(base);
  if (!delta || delta.kind !== 'delta' || delta.version !== 2 || !delta.changesBySheet) return next;

  for (const sheetKey of Object.keys(delta.changesBySheet)) {
    const sheetDelta = delta.changesBySheet[sheetKey];
    const baseSheet = (next[sheetKey] as Sheet_ACU | undefined) || null;
    const applied = applySheetDelta_ACU(baseSheet, sheetKey, sheetDelta);
    if (applied) {
      next[sheetKey] = applied;
    }
  }

  return next;
}
