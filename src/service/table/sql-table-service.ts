/**
 * service/table/sql-table-service.ts — SQLite 模式的 ITableStorageProvider 实现
 *
 * 核心职责：
 * - 管理 SqliteEngine 和 SyncBridge 的生命周期
 * - 将 AI 返回的 SQL 语句路由到引擎执行
 * - 维护 currentJsonTableData_ACU 的同步
 * - 提供 SQL 查询和变更的入口
 */

import type {
  ITableStorageProvider,
  SqlQueryResult,
  SqlMutationResult,
  ApplyEditsResult,
  TableSaveToChatOptions,
} from '../../shared/table-storage-provider';
import type { TableDataObject_ACU, Mate_ACU } from '../../shared/models/table-data';
import { SqliteEngine } from '../../data/sqlite/sqlite-engine';
import { SyncBridge } from '../../data/sqlite/sync-bridge';
import {
  saveIndependentTableToChatHistory_ACU,
} from './table-service';
import {
  currentJsonTableData_ACU,
  _set_currentJsonTableData_ACU,
} from '../runtime/state-manager';
import { mergeAllIndependentTablesWithMeta_ACU } from '../runtime/helpers-data-merge';
import { logDebug_ACU, logError_ACU, logWarn_ACU, parseTableTemplateJson_ACU, stripSeedRowsFromTemplate_ACU } from '../../shared/utils';
import { buildGlobalNameMapper, disposeGlobalNameMapper } from '../runtime/template-vars/name-mapper';
import { parseDDLTableName, generateDDL, generateInserts } from '../../data/sqlite/schema-mapper';
import { normalizeSqlStructure, normalizeStatementValues } from '../../data/sqlite/sql-normalizer';
import { getEffectiveSeedRowsForSheet_ACU, getCurrentChatTemplateScopeState_ACU, sanitizeTemplateSnapshotForChat_ACU } from '../template/chat-scope';
import { getTemplatePreset_ACU } from '../template/template-preset-service';
import { safeJsonParse_ACU } from '../../shared/json-helpers';
import { parseDDLColumnComments, parseDDLColumnNames } from '../../shared/ddl-utils';

export class SqlTableService implements ITableStorageProvider {
  readonly mode = 'sqlite' as const;
  private engine: SqliteEngine;
  private syncBridge: SyncBridge;
  private _initialized = false;
  private committedSnapshot: TableDataObject_ACU | null = null;
  private pendingBeforeSnapshot: TableDataObject_ACU | null = null;

  constructor() {
    this.engine = new SqliteEngine();
    this.syncBridge = new SyncBridge(this.engine);
  }

