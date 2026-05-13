/**
 * shared/table-storage-provider.ts — 统一的表格存储提供者接口
 *
 * 定义 ITableStorageProvider 接口，原生模式和 SQLite 模式各自实现。
 * 上层代码通过策略选择器获取 Provider，不直接依赖具体实现。
 */

import type { TableDataObject_ACU } from './models/table-data';

/** 存储模式 */
export type StorageMode = 'native' | 'sqlite';

/** SQL 查询结果（SELECT） */
export interface SqlQueryResult {
  /** 列名数组 */
  columns: string[];
  /** 结果行（每行是一个值数组） */
  values: (string | number | Uint8Array | null)[][];
  /** 结果行数 */
  rowCount: number;
}

/** SQL 变更结果（INSERT/UPDATE/DELETE） */
export interface SqlMutationResult {
  /** 受影响的行数 */
  changes: number;
  /** 错误信息列表（如果有） */
  errors: string[];
}

/** 保存到聊天消息的选项 */
export interface TableSaveToChatOptions {
  targetMessageIndex?: number;
  targetSheetKeys?: string[] | null;
  updateGroupKeys?: string[] | null;
  beforeData?: TableDataObject_ACU | null;
  afterData?: TableDataObject_ACU | null;
  trackingSheetKeys?: string[] | null;
  trackAsUpdate?: boolean;
}

/** AI 编辑应用结果 */
export interface ApplyEditsResult {
  /** 是否成功 */
  success: boolean;
  /** 受影响的 sheetKey 列表 */
  modifiedKeys: string[];
  /** 成功应用的编辑数量 */
  appliedEdits: number;
  /** 错误信息（失败时） */
  error?: string;
}

/**
 * 统一的表格存储提供者接口
 *
 * 原生模式（NativeTableServiceAdapter）和 SQLite 模式（SqlTableService）
 * 各自实现此接口。上层代码通过 getStorageProvider() 获取当前 Provider，
 * 不需要知道底层是 JSON 操作还是 SQL 操作。
 */
export interface ITableStorageProvider {
  /** 模式标识 */
  readonly mode: StorageMode;

  /**
   * 从聊天消息加载表格数据到运行时
   * - native：调用 loadOrCreateJsonTableFromChatHistory_ACU
   * - sqlite：mergeAll → loadFromTableData → 建表灌数据
   */
  loadFromChat(): Promise<{
    loaded: boolean;
    source: 'merged' | 'initialized' | 'empty';
    error?: string;
  }>;

  /**
   * 保存当前运行时数据到聊天消息
   * - native：调用 saveIndependentTableToChatHistory_ACU
   * - sqlite：exportToTableData → 更新 JSON 视图 → saveIndependentTable
   */
  saveToChat(options?: TableSaveToChatOptions): Promise<{ saved: boolean; messageIndex?: number; error?: string }>;
  saveToChat(
    targetSheetKeys?: string[] | null,
    updateGroupKeys?: string[] | null,
  ): Promise<{ saved: boolean; messageIndex?: number; error?: string }>;

  /**
   * 获取当前运行时的完整表格数据（JSON 格式）
   * 两种模式都返回 TableDataObject_ACU，保证上层代码零改动
   */
  getCurrentData(): TableDataObject_ACU | null;

  /**
   * 用调用方提供的 JSON 表格快照替换当前运行时数据源。
   *
   * 这是批处理填表的关键同步点：提示词构造会读取同一批次的历史基底，
   * SQL 模式也必须把 SQLite 内存库替换成同一份基底，否则就会出现
   * “提示词看到 A、SQL 写入 B”的双数据源事故。
   *
   * - native：仅同步 currentJsonTableData_ACU
   * - sqlite：重建 SQLite 内存库并从该快照加载，同时同步 JSON 视图与 committed snapshot
   */
  replaceCurrentData(data: TableDataObject_ACU | null): Promise<void>;

  /**
   * 应用 AI 返回的编辑指令
   * - native：解析 DSL（insertRow/updateRow/deleteRow）
   * - sqlite：执行 SQL 语句（事务包裹，失败回滚）
   *
   * @param edits AI 返回的编辑内容（DSL 或 SQL）
   * @param updateMode 更新模式（standard/summary/unified）
   * @returns 应用结果
   */
  applyEdits(edits: string, updateMode?: string): ApplyEditsResult;

  /**
   * 执行 SQL 查询（仅 sqlite 模式支持）
   * native 模式调用时抛出 Error
   */
  executeQuery(sql: string, params?: (string | number | null)[]): SqlQueryResult;

  /**
   * 执行 SQL 变更语句（仅 sqlite 模式支持）
   * native 模式调用时抛出 Error
   */
  executeMutation(sql: string, params?: (string | number | null)[]): SqlMutationResult;

  /**
   * 销毁/清理资源
   * - native：无操作
   * - sqlite：关闭数据库实例
   */
  dispose(): void;
}
