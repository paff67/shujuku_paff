import type { IsolationConfig_ACU } from '../../data/models/chat-message-data';
import { initIsolatedTagSlot_ACU, isLegacyMatchForIsolation_ACU, readIsolatedTagData_ACU } from '../../data/repositories/chat-message-data-repo';
import type { TableDataObject_ACU } from '../../shared/models/table-data';
import { logWarn_ACU } from '../../shared/utils';
import { reconstructTablesFromChatDeltas_ACU } from './table-delta-reconstruct';
import { readTablePersistenceLayerV2_ACU } from './table-delta-repository';
import type { RollupCheckpointBeforePurgeResult_ACU, TableCheckpointV2_ACU, TablePersistenceLayerV2_ACU } from './table-delta-types';
import {
  getTablePersistenceDeltasV2_ACU,
  hasTablePersistenceDeltasV2_ACU,
} from '../../shared/models/table-persistence-v2-utils';

function cloneJson_ACU<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function hasAnySheet_ACU(data: TableDataObject_ACU | null | undefined): data is TableDataObject_ACU {
  return !!data && Object.keys(data).some(key => key.startsWith('sheet_'));
}

function hasAnySheetKey_ACU(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).some(key => key.startsWith('sheet_'));
}

function hasMeaningfulTagDataAfterTablePurge_ACU(tagData: any): boolean {
  if (!tagData || typeof tagData !== 'object') return false;
  if (hasAnySheetKey_ACU(tagData.independentData)) return true;
  if (tagData.tablePersistenceV2?.checkpoint || hasTablePersistenceDeltasV2_ACU(tagData.tablePersistenceV2)) return true;
  if (Array.isArray(tagData.modifiedKeys) && tagData.modifiedKeys.length > 0) return true;
  if (Array.isArray(tagData.updateGroupKeys) && tagData.updateGroupKeys.length > 0) return true;
  if (tagData.vectorMemoryState !== undefined) return true;
  if (tagData.summaryVectorIndexState !== undefined) return true;
  if (tagData.summaryVectorIndexManifest !== undefined) return true;
  if (tagData._acu_base_state !== undefined) return true;
  return false;
}