  /**
   * 从聊天消息加载表格数据到 SQLite
   * 1. mergeAllIndependentTables_ACU() 获取 JSON 快照
   * 2. engine.init() 创建内存数据库
   * 3. syncBridge.loadFromTableData() 建表 + 灌数据
   * 4. 更新 currentJsonTableData_ACU
   */
  async loadFromChat(): Promise<{
    loaded: boolean;
    source: 'merged' | 'initialized' | 'empty';
    error?: string;
  }> {
    try {
      // 初始化 SQLite 引擎
      await this.engine.init();

      // 从聊天消息合并出最新 JSON 快照，并保留 V2/legacy migration 元信息。
      // SQL 模式不能只靠 content.length 猜测是否真实数据：旧聊天懒迁移出来的 checkpoint
      // 可能在表结构/指导表合并后看起来像空壳，但它仍然代表历史快照，必须加载进 SQLite。
      const mergeResult = await mergeAllIndependentTablesWithMeta_ACU();
      const mergedData = mergeResult.data;

      // 判断 mergedData 是否包含真正的用户/AI 写入的数据行，
      // 还是仅仅是模板/历史快照恢复出的结构（只有表头没有数据行）。
      // 空壳结构不应触发建表——用户可能还要改表结构。
      // [修复] 同时排除来自基底状态消息的数据（seedGreeting 写入的模板初始数据），
      // 这些数据虽然 content.length > 1（包含 seedRows），但不是 AI 真正填写的数据，
      // 不应触发建表——建表延迟到第一次写操作时由 _ensureTablesFromTemplate 完成。
      const hasRealDataRows = mergedData && Object.keys(mergedData)
        .filter(k => k.startsWith('sheet_'))
        .some(k => {
          const sheet = (mergedData as any)[k];
          if (!sheet?.content || !Array.isArray(sheet.content) || sheet.content.length <= 1) return false;
          // 来自基底状态的数据（seedGreeting 写入）不算真实数据行
          if (sheet._acu_from_base_state) return false;
          return true;
        });
      // legacy 迁移阶段只负责把历史快照转换到本地聊天层（V2/checkpoint + JSON视图），
      // 不应在 loadFromChat 阶段触发 SQLite 建表；建表延迟到首次真实写操作。
      const shouldSkipSqlLoadForLegacyMigration = !!mergeResult.usedLegacyMigration;

      if (!mergedData || !hasRealDataRows || shouldSkipSqlLoadForLegacyMigration) {
        // 新开卡场景（mergedData=null）或空壳结构（只有表头）：
        // 只初始化引擎，不建表——建表延迟到第一次写操作（applyEdits/executeMutation）时
        // 这样用户在新开卡后还能修改表结构（DDL），直到真正填数据时才锁定表结构
        // 注意：executeQuery（只读）不触发建表，避免前端查询意外提前锁定表结构
        if (mergedData) {
          // 空壳结构：仍然更新 JSON 视图（前端需要显示表头），但不建 SQLite 表
          _set_currentJsonTableData_ACU(mergedData as TableDataObject_ACU);
          this._buildNameMapper(mergedData as TableDataObject_ACU);
          this._markCommitted(mergedData as TableDataObject_ACU);
          logDebug_ACU('[SqlTableService] 检测到空壳结构（仅表头无数据行），引擎已就绪，等待第一次填表时建表');
        } else {
          this._markCommitted(null);
          logDebug_ACU('[SqlTableService] 没有找到表格数据，引擎已就绪，等待第一次填表时从模板建表');
        }
        this._initialized = true;
        return { loaded: false, source: 'empty' };
      }

      // 将 JSON 数据加载到 SQLite
      // [防御] 修复 content 表头为空的 sheet——从 DDL 推导列名和中文注释
      // 这处理了历史数据被污染（content=[[]] 或 content[0] 为空数组）的场景
      if (mergedData) {
        const sheetKeys = Object.keys(mergedData).filter(k => k.startsWith('sheet_'));
        for (const sk of sheetKeys) {
          const sheet = (mergedData as any)[sk];
          if (sheet?.sourceData?.ddl && Array.isArray(sheet.content)) {
            const headers = sheet.content[0];
            if (!Array.isArray(headers) || headers.length === 0 || headers.every((v: any) => v === null || v === undefined || String(v ?? '').trim() === '')) {
              try {
                const comments = parseDDLColumnComments(sheet.sourceData.ddl);
                sheet.content[0] = parseDDLColumnNames(sheet.sourceData.ddl).map((sqlName: string) => comments.get(sqlName) || sqlName);
              } catch (_) { /* DDL 解析失败，保持原样 */ }
            }
          }
        }
      }
      this.syncBridge.loadFromTableData(mergedData as TableDataObject_ACU);

      // 更新全局 JSON 视图
      _set_currentJsonTableData_ACU(mergedData as TableDataObject_ACU);

      // 从所有表的 DDL 构建中英文名称映射器
      this._buildNameMapper(mergedData as TableDataObject_ACU);

      this._markCommitted(mergedData as TableDataObject_ACU);
      this._initialized = true;
      logDebug_ACU('[SqlTableService] SQLite 数据库加载完成');
      return { loaded: true, source: 'merged' };
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      logError_ACU(`[SqlTableService] 加载失败: ${errMsg}`);
      return { loaded: false, source: 'empty', error: errMsg };
    }
  }

