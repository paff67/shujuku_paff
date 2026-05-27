/**
 * tests/data/sqlite/schema-mapper.test.ts
 * schema-mapper 纯函数单元测试
 */
import { describe, it, expect } from 'vitest';
import {
  generateDDL,
  generateFallbackDDL,
  generateInserts,
  resultToContent,
  validateDDLAgainstHeaders,
  parseDDLTableName,
  parseDDLChineseName,
  parseDDLColumnNames,
  parseDDLColumnComments,
  buildColumnNameMap,
} from '../../../src/data/sqlite/schema-mapper';
import type { Sheet_ACU } from '../../../src/shared/models/table-data';

// ═══════════════════════════════════════════════════════════════
// 辅助：构造最小 Sheet_ACU mock
// ═══════════════════════════════════════════════════════════════
function makeSheet(overrides: Partial<Sheet_ACU> = {}): Sheet_ACU {
  return {
    uid: 'test_table',
    name: '测试表',
    sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '' },
    content: [
      ['row_id', '姓名', '年龄'],
      ['1', '张三', '25'],
      ['2', '李四', '30'],
    ],
    updateConfig: { uiSentinel: 0, contextDepth: 0, updateFrequency: 0, batchSize: 0, skipFloors: 0 },
    exportConfig: {} as any,
    orderNo: 0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// parseDDLTableName
// ═══════════════════════════════════════════════════════════════
describe('parseDDLTableName', () => {
  it('解析标准 CREATE TABLE 语句的表名', () => {
    expect(parseDDLTableName('CREATE TABLE inventory (\n  row_id INTEGER PRIMARY KEY\n);')).toBe('inventory');
  });

  it('解析带 IF NOT EXISTS 的表名', () => {
    expect(parseDDLTableName('CREATE TABLE IF NOT EXISTS my_table (id INTEGER);')).toBe('my_table');
  });

  it('空字符串返回 null', () => {
    expect(parseDDLTableName('')).toBeNull();
  });

  it('无效 DDL 返回 null', () => {
    expect(parseDDLTableName('SELECT * FROM foo')).toBeNull();
  });

  it('大小写不敏感', () => {
    expect(parseDDLTableName('create table Foo (id int);')).toBe('Foo');
  });
});

// ═══════════════════════════════════════════════════════════════
// parseDDLChineseName
// ═══════════════════════════════════════════════════════════════
describe('parseDDLChineseName', () => {
  it('解析第一行注释中的中文表名', () => {
    expect(parseDDLChineseName('CREATE TABLE inventory (  -- 背包物品表\n  row_id INTEGER\n);')).toBe('背包物品表');
  });

  it('无注释返回 null', () => {
    expect(parseDDLChineseName('CREATE TABLE inventory (\n  row_id INTEGER\n);')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(parseDDLChineseName('')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// parseDDLColumnNames
// ═══════════════════════════════════════════════════════════════
describe('parseDDLColumnNames', () => {
  it('解析标准 DDL 的列名', () => {
    const ddl = `CREATE TABLE inventory (
      row_id INTEGER PRIMARY KEY,
      item_name TEXT NOT NULL,
      quantity INTEGER DEFAULT 1
    );`;
    expect(parseDDLColumnNames(ddl)).toEqual(['row_id', 'item_name', 'quantity']);
  });

  it('处理 CHECK 约束中的嵌套括号', () => {
    const ddl = `CREATE TABLE inventory (
      row_id INTEGER PRIMARY KEY,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      status TEXT CHECK(status IN ('active', 'inactive'))
    );`;
    const cols = parseDDLColumnNames(ddl);
    expect(cols).toEqual(['row_id', 'quantity', 'status']);
  });

  it('跳过表级约束', () => {
    const ddl = `CREATE TABLE test (
      id INTEGER,
      name TEXT,
      PRIMARY KEY (id),
      UNIQUE (name)
    );`;
    expect(parseDDLColumnNames(ddl)).toEqual(['id', 'name']);
  });

  it('空 DDL 返回空数组', () => {
    expect(parseDDLColumnNames('')).toEqual([]);
  });

  it('无括号的无效 DDL 返回空数组', () => {
    expect(parseDDLColumnNames('CREATE TABLE foo')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseDDLColumnComments
// ═══════════════════════════════════════════════════════════════
describe('parseDDLColumnComments', () => {
  it('解析列名到注释的映射', () => {
    const ddl = `CREATE TABLE inventory ( -- 背包物品表
      row_id INTEGER PRIMARY KEY, -- 行号
      item_name TEXT NOT NULL, -- 物品名称
      quantity INTEGER DEFAULT 1 -- 数量
    );`;
    const comments = parseDDLColumnComments(ddl);
    expect(comments.get('row_id')).toBe('行号');
    expect(comments.get('item_name')).toBe('物品名称');
    expect(comments.get('quantity')).toBe('数量');
  });

  it('无注释的列不在映射中', () => {
    const ddl = `CREATE TABLE test (
      id INTEGER PRIMARY KEY,
      name TEXT -- 姓名
    );`;
    const comments = parseDDLColumnComments(ddl);
    expect(comments.has('id')).toBe(false);
    expect(comments.get('name')).toBe('姓名');
  });

  it('空 DDL 返回空 Map', () => {
    expect(parseDDLColumnComments('').size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildColumnNameMap
// ═══════════════════════════════════════════════════════════════
describe('buildColumnNameMap', () => {
  it('构建双向映射', () => {
    const ddl = `CREATE TABLE inventory (
      row_id INTEGER PRIMARY KEY, -- 行号
      item_name TEXT, -- 物品名称
      quantity INTEGER -- 数量
    );`;
    const { sqlToChinese, chineseToSql } = buildColumnNameMap(ddl);
    expect(sqlToChinese.get('item_name')).toBe('物品名称');
    expect(chineseToSql.get('物品名称')).toBe('item_name');
    expect(sqlToChinese.get('quantity')).toBe('数量');
    expect(chineseToSql.get('数量')).toBe('quantity');
  });
});

// ═══════════════════════════════════════════════════════════════
// generateDDL
// ═══════════════════════════════════════════════════════════════
describe('generateDDL', () => {
  it('优先使用 sourceData.ddl', () => {
    const sheet = makeSheet({
      sourceData: {
        note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
        ddl: 'CREATE TABLE custom_table (\n  row_id INTEGER PRIMARY KEY\n);',
      },
    });
    expect(generateDDL(sheet)).toBe('CREATE TABLE custom_table (\n  row_id INTEGER PRIMARY KEY\n);');
  });

  it('无 DDL 时 fallback 生成全 TEXT DDL', () => {
    const sheet = makeSheet();
    const ddl = generateDDL(sheet);
    expect(ddl).toContain('CREATE TABLE');
    expect(ddl).toContain('row_id INTEGER PRIMARY KEY');
    expect(ddl).toContain('TEXT');
  });

  it('空 content 时生成最小 DDL', () => {
    const sheet = makeSheet({ content: [] });
    const ddl = generateDDL(sheet);
    expect(ddl).toContain('row_id INTEGER PRIMARY KEY');
  });
});

// ═══════════════════════════════════════════════════════════════
// generateFallbackDDL
// ═══════════════════════════════════════════════════════════════
describe('generateFallbackDDL', () => {
  it('第一列 row_id 映射为 INTEGER PRIMARY KEY', () => {
    const ddl = generateFallbackDDL('test_table', ['row_id', '姓名', '年龄']);
    expect(ddl).toContain('row_id INTEGER PRIMARY KEY');
  });

  it('中文列名转为 SQL 标识符', () => {
    const ddl = generateFallbackDDL('test_table', ['row_id', 'name', 'age']);
    expect(ddl).toContain('name TEXT');
    expect(ddl).toContain('age TEXT');
  });

  it('空 headers 生成最小 DDL', () => {
    const ddl = generateFallbackDDL('test_table', []);
    expect(ddl).toContain('row_id INTEGER PRIMARY KEY');
  });
});

// ═══════════════════════════════════════════════════════════════
// generateInserts
// ═══════════════════════════════════════════════════════════════
describe('generateInserts', () => {
  it('从 content 生成 INSERT 语句', () => {
    const sheet = makeSheet();
    const inserts = generateInserts(sheet, 'test_table');
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toContain('INSERT INTO');
    expect(inserts[0]).toContain('test_table');
  });

  it('null 值转为 NULL', () => {
    const sheet = makeSheet({
      content: [
        ['row_id', 'name'],
        ['1', null],
      ],
    });
    const inserts = generateInserts(sheet, 'test_table');
    expect(inserts[0]).toContain('NULL');
  });

  it('数字字符串不加引号', () => {
    const sheet = makeSheet({
      content: [
        ['row_id', 'count'],
        ['1', '42'],
      ],
    });
    const inserts = generateInserts(sheet, 'test_table');
    expect(inserts[0]).toContain('42');
    // 42 不应该被引号包围
    expect(inserts[0]).not.toContain("'42'");
  });

  it('含单引号的字符串正确转义', () => {
    const sheet = makeSheet({
      content: [
        ['row_id', 'desc'],
        ['1', "it's a test"],
      ],
    });
    const inserts = generateInserts(sheet, 'test_table');
    expect(inserts[0]).toContain("it''s a test");
  });

  it('空 content 返回空数组', () => {
    const sheet = makeSheet({ content: [] });
    expect(generateInserts(sheet, 'test_table')).toEqual([]);
  });

  it('只有表头没有数据行返回空数组', () => {
    const sheet = makeSheet({ content: [['row_id', 'name']] });
    expect(generateInserts(sheet, 'test_table')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// resultToContent
// ═══════════════════════════════════════════════════════════════
describe('resultToContent', () => {
  it('将 SQL 结果转为 content 二维数组', () => {
    const columns = ['row_id', 'name', 'age'];
    const values: any[][] = [[1, '张三', 25], [2, '李四', 30]];
    const content = resultToContent(columns, values);
    expect(content[0]).toEqual(['row_id', 'name', 'age']);
    expect(content[1]).toEqual(['1', '张三', '25']);
    expect(content[2]).toEqual(['2', '李四', '30']);
  });

  it('使用中文表头映射', () => {
    const columns = ['row_id', 'item_name', 'quantity'];
    const values: any[][] = [[1, '铁剑', 3]];
    const chineseHeaders = new Map([['item_name', '物品名称'], ['quantity', '数量']]);
    const content = resultToContent(columns, values, chineseHeaders);
    expect(content[0]).toEqual(['row_id', '物品名称', '数量']);
  });

  it('null 值保持为 null', () => {
    const columns = ['row_id', 'name'];
    const values: any[][] = [[1, null]];
    const content = resultToContent(columns, values);
    expect(content[1][1]).toBeNull();
  });

  it('空结果返回只有 row_id 表头的数组', () => {
    const content = resultToContent([], []);
    expect(content).toEqual([['row_id']]);
  });

  it('SQL 空结果未返回列名时使用 fallbackColumns 恢复完整表头', () => {
    const chineseHeaders = new Map([['item_name', '物品名称'], ['quantity', '数量']]);
    const content = resultToContent([], [], chineseHeaders, ['row_id', 'item_name', 'quantity']);
    expect(content).toEqual([['row_id', '物品名称', '数量']]);
  });

  it('SQL 已返回列名时优先使用真实 columns 而不是 fallbackColumns', () => {
    const chineseHeaders = new Map([['item_name', '物品名称'], ['quantity', '数量']]);
    const content = resultToContent(['row_id', 'item_name'], [[1, '铁剑']], chineseHeaders, [
      'row_id',
      'item_name',
      'quantity',
    ]);
    expect(content).toEqual([['row_id', '物品名称'], ['1', '铁剑']]);
  });

  it('Uint8Array 值转为 [BLOB]', () => {
    const columns = ['row_id', 'data'];
    const values: any[][] = [[1, new Uint8Array([1, 2, 3])]];
    const content = resultToContent(columns, values);
    expect(content[1][1]).toBe('[BLOB]');
  });
});

// ═══════════════════════════════════════════════════════════════
// validateDDLAgainstHeaders
// ═══════════════════════════════════════════════════════════════
describe('validateDDLAgainstHeaders', () => {
  it('匹配的 DDL 和表头返回 valid', () => {
    const ddl = `CREATE TABLE test (
      row_id INTEGER PRIMARY KEY, -- 行号
      name TEXT, -- 姓名
      age INTEGER -- 年龄
    );`;
    const result = validateDDLAgainstHeaders(ddl, ['row_id', '姓名', '年龄']);
    expect(result.valid).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it('英文物理列名配中文注释时按中文表头校验通过', () => {
    const ddl = `CREATE TABLE inventory (
      row_id INTEGER PRIMARY KEY, -- 行号
      item_name TEXT, -- 物品名称
      quantity INTEGER, -- 数量
      description TEXT -- 描述/效果
    );`;
    const result = validateDDLAgainstHeaders(ddl, ['row_id', '物品名称', '数量', '描述/效果']);
    expect(result.valid).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it('列数不匹配时报告', () => {
    const ddl = `CREATE TABLE test (
      row_id INTEGER PRIMARY KEY,
      name TEXT
    );`;
    const result = validateDDLAgainstHeaders(ddl, ['row_id', '姓名', '年龄']);
    expect(result.valid).toBe(false);
    expect(result.mismatches.some(m => m.includes('列数不匹配'))).toBe(true);
  });

  it('注释与表头不匹配时报告', () => {
    const ddl = `CREATE TABLE test (
      row_id INTEGER PRIMARY KEY, -- 行号
      name TEXT, -- 名字
      age INTEGER -- 年龄
    );`;
    const result = validateDDLAgainstHeaders(ddl, ['row_id', '姓名', '年龄']);
    expect(result.valid).toBe(false);
    expect(result.mismatches.some(m => m.includes('不匹配'))).toBe(true);
  });

  it('列顺序与表头不一致时报告', () => {
    const ddl = `CREATE TABLE test (
      row_id INTEGER PRIMARY KEY, -- 行号
      age INTEGER, -- 年龄
      name TEXT -- 姓名
    );`;
    const result = validateDDLAgainstHeaders(ddl, ['row_id', '姓名', '年龄']);
    expect(result.valid).toBe(false);
    expect(result.mismatches.some(m => m.includes('第 1 列不匹配'))).toBe(true);
  });
});