function createRetentionCheckpoint_ACU(
  data: TableDataObject_ACU,
  isolationKey: string,
  boundaryMessageIndex: number,
): TableCheckpointV2_ACU {
  return {
    kind: 'checkpoint',
    version: 2,
    checkpointId: `retention-rollup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString(),
    source: 'retention-rollup',
    isolationKey,
    messageIndexHint: boundaryMessageIndex,
    data: cloneJson_ACU(data),
  };
}

function deleteCurrentIsolationTableFields_ACU(msg: any, isolationKey: string): boolean {
  const isolatedData = msg?.TavernDB_ACU_IsolatedData;
  if (!isolatedData || typeof isolatedData !== 'object' || Array.isArray(isolatedData)) return false;
  if (!Object.prototype.hasOwnProperty.call(isolatedData, isolationKey)) return false;

  const nextContainer = cloneJson_ACU(isolatedData);
  const tagData = nextContainer[isolationKey];
  if (!tagData || typeof tagData !== 'object') return false;

  let changed = false;
  if (tagData.tablePersistenceV2 !== undefined) {
    delete tagData.tablePersistenceV2;
    changed = true;
  }
  if (tagData.independentData !== undefined && hasAnySheetKey_ACU(tagData.independentData)) {
    delete tagData.independentData;
    changed = true;
  }
  if (tagData.modifiedKeys !== undefined) {
    delete tagData.modifiedKeys;
    changed = true;
  }
  if (tagData.updateGroupKeys !== undefined) {
    delete tagData.updateGroupKeys;
    changed = true;
  }

  if (!changed) return false;

  if (hasMeaningfulTagDataAfterTablePurge_ACU(tagData)) {
    nextContainer[isolationKey] = tagData;
  } else {
    delete nextContainer[isolationKey];
  }

  if (Object.keys(nextContainer).length === 0) {
    delete msg.TavernDB_ACU_IsolatedData;
  } else {
    msg.TavernDB_ACU_IsolatedData = nextContainer;
  }
  return true;
}

function deleteRootLegacyTableFields_ACU(msg: any, isolationConfig: IsolationConfig_ACU): boolean {
  if (!isLegacyMatchForIsolation_ACU(msg, isolationConfig)) return false;

  let changed = false;
  const keysToDelete = [
    'TavernDB_ACU_Data',
    'TavernDB_ACU_SummaryData',
    'TavernDB_ACU_IndependentData',
    'TavernDB_ACU_ModifiedKeys',
    'TavernDB_ACU_UpdateGroupKeys',
    'TavernDB_ACU_Identity',
  ];

  for (const key of keysToDelete) {
    if (Object.prototype.hasOwnProperty.call(msg, key)) {
      delete msg[key];
      changed = true;
    }
  }

  return changed;
}

function purgeTableLayerFromMessage_ACU(
  msg: any,
  isolationKey: string,
  isolationConfig: IsolationConfig_ACU,
): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const isolatedChanged = deleteCurrentIsolationTableFields_ACU(msg, isolationKey);
  const rootChanged = deleteRootLegacyTableFields_ACU(msg, isolationConfig);
  return isolatedChanged || rootChanged;
}

export interface RollupCheckpointBeforePurgeOptions_ACU {
  chat: any[];
  isolationKey: string;
  isolationConfig: IsolationConfig_ACU;
  retainCount: number;
  dataMessageIndices?: number[];
  templateSheetKeys?: string[];
}

export function rollupCheckpointBeforePurge_ACU(
  options: RollupCheckpointBeforePurgeOptions_ACU,
): RollupCheckpointBeforePurgeResult_ACU {
  const chat = options.chat;
  const retainCount = Math.max(0, Math.trunc(Number(options.retainCount) || 0));
  if (!Array.isArray(chat) || chat.length === 0 || retainCount <= 0) {
    return { changed: false, purgedMessageIndices: [] };
  }

  const dataMessageIndices = Array.isArray(options.dataMessageIndices)
    ? options.dataMessageIndices.filter(index => Number.isInteger(index) && index > 0 && index < chat.length)
    : [];

  if (dataMessageIndices.length <= retainCount) {
    return { changed: false, purgedMessageIndices: [] };
  }

  const cutoffIndex = dataMessageIndices.length - retainCount;
  const purgedMessageIndices = dataMessageIndices.slice(0, cutoffIndex);
  const boundaryMessageIndex = dataMessageIndices[cutoffIndex];
  const boundaryMessage = chat[boundaryMessageIndex];

  if (!boundaryMessage || boundaryMessage.is_user) {
    logWarn_ACU('[TableDeltaRetention] Boundary message is not writable, skip checkpoint rollup.', boundaryMessageIndex);
    return { changed: false, boundaryMessageIndex, purgedMessageIndices };
  }

  let changed = false;
  const reconstructResult = reconstructTablesFromChatDeltas_ACU(chat, {
    isolationKey: options.isolationKey,
    isolationConfig: options.isolationConfig,
    templateSheetKeys: options.templateSheetKeys,
  }, {
    targetMessageIndexExclusive: boundaryMessageIndex,
    allowLegacyMigration: true,
    saveChatAfterMigration: true,
    retainRecentLayers: retainCount,
  });

  if (reconstructResult.changed) {
    changed = true;
  }

  let checkpointId: string | undefined;
  if (hasAnySheet_ACU(reconstructResult.data)) {
    const existingLayer = readTablePersistenceLayerV2_ACU(boundaryMessage, options.isolationKey);
    const checkpoint = createRetentionCheckpoint_ACU(reconstructResult.data, options.isolationKey, boundaryMessageIndex);
    const nextLayer: TablePersistenceLayerV2_ACU = {
      version: 2,
      checkpoint,
    };
    const existingDeltas = getTablePersistenceDeltasV2_ACU(existingLayer);
    if (existingDeltas.length > 0) {
      nextLayer.deltas = existingDeltas.map(delta => cloneJson_ACU(delta));
      nextLayer.delta = cloneJson_ACU(existingDeltas[existingDeltas.length - 1]);
    }
    const tagData = initIsolatedTagSlot_ACU(boundaryMessage, options.isolationKey);
    tagData.tablePersistenceV2 = nextLayer;
    checkpointId = checkpoint.checkpointId;
    changed = true;
  }

  for (const messageIndex of purgedMessageIndices) {
    const msg = chat[messageIndex];
    if (purgeTableLayerFromMessage_ACU(msg, options.isolationKey, options.isolationConfig)) {
      changed = true;
    }
  }

  return {
    changed,
    boundaryMessageIndex,
    checkpointId,
    purgedMessageIndices,
  };
}
