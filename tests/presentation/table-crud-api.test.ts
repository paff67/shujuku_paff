/**
 * tests/presentation/table-crud-api.test.ts
 * 表格 CRUD API 单元测试 — SQLite 模式 SQL 生成逻辑
 *
 * 策略：mock 全局状态 + mock provider，测试 SQL 生成的正确性和边界条件
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

vi.mock('../../src/shared/env', () => ({
  topLevelWindow_ACU: { AutoCardUpdaterAPI: { _notifyTableUpdate: vi.fn() } },
}));

vi.mock('../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  isSummaryOrOutlineTable_ACU: vi.fn(() => false),
}));

vi.mock('../../src/shared/host-api', () => ({
  SillyTavern_API_ACU: { chat: [] },
}));

let mockCurrentJsonTableData: any = null;
let mockSettings: any = { dataIsolationEnabled: false, dataIsolationCode: '' };

vi.mock('../../src/service/runtime/state-manager', () => ({
  get currentJsonTableData_ACU() { return mockCurrentJsonTableData; },
  get settings_ACU() { return mockSettings; },
  getCurrentIsolationKey_ACU: vi.fn(() => ''),
}));

let mockIsSqliteMode = false;
vi.mock('../../src/service/table/storage-mode', () => ({
  isSqliteMode: vi.fn(() => mockIsSqliteMode),
}));

const mockExecuteMutation = vi.fn(
  (_sql: string, _params?: (string | number | null)[]): { errors: string[]; changes: number } => ({ errors: [], changes: 1 }),
);
vi.mock('../../src/service/table/table-storage-strategy', () => ({
  getStorageProvider: vi.fn(() => ({
    executeMutation: mockExecuteMutation,
  })),
}));

const mockSaveIndependentTable = vi.fn().mockResolvedValue({ saved: true });
vi.mock('../../src/service/table/table-service', () => ({
  saveIndependentTableToChatHistory_ACU: (...args: any[]) => mockSaveIndependentTable(...args),
}));

vi.mock('../../src/service/table/table-history', () => ({
  resolveTableHistoryStateFromChat_ACU: vi.fn(() => ({
    latestAiMessageIndex: 0,
    latestDataMessageIndex: -1,
    lastTrackedUpdateMessageIndex: -1,
    latestDataAiFloor: 0,
    lastTrackedUpdateAiFloor: 0,
    hasAnyData: false,
    hasTrackedUpdate: false,
  })),
}));

vi.mock('../../src/presentation/triggers/update-process', () => ({
  saveCurrentDataForTable_ACU: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/presentation/components/pipeline-ui-helpers', () => ({
  refreshMergedDataAndNotifyWithUI_ACU: vi.fn().mockResolvedValue(undefined),
}));

import {
  quoteIdentifier,
  findTargetSheet,
  createTableCrudApi,
} from '../../src/presentation/bootstrap/api-groups/table-crud-api';
import { SillyTavern_API_ACU } from '../../src/shared/host-api';
import { resolveTableHistoryStateFromChat_ACU } from '../../src/service/table/table-history';

// ═══════════════════════════════════════════════════════════════
// quoteIdentifier
// ═══════════════════════════════════════════════════════════════
describe('quoteIdentifier', () => {
  it('普通英文标识符', () => {
    expect(quoteIdentifier('item_name')).toBe('`item_name`');
  });

  it('中文标识符', () => {
    expect(quoteIdentifier('背包物品表')).toBe('`背包物品表`');
  });

  it('包含反引号的标识符（转义）', () => {
    expect(quoteIdentifier('col`name')).toBe('`col``name`');
  });

  it('空字符串', () => {
    expect(quoteIdentifier('')).toBe('``');
  });

  it('包含空格的标识符', () => {
    expect(quoteIdentifier('item name')).toBe('`item name`');
  });

  it('包含特殊字符的标识符', () => {
    expect(quoteIdentifier('col-1')).toBe('`col-1`');
  });

  it('多个反引号', () => {
    expect(quoteIdentifier('a``b')).toBe('`a````b`');
  });
});

// ═══════════════════════════════════════════════════════════════
// findTargetSheet
// ═══════════════════════════════════════════════════════════════
describe('findTargetSheet', () => {
  beforeEach(() => {
    mockCurrentJsonTableData = null;
  });

  it('找到匹配的表', () => {
    mockCurrentJsonTableData = {
      sheet_0: { name: '背包物品表', content: [['row_id', 'item']] },
      sheet_1: { name: '技能表', content: [['row_id', 'skill']] },
    };
    const result = findTargetSheet('技能表');
    expect(result).not.toBeNull();
    expect(result!.sheetKey).toBe('sheet_1');
    expect(result!.sheet.name).toBe('技能表');
  });

  it('找不到表返回 null', () => {
    mockCurrentJsonTableData = {
      sheet_0: { name: '背包物品表', content: [] },
    };
    expect(findTargetSheet('不存在的表')).toBeNull();
  });

  it('currentJsonTableData 为 null 返回 null', () => {
    mockCurrentJsonTableData = null;
    expect(findTargetSheet('任意表')).toBeNull();
  });

  it('跳过非 sheet_ 开头的键', () => {
    mockCurrentJsonTableData = {
      mate: { name: '背包物品表' },
      sheet_0: { name: '背包物品表', content: [] },
    };
    const result = findTargetSheet('背包物品表');
    expect(result!.sheetKey).toBe('sheet_0');
  });
});

// ═══════════════════════════════════════════════════════════════
// createTableCrudApi — SQLite 模式 SQL 生成
// ═══════════════════════════════════════════════════════════════
describe('createTableCrudApi — SQLite 模式', () => {
  let api: Record<string, Function>;
  const mockCtx: any = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSqliteMode = true;
    SillyTavern_API_ACU.chat = [];
    mockCurrentJsonTableData = {
      sheet_0: {
        name: '背包物品表',
        content: [
          ['row_id', '物品名', '数量'],
          ['1', '铁剑', '3'],
          ['2', '药水', '5'],
        ],
      },
    };
    mockExecuteMutation.mockReturnValue({ errors: [], changes: 1 });
    mockSaveIndependentTable.mockResolvedValue({ saved: true });
    api = createTableCrudApi(mockCtx);
  });

  // ─── updateCell ───
  describe('updateCell', () => {
    it('生成正确的 UPDATE SQL（列名为字符串）', async () => {
      await api.updateCell('背包物品表', 1, '数量', '10');
      expect(mockExecuteMutation).toHaveBeenCalledWith(
        'UPDATE `背包物品表` SET `数量` = ? WHERE `row_id` = ?;',
        ['10', '1'],
      );
    });

    it('生成正确的 UPDATE SQL（列名为数字索引）', async () => {
      await api.updateCell('背包物品表', 1, 1, '新铁剑');
      expect(mockExecuteMutation).toHaveBeenCalledWith(
        'UPDATE `背包物品表` SET `物品名` = ? WHERE `row_id` = ?;',
        ['新铁剑', '1'],
      );
    });

    it('value 为 null 时生成 NULL', async () => {
      await api.updateCell('背包物品表', 1, '数量', null);
      expect(mockExecuteMutation).toHaveBeenCalledWith(
        'UPDATE `背包物品表` SET `数量` = ? WHERE `row_id` = ?;',
        [null, '1'],
      );
    });

    it('value 包含单引号时正确转义', async () => {
      await api.updateCell('背包物品表', 1, '物品名', "铁剑'加强版");
      expect(mockExecuteMutation).toHaveBeenCalledWith(
        'UPDATE `背包物品表` SET `物品名` = ? WHERE `row_id` = ?;',
        ["铁剑'加强版", '1'],
      );
    });

    it('表不存在返回 false', async () => {
      const result = await api.updateCell('不存在的表', 1, '数量', '10');
      expect(result).toBe(false);
    });

    it('列不存在返回 false', async () => {
      const result = await api.updateCell('背包物品表', 1, '不存在的列', '10');
      expect(result).toBe(false);
    });

    it('行索引越界返回 false', async () => {
      const result = await api.updateCell('背包物品表', 0, '数量', '10');
      expect(result).toBe(false);
    });

    it('SQL 执行失败返回 false', async () => {
      mockExecuteMutation.mockReturnValue({ errors: ['SQL 语法错误'], changes: 0 });
      const result = await api.updateCell('背包物品表', 1, '数量', '10');
      expect(result).toBe(false);
    });

    it('currentJsonTableData 为 null 返回 false', async () => {
      mockCurrentJsonTableData = null;
      const result = await api.updateCell('背包物品表', 1, '数量', '10');
      expect(result).toBe(false);
    });

    it('保存时传入 mutation 前后的 beforeData 与 afterData', async () => {
      SillyTavern_API_ACU.chat = [{ is_user: false } as any];

      await api.updateCell('背包物品表', 1, '数量', '10');

      expect(mockSaveIndependentTable).toHaveBeenCalledTimes(1);
      const saveOptions = mockSaveIndependentTable.mock.calls[0][0];
      expect(saveOptions.targetMessageIndex).toBe(0);
      expect(saveOptions.targetSheetKeys).toEqual(['sheet_0']);
      expect(saveOptions.updateGroupKeys).toEqual(['sheet_0']);
      expect(saveOptions.beforeData.sheet_0.content[1]).toEqual(['1', '铁剑', '3']);
      expect(saveOptions.afterData.sheet_0.content[1]).toEqual(['1', '铁剑', '3']);
    });

    it('已有历史数据时不把编辑器保存记为最新更新', async () => {
      vi.mocked(resolveTableHistoryStateFromChat_ACU).mockReturnValueOnce({
        latestAiMessageIndex: 1,
        latestDataMessageIndex: 0,
        lastTrackedUpdateMessageIndex: 0,
        latestDataAiFloor: 1,
        lastTrackedUpdateAiFloor: 1,
        hasAnyData: true,
        hasTrackedUpdate: true,
      });
      await api.updateCell('背包物品表', 1, '数量', '10');
      const { saveCurrentDataForTable_ACU } = await import('../../src/presentation/triggers/update-process');
      expect(vi.mocked(saveCurrentDataForTable_ACU)).toHaveBeenCalledWith('sheet_0');
    });
  });

  // ─── updateRow ───
  describe('updateRow', () => {
    it('生成正确的 UPDATE SQL（多列）', async () => {
      await api.updateRow('背包物品表', 1, { '物品名': '钢剑', '数量': '7' });
      const call = mockExecuteMutation.mock.calls[0][0] as string;
      expect(call).toContain('UPDATE `背包物品表` SET');
      expect(call).toContain('`物品名` = ?');
      expect(call).toContain('`数量` = ?');
      expect(call).toContain('WHERE `row_id` = ?;');
      expect(mockExecuteMutation.mock.calls[0][1]).toEqual(['钢剑', '7', '1']);
    });

    it('跳过 isImportMode 内部标记', async () => {
      await api.updateRow('背包物品表', 1, { '物品名': '钢剑', isImportMode: true });
      const call = mockExecuteMutation.mock.calls[0][0] as string;
      expect(call).not.toContain('isImportMode');
    });

    it('跳过不存在的列名', async () => {
      await api.updateRow('背包物品表', 1, { '不存在的列': '值', '物品名': '钢剑' });
      const call = mockExecuteMutation.mock.calls[0][0] as string;
      expect(call).not.toContain('不存在的列');
      expect(call).toContain('`物品名` = ?');
      expect(mockExecuteMutation.mock.calls[0][1]).toEqual(['钢剑', '1']);
    });

    it('无有效列时返回 false 且不执行 SQL', async () => {
      const result = await api.updateRow('背包物品表', 1, { '不存在的列': '值' });
      expect(result).toBe(false);
      expect(mockExecuteMutation).not.toHaveBeenCalled();
    });

    it('rowIndex < 1 返回 false', async () => {
      const result = await api.updateRow('背包物品表', 0, { '物品名': '钢剑' });
      expect(result).toBe(false);
    });

    it('row_id 不存在返回 false', async () => {
      mockCurrentJsonTableData.sheet_0.content[1][0] = null;
      const result = await api.updateRow('背包物品表', 1, { '物品名': '钢剑' });
      expect(result).toBe(false);
    });
  });

  // ─── insertRow ───
  describe('insertRow', () => {
    it('生成正确的 INSERT SQL', async () => {
      await api.insertRow('背包物品表', { '物品名': '盾牌', '数量': '1' });
      const call = mockExecuteMutation.mock.calls[0][0] as string;
      expect(call).toContain('INSERT INTO `背包物品表`');
      expect(call).toContain('`物品名`');
      expect(call).toContain('`数量`');
      expect(call).toContain('VALUES (?, ?)');
      expect(mockExecuteMutation.mock.calls[0][1]).toEqual(['盾牌', '1']);
    });

    it('跳过 row_id 列（自增）', async () => {
      await api.insertRow('背包物品表', { row_id: '99', '物品名': '盾牌' });
      const call = mockExecuteMutation.mock.calls[0][0] as string;
      expect(call).not.toContain('row_id');
    });

    it('空 data 生成 DEFAULT VALUES', async () => {
      await api.insertRow('背包物品表', {});
      const call = mockExecuteMutation.mock.calls[0][0] as string;
      expect(call).toContain('DEFAULT VALUES');
    });

    it('value 为 null 时通过参数绑定传入 null', async () => {
      await api.insertRow('背包物品表', { '物品名': null, '数量': '1' });
      const call = mockExecuteMutation.mock.calls[0][0] as string;
      expect(call).toContain('VALUES (?, ?)');
      expect(mockExecuteMutation.mock.calls[0][1]).toEqual([null, '1']);
    });

    it('value 包含单引号时正确转义', async () => {
      await api.insertRow('背包物品表', { '物品名': "铁剑'加强版" });
      const call = mockExecuteMutation.mock.calls[0][0] as string;
      expect(call).toContain('VALUES (?)');
      expect(mockExecuteMutation.mock.calls[0][1]).toEqual(["铁剑'加强版"]);
    });

    it('表不存在返回 -1', async () => {
      const result = await api.insertRow('不存在的表', { '物品名': '盾牌' });
      expect(result).toBe(-1);
    });

    it('SQL 执行失败返回 -1', async () => {
      mockExecuteMutation.mockReturnValue({ errors: ['SQL 错误'], changes: 0 });
      const result = await api.insertRow('背包物品表', { '物品名': '盾牌' });
      expect(result).toBe(-1);
    });
  });

  // ─── deleteRow ───
  describe('deleteRow', () => {
    it('生成正确的 DELETE SQL', async () => {
      await api.deleteRow('背包物品表', 1);
      expect(mockExecuteMutation).toHaveBeenCalledWith(
        'DELETE FROM `背包物品表` WHERE `row_id` = ?;',
        ['1'],
      );
    });

    it('rowIndex < 1 返回 false', async () => {
      const result = await api.deleteRow('背包物品表', 0);
      expect(result).toBe(false);
    });

    it('rowIndex 越界返回 false', async () => {
      const result = await api.deleteRow('背包物品表', 99);
      expect(result).toBe(false);
    });

    it('row_id 为 null 返回 false', async () => {
      mockCurrentJsonTableData.sheet_0.content[1][0] = null;
      const result = await api.deleteRow('背包物品表', 1);
      expect(result).toBe(false);
    });

    it('SQL 执行失败返回 false', async () => {
      mockExecuteMutation.mockReturnValue({ errors: ['SQL 错误'], changes: 0 });
      const result = await api.deleteRow('背包物品表', 1);
      expect(result).toBe(false);
    });

    it('表不存在返回 false', async () => {
      const result = await api.deleteRow('不存在的表', 1);
      expect(result).toBe(false);
    });
  });
});