  /**
   * 从 SQLite 导出并保存到聊天消息
   * 1. exportToTableData() 导出最新状态
   * 2. 更新 currentJsonTableData_ACU
   * 3. saveIndependentTableToChatHistory_ACU() 写入聊天
   */
  async saveToChat(options?: TableSaveToChatOptions): Promise<{ saved: boolean; messageIndex?: number; error?: string }>;
  async saveToChat(
    targetSheetKeys?: string[] | null,
    updateGroupKeys?: string[] | null,
  ): Promise<{ saved: boolean; messageIndex?: number; error?: string }>;
  async saveToChat(
    targetSheetKeysOrOptions?: string[] | null | TableSaveToChatOptions,
    updateGroupKeys?: string[] | null,
  ): Promise<{ saved: boolean; messageIndex?: number; error?: string }> {
    this._ensureInitialized();

    try {
      const saveOptions = this._normalizeSaveOptions(targetSheetKeysOrOptions, updateGroupKeys);
      // 从 SQLite 导出最新数据到 JSON 视图
      const exportedData = this.syncBridge.exportToTableData(this._getCurrentMate());
      const resolvedData = this._resolveExportedDataForJsonView(exportedData);
      _set_currentJsonTableData_ACU(resolvedData);

      const afterData = saveOptions.afterData !== undefined
        ? saveOptions.afterData
        : resolvedData;
      const beforeData = saveOptions.beforeData !== undefined
        ? saveOptions.beforeData
        : this.pendingBeforeSnapshot ?? this.committedSnapshot;

      const result = await saveIndependentTableToChatHistory_ACU({
        ...saveOptions,
        targetMessageIndex: saveOptions.targetMessageIndex ?? -1,
        beforeData,
        afterData,
      });

      if (result.saved) {
        this._markCommitted(afterData);
      }

      return result;
    } catch (e: any) {
      const errMsg = e?.message || String(e);
      logError_ACU(`[SqlTableService] 保存失败: ${errMsg}`);
      return { saved: false, error: errMsg };
    }
  }

  /**
   * 获取当前运行时的完整表格数据
   * 从 SQLite 导出最新状态，同步更新 JSON 视图后返回
   */
  getCurrentData(): TableDataObject_ACU | null {
    if (!this._initialized || !this.engine.isReady) {
      return currentJsonTableData_ACU;
    }

    try {
      const exportedData = this.syncBridge.exportToTableData(this._getCurrentMate());
      const resolvedData = this._resolveExportedDataForJsonView(exportedData);
      _set_currentJsonTableData_ACU(resolvedData);
      return resolvedData;
    } catch (e: any) {
      logError_ACU(`[SqlTableService] getCurrentData 失败: ${e?.message}`);
      return currentJsonTableData_ACU;
    }
  }

  /**
   * 用指定 JSON 快照替换 SQLite 模式当前数据源。
   * 批处理填表需要让提示词基底与 SQL 执行引擎完全一致；否则 AI 看到的当前数据
   * 和 INSERT/UPDATE 实际作用的数据库不是同一份状态。
   */
  async replaceCurrentData(data: TableDataObject_ACU | null): Promise<void> {
    this.engine.dispose();
    disposeGlobalNameMapper();
    this.engine = new SqliteEngine();
    this.syncBridge = new SyncBridge(this.engine);
    await this.engine.init();

    if (data) {
      const clonedData = this._cloneTableData(data)!;
      this.syncBridge.loadFromTableData(clonedData);
      _set_currentJsonTableData_ACU(clonedData);
      this._buildNameMapper(clonedData);
      this._markCommitted(clonedData);
    } else {
      _set_currentJsonTableData_ACU(null);
      this._markCommitted(null);
    }

    this._initialized = true;
  }

