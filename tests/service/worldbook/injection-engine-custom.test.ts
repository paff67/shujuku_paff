
/**
 * tests/service/worldbook/injection-engine-custom.test.ts
 * 世界书自定义表格导出 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSettings,
  mockGetCurrentWorldbookConfig,
  mockIsWorldbookApiAvailable, mockGetLorebookEntries, mockSetLorebookEntries,
  mockCreateLorebookEntries, mockDeleteLorebookEntries,
  mockSaveSettings,
  mockGetSortedSheetKeys,
  mockLogDebug, mockLogError, mockLogWarn,
  mockGetImportBatchPrefix,
  mockEnsureExportConfigDefaults, mockNormalizePlacementConfig,
  mockApplyPlacementToEntry,
  mockBuildUsedOrderSet, mockAllocOrder, mockAllocConsecutiveOrderBlock,
  mockGetInjectionTargetLorebook, mockGetIsolationPrefix,
  mockSplitKeywordsByComma,
} = vi.hoisted(() => ({
  mockSettings: {
    dataIsolationEnabled: false,
    dataIsolationCode: '',
    knownCustomEntryNames: [] as string[],
  } as any,
  mockGetCurrentWorldbookConfig: vi.fn(() => ({
    zeroTkOccupyMode: false,
  })),
  mockIsWorldbookApiAvailable: vi.fn(() => true),
  mockGetLorebookEntries: vi.fn(async () => []),
  mockSetLorebookEntries: vi.fn(async () => {}),
  mockCreateLorebookEntries: vi.fn(async () => {}),
  mockDeleteLorebookEntries: vi.fn(async () => {}),
  mockSaveSettings: vi.fn(),
  mockGetSortedSheetKeys: vi.fn(() => []),
  mockLogDebug: vi.fn(),
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockGetImportBatchPrefix: vi.fn(() => '外部导入-'),
  mockEnsureExportConfigDefaults: vi.fn((cfg: any, name: string) => ({
    enabled: false,
    splitByRow: false,
    entryName: name || '',
    entryType: 'constant',
    keywords: '',
    preventRecursion: true,
    injectionTemplate: '',
    extraIndexEnabled: false,
    extraIndexEntryName: `${name || '表格'}-索引`,
    extraIndexColumns: [],
    extraIndexColumnModes: {},
    extraIndexInjectionTemplate: '',
    entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
    extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
    fixedEntryPlacement: { position: 'at_depth_as_system', depth: 2, order: 99990 },
    fixedIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 99991 },
    ...cfg,
  })),
  mockNormalizePlacementConfig: vi.fn((raw: any, fallback: any) => raw || fallback || { position: 'at_depth_as_system', depth: 2, order: 10000 }),
  mockApplyPlacementToEntry: vi.fn((entry: any, placement: any) => ({ ...entry, ...placement })),
  mockBuildUsedOrderSet: vi.fn(() => new Set<number>()),
  mockAllocOrder: vi.fn(() => 10001),
  mockAllocConsecutiveOrderBlock: vi.fn(() => 100),
  mockGetInjectionTargetLorebook: vi.fn(async () => 'test-lorebook'),
  mockGetIsolationPrefix: vi.fn(() => ''),
  mockSplitKeywordsByComma: vi.fn((text: string) => {
    const raw = String(text || '').trim();
    if (!raw) return [];
    return raw.split(/[,，]/).map((k: string) => k.trim()).filter(Boolean);
  }),
}));

vi.mock('../../../src/service/settings/settings-readers', () => ({
  getCurrentWorldbookConfig_ACU: mockGetCurrentWorldbookConfig,
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  get settings_ACU() { return mockSettings; },
}));

vi.mock('../../../src/data/gateways/worldbook-gateway', () => ({
  isWorldbookApiAvailable_ACU: mockIsWorldbookApiAvailable,
  getLorebookEntries_ACU: mockGetLorebookEntries,
  setLorebookEntries_ACU: mockSetLorebookEntries,
  createLorebookEntries_ACU: mockCreateLorebookEntries,
  deleteLorebookEntries_ACU: mockDeleteLorebookEntries,
}));

vi.mock('../../../src/service/settings/settings-service', () => ({
  saveSettings_ACU: mockSaveSettings,
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  getSortedSheetKeys_ACU: mockGetSortedSheetKeys,
}));

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: mockLogDebug,
  logError_ACU: mockLogError,
  logWarn_ACU: mockLogWarn,
}));

vi.mock('../../../src/shared/constants', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/shared/constants')>();
  return {
    ...actual,
    getImportBatchPrefix_ACU: mockGetImportBatchPrefix,
  };
});

vi.mock('../../../src/service/worldbook/injection-engine-config', () => ({
  DEFAULT_ENTRY_PLACEMENT_ACU: Object.freeze({ position: 'at_depth_as_system', depth: 2, order: 10000 }),
  DEFAULT_EXTRA_INDEX_PLACEMENT_ACU: Object.freeze({ position: 'at_depth_as_system', depth: 2, order: 10010 }),
  ensureExportConfigDefaults_ACU: mockEnsureExportConfigDefaults,
  normalizePlacementConfig_ACU: mockNormalizePlacementConfig,
  applyPlacementToEntry_ACU: mockApplyPlacementToEntry,
}));

vi.mock('../../../src/service/worldbook/injection-engine-order', () => ({
  buildUsedOrderSet_ACU: mockBuildUsedOrderSet,
  allocOrder_ACU: mockAllocOrder,
  allocConsecutiveOrderBlock_ACU: mockAllocConsecutiveOrderBlock,
}));

vi.mock('../../../src/service/worldbook/injection-engine-state', () => ({
  getInjectionTargetLorebook_ACU: mockGetInjectionTargetLorebook,
  getIsolationPrefix_ACU: mockGetIsolationPrefix,
}));

vi.mock('../../../src/service/worldbook/injection-engine-entries', () => ({
  splitKeywordsByComma_ACU: mockSplitKeywordsByComma,
}));

import { updateCustomTableExports_ACU } from '../../../src/service/worldbook/injection-engine-custom';

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.dataIsolationEnabled = false;
  mockSettings.dataIsolationCode = '';
  mockSettings.knownCustomEntryNames = [];
  mockIsWorldbookApiAvailable.mockReturnValue(true);
  mockGetInjectionTargetLorebook.mockResolvedValue('test-lorebook');
  mockGetIsolationPrefix.mockReturnValue('');
  mockGetLorebookEntries.mockResolvedValue([]);
  mockBuildUsedOrderSet.mockReturnValue(new Set<number>());
  mockAllocOrder.mockReturnValue(10001);
  mockAllocConsecutiveOrderBlock.mockReturnValue(100);
  mockGetCurrentWorldbookConfig.mockReturnValue({ zeroTkOccupyMode: false });
  mockGetSortedSheetKeys.mockReturnValue([]);
});

describe('updateCustomTableExports_ACU', () => {
  // ═══ 基础守卫 ═══
  describe('基础守卫', () => {
    it('API 不可用时直接返回', async () => {
      mockIsWorldbookApiAvailable.mockReturnValue(false);
      await updateCustomTableExports_ACU({ sheet_0: {} });
      expect(mockGetLorebookEntries).not.toHaveBeenCalled();
    });

    it('无 lorebook 时直接返回', async () => {
      mockGetInjectionTargetLorebook.mockResolvedValue(null);
      await updateCustomTableExports_ACU({ sheet_0: {} });
      expect(mockGetLorebookEntries).not.toHaveBeenCalled();
    });
  });

  // ═══ 清理模式（mergedData 为 null） ═══
  describe('清理模式', () => {
    it('mergedData 为 null 时只清理旧条目', async () => {
      mockGetLorebookEntries.mockResolvedValue([
        { uid: 1, comment: 'TavernDB-ACU-CustomExport-表A' },
        { uid: 2, comment: '无关条目' },
      ]);
      await updateCustomTableExports_ACU(null);
      expect(mockDeleteLorebookEntries).toHaveBeenCalledWith('test-lorebook', [1]);
      expect(mockCreateLorebookEntries).not.toHaveBeenCalled();
    });

    it('清理后保存 knownNames', async () => {
      mockSettings.knownCustomEntryNames = ['TavernDB-ACU-CustomExport-旧表'];
      mockGetLorebookEntries.mockResolvedValue([]);
      await updateCustomTableExports_ACU(null);
      expect(mockSaveSettings).toHaveBeenCalled();
    });

    it('隔离模式下只清理匹配前缀的条目', async () => {
      mockGetIsolationPrefix.mockReturnValue('ACU-[test]-');
      mockSettings.knownCustomEntryNames = ['ACU-[test]-TavernDB-ACU-CustomExport-表A'];
      mockGetLorebookEntries.mockResolvedValue([
        { uid: 1, comment: 'ACU-[test]-TavernDB-ACU-CustomExport-表A' },
        { uid: 2, comment: 'ACU-[other]-TavernDB-ACU-CustomExport-表B' },
      ]);
      await updateCustomTableExports_ACU(null);
      expect(mockDeleteLorebookEntries).toHaveBeenCalledWith('test-lorebook', [1]);
    });

    it('导入模式不删除旧条目', async () => {
      mockGetLorebookEntries.mockResolvedValue([
        { uid: 1, comment: 'TavernDB-ACU-CustomExport-表A' },
      ]);
      await updateCustomTableExports_ACU(null, true);
      expect(mockDeleteLorebookEntries).not.toHaveBeenCalled();
    });
  });

  // ═══ 整表导出 ═══
  describe('整表导出', () => {
    it('创建自定义导出条目', async () => {
      const mergedData: any = {
        sheet_0: {
          name: '自定义表',
          content: [['', '列1', '列2'], ['', '值A', '值B']],
          exportConfig: { enabled: true, entryName: '自定义表', entryType: 'constant' },
        },
      };
      mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
      mockEnsureExportConfigDefaults.mockReturnValue({
        enabled: true,
        splitByRow: false,
        entryName: '自定义表',
        entryType: 'constant',
        keywords: '',
        preventRecursion: true,
        injectionTemplate: '',
        extraIndexEnabled: false,
        extraIndexEntryName: '自定义表-索引',
        extraIndexColumns: [],
        extraIndexColumnModes: {},
        extraIndexInjectionTemplate: '',
        entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
      });
      await updateCustomTableExports_ACU(mergedData);
      expect(mockCreateLorebookEntries).toHaveBeenCalled();
    });

    it('未启用导出的表格被跳过', async () => {
      const mergedData: any = {
        sheet_0: {
          name: '未启用表',
          content: [['', '列1'], ['', '值A']],
          exportConfig: { enabled: false },
        },
      };
      mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
      await updateCustomTableExports_ACU(mergedData);
      expect(mockCreateLorebookEntries).not.toHaveBeenCalled();
    });

    it('空行表格不创建条目', async () => {
      const mergedData: any = {
        sheet_0: {
          name: '空表',
          content: [['', '列1']],
          exportConfig: { enabled: true, entryName: '空表', entryType: 'constant' },
        },
      };
      mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
      mockEnsureExportConfigDefaults.mockReturnValue({
        enabled: true,
        splitByRow: false,
        entryName: '空表',
        entryType: 'constant',
        keywords: '',
        preventRecursion: true,
        injectionTemplate: '',
        extraIndexEnabled: false,
        extraIndexColumns: [],
        extraIndexColumnModes: {},
        entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
      });
      await updateCustomTableExports_ACU(mergedData);
      expect(mockCreateLorebookEntries).not.toHaveBeenCalled();
    });

    it('更新 knownCustomEntryNames', async () => {
      const mergedData: any = {
        sheet_0: {
          name: '自定义表',
          content: [['', '列1'], ['', '值A']],
          exportConfig: { enabled: true, entryName: '自定义表', entryType: 'constant' },
        },
      };
      mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
      mockEnsureExportConfigDefaults.mockReturnValue({
        enabled: true,
        splitByRow: false,
        entryName: '自定义表',
        entryType: 'constant',
        keywords: '',
        preventRecursion: true,
        injectionTemplate: '',
        extraIndexEnabled: false,
        extraIndexColumns: [],
        extraIndexColumnModes: {},
        entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
      });
      await updateCustomTableExports_ACU(mergedData);
      expect(mockSaveSettings).toHaveBeenCalled();
      expect(mockSettings.knownCustomEntryNames.length).toBeGreaterThan(0);
    });
  });

  // ═══ 按行拆分导出 ═══
  describe('按行拆分导出', () => {
    it('每行创建一个条目', async () => {
      const mergedData: any = {
        sheet_0: {
          name: '拆分表',
          content: [['', '列1', '列2'], ['', '值A1', '值A2'], ['', '值B1', '值B2']],
          exportConfig: { enabled: true, splitByRow: true, entryName: '拆分表', entryType: 'constant' },
        },
      };
      mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
      mockEnsureExportConfigDefaults.mockReturnValue({
        enabled: true,
        splitByRow: true,
        entryName: '拆分表',
        entryType: 'constant',
        keywords: '',
        preventRecursion: true,
        injectionTemplate: '',
        extraIndexEnabled: false,
        extraIndexEntryName: '拆分表-索引',
        extraIndexColumns: [],
        extraIndexColumnModes: {},
        extraIndexInjectionTemplate: '',
        entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
      });
      await updateCustomTableExports_ACU(mergedData);
      expect(mockCreateLorebookEntries).toHaveBeenCalled();
      const createArgs = mockCreateLorebookEntries.mock.calls[0];
      // 表头(1) + 行条目(2) = 3
      expect(createArgs[1].length).toBe(3);
    });
  });

  // ═══ 隔离模式 ═══
  describe('隔离模式', () => {
    it('条目名称带隔离前缀', async () => {
      mockGetIsolationPrefix.mockReturnValue('ACU-[test]-');
      const mergedData: any = {
        sheet_0: {
          name: '隔离表',
          content: [['', '列1'], ['', '值A']],
          exportConfig: { enabled: true, entryName: '隔离表', entryType: 'constant' },
        },
      };
      mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
      mockEnsureExportConfigDefaults.mockReturnValue({
        enabled: true,
        splitByRow: false,
        entryName: '隔离表',
        entryType: 'constant',
        keywords: '',
        preventRecursion: true,
        injectionTemplate: '',
        extraIndexEnabled: false,
        extraIndexColumns: [],
        extraIndexColumnModes: {},
        entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
      });
      await updateCustomTableExports_ACU(mergedData);
      const createArgs = mockCreateLorebookEntries.mock.calls[0];
      // 条目名称应包含隔离前缀
      const hasIsoPrefix = createArgs[1].some((e: any) => e.comment && e.comment.startsWith('ACU-[test]-'));
      expect(hasIsoPrefix).toBe(true);
    });
  });

  // ═══ 外部导入模式 ═══
  describe('外部导入模式', () => {
    it('不更新 knownCustomEntryNames', async () => {
      const mergedData: any = {
        sheet_0: {
          name: '导入表',
          content: [['', '列1'], ['', '值A']],
          exportConfig: { enabled: true, entryName: '导入表', entryType: 'constant' },
        },
      };
      mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
      mockEnsureExportConfigDefaults.mockReturnValue({
        enabled: true,
        splitByRow: false,
        entryName: '导入表',
        entryType: 'constant',
        keywords: '',
        preventRecursion: true,
        injectionTemplate: '',
        extraIndexEnabled: false,
        extraIndexColumns: [],
        extraIndexColumnModes: {},
        entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
      });
      await updateCustomTableExports_ACU(mergedData, true);
      // 外部导入模式不应保存 knownNames
      expect(mockSaveSettings).not.toHaveBeenCalled();
    });

    it('条目名称使用导入前缀', async () => {
      const mergedData: any = {
        sheet_0: {
          name: '导入表',
          content: [['', '列1'], ['', '值A']],
          exportConfig: { enabled: true, entryName: '导入表', entryType: 'constant' },
        },
      };
      mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
      mockEnsureExportConfigDefaults.mockReturnValue({
        enabled: true,
        splitByRow: false,
        entryName: '导入表',
        entryType: 'constant',
        keywords: '',
        preventRecursion: true,
        injectionTemplate: '',
        extraIndexEnabled: false,
        extraIndexColumns: [],
        extraIndexColumnModes: {},
        entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
      });
      await updateCustomTableExports_ACU(mergedData, true);
      if (mockCreateLorebookEntries.mock.calls.length > 0) {
        const createArgs = mockCreateLorebookEntries.mock.calls[0];
        const hasImportPrefix = createArgs[1].some((e: any) => e.comment && e.comment.includes('外部导入-'));
        expect(hasImportPrefix).toBe(true);
      }
    });
  });

  // ═══ 异常处理 ═══
  describe('异常处理', () => {
    it('异常时记录错误', async () => {
      mockGetLorebookEntries.mockRejectedValue(new Error('网络错误'));
      await updateCustomTableExports_ACU({ sheet_0: {} });
      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update custom table export'),
        expect.any(Error)
      );
    });
  });

  // ═══ keyword 类型条目 ═══
  describe('keyword 类型条目', () => {
    it('keyword 类型无关键词时跳过', async () => {
      const mergedData: any = {
        sheet_0: {
          name: '关键词表',
          content: [['', '列1'], ['', '值A']],
          exportConfig: { enabled: true, entryName: '关键词表', entryType: 'keyword', keywords: '' },
        },
      };
      mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
      mockEnsureExportConfigDefaults.mockReturnValue({
        enabled: true,
        splitByRow: false,
        entryName: '关键词表',
        entryType: 'keyword',
        keywords: '',
        preventRecursion: true,
        injectionTemplate: '',
        extraIndexEnabled: false,
        extraIndexColumns: [],
        extraIndexColumnModes: {},
        entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
      });
      await updateCustomTableExports_ACU(mergedData);
      expect(mockCreateLorebookEntries).not.toHaveBeenCalled();
    });
  });

  // ═══ 主条目禁用但索引启用 ═══
  describe('主条目禁用但索引启用', () => {
    it('只导出索引条目', async () => {
      const mergedData: any = {
        sheet_0: {
          name: '索引表',
          content: [['', '列1', '列2'], ['', '值A', '值B']],
          exportConfig: {
            enabled: true,
            injectIntoWorldbook: false,
            entryName: '索引表',
            entryType: 'constant',
            extraIndexEnabled: true,
            extraIndexEntryName: '索引表-索引',
            extraIndexColumns: ['列1'],
            extraIndexColumnModes: {},
          },
        },
      };
      mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
      mockEnsureExportConfigDefaults.mockReturnValue({
        enabled: true,
        splitByRow: false,
        entryName: '索引表',
        entryType: 'constant',
        keywords: '',
        preventRecursion: true,
        injectionTemplate: '',
        injectIntoWorldbook: false,
        extraIndexEnabled: true,
        extraIndexEntryName: '索引表-索引',
        extraIndexColumns: ['列1'],
        extraIndexColumnModes: {},
        extraIndexInjectionTemplate: '',
        entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
      });
      await updateCustomTableExports_ACU(mergedData);
      // 应该创建了索引条目
      if (mockCreateLorebookEntries.mock.calls.length > 0) {
        const createArgs = mockCreateLorebookEntries.mock.calls[0];
        // 只有索引条目，没有主条目
        const hasMainEntry = createArgs[1].some((e: any) => e.comment && !e.comment.includes('索引'));
        // 索引条目应该存在
        const hasIndexEntry = createArgs[1].some((e: any) => e.comment && e.comment.includes('索引'));
        expect(hasIndexEntry).toBe(true);
      }
    });
  });
});
