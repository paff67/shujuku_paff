/**
 * data/sqlite/schema-mapper.ts — Sheet ↔ SQL 双向映射
 *
 * 职责：
 * - Sheet → SQL：生成 DDL + INSERT 语句
 * - SQL → Sheet：SELECT 结果 → content 二维数组
 * - 处理类型亲和性转换（content 全是 string，SQL 有类型）
 * - DDL 解析（表名、中文名、列信息）
 */

import type { Sheet_ACU } from '../../shared/models/table-data';
import { logDebug_ACU, logError_ACU, logWarn_ACU } from '../../shared/utils';
import { normalizeSqlStructure, normalizeConstrainedValue } from './sql-normalizer';

// DDL 纯解析函数已移至 shared/ddl-utils.ts，此处 re-export 保持 data 层内部调用不变
export {
  parseDDLTableName,
  parseDDLChineseName,
  parseDDLColumnNames,
  parseDDLColumnComments,
  buildColumnNameMap,
  getDDLColumnNameByIndex,
  updateDDLColumnComment,
  parseDDLColumnInfos_ACU,
  validateDDLTextAgainstHeaders_ACU,
} from '../../shared/ddl-utils';
import {
  parseDDLTableName,
  parseDDLColumnNames,
  validateDDLTextAgainstHeaders_ACU,
} from '../../shared/ddl-utils';

// ═══════════════════════════════════════════════════════════════
// DDL 生成
// ═══════════════════════════════════════════════════════════════

/**
 * 从 Sheet 生成建表 DDL
 * 优先使用 sourceData.ddl，fallback 为全 TEXT 的自动生成 DDL
 *
 * @param sheet Sheet 对象
 * @param fallbackTableName fallback 时使用的英文表名（默认用 sheet.uid）
 * @returns CREATE TABLE 语句
 */
export function generateDDL(sheet: Sheet_ACU, fallbackTableName?: string): string {
  // 优先使用用户定义的 DDL
  const ddl = sheet.sourceData?.ddl?.trim();
  if (ddl) {
    // 对 DDL 做结构字符规范化（全角兼容字符 → ASCII）
    const normalizedDdl = normalizeSqlStructure(ddl);
    logDebug_ACU(`[Schema] generateDDL: 使用用户定义 DDL, 表名=${parseDDLTableName(normalizedDdl) || 'unknown'}`);
    return normalizedDdl;
  }

  // fallback：从 content[0] 表头自动生成全 TEXT 的 DDL
  const headers = sheet.content?.[0];
  if (!Array.isArray(headers) || headers.length === 0) {
    const tblName = fallbackTableName || sheet.uid || 'unknown_table';
    return `CREATE TABLE ${sanitizeIdentifier(tblName)} (\n  row_id INTEGER PRIMARY KEY -- 行号\n);`;
  }

  const tblName = fallbackTableName || sheet.uid || 'unknown_table';
  return generateFallbackDDL(sanitizeIdentifier(tblName), headers);
}

/**
 * 从 content[0] 表头自动生成全 TEXT 的 fallback DDL
 * 第一列 "row_id" 映射为 INTEGER PRIMARY KEY
 * 其余列全部为 TEXT
 *
 * @param tableName 英文表名
 * @param headers content[0] 表头行
 * @returns CREATE TABLE 语句
 */
export function generateFallbackDDL(tableName: string, headers: (string | null)[]): string {
  const lines: string[] = [];

  for (let i = 0; i < headers.length; i++) {
    const colName = headers[i];
    if (colName === 'row_id') {
      lines.push('  row_id INTEGER PRIMARY KEY -- 行号');
    } else if (colName) {
      // 中文列名转为合法的 SQL 标识符
      const sqlColName = chineseToIdentifier(colName);
      lines.push(`  ${sqlColName} TEXT -- ${colName}`);
    }
  }

  if (lines.length === 0) {
    lines.push('  row_id INTEGER PRIMARY KEY -- 行号');
  }

  // 逗号必须放在注释之前（-- 注释到行尾，逗号在注释后会被注释掉）
  // 格式：column_def, -- 注释
  const formattedLines = lines.map((line, idx) => {
    if (idx < lines.length - 1) {
      // 非最后一行：在注释前插入逗号
      const commentIdx = line.indexOf('--');
      if (commentIdx > 0) {
        return line.substring(0, commentIdx).trimEnd() + ', ' + line.substring(commentIdx);
      }
      return line + ',';
    }
    return line; // 最后一行不加逗号
  });

  return `CREATE TABLE ${sanitizeIdentifier(tableName)} (\n${formattedLines.join('\n')}\n);`;
}

// ═══════════════════════════════════════════════════════════════
// INSERT 生成
// ═══════════════════════════════════════════════════════════════

/**
 * 从 Sheet 生成 INSERT 语句（灌入 content 数据）
 * content[0] 是表头，content[1:] 是数据行
 *
 * @param sheet Sheet 对象
 * @param tableName SQL 表名（如果不传，从 DDL 解析或用 sheet.uid）
 * @returns INSERT 语句数组（每行一条）
 */
