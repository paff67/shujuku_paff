import type { IsolationConfig_ACU, IsolationTagData_ACU, IsolatedDataContainer_ACU } from '../../data/models/chat-message-data';
import { initIsolatedTagSlot_ACU, isLegacyMatchForIsolation_ACU, readIsolatedTagData_ACU } from '../../data/repositories/chat-message-data-repo';
import type { TablePersistenceLayerV2_ACU } from './table-delta-types';

function safeClone_ACU<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function parseIsolatedContainer_ACU(msg: any): IsolatedDataContainer_ACU | null {
  const raw = msg?.TavernDB_ACU_IsolatedData;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as IsolatedDataContainer_ACU)
        : null;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? (raw as IsolatedDataContainer_ACU) : null;
}

function hasAnySheetKey_ACU(value: any): boolean {
  return !!value && typeof value === 'object' && Object.keys(value).some(key => key.startsWith('sheet_'));
}

function hasMeaningfulIsolatedTagData_ACU(tagData: IsolationTagData_ACU | null | undefined): boolean {
  if (!tagData || typeof tagData !== 'object') return false;
  if (hasAnySheetKey_ACU(tagData.independentData)) return true;
  if (tagData.tablePersistenceV2?.checkpoint || tagData.tablePersistenceV2?.delta) return true;
  if (tagData.vectorMemoryState !== undefined) return true;
  if (tagData.summaryVectorIndexState !== undefined) return true;
  if (tagData.summaryVectorIndexManifest !== undefined) return true;
  if (tagData._acu_base_state) return true;
  return false;
}

export function readTablePersistenceLayerV2_ACU(
  msg: any,
  isolationKey: string,
): TablePersistenceLayerV2_ACU | null {
  const tagData = readIsolatedTagData_ACU(msg, isolationKey);
  const layer = tagData?.tablePersistenceV2;
  if (!layer || layer.version !== 2) return null;
  return layer;
}

export function writeTablePersistenceLayerV2_ACU(
  msg: any,
  isolationKey: string,
  layer: TablePersistenceLayerV2_ACU,
): void {
  if (!msg) return;
  const tagData = initIsolatedTagSlot_ACU(msg, isolationKey);
  tagData.tablePersistenceV2 = safeClone_ACU(layer);
}

export function clearCurrentIsolationLegacyTableSnapshots_ACU(
  msg: any,
  isolationKey: string,
  isolationConfig: IsolationConfig_ACU,
): boolean {
  if (!msg) return false;
  let changed = false;

  const container = parseIsolatedContainer_ACU(msg);
  if (container && container[isolationKey]) {
    const nextContainer = safeClone_ACU(container);
    const tagData = nextContainer[isolationKey];
    if (tagData?.independentData && hasAnySheetKey_ACU(tagData.independentData)) {
      tagData.independentData = {};
      changed = true;
    }
    if (hasMeaningfulIsolatedTagData_ACU(tagData)) {
      msg.TavernDB_ACU_IsolatedData = nextContainer;
    } else {
      delete nextContainer[isolationKey];
      if (Object.keys(nextContainer).length === 0) {
        delete msg.TavernDB_ACU_IsolatedData;
      } else {
        msg.TavernDB_ACU_IsolatedData = nextContainer;
      }
      changed = true;
    }
  }

  if (isLegacyMatchForIsolation_ACU(msg, isolationConfig)) {
    if (msg.TavernDB_ACU_IndependentData !== undefined) {
      delete msg.TavernDB_ACU_IndependentData;
      changed = true;
    }
    if (msg.TavernDB_ACU_Data !== undefined) {
      delete msg.TavernDB_ACU_Data;
      changed = true;
    }
    if (msg.TavernDB_ACU_SummaryData !== undefined) {
      delete msg.TavernDB_ACU_SummaryData;
      changed = true;
    }
    if (msg.TavernDB_ACU_ModifiedKeys !== undefined) {
      delete msg.TavernDB_ACU_ModifiedKeys;
      changed = true;
    }
    if (msg.TavernDB_ACU_UpdateGroupKeys !== undefined) {
      delete msg.TavernDB_ACU_UpdateGroupKeys;
      changed = true;
    }
  }

  return changed;
}

export function messageHasTablePersistenceV2_ACU(msg: any, isolationKey: string): boolean {
  const layer = readTablePersistenceLayerV2_ACU(msg, isolationKey);
  return !!(layer?.checkpoint || layer?.delta);
}

export function messageHasLegacyTableSnapshot_ACU(
  msg: any,
  isolationKey: string,
  isolationConfig: IsolationConfig_ACU,
): boolean {
  const tagData = readIsolatedTagData_ACU(msg, isolationKey);
  if (hasAnySheetKey_ACU(tagData?.independentData)) return true;
  if (!isLegacyMatchForIsolation_ACU(msg, isolationConfig)) return false;
  return hasAnySheetKey_ACU(msg?.TavernDB_ACU_IndependentData)
    || hasAnySheetKey_ACU(msg?.TavernDB_ACU_Data)
    || hasAnySheetKey_ACU(msg?.TavernDB_ACU_SummaryData);
}
