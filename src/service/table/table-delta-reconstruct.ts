import type { IsolationConfig_ACU } from '../../data/models/chat-message-data';
import type { TableDataObject_ACU } from '../../shared/models/table-data';
import { logWarn_ACU } from '../../shared/utils';
import { applyTableDelta_ACU } from './table-delta-apply';
import { buildLegacyCheckpointFromChat_ACU, migrateLegacyCheckpointToRootMessage_ACU } from './table-delta-migration';
import { readTablePersistenceLayerV2_ACU } from './table-delta-repository';
import type { ReconstructTablesFromChatDeltasOptions_ACU, TableCheckpointV2_ACU } from './table-delta-types';

function cloneJson_ACU<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function normalizeEndExclusive_ACU(chat: any[], targetMessageIndexExclusive?: number): number {
  if (!Number.isFinite(targetMessageIndexExclusive)) return chat.length;
  return Math.max(0, Math.min(Math.trunc(Number(targetMessageIndexExclusive)), chat.length));
}

function hasAnySheet_ACU(data: TableDataObject_ACU | null): boolean {
  return !!data && Object.keys(data).some(key => key.startsWith('sheet_'));
}

export interface ReconstructTablesFromChatDeltasContext_ACU {
  isolationKey: string;
  isolationConfig: IsolationConfig_ACU;
  templateSheetKeys?: string[];
}

export interface ReconstructTablesFromChatDeltasResult_ACU {
  data: TableDataObject_ACU | null;
  checkpoint: TableCheckpointV2_ACU | null;
  checkpointMessageIndex?: number;
  usedLegacyMigration: boolean;
  changed: boolean;
}

export function reconstructTablesFromChatDeltas_ACU(
  chat: any[],
  context: ReconstructTablesFromChatDeltasContext_ACU,
  options: ReconstructTablesFromChatDeltasOptions_ACU = {},
): ReconstructTablesFromChatDeltasResult_ACU {
  if (!Array.isArray(chat) || chat.length === 0) {
    return { data: null, checkpoint: null, usedLegacyMigration: false, changed: false };
  }

  const endExclusive = normalizeEndExclusive_ACU(chat, options.targetMessageIndexExclusive);
  let data: TableDataObject_ACU | null = null;
  let checkpoint: TableCheckpointV2_ACU | null = null;
  let checkpointMessageIndex: number | undefined;
  let sawV2 = false;
  let sawV2Checkpoint = false;
  let firstV2MessageIndex: number | undefined;

  for (let i = 0; i < endExclusive; i++) {
    const message = chat[i];
    if (!message || message.is_user) continue;
    const layer = readTablePersistenceLayerV2_ACU(message, context.isolationKey);
    if (!layer) continue;

    sawV2 = true;
    if (firstV2MessageIndex === undefined) firstV2MessageIndex = i;

    if (layer.checkpoint) {
      sawV2Checkpoint = true;
      checkpoint = cloneJson_ACU(layer.checkpoint);
      checkpointMessageIndex = i;
      data = cloneJson_ACU(layer.checkpoint.data);
    }

    if (layer.delta) {
      data = applyTableDelta_ACU(data, layer.delta);
    }
  }

  if (sawV2Checkpoint) {
    return {
      data: hasAnySheet_ACU(data) ? data : null,
      checkpoint,
      checkpointMessageIndex,
      usedLegacyMigration: false,
      changed: false,
    };
  }

  if (options.allowLegacyMigration === false) {
    return {
      data: hasAnySheet_ACU(data) ? data : null,
      checkpoint: null,
      usedLegacyMigration: false,
      changed: false,
    };
  }

  const legacyBoundaryIndex = firstV2MessageIndex === undefined
    ? endExclusive - 1
    : firstV2MessageIndex - 1;
  const legacyResult = buildLegacyCheckpointFromChat_ACU(chat, {
    isolationKey: context.isolationKey,
    isolationConfig: context.isolationConfig,
    templateSheetKeys: context.templateSheetKeys,
    targetBoundaryMessageIndex: legacyBoundaryIndex,
  });

  if (!legacyResult.checkpoint || legacyResult.checkpointMessageIndex === undefined) {
    return {
      data: hasAnySheet_ACU(data) ? data : null,
      checkpoint: null,
      usedLegacyMigration: false,
      changed: false,
    };
  }

  let changed = false;
  let migratedCheckpointMessageIndex = legacyResult.checkpointMessageIndex;
  let migratedCheckpoint = cloneJson_ACU(legacyResult.checkpoint);
  if (options.saveChatAfterMigration !== false) {
    try {
      const migrationResult = migrateLegacyCheckpointToRootMessage_ACU(
        chat,
        context.isolationKey,
        context.isolationConfig,
        legacyResult.checkpoint,
        { retainRecentLayers: options.retainRecentLayers },
      );
      if (migrationResult !== null) {
        migratedCheckpointMessageIndex = migrationResult.messageIndex;
        migratedCheckpoint = cloneJson_ACU(migrationResult.checkpoint);
        changed = true;
      }
    } catch (error) {
      logWarn_ACU('[TableDeltaMigration] Failed to write legacy root checkpoint:', error);
    }
  }

  data = cloneJson_ACU(legacyResult.checkpoint.data);
  checkpoint = migratedCheckpoint;
  checkpointMessageIndex = migratedCheckpointMessageIndex;

  for (let i = legacyResult.checkpointMessageIndex + 1; i < endExclusive; i++) {
    const message = chat[i];
    if (!message || message.is_user) continue;
    const layer = readTablePersistenceLayerV2_ACU(message, context.isolationKey);
    if (!layer?.delta) continue;
    data = applyTableDelta_ACU(data, layer.delta);
  }

  return {
    data: hasAnySheet_ACU(data) ? data : null,
    checkpoint,
    checkpointMessageIndex,
    usedLegacyMigration: true,
    changed,
  };
}