  /**
   * 应用 AI 返回的 SQL 编辑指令
   * 1. 拆分多条 SQL 语句
   * 2. 事务包裹执行（runBatch）
   * 3. 同步到 JSON 视图
   * 4. 返回结果
   *
   * 失败时抛出包含详细报错的 Error，供上层重试循环捕获
   */
  applyEdits(sqlStatements: string, _updateMode?: string): ApplyEditsResult {
    this._ensureInitialized();
    this._ensureTablesFromTemplate();

    // 纵深防御：剥离 AI 思维链标签，防止上层提取失败时泄漏进 SQL 执行层
    let cleaned = sqlStatements
      .replace(/<thinking[^>]*>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<thought[^>]*>[\s\S]*?<\/thought>/gi, '')
      .replace(/<\/?(?:thinking|thought)[^>]*>/gi, '')
      .replace(/<!--|-->/g, '')
      .trim();
    if (!cleaned) {
      return { success: true, modifiedKeys: [], appliedEdits: 0 };
    }

    // 按分号拆分为多条语句（跳过字符串内的分号）
    const rawStatements = splitSqlStatements(cleaned);
    if (rawStatements.length === 0) {
      return { success: true, modifiedKeys: [], appliedEdits: 0 };
    }

    // 对每条语句做规范化：结构字符兼容化 + 受约束字段值规范化
    const statements = rawStatements.map(stmt => {
      const structNormalized = normalizeSqlStructure(stmt);
      return normalizeStatementValues(structNormalized);
    });

    const hadPendingBeforeMutation = !!this.pendingBeforeSnapshot;
    this._markMutationStarted();

    try {
      // 事务执行
      const result = this.engine.runBatch(statements);

      // 同步到 JSON 视图
      this._syncToJson();

      // 收集受影响的表名（从 SQL 语句中提取）
      const modifiedTables = extractTableNamesFromStatements(statements);
      const modifiedKeys = this._tableNamesToSheetKeys(modifiedTables);

      logDebug_ACU(`[SqlTableService] SQL 执行成功: ${statements.length} 条语句, ${result.totalChanges} 行受影响`);

      return {
        success: true,
        modifiedKeys,
        appliedEdits: statements.length,
      };
    } catch (e: any) {
      if (!hadPendingBeforeMutation) {
        this.pendingBeforeSnapshot = null;
      }
      // 事务已回滚，数据保持原样
      const errMsg = e?.message || String(e);
      logError_ACU(`[SqlTableService] SQL 执行失败: ${errMsg}`);
      // 抛出错误，供上层重试循环捕获并注入到 AI prompt
      throw e;
    }
  }

  /**
   * 执行 SQL 查询（SELECT）
   *
   * 注意：不触发 _ensureTablesFromTemplate()。
   * 新开卡场景下表尚未创建，查询会抛出 "no such table" 错误——这是预期行为。
   * 建表只在写操作（applyEdits/executeMutation）时触发，确保用户有机会在首次填表前修改表结构。
   */
  executeQuery(sql: string, params?: (string | number | null)[]): SqlQueryResult {
    this._ensureInitialized();
    const result = this.engine.query(sql, params);
    return {
      columns: result.columns,
      values: result.values,
      rowCount: result.values.length,
    };
  }

  /**
   * 执行 SQL 变更语句（INSERT/UPDATE/DELETE）
   * 执行后自动同步到 JSON 视图
   */
  executeMutation(sql: string, params?: (string | number | null)[]): SqlMutationResult {
    this._ensureInitialized();
    this._ensureTablesFromTemplate();
    const hadPendingBeforeMutation = !!this.pendingBeforeSnapshot;
    try {
      // 对 SQL 做规范化：结构字符兼容化 + 受约束字段值规范化
      const normalizedSql = normalizeStatementValues(normalizeSqlStructure(sql));
      this._markMutationStarted();
      const result = this.engine.run(normalizedSql, params);
      this._syncToJson();
      return { changes: result.changes, errors: [] };
    } catch (e: any) {
      if (!hadPendingBeforeMutation) {
        this.pendingBeforeSnapshot = null;
      }
      return { changes: 0, errors: [e?.message || String(e)] };
    }
  }