export function generateInserts(sheet: Sheet_ACU, tableName?: string): string[] {
  const content = sheet.content;
  if (!Array.isArray(content) || content.length < 2) return [];

  const headers = content[0];
  if (!Array.isArray(headers) || headers.length === 0) return [];

  // 确定表名
  const tblName = tableName
    || parseDDLTableName(sheet.sourceData?.ddl || '')
    || sheet.uid
    || 'unknown_table';

  logDebug_ACU(`[Schema] generateInserts: 表=${tblName}, 数据行数=${content.length - 1}`);

  // 确定列名（从 DDL 解析，或从表头生成）
  const ddlColumns = sheet.sourceData?.ddl ? parseDDLColumnNames(sheet.sourceData.ddl) : null;
  const columnNames = ddlColumns || headers.map((h, i) => {
    if (h === 'row_id') return 'row_id';
    return h ? chineseToIdentifier(h) : `col_${i}`;
  });

  const statements: string[] = [];

  for (let r = 1; r < content.length; r++) {
    const row = content[r];
    if (!Array.isArray(row)) continue;

    const values: string[] = [];
    for (let c = 0; c < columnNames.length; c++) {
      const val = c < row.length ? row[c] : null;
      // 对白名单约束字段做值规范化（如 code_index 的大小写/全角数字）
      const normalizedVal = normalizeConstrainedValue(columnNames[c], val);
      values.push(escapeValue(normalizedVal));
    }

    statements.push(
      `INSERT INTO ${sanitizeIdentifier(tblName)} (${columnNames.map(sanitizeIdentifier).join(', ')}) VALUES (${values.join(', ')});`
    );
  }

  return statements;
}

// ═══════════════════════════════════════════════════════════════
// SQL 结果 → content 转换
// ═══════════════════════════════════════════════════════════════

/**
 * 从 SQL 查询结果还原为 content 二维数组
 * 自动将 SQL 类型值转为 string（content 的存储格式）
 *
 * @param columns SQL 结果的列名数组
 * @param values SQL 结果的值数组
 * @param chineseHeaders 中文表头映射（列名 → 中文名），用于还原 content[0]
 * @param fallbackColumns 当 SQL 引擎对空结果返回空列名时，用 DDL 解析出的列名恢复表头
 * @returns content 二维数组（第一行是表头，后续是数据行）
 */
export function resultToContent(
  columns: string[],
  values: SqlJsValueType[][],
  chineseHeaders?: Map<string, string>,
  fallbackColumns?: string[]
): (string | null)[][] {
  const effectiveColumns = Array.isArray(columns) && columns.length > 0
    ? columns
    : (Array.isArray(fallbackColumns) && fallbackColumns.length > 0 ? fallbackColumns : []);

  if (effectiveColumns.length === 0) return [['row_id']];

  // 构建表头行：用中文名（如果有映射），否则用 SQL 列名
  const headerRow: (string | null)[] = effectiveColumns.map(col => {
    if (col === 'row_id') return 'row_id';
    return chineseHeaders?.get(col) || col;
  });

  // 构建数据行：所有值转为 string
  const dataRows: (string | null)[][] = values.map(row =>
    row.map(val => valueToString(val))
  );

  return [headerRow, ...dataRows];
}

// ═══════════════════════════════════════════════════════════════
// DDL 校验
// ═══════════════════════════════════════════════════════════════

/**
 * 校验 DDL 列名与 content[0] 表头是否匹配
 * 比较的是列数和列的对应关系（通过 DDL 注释中的中文名匹配）
 *
 * @param ddl CREATE TABLE 语句
 * @param headers content[0] 表头行
 * @returns 校验结果
 */
export function validateDDLAgainstHeaders(
  ddl: string,
  headers: (string | null)[]
): { valid: boolean; mismatches: string[] } {
  const normalizedHeaders = headers.filter(h => h !== null).map(h => String(h ?? ''));
  const result = validateDDLTextAgainstHeaders_ACU(ddl, normalizedHeaders);
  return {
    valid: result.valid,
    mismatches: result.valid ? [] : [result.message],
  };
}



// ═══════════════════════════════════════════════════════════════
// 内部工具函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将 SQL 值转为 content 中的 string 格式
 * null → null, number → string, Uint8Array → "[BLOB]", string → string
 */
function valueToString(val: SqlJsValueType): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Uint8Array) return '[BLOB]';
  return String(val);
}

/**
 * 将 content 中的值转为 SQL 字面量
 * null/undefined → NULL, 数字字符串 → 数字, 其他 → 带引号的字符串
 */
function escapeValue(val: string | null | undefined): string {
  if (val === null || val === undefined || val === '') return 'NULL';
  // 纯数字（整数或浮点数）直接输出
  if (/^-?\d+(\.\d+)?$/.test(val)) return val;
  // 字符串：单引号转义
  return `'${val.replace(/'/g, "''")}'`;
}

/**
 * 清理 SQL 标识符（防止注入）
 * 只保留字母、数字、下划线
 */
function sanitizeIdentifier(name: string): string {
  // 如果已经是合法标识符，直接返回
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return name;
  // 否则去掉非法字符
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return cleaned || '_unknown';
}

/**
 * 将中文列名转为合法的 SQL 标识符
 * 使用拼音首字母或简单的 col_N 格式
 */
function chineseToIdentifier(name: string): string {
  if (!name) return '_unknown';
  // 如果已经是合法标识符，直接返回
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return name;
  // 中文名：用下划线连接的 ASCII 化
  const ascii = name.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (ascii && /^[a-zA-Z_]/.test(ascii)) return ascii;
  // 实在不行就用 col_ 前缀
  return `col_${ascii || 'unknown'}`;
}


