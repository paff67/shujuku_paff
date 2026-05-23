import type { IsolationConfig_ACU } from '../../data/models/chat-message-data';
import {
  isLegacyMatchForIsolation_ACU,
  readIsolatedTagData_ACU,
  readLegacyIndependentData_ACU,
  readLegacyStandardData_ACU,
  readLegacySummaryData_ACU,
  readModifiedKeys_ACU,
  readUpdateGroupKeys_ACU,
} from '../../data/repositories/chat-message-data-repo';
import type { Sheet_ACU, TableDataObject_ACU } from '../../shared/models/table-data';
import { isSummaryOrOutlineTable_ACU } from '../../shared/utils';
import { readTablePersistenceLayerV2_ACU, writeTablePersistenceLayerV2_ACU } from './table-delta-repository';
import type { TableCheckpointV2_ACU, TablePersistenceLayerV2_ACU } from './table-delta-types';
import {
  getTablePersistenceDeltasV2_ACU,
  hasTablePersistenceDeltasV2_ACU,
} from '../../shared/models/table-persistence-v2-utils';

function cloneJson_ACU<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createEmptyTableData_ACU(): TableDataObject_ACU {
  return {
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
}

function isSheetLike_ACU(value: unknown): value is Sheet_ACU {
  return !!value && typeof value === 'object' && Array.isArray((value as Sheet_ACU).content);
}

function shouldAcceptSheet_ACU(sheetKey: string, sheet: Sheet_ACU, templateSheetKeySet?: Set<string>): boolean {
  if (!sheetKey.startsWith('sheet_')) return false;
  if (templateSheetKeySet && !templateSheetKeySet.has(sheetKey)) return false;
  return isSheetLike_ACU(sheet);
}

function mergeIndependentSnapshot_ACU(
  out: TableDataObject_ACU,
  foundSheets: Set<string>,
  independentData: Record<string, Sheet_ACU> | null | undefined,
  templateSheetKeySet?: Set<string>,
): void {
  if (!independentData || typeof independentData !== 'object') return;
  Object.keys(independentData).forEach(sheetKey => {
    if (foundSheets.has(sheetKey)) return;
    const sheet = independentData[sheetKey];
    if (!shouldAcceptSheet_ACU(sheetKey, sheet, templateSheetKeySet)) return;
    out[sheetKey] = cloneJson_ACU(sheet);
    foundSheets.add(sheetKey);
  });
}

function mergeLegacyContainer_ACU(
  out: TableDataObject_ACU,
  foundSheets: Set<string>,
  container: Record<string, unknown> | null | undefined,
  options: { templateSheetKeySet?: Set<string>; summaryOnly: boolean },
): void {
  if (!container || typeof container !== 'object') return;
  Object.keys(container).forEach(sheetKey => {
    if (foundSheets.has(sheetKey)) return;
    const sheet = container[sheetKey] as Sheet_ACU;
    if (!shouldAcceptSheet_ACU(sheetKey, sheet, options.templateSheetKeySet)) return;
    const isSummary = isSummaryOrOutlineTable_ACU(sheet.name || '');
    if (options.summaryOnly !== isSummary) return;
    out[sheetKey] = cloneJson_ACU(sheet);
    foundSheets.add(sheetKey);
  });
}

export interface BuildLegacyCheckpointFromChatOptions_ACU {
  isolationKey: string;
  isolationConfig: IsolationConfig_ACU;
  templateSheetKeys?: string[];
  targetBoundaryMessageIndex?: number;
}

export interface BuildLegacyCheckpointFromChatResult_ACU {
  checkpoint: TableCheckpointV2_ACU | null;
  checkpointMessageIndex?: number;
  modifiedKeys: string[];
  updateGroupKeys: string[];
}

export function buildLegacyCheckpointFromChat_ACU(
  chat: any[],
  options: BuildLegacyCheckpointFromChatOptions_ACU,
): BuildLegacyCheckpointFromChatResult_ACU {
  const templateSheetKeySet = Array.isArray(options.templateSheetKeys) && options.templateSheetKeys.length > 0
    ? new Set(options.templateSheetKeys)
    : undefined;
  const endIndex = Number.isFinite(options.targetBoundaryMessageIndex)
    ? Math.min(Math.trunc(Number(options.targetBoundaryMessageIndex)), chat.length - 1)
    : chat.length - 1;

  const scanLegacySnapshots = (activeTemplateSheetKeySet?: Set<string>) => {
    const data = createEmptyTableData_ACU();
    const foundSheets = new Set<string>();
    const modifiedKeys = new Set<string>();
    const updateGroupKeys = new Set<string>();
    let checkpointMessageIndex: number | undefined;

    for (let i = endIndex; i >= 0; i--) {
      const message = chat[i];
      if (!message || message.is_user) continue;

      const tagData = readIsolatedTagData_ACU(message, options.isolationKey);
      if (tagData) {
        mergeIndependentSnapshot_ACU(data, foundSheets, tagData.independentData, activeTemplateSheetKeySet);
        (tagData.modifiedKeys || []).forEach(key => modifiedKeys.add(key));
        (tagData.updateGroupKeys || []).forEach(key => updateGroupKeys.add(key));
        if (checkpointMessageIndex === undefined && foundSheets.size > 0) checkpointMessageIndex = i;
      }

      if (!isLegacyMatchForIsolation_ACU(message, options.isolationConfig)) continue;

      const legacyIndependent = readLegacyIndependentData_ACU(message);
      mergeIndependentSnapshot_ACU(data, foundSheets, legacyIndependent, activeTemplateSheetKeySet);
      readModifiedKeys_ACU(message).forEach(key => modifiedKeys.add(key));
      readUpdateGroupKeys_ACU(message).forEach(key => updateGroupKeys.add(key));

      mergeLegacyContainer_ACU(data, foundSheets, readLegacyStandardData_ACU(message) as Record<string, unknown> | null, {
        templateSheetKeySet: activeTemplateSheetKeySet,
        summaryOnly: false,
      });
      mergeLegacyContainer_ACU(data, foundSheets, readLegacySummaryData_ACU(message) as Record<string, unknown> | null, {
        templateSheetKeySet: activeTemplateSheetKeySet,
        summaryOnly: true,
      });

      if (checkpointMessageIndex === undefined && foundSheets.size > 0) checkpointMessageIndex = i;
    }

    return { data, foundSheets, modifiedKeys, updateGroupKeys, checkpointMessageIndex };
  };

  let scanResult = scanLegacySnapshots(templateSheetKeySet);
  if (scanResult.foundSheets.size === 0 && templateSheetKeySet) {
    scanResult = scanLegacySnapshots(undefined);
  }

  const { data, foundSheets, modifiedKeys, updateGroupKeys, checkpointMessageIndex } = scanResult;

  // ── D1: migrateContentNullToRowId — 确保 checkpoint 数据格式与 SQL DDL 兼容 ──
  // 旧快照中可能存在 content[0][0] === null 的格式，需要迁移为 "row_id"
  // 幂等：已在其他路径迁移过的数据会跳过（headerRow[0] === 'row_id'）
  if (data && typeof data === 'object') {
    Object.keys(data).forEach(k => {
      if (!k.startsWith('sheet_')) return;
      const sheet = data[k] as Sheet_ACU;
      if (!sheet || !Array.isArray(sheet.content) || sheet.content.length === 0) return;
      const headerRow = sheet.content[0];
      if (!Array.isArray(headerRow) || headerRow.length === 0) return;
      if (headerRow[0] === 'row_id') return;
      if (headerRow[0] !== null) return;
      headerRow[0] = 'row_id';
      for (let i = 1; i < sheet.content.length; i++) {
        const row = sheet.content[i];
        if (Array.isArray(row) && row[0] === null) {
          row[0] = String(i);
        }
      }
    });
  }

  if (foundSheets.size === 0 || checkpointMessageIndex === undefined) {
    return { checkpoint: null, modifiedKeys: [], updateGroupKeys: [] };
  }

  return {
    checkpoint: {
      kind: 'checkpoint',
      version: 2,
      checkpointId: `legacy-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
      source: 'legacy-migration',
      isolationKey: options.isolationKey,
      messageIndexHint: checkpointMessageIndex,
      data,
    },
    checkpointMessageIndex,
    modifiedKeys: Array.from(modifiedKeys).filter(key => foundSheets.has(key)),
    updateGroupKeys: Array.from(updateGroupKeys).filter(key => foundSheets.has(key)),
  };
}

export function migrateLegacyCheckpointToMessage_ACU(
  msg: any,
  isolationKey: string,
  checkpoint: TableCheckpointV2_ACU,
): void {
  const existingLayer = readTablePersistenceLayerV2_ACU(msg, isolationKey);
  const layer: TablePersistenceLayerV2_ACU = {
    version: 2,
    checkpoint: cloneJson_ACU(checkpoint),
  };
  const existingDeltas = getTablePersistenceDeltasV2_ACU(existingLayer);
  if (existingDeltas.length > 0) {
    layer.deltas = existingDeltas.map(delta => cloneJson_ACU(delta));
    layer.delta = cloneJson_ACU(existingDeltas[existingDeltas.length - 1]);
  }
  writeTablePersistenceLayerV2_ACU(msg, isolationKey, layer);
}

export function findFirstWritableAiMessageIndex_ACU(chat: any[], startIndex = 0): number {
  if (!Array.isArray(chat)) return -1;
  const safeStartIndex = Math.max(0, Math.trunc(Number(startIndex) || 0));
  for (let i = safeStartIndex; i < chat.length; i += 1) {
    const message = chat[i];
    if (message && !message.is_user) return i;
  }
  return -1;
}

function hasAnySheetKey_ACU(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).some(key => key.startsWith('sheet_'));
}

function messageHasCurrentIsolationLocalTableLayer_ACU(
  message: any,
  isolationKey: string,
  isolationConfig: IsolationConfig_ACU,
): boolean {
  if (!message || message.is_user) return false;

  const layer = readTablePersistenceLayerV2_ACU(message, isolationKey);
  if (layer?.checkpoint || hasTablePersistenceDeltasV2_ACU(layer)) return true;

  const tagData = readIsolatedTagData_ACU(message, isolationKey);
  if (hasAnySheetKey_ACU(tagData?.independentData)) return true;
  if (Array.isArray(tagData?.modifiedKeys) && tagData.modifiedKeys.length > 0) return true;
  if (Array.isArray(tagData?.updateGroupKeys) && tagData.updateGroupKeys.length > 0) return true;

  if (!isLegacyMatchForIsolation_ACU(message, isolationConfig)) return false;
  if (hasAnySheetKey_ACU(readLegacyIndependentData_ACU(message))) return true;
  if (hasAnySheetKey_ACU(readLegacyStandardData_ACU(message))) return true;
  if (hasAnySheetKey_ACU(readLegacySummaryData_ACU(message))) return true;
  if (readModifiedKeys_ACU(message).length > 0) return true;
  if (readUpdateGroupKeys_ACU(message).length > 0) return true;
  return false;
}

export function collectCurrentIsolationLocalTableMessageIndices_ACU(
  chat: any[],
  isolationKey: string,
  isolationConfig: IsolationConfig_ACU,
): number[] {
  if (!Array.isArray(chat)) return [];
  const indices: number[] = [];
  for (let i = 0; i < chat.length; i += 1) {
    if (messageHasCurrentIsolationLocalTableLayer_ACU(chat[i], isolationKey, isolationConfig)) {
      indices.push(i);
    }
  }
  return indices;
}

export function resolveLegacyCheckpointAnchorMessageIndex_ACU(
  chat: any[],
  isolationKey: string,
  isolationConfig: IsolationConfig_ACU,
  retainRecentLayers?: number,
): number {
  const retainCount = Math.max(0, Math.trunc(Number(retainRecentLayers) || 0));
  if (retainCount <= 0) return findFirstWritableAiMessageIndex_ACU(chat);

  const dataMessageIndices = collectCurrentIsolationLocalTableMessageIndices_ACU(chat, isolationKey, isolationConfig)
    .filter(index => index > 0);
  if (dataMessageIndices.length <= retainCount) return findFirstWritableAiMessageIndex_ACU(chat);

  const boundaryIndex = dataMessageIndices[dataMessageIndices.length - retainCount];
  return findFirstWritableAiMessageIndex_ACU(chat, boundaryIndex);
}

export interface LegacyRootCheckpointMigrationResult_ACU {
  messageIndex: number;
  checkpoint: TableCheckpointV2_ACU;
}

export function createLegacyRootCheckpoint_ACU(
  checkpoint: TableCheckpointV2_ACU,
  rootMessageIndex: number,
): TableCheckpointV2_ACU {
  const checkpointId = checkpoint.checkpointId.startsWith('legacy-root-migration-')
    ? checkpoint.checkpointId
    : checkpoint.checkpointId.replace(/^legacy-migration-/, 'legacy-root-migration-');

  return {
    ...cloneJson_ACU(checkpoint),
    checkpointId,
    source: 'legacy-migration',
    messageIndexHint: rootMessageIndex,
  };
}

export function migrateLegacyCheckpointToRootMessage_ACU(
  chat: any[],
  isolationKey: string,
  checkpoint: TableCheckpointV2_ACU,
  targetMessageIndex: number,
): LegacyRootCheckpointMigrationResult_ACU | null {
  if (targetMessageIndex < 0 || targetMessageIndex >= chat.length) return null;

  const anchorMessage = chat[targetMessageIndex];
  if (!anchorMessage) return null;
  if (anchorMessage.is_user) return null;

  const rootCheckpoint = createLegacyRootCheckpoint_ACU(checkpoint, targetMessageIndex);

  migrateLegacyCheckpointToMessage_ACU(anchorMessage, isolationKey, rootCheckpoint);

  return { messageIndex: targetMessageIndex, checkpoint: rootCheckpoint };
}
