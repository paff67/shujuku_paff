import type { Sheet_ACU } from '../../shared/models/table-data';
import { logWarn_ACU } from '../../shared/utils';

export interface TableRowEntry_ACU {
  rowId: string;
  rowIndex: number;
  row: (string | null)[];
}

export function cloneTableRow_ACU(row: (string | null)[]): (string | null)[] {
  return Array.isArray(row) ? row.map(cell => cell ?? null) : [];
}

export function normalizeRowId_ACU(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

export function getRowIdFromRow_ACU(row: unknown): string | null {
  if (!Array.isArray(row)) return null;
  return normalizeRowId_ACU(row[0]);
}

export function getSheetHeader_ACU(sheet: Sheet_ACU | null | undefined): (string | null)[] | null {
  if (!sheet || !Array.isArray(sheet.content) || !Array.isArray(sheet.content[0])) return null;
  return cloneTableRow_ACU(sheet.content[0]);
}

export function getDataRowsWithIdentity_ACU(sheet: Sheet_ACU | null | undefined, sheetKey = ''): TableRowEntry_ACU[] {
  if (!sheet || !Array.isArray(sheet.content) || sheet.content.length <= 1) return [];

  const rows: TableRowEntry_ACU[] = [];
  for (let rowIndex = 1; rowIndex < sheet.content.length; rowIndex += 1) {
    const row = sheet.content[rowIndex];
    if (!Array.isArray(row)) {
      logWarn_ACU(`[TableDelta] Skip non-array row at ${sheetKey || sheet?.uid || 'unknown'}#${rowIndex}`);
      continue;
    }

    const rowId = getRowIdFromRow_ACU(row);
    if (!rowId) {
      logWarn_ACU(`[TableDelta] Skip row without row_id at ${sheetKey || sheet?.uid || 'unknown'}#${rowIndex}`);
      continue;
    }

    rows.push({
      rowId,
      rowIndex,
      row: cloneTableRow_ACU(row),
    });
  }

  return rows;
}

export function buildRowIdentityMap_ACU(sheet: Sheet_ACU | null | undefined, sheetKey = ''): Map<string, TableRowEntry_ACU> {
  const map = new Map<string, TableRowEntry_ACU>();
  for (const entry of getDataRowsWithIdentity_ACU(sheet, sheetKey)) {
    map.set(entry.rowId, entry);
  }
  return map;
}
