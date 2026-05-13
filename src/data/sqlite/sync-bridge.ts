/**
 * data/sqlite/sync-bridge.ts — SQLite ↔ ChatMessage 双向同步桥
 *
 * 加载方向：ChatMessage → mergeAll → JSON → SQLite
 * 保存方向：SQLite → JSON → saveIndependentTable → ChatMessage
 *
 * 关键设计：复用现有的 mergeAllIndependentTables_ACU 和
 *          saveIndependentTableToChatHistory_ACU，不重新实现持久化逻辑
 */

import { SqliteEngine } from './sqlite-engine';
import { generateDDL, generateInserts, resultToContent, parseDDLTableName, buildColumnNameMap, validateDDLAgainstHeaders } from './schema-mapper';
import type { TableDataObject_ACU, Sheet_ACU, Mate_ACU } from '../../shared/models/table-data';
import { logDebug_ACU, logError_ACU, logWarn_ACU } from '../../shared/utils';

/** 同步桥的元数据表名（内部使用，对用户和 AI 不可见） */
const META_TABLE_NAME = '_acu_sheet_meta';

/** 元数据表的建表 DDL */
const META_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${META_TABLE_NAME} (
  sheet_key TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  order_no INTEGER DEFAULT 0,
  source_data_json TEXT,
  update_config_json TEXT,
  export_config_json TEXT
);`;

export class SyncBridge {
  constructor(private engine: SqliteEngine) {}

  /**
   * 从 TableDataObject 加载到 SQLite
   * 1. 创建元数据表
   * 2. 遍历每张 sheet：建表 + 灌数据 + 写元数据
   *
   * @param data 完整的表格数据对象（通常来自 mergeAllIndependentTables_ACU 的结果）
   */
  loadFromTableData(data: TableDataObject_ACU): void {
    if (!data || typeof data !== 'object') return;
    if (!this.engine.isReady) {
      throw new Error('SyncBridge: SqliteEngine 未初始化');
    }

    // 创建元数据表
    this._ensureMetaTable();

    // 遍历所有 sheet
    const sheetKeys = Object.keys(data).filter(k => k.startsWith('sheet_'));
    logDebug_ACU(`[SyncBridge] 开始加载 ${sheetKeys.length} 张表到 SQLite`);
    for (const key of sheetKeys) {
      const sheet = data[key] as Sheet_ACU;
      if (!sheet || !Array.isArray(sheet.content)) continue;

      try {
        this._loadSheet(key, sheet);
      } catch (e: any) {
        // 单张表加载失败不影响其他表
        logError_ACU(`[SyncBridge] 加载表 ${key} (${sheet.name}) 失败:`, e?.message || e);
      }
    }
  }

  /**
   * 从 SQLite 导出为 TableDataObject
   * SELECT * FROM 每张用户表 → 还原为 content 二维数组
   * 元数据从 _acu_sheet_meta 表读取
   *
   * @param originalMate 原始的 mate 对象（SQLite 不存储 mate，需要外部传入）
   * @returns 完整的 TableDataObject
   */
  exportToTableData(originalMate: Mate_ACU): TableDataObject_ACU {
    if (!this.engine.isReady) {
      throw new Error('SyncBridge: SqliteEngine 未初始化');
    }

    const result: TableDataObject_ACU = { mate: originalMate };

    // 读取元数据。空数据库也必须有内部元表，避免把正常空状态变成 SQLite 错误日志。
    this._ensureMetaTable();
    const metaMap = this._loadAllMeta();

    // 遍历所有用户表
    const tableNames = this.engine.getTableNames();
    logDebug_ACU(`[SyncBridge] 开始导出 ${tableNames.length} 张表从 SQLite`);
    for (const tableName of tableNames) {
      // 查找对应的元数据
      const meta = this._findMetaByTableName(metaMap, tableName);
      if (!meta) continue;

      try {
        const sheet = this._exportSheet(tableName, meta);
        result[meta.sheetKey] = sheet;
      } catch (e: any) {
        logError_ACU(`[SyncBridge] 导出表 ${tableName} 失败:`, e?.message || e);
      }
    }

    return result;
  }

  /**
   * 仅同步 SQLite → JSON（不写聊天消息）
   * 用于 AI 编辑后立即更新内存视图，但延迟持久化
   *
   * @param originalData 原始的 TableDataObject（提供 mate 和未变更的 sheet 信息）
   * @returns 更新后的 TableDataObject
   */
  syncToJson(originalData: TableDataObject_ACU): TableDataObject_ACU {
    return this.exportToTableData(originalData.mate as Mate_ACU);
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════════════════════════

  /** 确保内部元数据表存在。只创建 _acu_ 系统表，不创建任何用户表。 */
  private _ensureMetaTable(): void {
    this.engine.run(META_TABLE_DDL);
  }

  /** 加载单张 sheet 到 SQLite */
  private _loadSheet(sheetKey: string, sheet: Sheet_ACU): void {
    // 生成 DDL
    const ddl = generateDDL(sheet);
    const tableName = parseDDLTableName(ddl);
    if (!tableName) {
      throw new Error(`无法从 DDL 中解析表名: ${ddl.substring(0, 100)}`);
    }

    // [6.7.1] DDL 与 content 表头校验
    const headers = sheet.content?.[0];
    if (headers && Array.isArray(headers) && sheet.sourceData?.ddl) {
      const validation = validateDDLAgainstHeaders(sheet.sourceData.ddl, headers);
      if (!validation.valid) {
        logWarn_ACU(
          `[SyncBridge] 表 "${sheet.name}" (${sheetKey}) DDL 与表头不匹配:\n` +
          validation.mismatches.map(m => `  - ${m}`).join('\n') +
          `\n将按位置映射继续加载，多余列数据可能丢失。`
        );
      }
    }

    // loadFromTableData 的语义是用传入 JSON 快照替换 SQLite 中的当前表数据。
    // 即使调用方复用同一个 engine，或运行环境未完全释放旧 sql.js Database，
    // 也不能让 CREATE TABLE 因同名用户表已存在而失败。
    this._dropExistingUserTable(tableName);

    // 建表
    this.engine.run(ddl);

    // 灌入数据
    const inserts = generateInserts(sheet, tableName);
    if (inserts.length > 0) {
      this.engine.runBatch(inserts);
    }

    // 写入元数据
    this.engine.run(
      `INSERT OR REPLACE INTO ${META_TABLE_NAME} (sheet_key, uid, name, order_no, source_data_json, update_config_json, export_config_json) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [
        sheetKey,
        sheet.uid || sheetKey,
        sheet.name || sheetKey,
        sheet.orderNo ?? 0,
        JSON.stringify(sheet.sourceData || {}),
        JSON.stringify(sheet.updateConfig || {}),
        JSON.stringify(sheet.exportConfig || {}),
      ]
    );
  }

  /**
   * 删除已存在的用户表，保证 loadFromTableData 具备替换式加载语义。
   * 内部元数据表和非法表名不会走到这里：tableName 来自 DDL 解析，仍做防御性校验。
   */
  private _dropExistingUserTable(tableName: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`非法表名: ${tableName}`);
    }
    if (tableName.startsWith('_acu_') || tableName.startsWith('sqlite_')) {
      throw new Error(`拒绝删除内部表: ${tableName}`);
    }

    if (this.engine.getTableDDL(tableName) !== null) {
      logDebug_ACU(`[SyncBridge] 替换加载前删除已存在表: ${tableName}`);
      this.engine.run(`DROP TABLE ${tableName};`);
    }
  }

  /** 从 SQLite 导出单张表为 Sheet_ACU */
  private _exportSheet(tableName: string, meta: SheetMeta): Sheet_ACU {
    // 查询所有数据
    const queryResult = this.engine.query(`SELECT * FROM ${tableName};`);

    // 构建列名映射（英文 → 中文）
    const ddl = meta.sourceData?.ddl || this.engine.getTableDDL(tableName) || '';
    const { sqlToChinese } = buildColumnNameMap(ddl);

    // 转换为 content
    const content = resultToContent(queryResult.columns, queryResult.values, sqlToChinese);

    return {
      uid: meta.uid,
      name: meta.name,
      sourceData: meta.sourceData,
      content,
      updateConfig: meta.updateConfig,
      exportConfig: meta.exportConfig,
      orderNo: meta.orderNo,
    };
  }

  /** 读取所有元数据 */
  private _loadAllMeta(): Map<string, SheetMeta> {
    const map = new Map<string, SheetMeta>();
    try {
      const result = this.engine.query(`SELECT * FROM ${META_TABLE_NAME};`);
      for (const row of result.values) {
        const sheetKey = String(row[0]);
        map.set(sheetKey, {
          sheetKey,
          uid: String(row[1]),
          name: String(row[2]),
          orderNo: Number(row[3]) || 0,
          sourceData: safeJsonParse(row[4]),
          updateConfig: safeJsonParse(row[5]),
          exportConfig: safeJsonParse(row[6]),
        });
      }
    } catch (_) {
      // 元数据表不存在时返回空 map
    }
    return map;
  }

  /** 通过 SQL 表名查找对应的元数据 */
  private _findMetaByTableName(metaMap: Map<string, SheetMeta>, tableName: string): SheetMeta | null {
    // 遍历元数据，找到 DDL 中表名匹配的那条
    for (const [, meta] of metaMap) {
      const ddl = meta.sourceData?.ddl;
      if (ddl) {
        const ddlTableName = parseDDLTableName(ddl);
        if (ddlTableName === tableName) return meta;
      }
    }
    // fallback：用 uid 匹配
    for (const [, meta] of metaMap) {
      if (meta.uid === tableName) return meta;
    }
    return null;
  }
}

/** 元数据结构 */
interface SheetMeta {
  sheetKey: string;
  uid: string;
  name: string;
  orderNo: number;
  sourceData: any;
  updateConfig: any;
  exportConfig: any;
}

/** 安全的 JSON 解析 */
function safeJsonParse(val: SqlJsValueType): any {
  if (val === null || val === undefined) return {};
  try {
    return JSON.parse(String(val));
  } catch (_) {
    return {};
  }
}
