/**
 * tests/service/ai/table-edit-parser.test.ts
 * AI 响应表格编辑解析器单元测试
 *
 * 策略：
 * - extractTableEditInner_ACU 是纯函数（只依赖 settings_ACU），mock settings 后直接测试
 * - isSqlContent 是纯函数，直接测试
 * - parseAndApplyTableEdits_ACU 的 SQL 分支通过 mock isSqliteMode + getStorageProvider 测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

let mockSettings: any = { tableEditLastPairOnly: false };
let mockCurrentJsonTableData: any = null;

vi.mock('../../../src/service/runtime/state-manager', () => ({
  get settings_ACU() { return mockSettings; },
  get currentJsonTableData_ACU() { return mockCurrentJsonTableData; },
}));

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  isSummaryOrOutlineTable_ACU: vi.fn(() => false),
}));

let mockIsSqliteMode = false;
vi.mock('../../../src/service/table/storage-mode', () => ({
  isSqliteMode: vi.fn(() => mockIsSqliteMode),
}));

const mockApplyEdits = vi.fn().mockReturnValue({ success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 });
vi.mock('../../../src/service/table/table-storage-strategy', () => ({
  getStorageProvider: vi.fn(() => ({
    applyEdits: mockApplyEdits,
  })),
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  getEffectiveSeedRowsForSheet_ACU: vi.fn(() => []),
  getSortedSheetKeys_ACU: vi.fn((data: any) => data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')) : []),
}));

vi.mock('../../../src/service/runtime/helpers-remaining', () => ({
  applySummaryIndexSequenceToTable_ACU: vi.fn(),
  formatSummaryIndexCode_ACU: vi.fn(() => '001'),
  getSummaryIndexColumnIndex_ACU: vi.fn(() => -1),
  isSpecialIndexLockEnabled_ACU: vi.fn(() => false),
  getTableLocksForSheet_ACU: vi.fn(() => ({ rows: new Set(), cols: new Set(), cells: new Set() })),
}));

vi.mock('../../../src/service/ai/prompt-builder/json-sanitizer', () => ({
  sanitizeJsonPipeline_ACU: vi.fn(() => ({ success: false, result: '', layersApplied: [], error: 'mock' })),
  coerceLooseRowObject_ACU: vi.fn(() => ({ success: false, error: 'mock' })),
}));

import {
  extractTableEditInner_ACU,
  parseAndApplyTableEdits_ACU,
  isSqlContent,
  extractSqlPayload_ACU,
  coerceSqliteTableEditPayload_ACU,
  convertLegacyDslEditsToSql_ACU,
} from '../../../src/service/ai/prompt-builder/table-edit-parser';

// ═══════════════════════════════════════════════════════════════
// isSqlContent
// ═══════════════════════════════════════════════════════════════
describe('isSqlContent', () => {
  it('INSERT 开头返回 true', () => {
    expect(isSqlContent("INSERT INTO inventory VALUES (1, '铁剑', 3);")).toBe(true);
  });

  it('UPDATE 开头返回 true', () => {
    expect(isSqlContent('UPDATE inventory SET quantity = 5 WHERE row_id = 1;')).toBe(true);
  });

  it('DELETE 开头返回 true', () => {
    expect(isSqlContent('DELETE FROM inventory WHERE row_id = 1;')).toBe(true);
  });

  it('ALTER 开头返回 true', () => {
    expect(isSqlContent('ALTER TABLE inventory ADD COLUMN desc TEXT;')).toBe(true);
  });

  it('BEGIN 开头返回 true', () => {
    expect(isSqlContent('BEGIN TRANSACTION;')).toBe(true);
  });

  it('CREATE 开头返回 true', () => {
    expect(isSqlContent('CREATE TABLE new_table (id INTEGER);')).toBe(true);
  });

  it('DROP 开头返回 true', () => {
    expect(isSqlContent('DROP TABLE old_table;')).toBe(true);
  });

  it('REPLACE 开头返回 true', () => {
    expect(isSqlContent("REPLACE INTO inventory VALUES (1, '铁剑', 3);")).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(isSqlContent("insert into inventory values (1, '铁剑', 3);")).toBe(true);
  });

  it('跳过空行后检测', () => {
    expect(isSqlContent("\n\n  INSERT INTO inventory VALUES (1);")).toBe(true);
  });

  it('跳过 SQL 注释行后检测', () => {
    expect(isSqlContent("-- 这是注释\nINSERT INTO inventory VALUES (1);")).toBe(true);
  });

  it('跳过 HTML 注释残留后检测', () => {
    expect(isSqlContent("<!--\n-->\nINSERT INTO inventory VALUES (1);")).toBe(true);
  });

  it('insertRow 指令不是 SQL', () => {
    expect(isSqlContent("insertRow(0, {0: '铁剑', 1: '3'})")).toBe(false);
  });

  it('updateRow 指令不是 SQL', () => {
    expect(isSqlContent("updateRow(0, 1, {0: '铁剑'})")).toBe(false);
  });

  it('deleteRow 指令不是 SQL', () => {
    expect(isSqlContent('deleteRow(0, 1)')).toBe(false);
  });

  it('空字符串返回 false', () => {
    expect(isSqlContent('')).toBe(false);
  });

  it('纯注释返回 false', () => {
    expect(isSqlContent('-- 只有注释\n-- 没有语句')).toBe(false);
  });

  it('纯空白返回 false', () => {
    expect(isSqlContent('   \n\t  ')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('SQLite legacy DSL to SQL fallback', () => {
  beforeEach(() => {
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        content: [['row_id', 'item_name', 'quantity'], ['7', '铁剑', '3']],
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT, quantity INTEGER);' },
        updateConfig: {},
      },
      sheet_1: {
        name: '编年史',
        content: [['row_id', 'code_index', 'time_span', 'today_relation', 'summary'], ['1', 'AM0001', 't0', '既有关系', '旧摘要']],
        sourceData: { ddl: 'CREATE TABLE chronicle (row_id INTEGER PRIMARY KEY, code_index TEXT, time_span TEXT, today_relation TEXT, summary TEXT);' },
        updateConfig: {},
      },
    };
  });

  it('converts insertRow with SQL table name to INSERT and preserves skipped numeric columns', () => {
    const sql = convertLegacyDslEditsToSql_ACU('解释文本 <tableEdit>insertRow("chronicle", {"0":"AM0002","1":"t1","3":"新摘要"})</tableEdit>');
    expect(sql).toBe(`INSERT INTO "chronicle" ("code_index", "time_span", "summary") VALUES ('AM0002', 't1', '新摘要');`);
  });

  it('deduplicates accidental row_id in insertRow data before converting', () => {
    const sql = convertLegacyDslEditsToSql_ACU('insertRow(0, {"0":"8","1":"药水","2":2})');
    expect(sql).toBe(`INSERT INTO "inventory" ("item_name", "quantity") VALUES ('药水', 2);`);
  });

  it('converts updateRow/deleteRow with native row index to row_id predicates', () => {
    const sql = convertLegacyDslEditsToSql_ACU('updateRow(0, 0, {"1":4}); deleteRow(0, 0);');
    expect(sql).toBe(`UPDATE "inventory" SET "quantity" = 4 WHERE row_id = '7';\nDELETE FROM "inventory" WHERE row_id = '7';`);
  });

  it('coerces the last tableEdit block and ignores prose before it', () => {
    const sql = coerceSqliteTableEditPayload_ACU('前置解释 insertRow(表格ID, {"0":"无效"}) <content><tableEdit>insertRow("inventory", {"0":"药水","1":1})</tableEdit></content>');
    expect(sql).toBe(`INSERT INTO "inventory" ("item_name", "quantity") VALUES ('药水', 1);`);
  });
});

describe('extractSqlPayload_ACU', () => {
  it('extracts SQL after explanatory prose', () => {
    const content = "Use SQL in tableEdit.\nUPDATE inventory SET quantity=5 WHERE row_id=1;";
    expect(extractSqlPayload_ACU(content)).toBe('UPDATE inventory SET quantity=5 WHERE row_id=1;');
  });

  it('does not treat prose-only SQL keyword list as executable SQL', () => {
    const content = 'Format note: INSERT INTO / UPDATE / DELETE FROM are supported.';
    expect(extractSqlPayload_ACU(content)).toBeNull();
  });

  it('trims a dangling quote after the final semicolon', () => {
    const content = "prose\nINSERT INTO inventory VALUES (1,'sword',3);\"";
    expect(extractSqlPayload_ACU(content)).toBe("INSERT INTO inventory VALUES (1,'sword',3);");
  });
});

// extractTableEditInner_ACU
// ═══════════════════════════════════════════════════════════════
describe('extractTableEditInner_ACU', () => {
  beforeEach(() => {
    mockSettings = { tableEditLastPairOnly: false };
  });

  it('提取完整 <tableEdit> 标签内容', () => {
    const text = '一些文字 <tableEdit>insertRow(0, {0: "铁剑"})</tableEdit> 更多文字';
    const result = extractTableEditInner_ACU(text);
    expect(result).not.toBeNull();
    expect(result!.inner).toBe('insertRow(0, {0: "铁剑"})');
    expect(result!.mode).toBe('full');
  });

  it('大小写不敏感', () => {
    const text = '<TABLEEDIT>insertRow(0, {})</TABLEEDIT>';
    const result = extractTableEditInner_ACU(text);
    expect(result).not.toBeNull();
    expect(result!.inner).toContain('insertRow');
  });

  it('useLastPairOnly 模式取最后一对', () => {
    mockSettings = { tableEditLastPairOnly: true };
    const text = '<tableEdit>第一个</tableEdit> 中间文字 <tableEdit>第二个</tableEdit>';
    const result = extractTableEditInner_ACU(text, { useLastPairOnly: true });
    expect(result).not.toBeNull();
    expect(result!.inner).toBe('第二个');
    expect(result!.mode).toBe('full_last');
  });

  it('HTML 注释中的指令（comment_fallback）', () => {
    const text = '<!-- insertRow(0, {0: "铁剑"}) -->';
    const result = extractTableEditInner_ACU(text, { allowNoTableEditTags: true });
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('comment_fallback');
  });

  it('只有开标签时从注释中提取', () => {
    const text = '<tableEdit> <!-- insertRow(0, {0: "铁剑"}) -->';
    const result = extractTableEditInner_ACU(text, { allowNoTableEditTags: true });
    expect(result).not.toBeNull();
    expect(result!.hasOpen).toBe(true);
  });

  it('只有闭标签时从注释中提取', () => {
    const text = '<!-- insertRow(0, {0: "铁剑"}) --> </tableEdit>';
    const result = extractTableEditInner_ACU(text, { allowNoTableEditTags: true });
    expect(result).not.toBeNull();
    expect(result!.hasClose).toBe(true);
  });

  it('空字符串返回 null', () => {
    expect(extractTableEditInner_ACU('')).toBeNull();
  });

  it('无任何指令返回 null', () => {
    expect(extractTableEditInner_ACU('这是一段普通文字，没有任何指令')).toBeNull();
  });

  it('allowNoTableEditTags=false 且无标签时返回 null', () => {
    const text = '<!-- insertRow(0, {0: "铁剑"}) -->';
    const result = extractTableEditInner_ACU(text, { allowNoTableEditTags: false });
    expect(result).toBeNull();
  });

  it('处理 AI 响应中的转义字符', () => {
    const text = "'<tableEdit>insertRow(0, {0: \"铁剑\"})</tableEdit>'";
    const result = extractTableEditInner_ACU(text);
    expect(result).not.toBeNull();
  });

  it('处理字符串拼接残留', () => {
    const text = "' + '<tableEdit>insertRow(0, {})</tableEdit>' + '";
    const result = extractTableEditInner_ACU(text);
    expect(result).not.toBeNull();
  });

  // ═══ 思维链剥离 ═══
  it('<thought> 块在提取前被剥离，不污染编辑内容', () => {
    const text = '<thought>这是分析过程，不应出现在结果中</thought><tableEdit>INSERT INTO t VALUES (1);</tableEdit>';
    const result = extractTableEditInner_ACU(text);
    expect(result).not.toBeNull();
    expect(result!.inner).toBe('INSERT INTO t VALUES (1);');
    expect(result!.inner).not.toContain('分析过程');
  });

  it('<thinking> 块在提取前被剥离，不污染编辑内容', () => {
    const text = '<thinking type="deep">逐步推理...\n多行分析</thinking><tableEdit>UPDATE t SET a=1;</tableEdit>';
    const result = extractTableEditInner_ACU(text);
    expect(result).not.toBeNull();
    expect(result!.inner).toBe('UPDATE t SET a=1;');
    expect(result!.inner).not.toContain('逐步推理');
  });

  it('孤立 <thought> 开标签被剥离', () => {
    const text = '<thought>\n这是未闭合的思维\n</thought>\n<tableEdit>DELETE FROM t WHERE 1=1;</tableEdit>';
    const result = extractTableEditInner_ACU(text);
    expect(result).not.toBeNull();
    expect(result!.inner).toBe('DELETE FROM t WHERE 1=1;');
  });

  it('<content> 包裹 <tableEdit> 时正确提取内部编辑', () => {
    const text = '<thought>分析...</thought><content><tableEdit>INSERT INTO chronicle (row_id) VALUES (1);</tableEdit></content>';
    const result = extractTableEditInner_ACU(text);
    expect(result).not.toBeNull();
    expect(result!.inner).toBe('INSERT INTO chronicle (row_id) VALUES (1);');
    expect(result!.inner).not.toContain('分析');
    expect(result!.inner).not.toContain('content');
  });

  it('多个思维链块全部被剥离', () => {
    const text = '<thought>第一段思维</thought>中间文本<thinking>第二段思维</thinking><tableEdit>SELECT 1;</tableEdit>';
    const result = extractTableEditInner_ACU(text);
    expect(result).not.toBeNull();
    expect(result!.inner).toBe('SELECT 1;');
    expect(result!.inner).not.toContain('思维');
  });
});

// ═══════════════════════════════════════════════════════════════
// parseAndApplyTableEdits_ACU — SQL 分支
// ═══════════════════════════════════════════════════════════════
describe('parseAndApplyTableEdits_ACU — SQL 分支', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings = { tableEditLastPairOnly: false };
    mockIsSqliteMode = true;
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        content: [['row_id', 'item_name', 'quantity'], ['1', '铁剑', '3']],
        sourceData: { ddl: 'CREATE TABLE inventory (row_id INTEGER PRIMARY KEY, item_name TEXT, quantity INTEGER);' },
        updateConfig: {},
      },
    };
  });

  it('SQLite mode routes SQL content to provider.applyEdits', () => {
    const aiResponse = "<tableEdit>INSERT INTO inventory VALUES (2, 'potion', 5);</tableEdit>";
    mockApplyEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 });

    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(mockApplyEdits).toHaveBeenCalled();
    expect(result).toEqual({ success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 });
  });

  it('SQLite mode extracts SQL after prose and routes to provider.applyEdits', () => {
    const aiResponse = "<tableEdit>Before SQL.\nUPDATE inventory SET quantity=5 WHERE row_id=1;</tableEdit>";
    mockApplyEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 });

    parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(mockApplyEdits).toHaveBeenCalledWith('UPDATE inventory SET quantity=5 WHERE row_id=1;', 'standard');
  });

  it('SQLite mode converts legacy DSL content to SQL instead of falling back to native parser', () => {
    const aiResponse = '<tableEdit>insertRow(0, {"0":"potion","1":5})</tableEdit>';
    mockApplyEdits.mockClear();
    mockApplyEdits.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'], appliedEdits: 1 });

    parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(mockApplyEdits).toHaveBeenCalledWith(`INSERT INTO "inventory" ("item_name", "quantity") VALUES ('potion', 5);`, 'standard');
  });

  it('非 SQLite 模式下 SQL 内容走原生解析路径', () => {
    mockIsSqliteMode = false;
    const aiResponse = "<tableEdit>INSERT INTO inventory VALUES (2, '药水', 5);</tableEdit>";
    mockApplyEdits.mockClear();

    parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(mockApplyEdits).not.toHaveBeenCalled();
  });

  it('SQL 执行失败时抛出异常', () => {
    const aiResponse = "<tableEdit>INSERT INTO inventory VALUES (2, '药水', 5);</tableEdit>";
    mockApplyEdits.mockImplementation(() => { throw new Error('SQL 语法错误'); });

    expect(() => parseAndApplyTableEdits_ACU(aiResponse, 'standard')).toThrow('SQL 语法错误');
  });

  it('currentJsonTableData 为 null 时返回 false', () => {
    mockCurrentJsonTableData = null;
    const result = parseAndApplyTableEdits_ACU("<tableEdit>INSERT INTO t VALUES (1);</tableEdit>");
    expect(result).toBe(false);
  });

  it('空 <tableEdit> 块返回 true', () => {
    const result = parseAndApplyTableEdits_ACU('<tableEdit></tableEdit>');
    expect(result).toBe(true);
  });

  it('传递 updateMode 参数给 provider', () => {
    const aiResponse = "<tableEdit>INSERT INTO inventory VALUES (2, '药水', 5);</tableEdit>";
    mockApplyEdits.mockReturnValue({ success: true, modifiedKeys: [], appliedEdits: 1 });

    parseAndApplyTableEdits_ACU(aiResponse, 'auto_standard');
    expect(mockApplyEdits).toHaveBeenCalledWith(expect.any(String), 'auto_standard');
  });
});

// ═══════════════════════════════════════════════════════════════
// parseAndApplyTableEdits_ACU — DSL 分支（insertRow/updateRow/deleteRow）
// ═══════════════════════════════════════════════════════════════
describe('parseAndApplyTableEdits_ACU — DSL 分支', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings = { tableEditLastPairOnly: false };
    mockIsSqliteMode = false;
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        content: [
          ['row_id', 'item_name', 'quantity'],
          ['1', '铁剑', '3'],
          ['2', '药水', '5'],
        ],
        updateConfig: {},
      },
    };
  });

  it('insertRow 指令正确插入新行', () => {
    const aiResponse = '<tableEdit>insertRow(0, {"0": "盾牌", "1": "1"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success');
    // 验证表格数据被修改（新行被插入）
    const content = mockCurrentJsonTableData.sheet_0.content;
    expect(content.length).toBe(4); // 表头 + 原2行 + 新1行
  });

  it('deleteRow 指令正确删除行', () => {
    const aiResponse = '<tableEdit>deleteRow(0, 1)</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success');
    // 验证行被删除
    const content = mockCurrentJsonTableData.sheet_0.content;
    expect(content.length).toBe(2); // 表头 + 剩余1行
  });

  it('updateRow 指令正确更新行', () => {
    const aiResponse = '<tableEdit>updateRow(0, 1, {"1": "10"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success');
    // updateRow(0, 1, {"1": "10"}) → content[rowIndex+1][colIndex+1] = content[2][2]
    // rowIndex=1 对应第2行数据行（content[2]），colIndex=1 对应第2列数据列（content[][2]）
    expect(mockCurrentJsonTableData.sheet_0.content[2][2]).toBe('10');
  });

  it('多条指令按顺序执行', () => {
    const aiResponse = '<tableEdit>insertRow(0, {"0": "盾牌", "1": "1"})\ninsertRow(0, {"0": "头盔", "1": "2"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success');
    const content = mockCurrentJsonTableData.sheet_0.content;
    expect(content.length).toBe(5); // 表头 + 原2行 + 新2行
  });

  it('无法识别的指令不报错', () => {
    const aiResponse = '<tableEdit>unknownCommand(0, 1)</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    // 无法识别的指令应被跳过，不影响整体结果
    expect(result).toHaveProperty('success');
  });

  it('非 SQLite 模式下 SQL 内容走 DSL 解析路径', () => {
    mockIsSqliteMode = false;
    const aiResponse = "<tableEdit>INSERT INTO inventory VALUES (2, '药水', 5);</tableEdit>";
    mockApplyEdits.mockClear();
    parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    // 非 SQLite 模式不应调用 provider.applyEdits
    expect(mockApplyEdits).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// parseAndApplyTableEdits_ACU — 表名容错（SQL 表名 / 中文表名代替数字索引）
// ═══════════════════════════════════════════════════════════════
describe('parseAndApplyTableEdits_ACU — 表名容错', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings = { tableEditLastPairOnly: false };
    mockIsSqliteMode = false;
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        sourceData: { ddl: 'CREATE TABLE inventory ( row_id INTEGER PRIMARY KEY, item_name TEXT, quantity INTEGER )' },
        content: [
          ['row_id', 'item_name', 'quantity'],
          ['1', '铁剑', '3'],
        ],
        updateConfig: {},
      },
      sheet_1: {
        name: '广场主贴表',
        sourceData: { ddl: 'CREATE TABLE square_posts ( row_id INTEGER PRIMARY KEY, author TEXT, content TEXT )' },
        content: [
          ['row_id', 'author', 'content'],
        ],
        updateConfig: {},
      },
    };
  });

  it('insertRow 使用 SQL 表名代替数字索引能正常写入', () => {
    const aiResponse = '<tableEdit>insertRow(square_posts, {"0": "user1", "1": "hello"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success', true);
    const content = mockCurrentJsonTableData.sheet_1.content;
    expect(content.length).toBe(2); // 表头 + 新插入1行
    expect(content[1][1]).toBe('user1');
  });

  it('insertRow 使用中文表名代替数字索引能正常写入', () => {
    const aiResponse = '<tableEdit>insertRow(广场主贴表, {"0": "user2", "1": "world"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success', true);
    const content = mockCurrentJsonTableData.sheet_1.content;
    expect(content.length).toBe(2);
  });

  it('deleteRow 使用 SQL 表名代替数字索引能正常删除', () => {
    const aiResponse = '<tableEdit>deleteRow(inventory, 0)</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success', true);
    const content = mockCurrentJsonTableData.sheet_0.content;
    expect(content.length).toBe(1); // 只剩表头
  });

  it('updateRow 使用 SQL 表名代替数字索引能正常更新', () => {
    const aiResponse = '<tableEdit>updateRow(inventory, 0, {"1": "99"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success', true);
    expect(mockCurrentJsonTableData.sheet_0.content[1][2]).toBe('99');
  });

  it('数字索引仍然正常工作（回归测试）', () => {
    const aiResponse = '<tableEdit>insertRow(0, {"0": "盾牌", "1": "1"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success', true);
    const content = mockCurrentJsonTableData.sheet_0.content;
    expect(content.length).toBe(3);
  });

  it('无法识别的表名会被跳过而不崩溃', () => {
    const aiResponse = '<tableEdit>insertRow(nonexistent_table, {"0": "test"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success', true);
    // 两个表的内容应该没变
    expect(mockCurrentJsonTableData.sheet_0.content.length).toBe(2);
    expect(mockCurrentJsonTableData.sheet_1.content.length).toBe(1);
  });
});

describe('parseAndApplyTableEdits_ACU — row_id 去重', () => {
  beforeEach(() => {
    mockSettings = { tableEditLastPairOnly: false };
    mockIsSqliteMode = false;
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '好感度表',
        sourceData: { ddl: 'CREATE TABLE affection ( row_id INTEGER PRIMARY KEY, character_name TEXT, stage TEXT, value INTEGER, change TEXT, note TEXT )' },
        content: [
          ['row_id', '角色名', '好感度阶段', '好感度数值', '本轮变化', '关系备注'],
        ],
        updateConfig: {},
      },
      sheet_1: {
        name: '广场主贴表',
        sourceData: { ddl: 'CREATE TABLE square_posts ( row_id INTEGER PRIMARY KEY, post_id TEXT, author TEXT )' },
        content: [
          ['row_id', '帖子ID', '发帖账号名'],
        ],
        updateConfig: {},
      },
    };
  });

  it('AI 传入多余 row_id 时自动去重，列不错位', () => {
    // AI 指令: data["0"]="1" (多余row_id), data["1"]="千早爱音", data["2"]="认识", ...
    const aiResponse = '<tableEdit>insertRow(0, {"0": "1", "1": "千早爱音", "2": "认识", "3": "25", "4": "+25", "5": "互相介绍"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success', true);
    const row = mockCurrentJsonTableData.sheet_0.content[1];
    // row[0] = auto row_id "1", row[1] = "千早爱音" (不是 "1")
    expect(row[0]).toBe('1');
    expect(row[1]).toBe('千早爱音');
    expect(row[2]).toBe('认识');
    expect(row[3]).toBe('25');
    expect(row[4]).toBe('+25');
    expect(row[5]).toBe('互相介绍');
  });

  it('AI 不传 row_id 时正常写入，不受去重影响', () => {
    // 正常情况: data["0"]="千早爱音" (业务列), data key数 = header数
    const aiResponse = '<tableEdit>insertRow(0, {"0": "千早爱音", "1": "认识", "2": "25", "3": "+25", "4": "互相介绍"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success', true);
    const row = mockCurrentJsonTableData.sheet_0.content[1];
    expect(row[0]).toBe('1');
    expect(row[1]).toBe('千早爱音');
    expect(row[2]).toBe('认识');
  });

  it('多行 insertRow 均能正确去重', () => {
    const aiResponse = '<tableEdit>\ninsertRow(0, {"0": "1", "1": "千早爱音", "2": "认识", "3": "25", "4": "+25", "5": "介绍"})\ninsertRow(0, {"0": "2", "1": "高松灯", "2": "陌生", "3": "5", "4": "+5", "5": "注意到"})\n</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success', true);
    const content = mockCurrentJsonTableData.sheet_0.content;
    expect(content.length).toBe(3); // header + 2 rows
    expect(content[1][1]).toBe('千早爱音');
    expect(content[2][1]).toBe('高松灯');
    // row_id 应为自动生成
    expect(content[1][0]).toBe('1');
    expect(content[2][0]).toBe('2');
  });

  it('data[0] 为非数字时不触发去重（正常业务数据）', () => {
    const aiResponse = '<tableEdit>insertRow(1, {"0": "post_001", "1": "爱音"})</tableEdit>';
    const result = parseAndApplyTableEdits_ACU(aiResponse, 'standard');
    expect(result).toHaveProperty('success', true);
    const row = mockCurrentJsonTableData.sheet_1.content[1];
    expect(row[1]).toBe('post_001');
    expect(row[2]).toBe('爱音');
  });
});
