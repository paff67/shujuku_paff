/**
 * tests/service/table/native-table-service-adapter.test.ts
 * NativeTableServiceAdapter 单元测试
 *
 * 策略：mock 所有委托函数，验证适配器正确转发调用和转换返回值
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

// mock log 函数
vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
}));

// mock table-service
const mockLoadOrCreate = vi.fn();
const mockSaveIndependentTable = vi.fn();
vi.mock('../../../src/service/table/table-service', () => ({
  loadOrCreateJsonTableFromChatHistory_ACU: (...args: any[]) => mockLoadOrCreate(...args),
  saveIndependentTableToChatHistory_ACU: (...args: any[]) => mockSaveIndependentTable(...args),
}));

// mock table-edit-parser
const mockParseAndApply = vi.fn();
vi.mock('../../../src/service/ai/prompt-builder/table-edit-parser', () => ({
  parseAndApplyTableEdits_ACU: (...args: any[]) => mockParseAndApply(...args),
}));

// mock state-manager
let mockCurrentJsonTableData: any = null;
vi.mock('../../../src/service/runtime/state-manager', () => ({
  get currentJsonTableData_ACU() { return mockCurrentJsonTableData; },
}));

import { NativeTableServiceAdapter } from '../../../src/service/table/native-table-service-adapter';

describe('NativeTableServiceAdapter', () => {
  let adapter: NativeTableServiceAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentJsonTableData = null;
    adapter = new NativeTableServiceAdapter();
  });

  // ═══════════════════════════════════════════════════════════════
  // mode
  // ═══════════════════════════════════════════════════════════════
  describe('mode', () => {
    it('mode 为 "native"', () => {
      expect(adapter.mode).toBe('native');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // loadFromChat
  // ═══════════════════════════════════════════════════════════════
  describe('loadFromChat', () => {
    it('委托给 loadOrCreateJsonTableFromChatHistory_ACU', async () => {
      mockLoadOrCreate.mockResolvedValue({ loaded: true, source: 'merged' });
      const result = await adapter.loadFromChat();
      expect(result.loaded).toBe(true);
      expect(result.source).toBe('merged');
      expect(mockLoadOrCreate).toHaveBeenCalledTimes(1);
    });

    it('传递初始化结果', async () => {
      mockLoadOrCreate.mockResolvedValue({ loaded: true, source: 'initialized' });
      const result = await adapter.loadFromChat();
      expect(result.source).toBe('initialized');
    });

    it('传递空结果', async () => {
      mockLoadOrCreate.mockResolvedValue({ loaded: false, source: 'empty', error: '无数据' });
      const result = await adapter.loadFromChat();
      expect(result.loaded).toBe(false);
      expect(result.error).toBe('无数据');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // saveToChat
  // ═══════════════════════════════════════════════════════════════
  describe('saveToChat', () => {
    it('委托给 saveIndependentTableToChatHistory_ACU', async () => {
      mockSaveIndependentTable.mockResolvedValue({ saved: true, messageIndex: 5 });
      const result = await adapter.saveToChat(['sheet_0'], ['group_1']);
      expect(result.saved).toBe(true);
      expect(result.messageIndex).toBe(5);
      expect(mockSaveIndependentTable).toHaveBeenCalledWith(-1, ['sheet_0'], ['group_1']);
    });

    it('options 参数完整转发到保存入口', async () => {
      mockSaveIndependentTable.mockResolvedValue({ saved: true, messageIndex: 7 });
      const beforeData: any = { mate: { type: 'acu' }, sheet_0: { content: [['row_id'], ['1']] } };
      const afterData: any = { mate: { type: 'acu' }, sheet_0: { content: [['row_id'], ['2']] } };

      const result = await adapter.saveToChat({
        targetMessageIndex: 3,
        targetSheetKeys: ['sheet_0'],
        updateGroupKeys: ['sheet_0'],
        trackingSheetKeys: ['sheet_0'],
        beforeData,
        afterData,
      });

      expect(result.messageIndex).toBe(7);
      expect(mockSaveIndependentTable).toHaveBeenCalledWith({
        targetMessageIndex: 3,
        targetSheetKeys: ['sheet_0'],
        updateGroupKeys: ['sheet_0'],
        trackingSheetKeys: ['sheet_0'],
        beforeData,
        afterData,
      });
    });

    it('null 参数正确传递', async () => {
      mockSaveIndependentTable.mockResolvedValue({ saved: true });
      await adapter.saveToChat(null, null);
      expect(mockSaveIndependentTable).toHaveBeenCalledWith(-1, null, null);
    });

    it('无参数时传递 null', async () => {
      mockSaveIndependentTable.mockResolvedValue({ saved: true });
      await adapter.saveToChat();
      expect(mockSaveIndependentTable).toHaveBeenCalledWith(-1, null, null);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getCurrentData
  // ═══════════════════════════════════════════════════════════════
  describe('getCurrentData', () => {
    it('返回 currentJsonTableData_ACU', () => {
      mockCurrentJsonTableData = { mate: { type: 'acu' }, sheet_0: { name: '测试' } };
      expect(adapter.getCurrentData()).toEqual(mockCurrentJsonTableData);
    });

    it('数据为 null 时返回 null', () => {
      mockCurrentJsonTableData = null;
      expect(adapter.getCurrentData()).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // applyEdits
  // ═══════════════════════════════════════════════════════════════
  describe('applyEdits', () => {
    it('成功时返回 success=true', () => {
      mockParseAndApply.mockReturnValue(true);
      const result = adapter.applyEdits('<tableEdit>...</tableEdit>', 'standard');
      expect(result.success).toBe(true);
      expect(result.appliedEdits).toBe(1);
      expect(mockParseAndApply).toHaveBeenCalledWith('<tableEdit>...</tableEdit>', 'standard');
    });

    it('失败时返回 success=false', () => {
      mockParseAndApply.mockReturnValue(false);
      const result = adapter.applyEdits('invalid', 'standard');
      expect(result.success).toBe(false);
      expect(result.appliedEdits).toBe(0);
    });

    it('返回对象结果时正确处理', () => {
      mockParseAndApply.mockReturnValue({ success: true, modifiedKeys: ['sheet_0'] });
      const result = adapter.applyEdits('edits', 'standard');
      // NativeTableServiceAdapter 将 parseAndApplyTableEdits_ACU 的返回值当 boolean 处理
      expect(result.success).toBe(true);
    });

    it('updateMode 默认为 "standard"', () => {
      mockParseAndApply.mockReturnValue(true);
      adapter.applyEdits('edits');
      expect(mockParseAndApply).toHaveBeenCalledWith('edits', 'standard');
    });

    it('modifiedKeys 始终为空数组（原生模式不追踪）', () => {
      mockParseAndApply.mockReturnValue(true);
      const result = adapter.applyEdits('edits', 'standard');
      expect(result.modifiedKeys).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // executeQuery — 原生模式不支持
  // ═══════════════════════════════════════════════════════════════
  describe('executeQuery', () => {
    it('抛出 Error', () => {
      expect(() => adapter.executeQuery('SELECT 1')).toThrow('SQL 查询仅在 SQLite 模式下可用');
    });

    it('错误信息包含切换提示', () => {
      expect(() => adapter.executeQuery('SELECT 1')).toThrow('切换到 SQLite 模式');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // executeMutation — 原生模式不支持
  // ═══════════════════════════════════════════════════════════════
  describe('executeMutation', () => {
    it('抛出 Error', () => {
      expect(() => adapter.executeMutation('INSERT INTO t VALUES (1)')).toThrow('SQL 变更仅在 SQLite 模式下可用');
    });

    it('错误信息包含切换提示', () => {
      expect(() => adapter.executeMutation('DELETE FROM t')).toThrow('切换到 SQLite 模式');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // dispose
  // ═══════════════════════════════════════════════════════════════
  describe('dispose', () => {
    it('不抛出异常', () => {
      expect(() => adapter.dispose()).not.toThrow();
    });

    it('多次调用不抛出', () => {
      adapter.dispose();
      expect(() => adapter.dispose()).not.toThrow();
    });
  });
});
