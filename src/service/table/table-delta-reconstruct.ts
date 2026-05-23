import type { IsolationConfig_ACU } from '../../data/models/chat-message-data';
import type { Sheet_ACU, TableDataObject_ACU } from '../../shared/models/table-data';
import { logWarn_ACU } from '../../shared/utils';
import { applyTableDelta_ACU } from './table-delta-apply';
import { buildLegacyCheckpointFromChat_ACU, migrateLegacyCheckpointToRootMessage_ACU } from './table-delta-migration';
import { readTablePersistenceLayerV2_ACU, writeTablePersistenceLayerV2_ACU } from './table-delta-repository';
import type { ReconstructTablesFromChatDeltasOptions_ACU, TableCheckpointV2_ACU } from './table-delta-types';
import { getTablePersistenceDeltasV2_ACU } from '../../shared/models/table-persistence-v2-utils';
import { parseTableTemplateJson_ACU } from '../../shared/utils';
import type { TablePersistenceLayerV2_ACU } from './table-delta-types';

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

/**
 * 从模板对象构建表格基底状态数据（内联自 helpers-data-merge.ts）
 * 避免循环依赖，直接内联逻辑。
 */
function buildTemplateBaseStateDataForLocalStorage_ACU(templateObj: Record<string, any> | null): TableDataObject_ACU | null {
  if (!templateObj || typeof templateObj !== 'object') return null;
  const out: TableDataObject_ACU = { mate: { type: 'chatSheets' as const, version: 1 as const } } as TableDataObject_ACU;
  const sheetKeys = Object.keys(templateObj).filter(k => k.startsWith('sheet_'));
  if (sheetKeys.length === 0) return null;
  sheetKeys.forEach(k => {
    out[k] = JSON.parse(JSON.stringify(templateObj[k])) as Sheet_ACU;
  });
  return out;
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

    for (const delta of getTablePersistenceDeltasV2_ACU(layer)) {
      data = applyTableDelta_ACU(data, delta);
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
    // ── A1b: 无旧快照，但有孤立 V2 delta → 从模板建表累加 delta 生成 checkpoint ──
    if (sawV2 && firstV2MessageIndex !== undefined) {
      const templateObj = parseTableTemplateJson_ACU({ stripSeedRows: false });
      let seedData: TableDataObject_ACU | null = templateObj
        ? buildTemplateBaseStateDataForLocalStorage_ACU(templateObj)
        : null;

      if (seedData) {
        // 累加 firstV2MessageIndex 及之前的 delta（构建完整 checkpoint 数据）
        for (let i = 0; i <= firstV2MessageIndex; i++) {
          const msg = chat[i];
          if (!msg || msg.is_user) continue;
          const layer = readTablePersistenceLayerV2_ACU(msg, context.isolationKey);
          if (!layer) continue;
          for (const delta of getTablePersistenceDeltasV2_ACU(layer)) {
            seedData = applyTableDelta_ACU(seedData, delta);
          }
        }

        const targetMsg = chat[firstV2MessageIndex];
        if (targetMsg && !targetMsg.is_user && hasAnySheet_ACU(seedData)) {
          const newCheckpoint: TableCheckpointV2_ACU = {
            kind: 'checkpoint',
            version: 2,
            checkpointId: `delta-anchor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
            createdAt: new Date().toISOString(),
            source: 'legacy-migration',
            isolationKey: context.isolationKey,
            messageIndexHint: firstV2MessageIndex,
            data: cloneJson_ACU(seedData),
          };

          const nextLayer: TablePersistenceLayerV2_ACU = {
            version: 2,
            checkpoint: newCheckpoint,
          };
          writeTablePersistenceLayerV2_ACU(targetMsg, context.isolationKey, nextLayer);

          // 继续回放 firstV2MessageIndex + 1 到 endExclusive 的 delta
          data = cloneJson_ACU(seedData);
          for (let i = firstV2MessageIndex + 1; i < endExclusive; i++) {
            const msg = chat[i];
            if (!msg || msg.is_user) continue;
            const layer = readTablePersistenceLayerV2_ACU(msg, context.isolationKey);
            for (const delta of getTablePersistenceDeltasV2_ACU(layer)) {
              data = applyTableDelta_ACU(data, delta);
            }
          }

          return {
            data: hasAnySheet_ACU(data) ? data : null,
            checkpoint: newCheckpoint,
            checkpointMessageIndex: firstV2MessageIndex,
            usedLegacyMigration: true,
            changed: true,
          };
        }
      }
    }
    // 模板为空或建表失败 → 回退到当前逻辑（返回 data 无 checkpoint）
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
        legacyResult.checkpoint,
        legacyResult.checkpointMessageIndex!,
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
    for (const delta of getTablePersistenceDeltasV2_ACU(layer)) {
      data = applyTableDelta_ACU(data, delta);
    }
  }

  return {
    data: hasAnySheet_ACU(data) ? data : null,
    checkpoint,
    checkpointMessageIndex,
    usedLegacyMigration: true,
    changed,
  };
}