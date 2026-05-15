import type { Sheet_ACU, TableDataObject_ACU } from './table-data';

export type TableCheckpointSourceV2_ACU =
  | 'legacy-migration'
  | 'retention-rollup'
  | 'template-seed'
  | 'manual-rebase';

export interface TableCheckpointV2_ACU {
  kind: 'checkpoint';
  version: 2;
  checkpointId: string;
  createdAt: string;
  source: TableCheckpointSourceV2_ACU;
  isolationKey: string;
  aiFloorHint?: number;
  messageIndexHint?: number;
  data: TableDataObject_ACU;
}

export interface TableLayerDeltaV2_ACU {
  kind: 'delta';
  version: 2;
  deltaId: string;
  /**
   * 同一消息楼层内的确定性回放顺序。旧数据可能缺失该字段，读取端会按数组顺序兼容。
   */
  sequence?: number;
  createdAt: string;
  isolationKey: string;
  baseCheckpointId?: string;
  aiFloorHint?: number;
  messageIndexHint?: number;
  changedSheets: string[];
  modifiedKeys: string[];
  updateGroupKeys: string[];
  changesBySheet: Record<string, SheetDeltaV2_ACU>;
}

export interface SheetDeltaV2_ACU {
  sheetKey: string;
  sheetName?: string;
  header?: (string | null)[];
  sheetMeta?: Partial<Omit<Sheet_ACU, 'content' | 'seedRows'>>;
  rowChanges: RowChangeV2_ACU[];
}

export type RowChangeV2_ACU =
  | {
      op: 'upsert';
      rowId: string;
      rowIndexHint?: number;
      row: (string | null)[];
    }
  | {
      op: 'delete';
      rowId: string;
      rowIndexHint?: number;
    }
  | {
      op: 'clearSheet';
    };

export interface TablePersistenceLayerV2_ACU {
  version: 2;
  checkpoint?: TableCheckpointV2_ACU;
  /**
   * 旧版单 delta 字段，同时作为新格式下“最新 delta”的兼容镜像。
   * 当 deltas 存在且非空时，读取端必须以 deltas 为权威，避免重复回放该镜像。
   */
  delta?: TableLayerDeltaV2_ACU;
  /**
   * 同一消息楼层内的有序 delta 日志。按 sequence / 数组顺序依次回放。
   */
  deltas?: TableLayerDeltaV2_ACU[];
}

export interface CreateTableDeltaOptions_ACU {
  before: TableDataObject_ACU | null;
  after: TableDataObject_ACU | null;
  targetSheetKeys: string[];
  modifiedKeys: string[];
  updateGroupKeys: string[];
  isolationKey: string;
  targetMessageIndex: number;
  baseCheckpointId?: string;
  aiFloorHint?: number;
}

export interface ReconstructTablesFromChatDeltasOptions_ACU {
  allowLegacyMigration?: boolean;
  targetMessageIndexExclusive?: number;
  includeSameLayerDeltaAfterCheckpoint?: boolean;
  saveChatAfterMigration?: boolean;
  /**
   * 表格本地层保留数量。0/undefined 表示全部保留。
   * legacy 懒迁移写 checkpoint 时会用它选择锚点：未超过保留窗口写首个 AI，超过时写最早保留层。
   */
  retainRecentLayers?: number;
}

export interface LegacyMigrationOptions_ACU {
  targetBoundaryMessageIndex?: number;
  saveChat?: boolean;
}

export interface LegacyMigrationResult_ACU {
  migrated: boolean;
  checkpointMessageIndex?: number;
  checkpointId?: string;
}

export interface RollupCheckpointBeforePurgeResult_ACU {
  changed: boolean;
  boundaryMessageIndex?: number;
  checkpointId?: string;
  purgedMessageIndices: number[];
}