  /**
   * 销毁数据库实例，释放内存
   */
  dispose(): void {
    this.engine.dispose();
    disposeGlobalNameMapper();
    this._initialized = false;
    logDebug_ACU('[SqlTableService] SQLite 引擎已销毁');
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════════════════════════

  private _cloneTableData(data: TableDataObject_ACU | null): TableDataObject_ACU | null {
    return data ? JSON.parse(JSON.stringify(data)) as TableDataObject_ACU : null;
  }

  private _markCommitted(data: TableDataObject_ACU | null): void {
    this.committedSnapshot = this._cloneTableData(data);
    this.pendingBeforeSnapshot = null;
  }

  private _markMutationStarted(): void {
    if (!this.pendingBeforeSnapshot) {
      this.pendingBeforeSnapshot = this._cloneTableData(this.committedSnapshot);
    }
  }

  private _normalizeSaveOptions(
    targetSheetKeysOrOptions?: string[] | null | TableSaveToChatOptions,
    updateGroupKeys?: string[] | null,
  ): TableSaveToChatOptions {
    if (targetSheetKeysOrOptions && !Array.isArray(targetSheetKeysOrOptions) && typeof targetSheetKeysOrOptions === 'object') {
      return targetSheetKeysOrOptions;
    }

    return {
      targetMessageIndex: -1,
      targetSheetKeys: Array.isArray(targetSheetKeysOrOptions) ? targetSheetKeysOrOptions : null,
      updateGroupKeys: updateGroupKeys ?? null,
    };
  }

  private _getCurrentMate(): Mate_ACU {
    return (currentJsonTableData_ACU?.mate as Mate_ACU) || {
      type: 'acu',
      version: 1,
      updateConfigUiSentinel: 0,
      globalInjectionConfig: {
        readableEntryPlacement: { position: '', depth: 0, order: 0 },
        wrapperPlacement: { position: '', depth: 0, order: 0 },
      },
    };
  }

  private _hasSheetEntries(data: TableDataObject_ACU | null | undefined): boolean {
    return !!data && Object.keys(data).some(key => key.startsWith('sheet_'));
  }

  /**
   * 解析 SQLite 导出结果在 JSON 视图中的最终形态。
   *
   * 新开对话/空壳结构下，SQLite 尚未物化用户表，但 currentJsonTableData_ACU 中已经有
   * header-only 模板结构供 UI 和提示词使用。此时空库导出会合法返回 mate-only；不能让它
   * 覆盖仍有业务意义的 JSON 空壳，否则表格会在刷新链路中闪一下后消失。
   */
  private _resolveExportedDataForJsonView(exportedData: TableDataObject_ACU): TableDataObject_ACU {
    if (
      this.engine.getTableNames().length === 0 &&
      !this._hasSheetEntries(exportedData) &&
      this._hasSheetEntries(currentJsonTableData_ACU)
    ) {
      return currentJsonTableData_ACU as TableDataObject_ACU;
    }

    return exportedData;
  }

  /** 从 TableDataObject 中提取所有 DDL，构建全局 NameMapper */
  private _buildNameMapper(data: TableDataObject_ACU): void {
    try {
      const ddlMap = new Map<string, string>();
      for (const [key, value] of Object.entries(data)) {
        if (!key.startsWith('sheet_')) continue;
        const sheet = value as any;
        const ddl = sheet?.sourceData?.ddl;
        if (!ddl) continue;
        const tableName = parseDDLTableName(ddl);
        if (tableName) {
          ddlMap.set(tableName, ddl);
        }
      }
      if (ddlMap.size > 0) {
        buildGlobalNameMapper(ddlMap);
      }
    } catch (e: any) {
      logWarn_ACU(`[SqlTableService] 构建 NameMapper 失败: ${e?.message}`);
    }
  }

  /** 同步 SQLite → JSON 视图 */
  private _syncToJson(): void {
    try {
      const exportedData = this.syncBridge.exportToTableData(this._getCurrentMate());
      const resolvedData = this._resolveExportedDataForJsonView(exportedData);
      _set_currentJsonTableData_ACU(resolvedData);
    } catch (e: any) {
      logError_ACU(`[SqlTableService] syncToJson 失败: ${e?.message}`);
    }
  }

  /** 将 SQL 表名映射为 sheetKey */
  private _tableNamesToSheetKeys(tableNames: string[]): string[] {
    if (!currentJsonTableData_ACU) return [];
    const keys: string[] = [];
    for (const [key, value] of Object.entries(currentJsonTableData_ACU)) {
      if (!key.startsWith('sheet_')) continue;
      const sheet = value as any;
      // 从 DDL 中解析表名进行匹配
      const ddl = sheet?.sourceData?.ddl;
      if (ddl) {
        const match = ddl.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
        if (match && tableNames.includes(match[1])) {
          keys.push(key);
        }
      }
    }
    return keys;
  }

  /** 确保引擎已初始化 */
  private _ensureInitialized(): void {
    if (!this._initialized || !this.engine.isReady) {
      throw new Error('[SqlTableService] SQLite 引擎未初始化，请先调用 loadFromChat()');
    }
  }

  /**
   * 按需建表：在写操作（applyEdits/executeMutation）前，检查当前聊天模板中的表是否都已存在于 SQLite。
   *
   * 仅在写操作时调用，不在只读查询（executeQuery）时调用。
   * 这样新开卡场景下，用户可以在首次填表前自由修改表结构（DDL），
   * 直到 AI 真正往表里写数据时才锁定表结构并建表。
   *
   * 三种场景：
   * 1. 新卡第一次填表：SQLite 中无任何用户表 → 全量建表
   * 2. 老卡正常运行：所有表都已存在 → 直接返回（幂等）
   * 3. 中途加表：模板中新增了一张表，但 SQLite 中没有 → 只建缺失的表
   *
   * 模板来源优先级（只使用当前聊天模板预设）：
   * 1. 当前聊天的 chat_override 模板快照
   * 2. 当前聊天的 preset_link 链接的全局预设
   * 3. 全局模板（inherit_global 或无聊天级模板时的 fallback）
   *
   * DDL 来源优先级：
   * 1. currentJsonTableData_ACU 中的 sourceData.ddl（可能来自指导表，包含用户在可视化编辑器中的修改）
   * 2. 当前聊天模板中的 sourceData.ddl（fallback）
   */
  private _ensureTablesFromTemplate(): void {
    const existingTables = new Set(this.engine.getTableNames());

    // [修复] 优先从当前聊天模板预设获取模板，而不是依赖全局变量 TABLE_TEMPLATE_ACU
    // 这样确保建表时只使用当前聊天模板预设的内容，不会混入全局模板的表
    const templateData = this._resolveCurrentChatTemplate();
    if (!templateData) {
      if (existingTables.size > 0) return;
      throw new Error('[SqlTableService] 模板解析失败，无法建表。请检查模板格式。');
    }

    // 收集当前聊天模板中所有表的 sheetKey 和表名，找出 SQLite 中缺失的
    const sheetKeys = Object.keys(templateData).filter(k => k.startsWith('sheet_'));
    const templateSheetKeySet = new Set(sheetKeys);
    const missingSheets: Record<string, any> = {};

    for (const key of sheetKeys) {
      // 优先从 currentJsonTableData_ACU 获取 sheet 数据（可能包含指导表中用户修改过的 DDL），
      // fallback 到当前聊天模板。这样用户在可视化编辑器中修改 DDL 后，建表时用的是新 DDL。
      const liveSheet = (currentJsonTableData_ACU as any)?.[key];
      const sheet = liveSheet || templateData[key] as any;
      if (!sheet) continue;
      const ddl = generateDDL(sheet);
      const tableName = parseDDLTableName(ddl);
      if (tableName && !existingTables.has(tableName)) {
        missingSheets[key] = sheet;
      }
    }

    // [修复] 检查 currentJsonTableData_ACU 中是否有当前聊天模板中存在但上面未处理的表
    // 注意：只允许建当前聊天模板中存在的表，不建其他来源的表
    if (currentJsonTableData_ACU) {
      const liveSheetKeys = Object.keys(currentJsonTableData_ACU).filter(k => k.startsWith('sheet_'));
      for (const key of liveSheetKeys) {
        if (missingSheets[key]) continue; // 已在上面处理过
        if (!templateSheetKeySet.has(key)) continue; // 不在当前聊天模板中，跳过
        const sheet = (currentJsonTableData_ACU as any)[key];
        if (!sheet?.sourceData?.ddl) continue;
        const tableName = parseDDLTableName(sheet.sourceData.ddl);
        if (tableName && !existingTables.has(tableName)) {
          missingSheets[key] = sheet;
        }
      }
    }

    // 所有表都已存在，无需建表
    if (Object.keys(missingSheets).length === 0) return;

    logDebug_ACU(`[SqlTableService] 发现 ${Object.keys(missingSheets).length} 张缺失表，按需建表: ${Object.keys(missingSheets).join(', ')}`);

    // 构造只包含缺失表的数据子集，交给 syncBridge 建表
    // [修复] 同时为缺失表注入 seedRows（初始数据），使建表后 SQLite 中包含初版快照
    // 设计文档 Q9 确认：seedRows 是初版快照，应写入 SQLite 作为真实数据
    const partialData: TableDataObject_ACU = { mate: templateData.mate };
    for (const [key, sheet] of Object.entries(missingSheets)) {
      const sheetCopy = JSON.parse(JSON.stringify(sheet));

      // 如果 sheet 的 content 只有表头（stripSeedRows 后的空壳），尝试注入 seedRows
      if (Array.isArray(sheetCopy.content) && sheetCopy.content.length <= 1) {
        const seedRows = getEffectiveSeedRowsForSheet_ACU(key, { allowTemplateFallback: true });
        if (Array.isArray(seedRows) && seedRows.length > 0) {
          // seedRows 是不含表头的纯数据行，拼接到表头后面
          sheetCopy.content = [sheetCopy.content[0] || [], ...seedRows];
          logDebug_ACU(`[SqlTableService] 表 ${key} (${sheetCopy.name}) 注入 ${seedRows.length} 行 seedRows 作为初版快照`);
        }
      }

      (partialData as any)[key] = sheetCopy;
    }
    this.syncBridge.loadFromTableData(partialData);

    // 合并新建的表到当前 JSON 视图
    if (currentJsonTableData_ACU) {
      for (const [key, sheet] of Object.entries(missingSheets)) {
        (currentJsonTableData_ACU as any)[key] = sheet;
      }
    } else {
      _set_currentJsonTableData_ACU(templateData);
    }
    this._buildNameMapper(currentJsonTableData_ACU || templateData);

    logDebug_ACU(`[SqlTableService] 按需建表完成，当前共 ${this.engine.getTableNames().length} 张表`);
  }

  /**
   * 解析当前聊天模板预设，返回 stripSeedRows 后的模板对象。
   *
   * 优先级：
   * 1. chat_override —— 当前聊天的专属模板快照
   * 2. preset_link  —— 当前聊天链接的全局预设
   * 3. inherit_global / 无聊天级模板 —— fallback 到 parseTableTemplateJson_ACU（全局模板）
   */
  private _resolveCurrentChatTemplate(): TableDataObject_ACU | null {
    try {
      const scopeState = getCurrentChatTemplateScopeState_ACU();

      if (scopeState) {
        let templateStr: string | null = null;

        if (scopeState.mode === 'chat_override' && scopeState.templateStr) {
          // 场景 1：当前聊天有专属模板快照
          templateStr = scopeState.templateStr;
        } else if (scopeState.mode === 'preset_link' && scopeState.presetName) {
          // 场景 2：当前聊天链接了全局预设
          const preset = getTemplatePreset_ACU(scopeState.presetName);
          if (preset?.templateStr) {
            templateStr = preset.templateStr;
          }
        }

        if (templateStr) {
          const parsed = safeJsonParse_ACU(templateStr, null);
          if (parsed && typeof parsed === 'object') {
            const stripped = stripSeedRowsFromTemplate_ACU(JSON.parse(JSON.stringify(parsed)));
            logDebug_ACU(`[SqlTableService] 使用当前聊天模板预设 (mode=${scopeState.mode})`);
            return stripped as TableDataObject_ACU;
          }
        }
      }
    } catch (e: any) {
      logWarn_ACU(`[SqlTableService] 获取当前聊天模板快照失败，fallback 到全局模板: ${e?.message}`);
    }

    // 场景 3：inherit_global 或无聊天级模板，fallback 到全局模板
    logDebug_ACU('[SqlTableService] 使用全局模板 (inherit_global)');
    return parseTableTemplateJson_ACU({ stripSeedRows: true }) as TableDataObject_ACU | null;
  }
}

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

/**
 * 按分号拆分 SQL 语句（跳过字符串内的分号）
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (inString) {
      current += char;
      // 检查字符串结束（处理转义的引号 ''）
      if (char === stringChar) {
        if (i + 1 < sql.length && sql[i + 1] === stringChar) {
          // 转义的引号，跳过
          current += sql[i + 1];
          i++;
        } else {
          inString = false;
        }
      }
    } else if (char === "'" || char === '"') {
      inString = true;
      stringChar = char;
      current += char;
    } else if (char === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
    } else {
      current += char;
    }
  }

  // 最后一条语句（可能没有分号结尾）
  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);

  return statements;
}

/**
 * 从 SQL 语句中提取表名（简单正则匹配）
 * 支持 INSERT INTO、UPDATE、DELETE FROM、ALTER TABLE
 */
export function extractTableNamesFromStatements(statements: string[]): string[] {
  const tableNames = new Set<string>();
  const patterns = [
    /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/i,
    /UPDATE\s+(?:OR\s+\w+\s+)?(\w+)/i,
    /DELETE\s+FROM\s+(\w+)/i,
    /ALTER\s+TABLE\s+(\w+)/i,
  ];

  for (const stmt of statements) {
    for (const pattern of patterns) {
      const match = stmt.match(pattern);
      if (match) {
        tableNames.add(match[1]);
        break;
      }
    }
  }

  return Array.from(tableNames);
}
