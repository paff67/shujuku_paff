import type { Sheet_ACU } from '../../shared/models/table-data';
import type {
  CreateTableDeltaOptions_ACU,
  RowChangeV2_ACU,
  SheetDeltaV2_ACU,
  TableLayerDeltaV2_ACU,
} from './table-delta-types';
import {
  buildRowIdentityMap_ACU,
  cloneTableRow_ACU,
  getDataRowsWithIdentity_ACU,
  getSheetHeader_ACU,
} from './table-row-identity';

const SHEET_META_EXCLUDED_KEYS_ACU = new Set([
  'content',
  'seedRows',
  '_acu_from_base_state',
]);

function cloneJson_ACU<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createStableId_ACU(prefix: string, isolationKey: string, targetMessageIndex: number): string {
  const safeIsolation = String(isolationKey || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${prefix}_${safeIsolation}_${targetMessageIndex}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function stableStringify_ACU(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => stableStringify_ACU(item)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify_ACU(obj[key])}`).join(',')}}`;
}

function rowsEqual_ACU(a: (string | null)[] | null | undefined, b: (string | null)[] | null | undefined): boolean {
  return stableStringify_ACU(a || []) === stableStringify_ACU(b || []);
}

function headersEqual_ACU(before: Sheet_ACU | null | undefined, after: Sheet_ACU | null | undefined): boolean {
  return rowsEqual_ACU(getSheetHeader_ACU(before), getSheetHeader_ACU(after));
}

function extractSheetMeta_ACU(sheet: Sheet_ACU | null | undefined): Partial<Omit<Sheet_ACU, 'content' | 'seedRows'>> | null {
  if (!sheet || typeof sheet !== 'object') return null;
  const sheetRecord = sheet as unknown as Record<string, unknown>;
  const meta: Record<string, unknown> = {};
  Object.keys(sheetRecord).forEach(key => {
    if (SHEET_META_EXCLUDED_KEYS_ACU.has(key)) return;
    meta[key] = cloneJson_ACU(sheetRecord[key]);
  });
  return meta as Partial<Omit<Sheet_ACU, 'content' | 'seedRows'>>;
}

function metasEqual_ACU(before: Sheet_ACU | null | undefined, after: Sheet_ACU | null | undefined): boolean {
  return stableStringify_ACU(extractSheetMeta_ACU(before)) === stableStringify_ACU(extractSheetMeta_ACU(after));
}

function createSheetDelta_ACU(sheetKey: string, beforeSheet: Sheet_ACU | null, afterSheet: Sheet_ACU | null): SheetDeltaV2_ACU | null {
  if (!beforeSheet && !afterSheet) return null;

  if (beforeSheet && !afterSheet) {
    return {
      sheetKey,
      sheetName: beforeSheet.name,
      rowChanges: [{ op: 'clearSheet' }],
    };
  }

  const rowChanges: RowChangeV2_ACU[] = [];
  const beforeRows = buildRowIdentityMap_ACU(beforeSheet, sheetKey);
  const afterRows = buildRowIdentityMap_ACU(afterSheet, sheetKey);

  for (const [rowId, beforeEntry] of beforeRows.entries()) {
    if (!afterRows.has(rowId)) {
      rowChanges.push({ op: 'delete', rowId, rowIndexHint: beforeEntry.rowIndex });
    }
  }

  for (const afterEntry of getDataRowsWithIdentity_ACU(afterSheet, sheetKey)) {
    const beforeEntry = beforeRows.get(afterEntry.rowId);
    if (!beforeEntry || !rowsEqual_ACU(beforeEntry.row, afterEntry.row)) {
      rowChanges.push({
        op: 'upsert',
        rowId: afterEntry.rowId,
        rowIndexHint: afterEntry.rowIndex,
        row: cloneTableRow_ACU(afterEntry.row),
      });
    }
  }

  const headerChanged = !headersEqual_ACU(beforeSheet, afterSheet);
  const metaChanged = !metasEqual_ACU(beforeSheet, afterSheet);

  if (rowChanges.length === 0 && !headerChanged && !metaChanged) return null;

  const delta: SheetDeltaV2_ACU = {
    sheetKey,
    sheetName: afterSheet?.name || beforeSheet?.name,
    rowChanges,
  };

  if (headerChanged) {
    const header = getSheetHeader_ACU(afterSheet);
    if (header) delta.header = header;
  }

  if (metaChanged && afterSheet) {
    const meta = extractSheetMeta_ACU(afterSheet);
    if (meta) delta.sheetMeta = meta;
  }

  return delta;
}

export function createTableDeltaFromBeforeAfter_ACU(options: CreateTableDeltaOptions_ACU): TableLayerDeltaV2_ACU | null {
  const targetSheetKeys = Array.from(new Set((options.targetSheetKeys || []).filter(key => typeof key === 'string' && key.startsWith('sheet_'))));
  if (targetSheetKeys.length === 0) return null;

  const changesBySheet: Record<string, SheetDeltaV2_ACU> = {};
  const changedSheets: string[] = [];

  for (const sheetKey of targetSheetKeys) {
    const beforeSheet = (options.before?.[sheetKey] as Sheet_ACU | undefined) || null;
    const afterSheet = (options.after?.[sheetKey] as Sheet_ACU | undefined) || null;
    const sheetDelta = createSheetDelta_ACU(sheetKey, beforeSheet, afterSheet);
    if (!sheetDelta) continue;
    changesBySheet[sheetKey] = sheetDelta;
    changedSheets.push(sheetKey);
  }

  if (changedSheets.length === 0) return null;

  return {
    kind: 'delta',
    version: 2,
    deltaId: createStableId_ACU('delta_v2', options.isolationKey, options.targetMessageIndex),
    createdAt: new Date().toISOString(),
    isolationKey: options.isolationKey,
    baseCheckpointId: options.baseCheckpointId,
    aiFloorHint: options.aiFloorHint,
    messageIndexHint: options.targetMessageIndex,
    changedSheets,
    modifiedKeys: Array.from(new Set(options.modifiedKeys || [])),
    updateGroupKeys: Array.from(new Set(options.updateGroupKeys || [])),
    changesBySheet,
  };
}
