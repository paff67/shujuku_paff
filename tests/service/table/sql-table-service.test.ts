/**
 * tests/service/table/sql-table-service.test.ts
 * SqlTableService 单元测试
 *
 * 策略：
 * - splitSqlStatements / extractTableNamesFromStatements 是纯函数，直接测试
 * - SqlTableService 类方法需要 mock 外部依赖（state-manager/table-service/helpers-data-merge/name-mapper）
 *   但使用真实 SqliteEngine + SyncBridge 作为后端
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Mock 设置（必须在 import 被测模块之前）
// ═══════════════════════════════════════════════════════════════

// mock log 函数
const { mockLogError } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
}));
vi.mock('../../../src/shared/utils', () => ({
      logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: mockLogError,
  isSummaryOrOutlineTable_ACU: vi.fn(() => false),
  parseTableTemplateJson_ACU: vi.fn(() => null),
  stripSeedRowsFromTemplate_ACU: vi.fn((obj: any) => {
    if (!obj || typeof obj !== 'object') return obj;
    Object.keys(obj).forEach(k => {
      if (!k.startsWith('sheet_')) return;
      const table = obj[k];
      if (!table || !Array.isArray(table.content) || table.content.length === 0) return;
      table.content = [table.content[0]];
    });
    return obj;
  }),
}));

// mock state-manager
let mockCurrentJsonTableData: any = null;
vi.mock('../../../src/service/runtime/state-manager', () => ({
  get currentJsonTableData_ACU() { return mockCurrentJsonTableData; },
  _set_currentJsonTableData_ACU: vi.fn((v: any) => { mockCurrentJsonTableData = v; }),
}));

// mock table-service
const mockSaveIndependentTable = vi.fn().mockResolvedValue({ saved: true, messageIndex: 5 });
vi.mock('../../../src/service/table/table-service', () => ({
  saveIndependentTableToChatHistory_ACU: (...args: any[]) => mockSaveIndependentTable(...args),
}));

// mock helpers-data-merge
const mockMergeAll = vi.fn();
const mockMergeAllWithMeta = vi.fn(async (...args: any[]) => {
  const data = await mockMergeAll(...args);
  return {
    data,
    usedLegacyMigration: false,
    changed: false,
    foundSheetCount: data && typeof data === 'object'
      ? Object.keys(data).filter(k => k.startsWith('sheet_')).length
      : 0,
  };
});
vi.mock('../../../src/service/runtime/helpers-data-merge', () => ({
  mergeAllIndependentTables_ACU: (...args: any[]) => mockMergeAll(...args),
  mergeAllIndependentTablesWithMeta_ACU: (...args: any[]) => mockMergeAllWithMeta(...args),
}));

// mock name-mapper
vi.mock('../../../src/service/runtime/template-vars/name-mapper', () => ({
  buildGlobalNameMapper: vi.fn(),
  disposeGlobalNameMapper: vi.fn(),
}));

// mock chat-scope（getEffectiveSeedRowsForSheet_ACU + getCurrentChatTemplateScopeState_ACU）
const mockGetEffectiveSeedRows = vi.fn().mockReturnValue([]);
const mockGetCurrentChatTemplateScopeState = vi.fn().mockReturnValue(null);
vi.mock('../../../src/service/template/chat-scope', () => ({
  getEffectiveSeedRowsForSheet_ACU: (...args: any[]) => mockGetEffectiveSeedRows(...args),
  getCurrentChatTemplateScopeState_ACU: (...args: any[]) => mockGetCurrentChatTemplateScopeState(...args),
  sanitizeTemplateSnapshotForChat_ACU: vi.fn((source: any) => {
    if (!source) return null;
    return { templateStr: typeof source === 'string' ? source : JSON.stringify(source), templateObj: typeof source === 'string' ? JSON.parse(source) : source };
  }),
}));

// mock template-preset-service
const mockGetTemplatePreset = vi.fn().mockReturnValue(null);
vi.mock('../../../src/service/template/template-preset-service', () => ({
  getTemplatePreset_ACU: (...args: any[]) => mockGetTemplatePreset(...args),
}));

// mock json-helpers
vi.mock('../../../src/shared/json-helpers', () => ({
  safeJsonParse_ACU: vi.fn((str: string, fallback: any) => {
    try { return JSON.parse(str); } catch { return fallback; }
  }),
}));

// 现在 import 被测模块
import {
  SqlTableService,
  splitSqlStatements,
  extractTableNamesFromStatements,
} from '../../../src/service/table/sql-table-service';

// ═══════════════════════════════════════════════════════════════
// 纯函数测试：splitSqlStatements
// ═══════════════════════════════════════════════════════════════
describe('splitSqlStatements', () => {
  it('按分号拆分多条语句', () => {
    const sql = "INSERT INTO t VALUES (1, 'a'); UPDATE t SET x = 1; DELETE FROM t WHERE id = 1;";
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("INSERT INTO t VALUES (1, 'a')");
    expect(result[1]).toBe('UPDATE t SET x = 1');
    expect(result[2]).toBe('DELETE FROM t WHERE id = 1');
  });

  it('跳过字符串内的分号（单引号）', () => {
    const sql = "INSERT INTO t VALUES (1, 'hello; world'); INSERT INTO t VALUES (2, 'foo');";
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("INSERT INTO t VALUES (1, 'hello; world')");
    expect(result[1]).toBe("INSERT INTO t VALUES (2, 'foo')");
  });

  it('跳过字符串内的分号（双引号）', () => {
    const sql = 'INSERT INTO t VALUES (1, "hello; world"); INSERT INTO t VALUES (2, "foo");';
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('INSERT INTO t VALUES (1, "hello; world")');
    expect(result[1]).toBe('INSERT INTO t VALUES (2, "foo")');
  });

  it('处理转义的单引号（SQL 风格 \'\'）', () => {
    const sql = "INSERT INTO t VALUES (1, 'it''s a test'); INSERT INTO t VALUES (2, 'ok');";
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("INSERT INTO t VALUES (1, 'it''s a test')");
    expect(result[1]).toBe("INSERT INTO t VALUES (2, 'ok')");
  });

  it('最后一条语句没有分号结尾', () => {
    const sql = 'INSERT INTO t VALUES (1); UPDATE t SET x = 2';
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[1]).toBe('UPDATE t SET x = 2');
  });

  it('空字符串返回空数组', () => {
    expect(splitSqlStatements('')).toEqual([]);
  });

  it('纯空白返回空数组', () => {
    expect(splitSqlStatements('   \n\t  ')).toEqual([]);
  });

  it('单条语句无分号', () => {
    const result = splitSqlStatements('SELECT * FROM t');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('SELECT * FROM t');
  });

  it('连续分号产生空语句被过滤', () => {
    const sql = 'INSERT INTO t VALUES (1);;; UPDATE t SET x = 2;;';
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
  });

  it('多行 SQL 语句', () => {
    const sql = `INSERT INTO inventory
      VALUES (1, '铁剑', 3);
    UPDATE inventory
      SET quantity = 5
      WHERE item_name = '铁剑';`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('INSERT INTO inventory');
    expect(result[1]).toContain('UPDATE inventory');
  });

  it('字符串中包含转义双引号', () => {
    const sql = 'INSERT INTO t VALUES (1, "he said ""hello"""); INSERT INTO t VALUES (2, "ok");';
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 纯函数测试：extractTableNamesFromStatements
// ═══════════════════════════════════════════════════════════════
describe('extractTableNamesFromStatements', () => {
  it('提取 INSERT INTO 的表名', () => {
    const result = extractTableNamesFromStatements(["INSERT INTO inventory VALUES (1, '铁剑', 3)"]);
    expect(result).toEqual(['inventory']);
  });

  it('提取 INSERT OR REPLACE INTO 的表名', () => {
    const result = extractTableNamesFromStatements(["INSERT OR REPLACE INTO inventory VALUES (1, '铁剑', 3)"]);
    expect(result).toEqual(['inventory']);
  });

  it('提取 UPDATE 的表名', () => {
    const result = extractTableNamesFromStatements(["UPDATE inventory SET quantity = 5 WHERE row_id = 1"]);
    expect(result).toEqual(['inventory']);
  });

  it('提取 UPDATE OR IGNORE 的表名', () => {
    const result = extractTableNamesFromStatements(["UPDATE OR IGNORE inventory SET quantity = 5"]);
    expect(result).toEqual(['inventory']);
  });

  it('提取 DELETE FROM 的表名', () => {
    const result = extractTableNamesFromStatements(["DELETE FROM inventory WHERE row_id = 1"]);
    expect(result).toEqual(['inventory']);
  });

  it('提取 ALTER TABLE 的表名', () => {
    const result = extractTableNamesFromStatements(["ALTER TABLE inventory ADD COLUMN description TEXT"]);
    expect(result).toEqual(['inventory']);
  });

  it('多条语句提取多个表名（去重）', () => {
    const result = extractTableNamesFromStatements([
      "INSERT INTO inventory VALUES (1, '铁剑', 3)",
      "UPDATE inventory SET quantity = 5",
      "INSERT INTO characters VALUES (1, '角色A', 25)",
    ]);
    expect(result).toContain('inventory');
    expect(result).toContain('characters');
    expect(result).toHaveLength(2); // inventory 去重
  });

  it('SELECT 语句不提取表名', () => {
    const result = extractTableNamesFromStatements(["SELECT * FROM inventory"]);
    expect(result).toEqual([]);
  });

  it('CREATE TABLE 语句不提取表名', () => {
    const result = extractTableNamesFromStatements(["CREATE TABLE new_table (id INTEGER)"]);
    expect(result).toEqual([]);
  });

  it('空数组返回空数组', () => {
    expect(extractTableNamesFromStatements([])).toEqual([]);
  });

  it('空字符串语句不提取', () => {
    expect(extractTableNamesFromStatements(['', '  '])).toEqual([]);
  });

  it('大小写不敏感', () => {
    const result = extractTableNamesFromStatements(["insert into MyTable values (1)"]);
    expect(result).toEqual(['MyTable']);
  });
});

// ═══════════════════════════════════════════════════════════════
// SqlTableService 类测试
// ═══════════════════════════════════════════════════════════════
describe('SqlTableService', () => {
  let service: SqlTableService;

  // 构造测试用的 TableDataObject
  const TEST_DDL = `CREATE TABLE inventory (
    row_id INTEGER PRIMARY KEY,
    item_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1
  );`;

  const testTableData: any = {
    mate: { type: 'acu', version: 1, updateConfigUiSentinel: 0, globalInjectionConfig: { readableEntryPlacement: { position: '', depth: 0, order: 0 }, wrapperPlacement: { position: '', depth: 0, order: 0 } } },
    sheet_0: {
      uid: 'inventory',
      name: '背包物品表',
      sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '', ddl: TEST_DDL },
      content: [
        ['row_id', 'item_name', 'quantity'],
        ['1', '铁剑', '3'],
        ['2', '治疗药水', '5'],
      ],
      updateConfig: { uiSentinel: 0, contextDepth: 0, updateFrequency: 0, batchSize: 0, skipFloors: 0 },
      exportConfig: {},
      orderNo: 0,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentJsonTableData = null;
    // 重置 mock 返回值，防止测试之间的状态泄漏
    mockGetEffectiveSeedRows.mockReturnValue([]);
    mockGetCurrentChatTemplateScopeState.mockReturnValue(null);
    mockGetTemplatePreset.mockReturnValue(null);
    service = new SqlTableService();
  });

  afterAll(() => {
    // 确保清理
    try { service?.dispose(); } catch (_) {}
  });

  // ═══════════════════════════════════════════════════════════════
  // _ensureInitialized（通过公开方法间接测试）
  // ═══════════════════════════════════════════════════════════════
  describe('未初始化时的行为', () => {
    it('applyEdits 未初始化时抛出错误', () => {
      expect(() => service.applyEdits('INSERT INTO t VALUES (1)')).toThrow('SQLite 引擎未初始化');
    });

    it('executeQuery 未初始化时抛出错误', () => {
      expect(() => service.executeQuery('SELECT 1')).toThrow('SQLite 引擎未初始化');
    });

    it('executeMutation 未初始化时抛出错误', () => {
      expect(() => service.executeMutation('INSERT INTO t VALUES (1)')).toThrow('SQLite 引擎未初始化');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // loadFromChat
  // ═══════════════════════════════════════════════════════════════
  describe('loadFromChat', () => {
    it('无数据时返回 empty', async () => {
      mockMergeAll.mockResolvedValue(null);
      const result = await service.loadFromChat();
      expect(result.loaded).toBe(false);
      expect(result.source).toBe('empty');
    });

    it('新开卡无数据后 getCurrentData 不应触发 _acu_sheet_meta 缺失错误或提前创建用户表', async () => {
      mockMergeAll.mockResolvedValue(null);
      await service.loadFromChat();

      const currentData = service.getCurrentData();

      expect(currentData).toEqual({
        mate: {
          type: 'acu',
          version: 1,
          updateConfigUiSentinel: 0,
          globalInjectionConfig: {
            readableEntryPlacement: { position: '', depth: 0, order: 0 },
            wrapperPlacement: { position: '', depth: 0, order: 0 },
          },
        },
      });
      expect(() => service.executeQuery('SELECT * FROM inventory')).toThrow();
      expect(mockLogError).not.toHaveBeenCalledWith(
        expect.stringContaining('[SQLite引擎] query 执行失败:'),
        expect.stringContaining('SELECT * FROM _acu_sheet_meta'),
        expect.anything(),
        expect.stringContaining('no such table: _acu_sheet_meta'),
      );
    });

    it('空壳结构 getCurrentData 后应保留表头视图且不提前创建用户表', async () => {
      const headerOnlyData = JSON.parse(JSON.stringify({
        ...testTableData,
        sheet_0: {
          ...testTableData.sheet_0,
          content: [['row_id', 'item_name', 'quantity']],
        },
      }));
      mockMergeAll.mockResolvedValue(headerOnlyData);
      await service.loadFromChat();

      const currentData = service.getCurrentData();

      expect(currentData).toHaveProperty('sheet_0');
      expect((currentData as any).sheet_0.content).toEqual([['row_id', 'item_name', 'quantity']]);
      expect(mockCurrentJsonTableData.sheet_0.content).toEqual([['row_id', 'item_name', 'quantity']]);
      expect(() => service.executeQuery('SELECT * FROM inventory')).toThrow();
      expect(mockLogError).not.toHaveBeenCalledWith(
        expect.stringContaining('[SQLite引擎] query 执行失败:'),
        expect.stringContaining('SELECT * FROM _acu_sheet_meta'),
        expect.anything(),
        expect.stringContaining('no such table: _acu_sheet_meta'),
      );
    });

    it('有数据时成功加载', async () => {
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      const result = await service.loadFromChat();
      expect(result.loaded).toBe(true);
      expect(result.source).toBe('merged');
    });

    it('legacy migration 结果即使只有表头也不应在加载阶段建表，且应保留 JSON 视图', async () => {
      const migratedLegacyHeaderOnlyData = JSON.parse(JSON.stringify({
        ...testTableData,
        sheet_0: {
          ...testTableData.sheet_0,
          content: [['row_id', 'item_name', 'quantity']],
        },
      }));
      mockMergeAllWithMeta.mockResolvedValueOnce({
        data: migratedLegacyHeaderOnlyData,
        usedLegacyMigration: true,
        changed: true,
        foundSheetCount: 1,
      });

      const result = await service.loadFromChat();

      expect(result.loaded).toBe(false);
      expect(result.source).toBe('empty');
      expect(mockCurrentJsonTableData.sheet_0.content).toEqual([['row_id', 'item_name', 'quantity']]);
      expect(() => service.executeQuery('SELECT * FROM inventory')).toThrow();
    });

    it('样本风格 legacy migration 多表数据在加载阶段不导入 SQLite，但应保留 JSON 历史行视图', async () => {
      const migratedLegacySampleData = {
        mate: {
          type: 'acu',
          version: 1,
          updateConfigUiSentinel: 0,
          globalInjectionConfig: {
            readableEntryPlacement: { position: '', depth: 0, order: 0 },
            wrapperPlacement: { position: '', depth: 0, order: 0 },
          },
        },
        sheet_dCudvUnH: {
          uid: 'global_state',
          name: '全局数据表',
          sourceData: {
            note: '',
            initNode: '',
            deleteNode: '',
            updateNode: '',
            insertNode: '',
            ddl: `CREATE TABLE global_state (
              row_id INTEGER PRIMARY KEY,
              location TEXT NOT NULL,
              scene_time TEXT NOT NULL
            );`,
          },
          content: [
            ['row_id', 'location', 'scene_time'],
            ['1', '老旧公寓楼三楼家门口', '20XX-09-25 14:30'],
          ],
          updateConfig: { uiSentinel: 0, contextDepth: 0, updateFrequency: 0, batchSize: 0, skipFloors: 0 },
          exportConfig: {},
          orderNo: 0,
        },
        sheet_DpKcVGqg: {
          uid: 'protagonist_profile',
          name: '主角信息',
          sourceData: {
            note: '',
            initNode: '',
            deleteNode: '',
            updateNode: '',
            insertNode: '',
            ddl: `CREATE TABLE protagonist_profile (
              row_id INTEGER PRIMARY KEY,
              character_name TEXT NOT NULL,
              age_label TEXT NOT NULL,
              history TEXT NOT NULL
            );`,
          },
          content: [
            ['row_id', 'character_name', 'age_label', 'history'],
            ['1', '陈默', '男/30岁', '因保护妻子入狱三年，刚出狱回家。'],
          ],
          updateConfig: { uiSentinel: 0, contextDepth: 0, updateFrequency: 0, batchSize: 0, skipFloors: 0 },
          exportConfig: {},
          orderNo: 1,
        },
        sheet_3NoMc1wI: {
          uid: 'summary_log',
          name: '总结表',
          sourceData: {
            note: '',
            initNode: '',
            deleteNode: '',
            updateNode: '',
            insertNode: '',
            ddl: `CREATE TABLE summary_log (
              row_id INTEGER PRIMARY KEY,
              time_span TEXT NOT NULL,
              summary TEXT NOT NULL,
              code_index TEXT NOT NULL
            );`,
          },
          content: [
            ['row_id', 'time_span', 'summary', 'code_index'],
            ['1', '20XX-09-25 午后', '陈默出狱回到家门口，犹豫如何面对苏婉。', 'AM01'],
          ],
          updateConfig: { uiSentinel: 0, contextDepth: 0, updateFrequency: 0, batchSize: 0, skipFloors: 0 },
          exportConfig: {},
          orderNo: 6,
        },
        sheet_PfzcX5v2: {
          uid: 'outline_log',
          name: '总体大纲',
          sourceData: {
            note: '',
            initNode: '',
            deleteNode: '',
            updateNode: '',
            insertNode: '',
            ddl: `CREATE TABLE outline_log (
              row_id INTEGER PRIMARY KEY,
              outline TEXT NOT NULL,
              code_index TEXT NOT NULL
            );`,
          },
          content: [
            ['row_id', 'outline', 'code_index'],
            ['1', '陈默出狱回家，面对熟悉旧居与未知妻子。', 'AM01'],
          ],
          updateConfig: { uiSentinel: 0, contextDepth: 0, updateFrequency: 0, batchSize: 0, skipFloors: 0 },
          exportConfig: {},
          orderNo: 7,
        },
      };
      mockMergeAllWithMeta.mockResolvedValueOnce({
        data: migratedLegacySampleData,
        usedLegacyMigration: true,
        changed: true,
        foundSheetCount: 4,
      });

      const result = await service.loadFromChat();

      expect(result.loaded).toBe(false);
      expect(result.source).toBe('empty');
      expect(mockCurrentJsonTableData.sheet_dCudvUnH.content[1]).toEqual(['1', '老旧公寓楼三楼家门口', '20XX-09-25 14:30']);
      expect(mockCurrentJsonTableData.sheet_DpKcVGqg.content[1]).toEqual(['1', '陈默', '男/30岁', '因保护妻子入狱三年，刚出狱回家。']);
      expect(() => service.executeQuery('SELECT location, scene_time FROM global_state')).toThrow();
    });

    it('加载后可以执行查询', async () => {
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      await service.loadFromChat();
      const queryResult = service.executeQuery('SELECT * FROM inventory');
      expect(queryResult.rowCount).toBe(2);
      expect(queryResult.columns).toContain('item_name');
    });

    it('加载失败时返回错误信息', async () => {
      mockMergeAll.mockRejectedValue(new Error('网络错误'));
      const result = await service.loadFromChat();
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('网络错误');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // applyEdits
  // ═══════════════════════════════════════════════════════════════
  describe('applyEdits', () => {
    beforeEach(async () => {
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      await service.loadFromChat();
    });

    it('执行单条 INSERT 语句', () => {
      const result = service.applyEdits("INSERT INTO inventory VALUES (3, '魔法书', 1);");
      expect(result.success).toBe(true);
      expect(result.appliedEdits).toBe(1);
      // 验证数据确实插入了
      const query = service.executeQuery('SELECT * FROM inventory WHERE row_id = 3');
      expect(query.rowCount).toBe(1);
    });

    it('执行多条语句', () => {
      const sql = "INSERT INTO inventory VALUES (3, '魔法书', 1); UPDATE inventory SET quantity = 10 WHERE row_id = 1;";
      const result = service.applyEdits(sql);
      expect(result.success).toBe(true);
      expect(result.appliedEdits).toBe(2);
    });

    it('空字符串返回成功（无操作）', () => {
      const result = service.applyEdits('');
      expect(result.success).toBe(true);
      expect(result.appliedEdits).toBe(0);
    });

    it('纯空白返回成功（无操作）', () => {
      const result = service.applyEdits('   \n\t  ');
      expect(result.success).toBe(true);
      expect(result.appliedEdits).toBe(0);
    });

    it('去除 HTML 注释标记', () => {
      const sql = "<!-- INSERT INTO inventory VALUES (3, '魔法书', 1); -->";
      const result = service.applyEdits(sql);
      expect(result.success).toBe(true);
      expect(result.appliedEdits).toBe(1);
    });

    it('SQL 语法错误时抛出异常', () => {
      expect(() => service.applyEdits('INVALID SQL SYNTAX HERE;')).toThrow();
    });

    it('返回受影响的 modifiedKeys', () => {
      // 设置 currentJsonTableData 以便 _tableNamesToSheetKeys 能工作
      mockCurrentJsonTableData = JSON.parse(JSON.stringify(testTableData));
      const result = service.applyEdits("UPDATE inventory SET quantity = 10 WHERE row_id = 1;");
      expect(result.modifiedKeys).toContain('sheet_0');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // executeQuery
  // ═══════════════════════════════════════════════════════════════
  describe('executeQuery', () => {
    beforeEach(async () => {
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      await service.loadFromChat();
    });

    it('执行 SELECT 查询', () => {
      const result = service.executeQuery('SELECT item_name, quantity FROM inventory');
      expect(result.columns).toEqual(['item_name', 'quantity']);
      expect(result.rowCount).toBe(2);
      expect(result.values[0]).toEqual(['铁剑', 3]);
    });

    it('带参数的查询', () => {
      const result = service.executeQuery('SELECT * FROM inventory WHERE item_name = ?', ['铁剑']);
      expect(result.rowCount).toBe(1);
    });

    it('无结果的查询', () => {
      const result = service.executeQuery("SELECT * FROM inventory WHERE item_name = '不存在'");
      expect(result.rowCount).toBe(0);
      expect(result.values).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 新开卡场景：executeQuery 不触发建表
  // ═══════════════════════════════════════════════════════════════
  describe('新开卡场景下 executeQuery 不触发建表', () => {
    it('新开卡后 executeQuery 查询不存在的表应抛出错误，而非静默建表', async () => {
      // 模拟新开卡：mergeAll 返回 null
      mockMergeAll.mockResolvedValue(null);
      await service.loadFromChat();

      // executeQuery 不应触发建表，查询不存在的表应抛出错误
      expect(() => service.executeQuery('SELECT * FROM inventory')).toThrow();
    });

    it('新开卡后 applyEdits 才触发建表', async () => {
      // 模拟新开卡
      mockMergeAll.mockResolvedValue(null);
      await service.loadFromChat();

      // 设置模板数据，让 _ensureTablesFromTemplate 能找到模板
      const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu', version: 1 },
        sheet_0: {
          uid: 'inventory',
          name: '背包物品表',
          sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '', ddl: TEST_DDL },
          content: [['row_id', 'item_name', 'quantity']],
          updateConfig: {},
          exportConfig: {},
          orderNo: 0,
        },
      } as any);

      // applyEdits 应触发建表并成功执行
      const result = service.applyEdits("INSERT INTO inventory VALUES (1, '铁剑', 3);");
      expect(result.success).toBe(true);
      expect(result.appliedEdits).toBe(1);

      // 建表后 executeQuery 应正常工作
      const queryResult = service.executeQuery('SELECT * FROM inventory');
      expect(queryResult.rowCount).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // _ensureTablesFromTemplate + seedRows 写入
  // ═══════════════════════════════════════════════════════════════
  describe('建表时 seedRows 写入 SQLite', () => {
    const TEST_DDL_WITH_SEED = `CREATE TABLE inventory (
      row_id INTEGER PRIMARY KEY,
      item_name TEXT NOT NULL,
      quantity INTEGER DEFAULT 1
    );`;

    it('有 seedRows 的表建表后数据被写入 SQLite', async () => {
      // 模拟新开卡
      mockMergeAll.mockResolvedValue(null);
      await service.loadFromChat();

      // 设置模板（stripSeedRows=true 后只有表头）
      const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu', version: 1 },
        sheet_0: {
          uid: 'inventory',
          name: '背包物品表',
          sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '', ddl: TEST_DDL_WITH_SEED },
          content: [['row_id', 'item_name', 'quantity']], // 只有表头
          updateConfig: {},
          exportConfig: {},
          orderNo: 0,
        },
      } as any);

      // mock seedRows 返回初始数据
      mockGetEffectiveSeedRows.mockReturnValue([
        ['1', '铁剑', '3'],
        ['2', '治疗药水', '5'],
      ]);

      // applyEdits 触发建表 + seedRows 写入
      const result = service.applyEdits("UPDATE inventory SET quantity = 10 WHERE item_name = '铁剑';");
      expect(result.success).toBe(true);

      // 验证 seedRows 已写入 SQLite
      const queryResult = service.executeQuery('SELECT * FROM inventory ORDER BY row_id');
      expect(queryResult.rowCount).toBe(2);
      expect(queryResult.values[0]).toContain('铁剑');
      // 验证 UPDATE 确实生效了（quantity 从 3 变为 10）
      expect(queryResult.values[0]).toContain(10);
      expect(queryResult.values[1]).toContain('治疗药水');
    });

    it('没有 seedRows 的表建表后仍为空表', async () => {
      mockMergeAll.mockResolvedValue(null);
      await service.loadFromChat();

      const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu', version: 1 },
        sheet_0: {
          uid: 'inventory',
          name: '背包物品表',
          sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '', ddl: TEST_DDL_WITH_SEED },
          content: [['row_id', 'item_name', 'quantity']],
          updateConfig: {},
          exportConfig: {},
          orderNo: 0,
        },
      } as any);

      // mock seedRows 返回空
      mockGetEffectiveSeedRows.mockReturnValue([]);

      // applyEdits 触发建表（无 seedRows）
      const result = service.applyEdits("INSERT INTO inventory VALUES (1, '魔法书', 1);");
      expect(result.success).toBe(true);

      // 验证只有刚 INSERT 的那一行
      const queryResult = service.executeQuery('SELECT * FROM inventory');
      expect(queryResult.rowCount).toBe(1);
      expect(queryResult.values[0]).toContain('魔法书');
    });

    it('已存在的表不会被重复写入 seedRows', async () => {
      // 先加载有数据的表
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      await service.loadFromChat();

      // 设置 seedRows（即使有也不应写入，因为表已存在）
      mockGetEffectiveSeedRows.mockReturnValue([
        ['99', '不应出现的物品', '999'],
      ]);

      const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu', version: 1 },
        sheet_0: {
          uid: 'inventory',
          name: '背包物品表',
          sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '', ddl: TEST_DDL },
          content: [['row_id', 'item_name', 'quantity']],
          updateConfig: {},
          exportConfig: {},
          orderNo: 0,
        },
      } as any);

      // applyEdits 触发 _ensureTablesFromTemplate，但表已存在，不应重建
      const result = service.applyEdits("UPDATE inventory SET quantity = 10 WHERE row_id = 1;");
      expect(result.success).toBe(true);

      // 验证原始数据未被 seedRows 覆盖
      const queryResult = service.executeQuery('SELECT * FROM inventory ORDER BY row_id');
      expect(queryResult.rowCount).toBe(2); // 原始 2 行
      expect(queryResult.values[0]).toContain('铁剑');
      // 不应出现 seedRows 中的数据
      const allItems = queryResult.values.map(r => r[1]);
      expect(allItems).not.toContain('不应出现的物品');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // _ensureTablesFromTemplate 模板来源优先级
  // ═══════════════════════════════════════════════════════════════
  describe('建表时只使用当前聊天模板预设', () => {
    const CHAT_TEMPLATE_DDL = `CREATE TABLE chat_table (
      row_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );`;

    const GLOBAL_TEMPLATE_DDL = `CREATE TABLE global_table (
      row_id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );`;

    it('chat_override 模式下只建聊天级模板中的表，不建全局模板的表', async () => {
      // 模拟新开卡
      mockMergeAll.mockResolvedValue(null);
      await service.loadFromChat();

      // 设置当前聊天模板为 chat_override（只有 chat_table）
      mockGetCurrentChatTemplateScopeState.mockReturnValue({
        mode: 'chat_override',
        templateStr: JSON.stringify({
          mate: { type: 'acu', version: 1 },
          sheet_0: {
            uid: 'chat_table',
            name: '聊天专属表',
            sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '', ddl: CHAT_TEMPLATE_DDL },
            content: [['row_id', 'name']],
            updateConfig: {},
            exportConfig: {},
            orderNo: 0,
          },
        }),
        presetName: '聊天预设',
      });

      // 全局模板有 global_table（不应该被建出来）
      const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu', version: 1 },
        sheet_0: {
          uid: 'global_table',
          name: '全局表',
          sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '', ddl: GLOBAL_TEMPLATE_DDL },
          content: [['row_id', 'value']],
          updateConfig: {},
          exportConfig: {},
          orderNo: 0,
        },
      } as any);

      // applyEdits 触发建表
      const result = service.applyEdits("INSERT INTO chat_table VALUES (1, '测试');");
      expect(result.success).toBe(true);

      // 验证 chat_table 被建出来了
      const chatQuery = service.executeQuery('SELECT * FROM chat_table');
      expect(chatQuery.rowCount).toBe(1);

      // 验证 global_table 没有被建出来
      expect(() => service.executeQuery('SELECT * FROM global_table')).toThrow();
    });

    it('inherit_global 模式下 fallback 到全局模板', async () => {
      mockMergeAll.mockResolvedValue(null);
      await service.loadFromChat();

      // 当前聊天没有聊天级模板（inherit_global）
      mockGetCurrentChatTemplateScopeState.mockReturnValue(null);

      // 全局模板有 inventory 表
      const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
      vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
        mate: { type: 'acu', version: 1 },
        sheet_0: {
          uid: 'inventory',
          name: '背包物品表',
          sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '', ddl: TEST_DDL },
          content: [['row_id', 'item_name', 'quantity']],
          updateConfig: {},
          exportConfig: {},
          orderNo: 0,
        },
      } as any);

      // applyEdits 触发建表（应使用全局模板）
      const result = service.applyEdits("INSERT INTO inventory VALUES (1, '铁剑', 3);");
      expect(result.success).toBe(true);

      const queryResult = service.executeQuery('SELECT * FROM inventory');
      expect(queryResult.rowCount).toBe(1);
    });

    it('preset_link 模式下使用链接的全局预设', async () => {
      mockMergeAll.mockResolvedValue(null);
      await service.loadFromChat();

      // 当前聊天链接了全局预设
      mockGetCurrentChatTemplateScopeState.mockReturnValue({
        mode: 'preset_link',
        presetName: '战斗模板',
        templateStr: '',
      });

      // mock 全局预设返回
      mockGetTemplatePreset.mockReturnValue({
        templateStr: JSON.stringify({
          mate: { type: 'acu', version: 1 },
          sheet_0: {
            uid: 'inventory',
            name: '背包物品表',
            sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '', ddl: TEST_DDL },
            content: [['row_id', 'item_name', 'quantity']],
            updateConfig: {},
            exportConfig: {},
            orderNo: 0,
          },
        }),
      });

      const result = service.applyEdits("INSERT INTO inventory VALUES (1, '铁剑', 3);");
      expect(result.success).toBe(true);

      const queryResult = service.executeQuery('SELECT * FROM inventory');
      expect(queryResult.rowCount).toBe(1);
      expect(mockGetTemplatePreset).toHaveBeenCalledWith('战斗模板');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // executeMutation
  // ═══════════════════════════════════════════════════════════════
  describe('executeMutation', () => {
    beforeEach(async () => {
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      await service.loadFromChat();
    });

    it('执行 INSERT 并返回 changes', () => {
      const result = service.executeMutation("INSERT INTO inventory VALUES (3, '魔法书', 1)");
      expect(result.changes).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it('执行 UPDATE 并返回 changes', () => {
      const result = service.executeMutation('UPDATE inventory SET quantity = 10 WHERE row_id = 1');
      expect(result.changes).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it('执行 DELETE 并返回 changes', () => {
      const result = service.executeMutation('DELETE FROM inventory WHERE row_id = 1');
      expect(result.changes).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it('SQL 错误时返回 errors 而不抛出', () => {
      const result = service.executeMutation('INSERT INTO nonexistent_table VALUES (1)');
      expect(result.changes).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getCurrentData
  // ═══════════════════════════════════════════════════════════════
  describe('getCurrentData', () => {
    it('未初始化时返回 currentJsonTableData_ACU', () => {
      mockCurrentJsonTableData = { test: true };
      const result = service.getCurrentData();
      expect(result).toEqual({ test: true });
    });

    it('初始化后返回导出的数据', async () => {
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      await service.loadFromChat();
      const result = service.getCurrentData();
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('sheet_0');
    });

    it('首次写入物化用户表后 getCurrentData 应采用 SQLite 导出的真实数据', async () => {
      const headerOnlyData = JSON.parse(JSON.stringify({
        ...testTableData,
        sheet_0: {
          ...testTableData.sheet_0,
          content: [['row_id', 'item_name', 'quantity']],
        },
      }));
      mockMergeAll.mockResolvedValue(headerOnlyData);
      await service.loadFromChat();

      const result = service.applyEdits("INSERT INTO inventory VALUES (1, '铁剑', 3);");
      expect(result.success).toBe(true);

      const currentData = service.getCurrentData();
      expect((currentData as any).sheet_0.content).toContainEqual(['1', '铁剑', '3']);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // replaceCurrentData
  // ═══════════════════════════════════════════════════════════════
  describe('replaceCurrentData', () => {
    it('用批次 JSON 快照重建 SQLite，并清除旧内存库数据', async () => {
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      await service.loadFromChat();
      expect(service.executeQuery('SELECT COUNT(*) AS count FROM inventory').values[0][0]).toBe(2);

      const batchData = JSON.parse(JSON.stringify(testTableData));
      batchData.sheet_0.content = [
        ['row_id', 'item_name', 'quantity'],
        ['9', '旧聊天铁剑', '1'],
      ];

      await service.replaceCurrentData(batchData);
      const queryResult = service.executeQuery('SELECT row_id, item_name, quantity FROM inventory');
      expect(queryResult.values).toEqual([[9, '旧聊天铁剑', 1]]);
      expect(mockCurrentJsonTableData.sheet_0.content).toEqual([
        ['row_id', 'item_name', 'quantity'],
        ['9', '旧聊天铁剑', '1'],
      ]);
    });

    it('连续 replaceCurrentData 加载同名表时不应因旧表残留失败', async () => {
      const firstBatch = JSON.parse(JSON.stringify(testTableData));
      firstBatch.sheet_0.content = [
        ['row_id', 'item_name', 'quantity'],
        ['1', '第一批铁剑', '2'],
      ];

      const secondBatch = JSON.parse(JSON.stringify(testTableData));
      secondBatch.sheet_0.content = [
        ['row_id', 'item_name', 'quantity'],
        ['1', '第二批银剑', '4'],
      ];

      await service.replaceCurrentData(firstBatch);
      expect(service.executeQuery('SELECT item_name, quantity FROM inventory').values).toEqual([['第一批铁剑', 2]]);

      await expect(service.replaceCurrentData(secondBatch)).resolves.toBeUndefined();
      expect(service.executeQuery('SELECT item_name, quantity FROM inventory').values).toEqual([['第二批银剑', 4]]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // saveToChat
  // ═══════════════════════════════════════════════════════════════
  describe('saveToChat', () => {
    beforeEach(async () => {
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      await service.loadFromChat();
    });

    it('成功保存到聊天并传入 committed before 与导出 after', async () => {
      const result = await service.saveToChat();
      expect(result.saved).toBe(true);
      expect(mockSaveIndependentTable).toHaveBeenCalledTimes(1);
      const options = mockSaveIndependentTable.mock.calls[0][0];
      expect(options.targetMessageIndex).toBe(-1);
      expect(options.beforeData.sheet_0.content).toEqual(testTableData.sheet_0.content);
      expect(options.afterData.sheet_0.content).toEqual(testTableData.sheet_0.content);
    });

    it('传递 targetSheetKeys 参数', async () => {
      await service.saveToChat(['sheet_0'], ['group_1']);
      expect(mockSaveIndependentTable).toHaveBeenCalledWith(expect.objectContaining({
        targetMessageIndex: -1,
        targetSheetKeys: ['sheet_0'],
        updateGroupKeys: ['group_1'],
      }));
    });

    it('null 参数转为 null', async () => {
      await service.saveToChat(null, null);
      expect(mockSaveIndependentTable).toHaveBeenCalledWith(expect.objectContaining({
        targetMessageIndex: -1,
        targetSheetKeys: null,
        updateGroupKeys: null,
      }));
    });

    it('多次 mutation 后一次保存使用首次 mutation 前的 beforeData', async () => {
      service.executeMutation('UPDATE inventory SET quantity = 10 WHERE row_id = 1');
      service.executeMutation("INSERT INTO inventory VALUES (3, '魔法书', 1)");

      await service.saveToChat(['sheet_0'], ['sheet_0']);

      const options = mockSaveIndependentTable.mock.calls[0][0];
      expect(options.beforeData.sheet_0.content).toEqual(testTableData.sheet_0.content);
      expect(options.afterData.sheet_0.content).toContainEqual(['1', '铁剑', '10']);
      expect(options.afterData.sheet_0.content).toContainEqual(['3', '魔法书', '1']);
    });

    it('applyEdits 执行多条 UPDATE 与 INSERT 时应保留全部既有行', async () => {
      const result = service.applyEdits(`
        UPDATE inventory SET quantity = 10 WHERE row_id = 1;
        UPDATE inventory SET quantity = 6 WHERE row_id = 2;
        INSERT INTO inventory VALUES (3, '魔法书', 1);
      `);

      expect(result.success).toBe(true);
      expect(result.appliedEdits).toBe(3);

      const currentData = service.getCurrentData();
      expect((currentData as any).sheet_0.content).toContainEqual(['1', '铁剑', '10']);
      expect((currentData as any).sheet_0.content).toContainEqual(['2', '治疗药水', '6']);
      expect((currentData as any).sheet_0.content).toContainEqual(['3', '魔法书', '1']);
    });

    it('保存失败时保留 pending before，下一次保存仍使用同一 beforeData', async () => {
      mockSaveIndependentTable
        .mockResolvedValueOnce({ saved: false, error: '写入失败' })
        .mockResolvedValueOnce({ saved: true, messageIndex: 6 });

      service.executeMutation('UPDATE inventory SET quantity = 10 WHERE row_id = 1');
      const failed = await service.saveToChat(['sheet_0'], ['sheet_0']);
      expect(failed.saved).toBe(false);

      service.executeMutation('UPDATE inventory SET quantity = 11 WHERE row_id = 1');
      const saved = await service.saveToChat(['sheet_0'], ['sheet_0']);
      expect(saved.saved).toBe(true);

      const firstOptions = mockSaveIndependentTable.mock.calls[0][0];
      const secondOptions = mockSaveIndependentTable.mock.calls[1][0];
      expect(firstOptions.beforeData.sheet_0.content).toEqual(testTableData.sheet_0.content);
      expect(secondOptions.beforeData.sheet_0.content).toEqual(testTableData.sheet_0.content);
      expect(secondOptions.afterData.sheet_0.content).toContainEqual(['1', '铁剑', '11']);
    });

    it('成功保存后重置 committed snapshot，后续 mutation 的 beforeData 来自上次保存后的状态', async () => {
      service.executeMutation('UPDATE inventory SET quantity = 10 WHERE row_id = 1');
      await service.saveToChat(['sheet_0'], ['sheet_0']);

      service.executeMutation('UPDATE inventory SET quantity = 11 WHERE row_id = 1');
      await service.saveToChat(['sheet_0'], ['sheet_0']);

      const secondOptions = mockSaveIndependentTable.mock.calls[1][0];
      expect(secondOptions.beforeData.sheet_0.content).toContainEqual(['1', '铁剑', '10']);
      expect(secondOptions.afterData.sheet_0.content).toContainEqual(['1', '铁剑', '11']);
    });

    it('空 applyEdits 不创建 pending before', async () => {
      service.applyEdits('   ');
      await service.saveToChat(['sheet_0'], ['sheet_0']);
      const options = mockSaveIndependentTable.mock.calls[0][0];
      expect(options.beforeData.sheet_0.content).toEqual(testTableData.sheet_0.content);
      expect(options.afterData.sheet_0.content).toEqual(testTableData.sheet_0.content);
    });

    it('首次写入前保存空壳结构时不应把 afterData 覆盖成 mate-only', async () => {
      service.dispose();
      service = new SqlTableService();
      const headerOnlyData = JSON.parse(JSON.stringify({
        ...testTableData,
        sheet_0: {
          ...testTableData.sheet_0,
          content: [['row_id', 'item_name', 'quantity']],
        },
      }));
      mockMergeAll.mockResolvedValue(headerOnlyData);
      await service.loadFromChat();

      await service.saveToChat(['sheet_0'], ['sheet_0']);

      const options = mockSaveIndependentTable.mock.calls[0][0];
      expect(options.afterData).toHaveProperty('sheet_0');
      expect(options.afterData.sheet_0.content).toEqual([['row_id', 'item_name', 'quantity']]);
      expect(mockCurrentJsonTableData.sheet_0.content).toEqual([['row_id', 'item_name', 'quantity']]);
      expect(() => service.executeQuery('SELECT * FROM inventory')).toThrow();
    });

    it('replaceCurrentData 收到空壳批次后保存时应把清空防线参数传给持久化层', async () => {
      const headerOnlyData = JSON.parse(JSON.stringify({
        ...testTableData,
        sheet_0: {
          ...testTableData.sheet_0,
          content: [['row_id', 'item_name', 'quantity']],
        },
      }));

      await service.replaceCurrentData(headerOnlyData);
      await service.saveToChat({
        targetSheetKeys: ['sheet_0'],
        updateGroupKeys: ['sheet_0'],
        beforeData: testTableData as any,
      });

      const options = mockSaveIndependentTable.mock.calls[0][0];
      expect(options.beforeData.sheet_0.content).toEqual(testTableData.sheet_0.content);
      expect(options.afterData.sheet_0.content).toEqual([['row_id', 'item_name', 'quantity']]);
      expect(options.allowClearingTargetSheets).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // dispose
  // ═══════════════════════════════════════════════════════════════
  describe('dispose', () => {
    it('销毁后无法执行查询', async () => {
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      await service.loadFromChat();
      service.dispose();
      expect(() => service.executeQuery('SELECT 1')).toThrow();
    });

    it('多次 dispose 不抛出', async () => {
      mockMergeAll.mockResolvedValue(JSON.parse(JSON.stringify(testTableData)));
      await service.loadFromChat();
      service.dispose();
      expect(() => service.dispose()).not.toThrow();
    });
  });
});
