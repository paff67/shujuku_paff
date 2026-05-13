/**
 * tests/data/sqlite/sync-bridge.test.ts
 * SyncBridge 组合测试 — 使用真实 SqliteEngine + schema-mapper
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteEngine } from '../../../src/data/sqlite/sqlite-engine';
import { SyncBridge } from '../../../src/data/sqlite/sync-bridge';
import type { TableDataObject_ACU, Sheet_ACU, Mate_ACU } from '../../../src/shared/models/table-data';

// ═══════════════════════════════════════════════════════════════
// 辅助：构造测试数据
// ═══════════════════════════════════════════════════════════════
function makeMate(): Mate_ACU {
  return {
    type: 'acu_table_data',
    version: 3,
    updateConfigUiSentinel: 0,
    globalInjectionConfig: {
      readableEntryPlacement: { position: 'before_char', depth: 4, order: 100 },
      wrapperPlacement: { position: 'before_char', depth: 4, order: 100 },
    },
  };
}

function makeSheet(overrides: Partial<Sheet_ACU> = {}): Sheet_ACU {
  return {
    uid: 'inventory',
    name: '背包物品表',
    sourceData: {
      note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
      ddl: `CREATE TABLE inventory ( -- 背包物品表
  row_id INTEGER PRIMARY KEY, -- 行号
  item_name TEXT NOT NULL, -- 物品名称
  quantity INTEGER DEFAULT 1, -- 数量
  description TEXT -- 描述
);`,
    },
    content: [
      ['row_id', '物品名称', '数量', '描述'],
      ['1', '铁剑', '3', '普通的铁剑'],
      ['2', '治疗药水', '5', '恢复少量HP'],
    ],
    updateConfig: { uiSentinel: 0, contextDepth: 0, updateFrequency: 0, batchSize: 0, skipFloors: 0 },
    exportConfig: {} as any,
    orderNo: 0,
    ...overrides,
  };
}

function makeTableData(sheets: Record<string, Sheet_ACU> = {}): TableDataObject_ACU {
  const data: TableDataObject_ACU = { mate: makeMate() };
  for (const [key, sheet] of Object.entries(sheets)) {
    data[key] = sheet;
  }
  return data;
}

describe('SyncBridge', () => {
  let engine: SqliteEngine;
  let bridge: SyncBridge;

  beforeEach(async () => {
    engine = new SqliteEngine();
    await engine.init();
    bridge = new SyncBridge(engine);
  });

  afterEach(() => {
    engine.dispose();
  });

  // ═══════════════════════════════════════════════════════════════
  // loadFromTableData
  // ═══════════════════════════════════════════════════════════════
  describe('loadFromTableData', () => {
    it('加载单张表到 SQLite', () => {
      const data = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(data);

      // 验证表已创建
      const tableNames = engine.getTableNames();
      expect(tableNames).toContain('inventory');

      // 验证数据已灌入
      const result = engine.query('SELECT * FROM inventory;');
      expect(result.values).toHaveLength(2);
      expect(result.values[0][1]).toBe('铁剑');
      expect(result.values[1][1]).toBe('治疗药水');
    });

    it('加载多张表', () => {
      const sheet2 = makeSheet({
        uid: 'characters',
        name: '重要人物表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: `CREATE TABLE characters ( -- 重要人物表
  row_id INTEGER PRIMARY KEY, -- 行号
  char_name TEXT NOT NULL, -- 姓名
  status TEXT DEFAULT '存活' -- 状态
);`,
        },
        content: [
          ['row_id', '姓名', '状态'],
          ['1', '角色A', '存活'],
        ],
      });

      const data = makeTableData({
        sheet_0: makeSheet(),
        sheet_1: sheet2,
      });
      bridge.loadFromTableData(data);

      expect(engine.getTableNames()).toContain('inventory');
      expect(engine.getTableNames()).toContain('characters');
    });

    it('重复加载同名表时应替换旧表而不是因 CREATE TABLE already exists 失败', () => {
      bridge.loadFromTableData(makeTableData({ sheet_0: makeSheet() }));
      expect(engine.query('SELECT item_name, quantity FROM inventory ORDER BY row_id;').values).toEqual([
        ['铁剑', 3],
        ['治疗药水', 5],
      ]);

      const replacementSheet = makeSheet({
        content: [
          ['row_id', '物品名称', '数量', '描述'],
          ['1', '银剑', '1', '替换后的武器'],
        ],
      });

      expect(() => bridge.loadFromTableData(makeTableData({ sheet_0: replacementSheet }))).not.toThrow();
      expect(engine.query('SELECT item_name, quantity, description FROM inventory ORDER BY row_id;').values).toEqual([
        ['银剑', 1, '替换后的武器'],
      ]);
    });

    it('同一次加载中多张 sheet 指向不同 SQL 表时均应正常加载并保留数据', () => {
      const globalStateSheet = makeSheet({
        uid: 'global_state',
        name: '全局数据表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: `CREATE TABLE global_state (
  row_id INTEGER PRIMARY KEY,
  current_location TEXT NOT NULL,
  cur_time TEXT NOT NULL
);`,
        },
        content: [
          ['row_id', 'current_location', 'cur_time'],
          ['1', '医科大学', '2026-05-09 11:00'],
        ],
      });

      const protagonistSheet = makeSheet({
        uid: 'protagonist_info',
        name: '主角信息表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: `CREATE TABLE protagonist_info (
  row_id INTEGER PRIMARY KEY,
  char_name TEXT NOT NULL,
  occupation TEXT
);`,
        },
        content: [
          ['row_id', 'char_name', 'occupation'],
          ['1', '助手', '医学生'],
        ],
      });

      expect(() => bridge.loadFromTableData(makeTableData({
        sheet_global: globalStateSheet,
        sheet_protagonist: protagonistSheet,
      }))).not.toThrow();

      expect(engine.query('SELECT current_location FROM global_state;').values).toEqual([['医科大学']]);
      expect(engine.query('SELECT char_name, occupation FROM protagonist_info;').values).toEqual([['助手', '医学生']]);
    });

    it('null 或空对象不报错', () => {
      expect(() => bridge.loadFromTableData(null as any)).not.toThrow();
      expect(() => bridge.loadFromTableData({} as any)).not.toThrow();
    });

    it('引擎未初始化时抛出错误', () => {
      engine.dispose();
      const data = makeTableData({ sheet_0: makeSheet() });
      expect(() => bridge.loadFromTableData(data)).toThrow('未初始化');
    });

    it('单张表加载失败不影响其他表', () => {
      // 第一张表 DDL 有语法错误
      const badSheet = makeSheet({
        uid: 'bad_table',
        name: '坏表',
        sourceData: {
          note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '',
          ddl: 'CREATE TABLE bad_table ( INVALID SYNTAX;',
        },
      });

      const data = makeTableData({
        sheet_0: badSheet,
        sheet_1: makeSheet(),
      });

      // 不应该抛出错误（内部 try-catch 隔离）
      expect(() => bridge.loadFromTableData(data)).not.toThrow();

      // 好的表应该正常加载
      expect(engine.getTableNames()).toContain('inventory');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // exportToTableData
  // ═══════════════════════════════════════════════════════════════
  describe('exportToTableData', () => {
    it('空数据库导出时返回 mate-only 数据且不创建用户表', () => {
      const exported = bridge.exportToTableData(makeMate());

      expect(exported).toEqual({ mate: makeMate() });
      expect(engine.getTableNames()).toEqual([]);
      expect(engine.getAllTableNames()).toEqual(['_acu_sheet_meta']);
    });

    it('从 SQLite 导出为 TableDataObject', () => {
      const originalData = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(originalData);

      const exported = bridge.exportToTableData(makeMate());
      expect(exported.mate).toBeDefined();

      // 找到导出的 sheet
      const sheetKeys = Object.keys(exported).filter(k => k.startsWith('sheet_'));
      expect(sheetKeys).toHaveLength(1);

      const sheet = exported[sheetKeys[0]] as Sheet_ACU;
      expect(sheet.name).toBe('背包物品表');
      expect(sheet.content).toHaveLength(3); // 表头 + 2 行数据
      expect(sheet.content[0]).toContain('物品名称'); // 中文表头还原
    });

    it('导出后数据与原始数据一致', () => {
      const originalData = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(originalData);

      const exported = bridge.exportToTableData(makeMate());
      const sheetKeys = Object.keys(exported).filter(k => k.startsWith('sheet_'));
      const sheet = exported[sheetKeys[0]] as Sheet_ACU;

      // 数据行数一致
      expect(sheet.content.length).toBe(3);
      // 第一行数据的物品名称
      expect(sheet.content[1]).toContain('铁剑');
      expect(sheet.content[2]).toContain('治疗药水');
    });

    it('引擎未初始化时抛出错误', () => {
      engine.dispose();
      expect(() => bridge.exportToTableData(makeMate())).toThrow('未初始化');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // syncToJson
  // ═══════════════════════════════════════════════════════════════
  describe('syncToJson', () => {
    it('同步 SQLite 数据到 JSON 视图', () => {
      const originalData = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(originalData);

      // 在 SQLite 中修改数据
      engine.run("UPDATE inventory SET quantity = 10 WHERE item_name = '铁剑';");

      // 同步到 JSON
      const synced = bridge.syncToJson(originalData);
      const sheetKeys = Object.keys(synced).filter(k => k.startsWith('sheet_'));
      const sheet = synced[sheetKeys[0]] as Sheet_ACU;

      // 验证修改已同步
      // 找到铁剑那行，检查数量
      const ironSwordRow = sheet.content.find(row => row.includes('铁剑'));
      expect(ironSwordRow).toBeDefined();
      // quantity 列的值应该是 '10'（content 中全是 string）
      expect(ironSwordRow).toContain('10');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 元数据保存与恢复
  // ═══════════════════════════════════════════════════════════════
  describe('元数据保存与恢复', () => {
    it('sourceData 在导出后保留', () => {
      const originalData = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(originalData);

      const exported = bridge.exportToTableData(makeMate());
      const sheetKeys = Object.keys(exported).filter(k => k.startsWith('sheet_'));
      const sheet = exported[sheetKeys[0]] as Sheet_ACU;

      expect(sheet.sourceData).toBeDefined();
      expect(sheet.sourceData.ddl).toContain('CREATE TABLE inventory');
    });

    it('uid 和 name 在导出后保留', () => {
      const originalData = makeTableData({ sheet_0: makeSheet() });
      bridge.loadFromTableData(originalData);

      const exported = bridge.exportToTableData(makeMate());
      const sheetKeys = Object.keys(exported).filter(k => k.startsWith('sheet_'));
      const sheet = exported[sheetKeys[0]] as Sheet_ACU;

      expect(sheet.uid).toBe('inventory');
      expect(sheet.name).toBe('背包物品表');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // 无 DDL 的 fallback 模式
  // ═══════════════════════════════════════════════════════════════
  describe('无 DDL 的 fallback 模式', () => {
    it('无 DDL 时自动生成全 TEXT DDL', () => {
      const sheet = makeSheet({
        sourceData: { note: '', initNode: '', deleteNode: '', updateNode: '', insertNode: '' },
        content: [
          ['row_id', 'name', 'value'],
          ['1', 'test', '100'],
        ],
      });
      const data = makeTableData({ sheet_0: sheet });
      bridge.loadFromTableData(data);

      // 表应该被创建（使用 uid 作为表名）
      const tableNames = engine.getTableNames();
      expect(tableNames.length).toBeGreaterThan(0);

      // 数据应该被灌入
      const tableName = tableNames[0];
      const result = engine.query(`SELECT * FROM ${tableName};`);
      expect(result.values).toHaveLength(1);
    });
  });
});
