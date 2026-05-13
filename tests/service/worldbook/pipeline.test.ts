
/**
 * tests/service/worldbook/pipeline.test.ts
 * 世界书数据管线 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══ hoisted mocks ═══
const {
  mockSettings, mockCurrentJsonTableData, mockAllChatMessages,
  mockCoreApisAreReady, mockCurrentChatFileIdentifier,
  mockGetCurrentIsolationKey,
  mockSetCurrentJsonTableData, mockSetAllChatMessages,
  mockGetCurrentWorldbookConfig,
  mockIsWorldbookApiAvailable,
  mockGwGetLorebookEntries, mockGwSetLorebookEntries,
  mockGwCreateLorebookEntries, mockGwDeleteLorebookEntries,
  mockListLorebooks, mockGwGetWorldBooks,
  mockGetCharLorebooks, mockGetChatMessages, mockGetChatLength,
  mockSaveSettings,
  mockGetSortedSheetKeys, mockMaterializeDataFromSheetGuide,
  mockReorderDataBySheetKeys, mockGetChatSheetGuideDataForIsolationKey,
  mockGetImportBatchPrefix, mockGetImportStablePrefix,
  mockLogDebug, mockLogError, mockLogWarn,
  mockParseTableTemplateJson, mockIsEntryBlocked,
    mockFormatJsonToReadable, mockGetReadableContentStartColumn,
    mockHasReadableRowCellData, mockMaybeLiftWorldbookSuppression,
    mockMergeAllIndependentTables, mockShouldSuppressWorldbookInjection,
    mockIsSqliteMode, mockReloadStorageProvider, mockGetStorageProvider,
    mockAllocConsecutiveOrderBlock, mockApplyPlacementToEntry,
mockBuildDefaultGlobalInjectionConfig, mockBuildUsedOrderSet,
  mockEnsureExportConfigDefaults, mockEnsureGlobalInjectionConfigDefaults,
  mockGetEntryOrderNumber, mockGetFixedPlacementDefaultsForTable,
  mockGetInjectionTargetLorebook, mockGetIsolationPrefix,
  mockIsEntryPlacementMatched, mockNormalizeLorebookPosition,
  mockNormalizePlacementConfig,
  mockUpdateCustomTableExports, mockUpdateImportantPersonsRelatedEntries,
  mockUpdateOutlineTableEntry, mockUpdateSummaryTableEntries,
} = vi.hoisted(() => {
  const mockSettings: any = {
    dataIsolationEnabled: false,
    dataIsolationCode: '',
    knownCustomEntryNames: [],
  };
  return {
    mockSettings,
    mockCurrentJsonTableData: { value: null as any },
    mockAllChatMessages: { value: [] as any[] },
    mockCoreApisAreReady: { value: true },
    mockCurrentChatFileIdentifier: { value: 'test-chat' },
    mockGetCurrentIsolationKey: vi.fn(() => ''),
    mockSetCurrentJsonTableData: vi.fn(),
    mockSetAllChatMessages: vi.fn(),
    mockGetCurrentWorldbookConfig: vi.fn(() => ({
      source: 'character',
      injectionTarget: 'character',
      manualSelection: [],
      enabledEntries: {},
      zeroTkOccupyMode: false,
    })),
    mockIsWorldbookApiAvailable: vi.fn(() => true),
    mockGwGetLorebookEntries: vi.fn(async () => []),
    mockGwSetLorebookEntries: vi.fn(async () => {}),
    mockGwCreateLorebookEntries: vi.fn(async () => {}),
    mockGwDeleteLorebookEntries: vi.fn(async () => {}),
    mockListLorebooks: vi.fn(async () => []),
    mockGwGetWorldBooks: vi.fn(async () => []),
    mockGetCharLorebooks: vi.fn(async () => ({ primary: null, additional: [] })),
    mockGetChatMessages: vi.fn(async () => []),
    mockGetChatLength: vi.fn(() => 0),
    mockSaveSettings: vi.fn(),
    mockGetSortedSheetKeys: vi.fn(() => []),
    mockMaterializeDataFromSheetGuide: vi.fn(() => null),
    mockReorderDataBySheetKeys: vi.fn((data: any) => data),
    mockGetChatSheetGuideDataForIsolationKey: vi.fn(() => null),
    mockGetImportBatchPrefix: vi.fn(() => '外部导入-'),
    mockGetImportStablePrefix: vi.fn(() => '外部导入-'),
    mockLogDebug: vi.fn(),
    mockLogError: vi.fn(),
    mockLogWarn: vi.fn(),
    mockParseTableTemplateJson: vi.fn(() => null),
    mockIsEntryBlocked: vi.fn(() => false),
    mockFormatJsonToReadable: vi.fn(() => ({
      readableText: '测试可读文本',
      importantPersonsTable: null,
      summaryTable: null,
      outlineTable: null,
    })),
    mockGetReadableContentStartColumn: vi.fn((headerRow: any) => {
      if (!Array.isArray(headerRow) || headerRow.length === 0) return 0;
      return String(headerRow[0] ?? '').trim().toLowerCase() === 'row_id' ? 1 : 0;
    }),
    mockHasReadableRowCellData: vi.fn((row: any, startColumn: number) => {
      if (!Array.isArray(row)) return false;
      for (let c = Math.max(0, startColumn); c < row.length; c++) {
        const cell = row[c];
        if (cell === null || cell === undefined) continue;
        if (typeof cell === 'string') {
          if (cell.trim() !== '') return true;
        } else if (typeof cell === 'number') {
          if (!Number.isNaN(cell)) return true;
        } else if (typeof cell === 'boolean') {
          return true;
        } else {
          return true;
        }
      }
      return false;
    }),
    mockMaybeLiftWorldbookSuppression: vi.fn(),
    mockMergeAllIndependentTables: vi.fn(async () => null),
    mockShouldSuppressWorldbookInjection: vi.fn(() => false),
    mockIsSqliteMode: vi.fn(() => false),
    mockReloadStorageProvider: vi.fn(async () => {}),
    mockGetStorageProvider: vi.fn(() => ({
      getCurrentData: vi.fn(() => mockCurrentJsonTableData.value),
    })),
    mockAllocConsecutiveOrderBlock: vi.fn(() => 100),
    mockApplyPlacementToEntry: vi.fn((entry: any, placement: any) => ({ ...entry, ...placement })),
    mockBuildDefaultGlobalInjectionConfig: vi.fn(() => ({
      readableEntryPlacement: { position: 'before_character_definition', depth: 2, order: 99981 },
      wrapperPlacement: { position: 'before_character_definition', depth: 2, order: 99980 },
    })),
    mockBuildUsedOrderSet: vi.fn(() => new Set<number>()),
    mockEnsureExportConfigDefaults: vi.fn((cfg: any) => ({
      enabled: false,
      splitByRow: false,
      entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
      fixedEntryPlacement: { position: 'at_depth_as_system', depth: 2, order: 99990 },
      fixedIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 99991 },
      ...cfg,
    })),
    mockEnsureGlobalInjectionConfigDefaults: vi.fn((cfg: any) => ({
      readableEntryPlacement: { position: 'before_character_definition', depth: 2, order: 99981 },
      wrapperPlacement: { position: 'before_character_definition', depth: 2, order: 99980 },
      ...cfg,
    })),
    mockGetEntryOrderNumber: vi.fn((entry: any) => entry?.order ?? null),
    mockGetFixedPlacementDefaultsForTable: vi.fn(() => ({
      entry: { position: 'at_depth_as_system', depth: 2, order: 99990 },
      index: { position: 'at_depth_as_system', depth: 2, order: 99991 },
    })),
    mockGetInjectionTargetLorebook: vi.fn(async () => 'test-lorebook'),
    mockGetIsolationPrefix: vi.fn(() => ''),
    mockIsEntryPlacementMatched: vi.fn(() => true),
    mockNormalizeLorebookPosition: vi.fn((pos: any) => pos || 'at_depth_as_system'),
    mockNormalizePlacementConfig: vi.fn((raw: any, fallback: any) => raw || fallback || { position: 'at_depth_as_system', depth: 2, order: 10000 }),
    mockUpdateCustomTableExports: vi.fn(async () => {}),
    mockUpdateImportantPersonsRelatedEntries: vi.fn(async () => {}),
    mockUpdateOutlineTableEntry: vi.fn(async () => {}),
    mockUpdateSummaryTableEntries: vi.fn(async () => {}),
  };
});

// ═══ vi.mock ═══
vi.mock('../../../src/service/settings/settings-readers', () => ({
  getCurrentWorldbookConfig_ACU: mockGetCurrentWorldbookConfig,
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  get settings_ACU() { return mockSettings; },
  get currentJsonTableData_ACU() { return mockCurrentJsonTableData.value; },
  get allChatMessages_ACU() { return mockAllChatMessages.value; },
  get coreApisAreReady_ACU() { return mockCoreApisAreReady.value; },
  get currentChatFileIdentifier_ACU() { return mockCurrentChatFileIdentifier.value; },
  getCurrentIsolationKey_ACU: mockGetCurrentIsolationKey,
  _set_currentJsonTableData_ACU: mockSetCurrentJsonTableData,
  _set_allChatMessages_ACU: mockSetAllChatMessages,
}));

vi.mock('../../../src/data/gateways/worldbook-gateway', () => ({
  isWorldbookApiAvailable_ACU: mockIsWorldbookApiAvailable,
  getLorebookEntries_ACU: mockGwGetLorebookEntries,
  setLorebookEntries_ACU: mockGwSetLorebookEntries,
  createLorebookEntries_ACU: mockGwCreateLorebookEntries,
  deleteLorebookEntries_ACU: mockGwDeleteLorebookEntries,
  listLorebooks_ACU: mockListLorebooks,
  getWorldBooks_ACU: mockGwGetWorldBooks,
}));

vi.mock('../../../src/data/gateways/character-gateway', () => ({
  getCharLorebooks_ACU: mockGetCharLorebooks,
  getChatMessages_ACU: mockGetChatMessages,
}));

vi.mock('../../../src/data/gateways/chat-gateway', () => ({
  getChatLength_ACU: mockGetChatLength,
}));

vi.mock('../../../src/service/settings/settings-service', () => ({
  saveSettings_ACU: mockSaveSettings,
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  getSortedSheetKeys_ACU: mockGetSortedSheetKeys,
  materializeDataFromSheetGuide_ACU: mockMaterializeDataFromSheetGuide,
  reorderDataBySheetKeys_ACU: mockReorderDataBySheetKeys,
  getChatSheetGuideDataForIsolationKey_ACU: mockGetChatSheetGuideDataForIsolationKey,
}));

vi.mock('../../../src/shared/constants', () => ({
  getImportBatchPrefix_ACU: mockGetImportBatchPrefix,
  getImportStablePrefix_ACU: mockGetImportStablePrefix,
}));

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: mockLogDebug,
  logError_ACU: mockLogError,
  logWarn_ACU: mockLogWarn,
  parseTableTemplateJson_ACU: mockParseTableTemplateJson,
  isEntryBlocked_ACU: mockIsEntryBlocked,
}));

vi.mock('../../../src/service/runtime/helpers-remaining', () => ({
  formatJsonToReadable_ACU: mockFormatJsonToReadable,
  getReadableContentStartColumn_ACU: mockGetReadableContentStartColumn,
  hasReadableRowCellData_ACU: mockHasReadableRowCellData,
  maybeLiftWorldbookSuppression_ACU: mockMaybeLiftWorldbookSuppression,
  mergeAllIndependentTables_ACU: mockMergeAllIndependentTables,
  shouldSuppressWorldbookInjection_ACU: mockShouldSuppressWorldbookInjection,
}));

vi.mock('../../../src/service/table/storage-mode', () => ({
  isSqliteMode: mockIsSqliteMode,
}));

vi.mock('../../../src/service/table/table-storage-strategy', () => ({
  reloadStorageProvider: mockReloadStorageProvider,
  getStorageProvider: mockGetStorageProvider,
}));

vi.mock('../../../src/service/worldbook/injection-engine', () => ({
  allocConsecutiveOrderBlock_ACU: mockAllocConsecutiveOrderBlock,
  applyPlacementToEntry_ACU: mockApplyPlacementToEntry,
  buildDefaultGlobalInjectionConfig_ACU: mockBuildDefaultGlobalInjectionConfig,
  buildUsedOrderSet_ACU: mockBuildUsedOrderSet,
  ensureExportConfigDefaults_ACU: mockEnsureExportConfigDefaults,
  ensureGlobalInjectionConfigDefaults_ACU: mockEnsureGlobalInjectionConfigDefaults,
  getEntryOrderNumber_ACU: mockGetEntryOrderNumber,
  getFixedPlacementDefaultsForTable_ACU: mockGetFixedPlacementDefaultsForTable,
  getInjectionTargetLorebook_ACU: mockGetInjectionTargetLorebook,
  getIsolationPrefix_ACU: mockGetIsolationPrefix,
  isEntryPlacementMatched_ACU: mockIsEntryPlacementMatched,
  normalizeLorebookPosition_ACU: mockNormalizeLorebookPosition,
  normalizePlacementConfig_ACU: mockNormalizePlacementConfig,
  updateCustomTableExports_ACU: mockUpdateCustomTableExports,
  updateImportantPersonsRelatedEntries_ACU: mockUpdateImportantPersonsRelatedEntries,
  updateOutlineTableEntry_ACU: mockUpdateOutlineTableEntry,
  updateSummaryTableEntries_ACU: mockUpdateSummaryTableEntries,
}));

import {
  isImportTaggedLorebookEntry_ACU,
  getWorldbookCommentInfo_ACU,
  getWorldbookEntryKeywords_ACU,
  getWorldbookEntryPlaceholderSortKey_ACU,
  compareWorldbookEntriesForPlaceholder_ACU,
  getWorldbookNames_ACU,
  getLorebookEntriesByNames_ACU,
  getWorldBooks_ACU,
  loadAllChatMessages_ACU,
  deleteAllGeneratedEntries_ACU,
  refreshMergedDataAndNotify_ACU,
  buildCombinedWorldbookContentByStrategy_ACU,
  getCombinedWorldbookContent_ACU,
  updateReadableLorebookEntry_ACU,
} from '../../../src/service/worldbook/pipeline';

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.dataIsolationEnabled = false;
  mockSettings.dataIsolationCode = '';
  mockSettings.knownCustomEntryNames = [];
  mockCurrentJsonTableData.value = null;
  mockAllChatMessages.value = [];
  mockCoreApisAreReady.value = true;
  mockCurrentChatFileIdentifier.value = 'test-chat';
  mockIsWorldbookApiAvailable.mockReturnValue(true);
  mockGetInjectionTargetLorebook.mockResolvedValue('test-lorebook');
  mockGetIsolationPrefix.mockReturnValue('');
  mockShouldSuppressWorldbookInjection.mockReturnValue(false);
  mockGwGetLorebookEntries.mockResolvedValue([]);
  mockListLorebooks.mockResolvedValue([]);
  mockGetCharLorebooks.mockResolvedValue({ primary: null, additional: [] });
  mockGetImportStablePrefix.mockReturnValue('外部导入-');
  mockGetImportBatchPrefix.mockReturnValue('外部导入-');
});

// ═══════════════════════════════════════════════════
// 纯函数测试
// ═══════════════════════════════════════════════════

describe('isImportTaggedLorebookEntry_ACU', () => {
  it('识别外部导入标记的条目', () => {
    mockGetImportStablePrefix.mockReturnValue('外部导入-');
    expect(isImportTaggedLorebookEntry_ACU({ comment: '外部导入-表格A' })).toBe(true);
  });

  it('识别带隔离前缀的外部导入条目', () => {
    mockGetImportStablePrefix.mockReturnValue('外部导入-');
    expect(isImportTaggedLorebookEntry_ACU({ comment: 'ACU-[test]-外部导入-表格A' })).toBe(true);
  });

  it('非导入条目返回 false', () => {
    mockGetImportStablePrefix.mockReturnValue('外部导入-');
    expect(isImportTaggedLorebookEntry_ACU({ comment: 'TavernDB-ACU-ReadableDataTable' })).toBe(false);
  });

  it('空 comment 返回 false', () => {
    expect(isImportTaggedLorebookEntry_ACU({ comment: '' })).toBe(false);
    expect(isImportTaggedLorebookEntry_ACU({})).toBe(false);
  });

  it('使用 name 字段作为后备', () => {
    mockGetImportStablePrefix.mockReturnValue('外部导入-');
    expect(isImportTaggedLorebookEntry_ACU({ name: '外部导入-表格B' })).toBe(true);
  });
});

describe('getWorldbookCommentInfo_ACU', () => {
  it('返回原始和规范化的 comment', () => {
    const result = getWorldbookCommentInfo_ACU({ comment: '测试条目' });
    expect(result.rawComment).toBe('测试条目');
    expect(result.normalizedComment).toBe('测试条目');
  });

  it('去除隔离前缀', () => {
    const result = getWorldbookCommentInfo_ACU({ comment: 'ACU-[test]-外部导入-batch1-内容' });
    expect(result.rawComment).toBe('ACU-[test]-外部导入-batch1-内容');
    expect(result.normalizedComment).toBe('内容');
  });

  it('空 comment 使用 name 字段', () => {
    const result = getWorldbookCommentInfo_ACU({ name: '备用名称' });
    expect(result.rawComment).toBe('备用名称');
  });

  it('空对象返回空字符串', () => {
    const result = getWorldbookCommentInfo_ACU({});
    expect(result.rawComment).toBe('');
    expect(result.normalizedComment).toBe('');
  });
});

describe('getWorldbookEntryKeywords_ACU', () => {
  it('从 key 数组提取关键词', () => {
    const result = getWorldbookEntryKeywords_ACU({ key: ['Hello', 'World'] });
    expect(result).toEqual(['hello', 'world']);
  });

  it('从 keys 数组提取关键词', () => {
    const result = getWorldbookEntryKeywords_ACU({ keys: ['Test'] });
    expect(result).toEqual(['test']);
  });

  it('合并 key 和 keys 并去重', () => {
    const result = getWorldbookEntryKeywords_ACU({ key: ['a', 'b'], keys: ['b', 'c'] });
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('字符串类型的 key 转为数组', () => {
    const result = getWorldbookEntryKeywords_ACU({ key: 'single' });
    expect(result).toEqual(['single']);
  });

  it('空输入返回空数组', () => {
    expect(getWorldbookEntryKeywords_ACU({})).toEqual([]);
    expect(getWorldbookEntryKeywords_ACU({ key: [] })).toEqual([]);
  });

  it('过滤空字符串和空白', () => {
    const result = getWorldbookEntryKeywords_ACU({ key: ['valid', '', '  '] });
    expect(result).toEqual(['valid']);
  });
});

describe('getWorldbookEntryPlaceholderSortKey_ACU', () => {
  beforeEach(() => {
    mockNormalizeLorebookPosition.mockImplementation((pos: any) => {
      if (pos === 'before_character_definition' || pos === '0') return 'before_character_definition';
      if (pos === 'after_character_definition' || pos === '1') return 'after_character_definition';
      return 'at_depth_as_system';
    });
    mockGetEntryOrderNumber.mockImplementation((entry: any) => {
      const v = entry?.order;
      const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
      return Number.isFinite(n) ? n : null;
    });
  });

  it('before_character_definition 排在 segment 0', () => {
    const key = getWorldbookEntryPlaceholderSortKey_ACU({ position: 'before_character_definition', order: 5 });
    expect(key.segment).toBe(0);
    expect(key.order).toBe(5);
  });

  it('after_character_definition 排在 segment 1', () => {
    const key = getWorldbookEntryPlaceholderSortKey_ACU({ position: 'after_character_definition', order: 10 });
    expect(key.segment).toBe(1);
  });

  it('at_depth_as_system 排在 segment 2，depthRank 为负 depth', () => {
    const key = getWorldbookEntryPlaceholderSortKey_ACU({ position: 'at_depth_as_system', depth: 5, order: 100 });
    expect(key.segment).toBe(2);
    expect(key.depthRank).toBe(-5);
    expect(key.order).toBe(100);
  });

  it('无 order 时使用 MAX_SAFE_INTEGER', () => {
    const key = getWorldbookEntryPlaceholderSortKey_ACU({ position: 'at_depth_as_system' });
    expect(key.order).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('compareWorldbookEntriesForPlaceholder_ACU', () => {
  beforeEach(() => {
    mockNormalizeLorebookPosition.mockImplementation((pos: any) => {
      if (pos === 'before_character_definition') return 'before_character_definition';
      if (pos === 'after_character_definition') return 'after_character_definition';
      return 'at_depth_as_system';
    });
    mockGetEntryOrderNumber.mockImplementation((entry: any) => {
      const v = entry?.order;
      const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
      return Number.isFinite(n) ? n : null;
    });
  });

  it('不同 segment 按 segment 排序', () => {
    const a = { position: 'before_character_definition', order: 1 };
    const b = { position: 'at_depth_as_system', depth: 2, order: 1 };
    expect(compareWorldbookEntriesForPlaceholder_ACU(a, b)).toBeLessThan(0);
  });

  it('同 segment 按 depthRank 排序', () => {
    const a = { position: 'at_depth_as_system', depth: 10, order: 1 };
    const b = { position: 'at_depth_as_system', depth: 5, order: 1 };
    expect(compareWorldbookEntriesForPlaceholder_ACU(a, b)).toBeLessThan(0);
  });

  it('同 segment 同 depth 按 order 排序', () => {
    const a = { position: 'at_depth_as_system', depth: 2, order: 5 };
    const b = { position: 'at_depth_as_system', depth: 2, order: 10 };
    expect(compareWorldbookEntriesForPlaceholder_ACU(a, b)).toBeLessThan(0);
  });

  it('完全相同时按 _acuPlaceholderOriginalIndex 排序', () => {
    const a = { position: 'at_depth_as_system', depth: 2, order: 5, _acuPlaceholderOriginalIndex: 0 };
    const b = { position: 'at_depth_as_system', depth: 2, order: 5, _acuPlaceholderOriginalIndex: 1 };
    expect(compareWorldbookEntriesForPlaceholder_ACU(a, b)).toBeLessThan(0);
  });

  it('相同条件按 bookName 排序', () => {
    const a = { position: 'at_depth_as_system', depth: 2, order: 5, _acuPlaceholderOriginalIndex: 0, bookName: 'A书' };
    const b = { position: 'at_depth_as_system', depth: 2, order: 5, _acuPlaceholderOriginalIndex: 0, bookName: 'B书' };
    expect(compareWorldbookEntriesForPlaceholder_ACU(a, b)).toBeLessThan(0);
  });
});

// ═══════════════════════════════════════════════════
// 异步函数测试
// ═══════════════════════════════════════════════════

describe('getWorldbookNames_ACU', () => {
  it('返回世界书名称列表', async () => {
    mockListLorebooks.mockResolvedValue(['书A', '书B']);
    const result = await getWorldbookNames_ACU();
    expect(result).toEqual(['书A', '书B']);
  });

  it('过滤空名称', async () => {
    mockListLorebooks.mockResolvedValue(['书A', '', null, '书B']);
    const result = await getWorldbookNames_ACU();
    expect(result).toEqual(['书A', '书B']);
  });

  it('处理对象格式的名称', async () => {
    mockListLorebooks.mockResolvedValue([{ name: '书A' }, { name: '书B' }]);
    const result = await getWorldbookNames_ACU();
    expect(result).toEqual(['书A', '书B']);
  });

  it('空列表返回空数组', async () => {
    mockListLorebooks.mockResolvedValue([]);
    const result = await getWorldbookNames_ACU();
    expect(result).toEqual([]);
  });

  it('null 返回空数组', async () => {
    mockListLorebooks.mockResolvedValue(null);
    const result = await getWorldbookNames_ACU();
    expect(result).toEqual([]);
  });
});

describe('getLorebookEntriesByNames_ACU', () => {
  it('按名称获取条目并标记 book', async () => {
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: '条目1' },
    ]);
    const result = await getLorebookEntriesByNames_ACU(['书A']);
    expect(result['书A']).toHaveLength(1);
    expect(result['书A'][0].book).toBe('书A');
  });

  it('去重名称', async () => {
    mockGwGetLorebookEntries.mockResolvedValue([]);
    await getLorebookEntriesByNames_ACU(['书A', '书A', '书B']);
    // 应该只调用 2 次（去重后）
    expect(mockGwGetLorebookEntries).toHaveBeenCalledTimes(2);
  });

  it('获取失败时返回空数组', async () => {
    mockGwGetLorebookEntries.mockRejectedValue(new Error('网络错误'));
    const result = await getLorebookEntriesByNames_ACU(['书A']);
    expect(result['书A']).toEqual([]);
  });

  it('空输入返回空对象', async () => {
    const result = await getLorebookEntriesByNames_ACU([]);
    expect(result).toEqual({});
  });

  it('API 不可用时使用 fallback', async () => {
    mockIsWorldbookApiAvailable.mockReturnValue(false);
    mockGwGetWorldBooks.mockResolvedValue([
      { name: '书A', entries: [{ uid: 1, comment: '条目1' }] },
    ]);
    const result = await getLorebookEntriesByNames_ACU(['书A']);
    expect(result['书A']).toHaveLength(1);
  });
});

describe('getWorldBooks_ACU', () => {
  it('返回世界书列表及其条目', async () => {
    mockListLorebooks.mockResolvedValue(['书A']);
    mockGwGetLorebookEntries.mockResolvedValue([{ uid: 1, comment: '条目1' }]);
    const result = await getWorldBooks_ACU();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('书A');
    expect(result[0].entries).toHaveLength(1);
  });

  it('无世界书时返回空数组', async () => {
    mockListLorebooks.mockResolvedValue([]);
    const result = await getWorldBooks_ACU();
    expect(result).toEqual([]);
  });
});

describe('loadAllChatMessages_ACU', () => {
  it('加载聊天消息', async () => {
    mockGetChatLength.mockReturnValue(3);
    mockGetChatMessages.mockResolvedValue([
      { message: '消息1' },
      { message: '消息2' },
      { message: '消息3' },
    ]);
    await loadAllChatMessages_ACU();
    expect(mockSetAllChatMessages).toHaveBeenCalled();
    const callArg = mockSetAllChatMessages.mock.calls[0][0];
    expect(callArg).toHaveLength(3);
  });

  it('API 未就绪时不加载', async () => {
    mockCoreApisAreReady.value = false;
    await loadAllChatMessages_ACU();
    expect(mockGetChatLength).not.toHaveBeenCalled();
  });

  it('世界书 API 不可用时不加载', async () => {
    mockIsWorldbookApiAvailable.mockReturnValue(false);
    await loadAllChatMessages_ACU();
    expect(mockGetChatLength).not.toHaveBeenCalled();
  });

  it('无消息时设为空数组', async () => {
    mockGetChatLength.mockReturnValue(0);
    await loadAllChatMessages_ACU();
    expect(mockSetAllChatMessages).toHaveBeenCalledWith([]);
  });

  it('获取失败时设为空数组', async () => {
    mockGetChatLength.mockReturnValue(5);
    mockGetChatMessages.mockRejectedValue(new Error('网络错误'));
    await loadAllChatMessages_ACU();
    expect(mockSetAllChatMessages).toHaveBeenCalledWith([]);
  });
});

describe('deleteAllGeneratedEntries_ACU', () => {
  it('删除匹配基础前缀的条目', async () => {
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: 'TavernDB-ACU-ReadableDataTable' },
      { uid: 2, comment: 'TavernDB-ACU-OutlineTable' },
      { uid: 3, comment: '无关条目' },
    ]);
    await deleteAllGeneratedEntries_ACU();
    expect(mockGwDeleteLorebookEntries).toHaveBeenCalledWith('test-lorebook', [1, 2]);
  });

  it('不删除外部导入条目', async () => {
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: '外部导入-表格A' },
      { uid: 2, comment: 'TavernDB-ACU-ReadableDataTable' },
    ]);
    await deleteAllGeneratedEntries_ACU();
    expect(mockGwDeleteLorebookEntries).toHaveBeenCalledWith('test-lorebook', [2]);
  });

  it('隔离模式下只删除匹配前缀的条目', async () => {
    mockSettings.dataIsolationEnabled = true;
    mockSettings.dataIsolationCode = 'test';
    mockGetIsolationPrefix.mockReturnValue('ACU-[test]-');
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: 'ACU-[test]-TavernDB-ACU-ReadableDataTable' },
      { uid: 2, comment: 'ACU-[other]-TavernDB-ACU-ReadableDataTable' },
      { uid: 3, comment: 'TavernDB-ACU-ReadableDataTable' },
    ]);
    await deleteAllGeneratedEntries_ACU();
    expect(mockGwDeleteLorebookEntries).toHaveBeenCalledWith('test-lorebook', [1]);
  });

  it('无 lorebook 时直接返回', async () => {
    mockGetInjectionTargetLorebook.mockResolvedValue(null);
    await deleteAllGeneratedEntries_ACU();
    expect(mockGwGetLorebookEntries).not.toHaveBeenCalled();
  });

  it('使用指定的 targetLorebook', async () => {
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: 'TavernDB-ACU-ReadableDataTable' },
    ]);
    await deleteAllGeneratedEntries_ACU('custom-lorebook');
    expect(mockGwGetLorebookEntries).toHaveBeenCalledWith('custom-lorebook');
    expect(mockGwDeleteLorebookEntries).toHaveBeenCalledWith('custom-lorebook', [1]);
  });

  it('删除后清理 knownCustomEntryNames', async () => {
    mockSettings.knownCustomEntryNames = ['TavernDB-ACU-CustomExport-表A', 'ACU-[iso]-条目B'];
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: 'TavernDB-ACU-ReadableDataTable' },
    ]);
    await deleteAllGeneratedEntries_ACU();
    // 非隔离模式下只保留带 ACU-[ 前缀的
    expect(mockSettings.knownCustomEntryNames).toEqual(['ACU-[iso]-条目B']);
  });

  it('非隔离模式下不删除 ACU-[ 开头的条目', async () => {
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: 'ACU-[test]-TavernDB-ACU-ReadableDataTable' },
    ]);
    await deleteAllGeneratedEntries_ACU();
    expect(mockGwDeleteLorebookEntries).not.toHaveBeenCalled();
  });
});

describe('refreshMergedDataAndNotify_ACU', () => {
  it('合并数据并更新世界书', async () => {
    const mergedData = {
      mate: { type: 'chatSheets', version: 1 },
      sheet_0: { name: '测试表', content: [['', '列1'], ['', '值1']] },
    };
    mockMergeAllIndependentTables.mockResolvedValue(mergedData);
    mockGetSortedSheetKeys.mockReturnValue(['sheet_0']);
    mockReorderDataBySheetKeys.mockReturnValue(mergedData);

    const result = await refreshMergedDataAndNotify_ACU();
    expect(mockSetCurrentJsonTableData).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('合并失败时使用指导表物化', async () => {
    mockMergeAllIndependentTables.mockResolvedValue(null);
    const guideData = { sheet_0: { name: '指导表' } };
    mockGetChatSheetGuideDataForIsolationKey.mockReturnValue(guideData);
    const materializedData = { sheet_0: { name: '物化数据' } };
    mockMaterializeDataFromSheetGuide.mockReturnValue(materializedData);

    await refreshMergedDataAndNotify_ACU();
    expect(mockMaterializeDataFromSheetGuide).toHaveBeenCalledWith(guideData, { includeSeedRows: false });
    expect(mockSetCurrentJsonTableData).toHaveBeenCalledWith(materializedData);
  });

  it('无指导表时使用模板结构', async () => {
    mockMergeAllIndependentTables.mockResolvedValue(null);
    mockGetChatSheetGuideDataForIsolationKey.mockReturnValue(null);
    const templateData = { mate: { type: 'chatSheets', version: 1 }, sheet_0: {} };
    mockParseTableTemplateJson.mockReturnValue(templateData);

    await refreshMergedDataAndNotify_ACU();
    expect(mockParseTableTemplateJson).toHaveBeenCalledWith({ stripSeedRows: true });
    expect(mockSetCurrentJsonTableData).toHaveBeenCalledWith(templateData);
  });

  it('模板也失败时设为最小空结构', async () => {
    mockMergeAllIndependentTables.mockResolvedValue(null);
    mockGetChatSheetGuideDataForIsolationKey.mockReturnValue(null);
    mockParseTableTemplateJson.mockReturnValue(null);

    await refreshMergedDataAndNotify_ACU();
    expect(mockSetCurrentJsonTableData).toHaveBeenCalledWith(
      expect.objectContaining({ mate: expect.objectContaining({ type: 'chatSheets', version: 1 }) })
    );
  });
});

describe('updateReadableLorebookEntry_ACU', () => {
  it('抑制期间只执行清理', async () => {
    mockShouldSuppressWorldbookInjection.mockReturnValue(true);
    await updateReadableLorebookEntry_ACU(false, false);
    // 应该调用 deleteAllGeneratedEntries 但不调用 formatJsonToReadable
    expect(mockFormatJsonToReadable).not.toHaveBeenCalled();
  });

  it('外部导入模式不检查抑制', async () => {
    mockShouldSuppressWorldbookInjection.mockReturnValue(true);
    mockCurrentJsonTableData.value = {
      sheet_0: { name: '测试', content: [['', '列1'], ['', '值1']] },
    };
    mockFormatJsonToReadable.mockReturnValue({
      readableText: '测试文本',
      importantPersonsTable: null,
      summaryTable: null,
      outlineTable: null,
    });
    await updateReadableLorebookEntry_ACU(false, true);
    // 外部导入模式应该继续执行
    expect(mockFormatJsonToReadable).toHaveBeenCalled();
  });

  it('无数据时中止', async () => {
    mockMergeAllIndependentTables.mockResolvedValue(null);
    mockCurrentJsonTableData.value = null;
    await updateReadableLorebookEntry_ACU(false, false);
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('no data available'));
  });

  it('调用各个注入函数', async () => {
    const mergedData = {
      sheet_0: { name: '测试', content: [['', '列1'], ['', '值1']] },
    };
    mockMergeAllIndependentTables.mockResolvedValue(mergedData);
    mockFormatJsonToReadable.mockReturnValue({
      readableText: '测试可读文本',
      importantPersonsTable: { name: '重要人物表', content: [['', '姓名'], ['', '角色A']] },
      summaryTable: { name: '总结表', content: [['', '编码索引'], ['', 'AM0001']] },
      outlineTable: { name: '总体大纲', content: [['', '大纲列'], ['', '内容']] },
    });

    await updateReadableLorebookEntry_ACU(true, false);
    expect(mockUpdateImportantPersonsRelatedEntries).toHaveBeenCalled();
    expect(mockUpdateSummaryTableEntries).toHaveBeenCalled();
    expect(mockUpdateOutlineTableEntry).toHaveBeenCalled();
    expect(mockUpdateCustomTableExports).toHaveBeenCalled();
  });

  it('表头不含 row_id 时用首列真实业务数据判定数据库非空', async () => {
    const mergedData = {
      sheet_0: { name: '主角技能表', content: [['技能名称'], ['格斗']] },
    };
    mockMergeAllIndependentTables.mockResolvedValue(mergedData);
    mockFormatJsonToReadable.mockReturnValue({
      readableText: '# 主角技能表\n\n| 技能名称 |\n|---|\n| 格斗 |\n',
      importantPersonsTable: null,
      summaryTable: null,
      outlineTable: null,
    });

    await updateReadableLorebookEntry_ACU(true, false);

    expect(mockGetReadableContentStartColumn).toHaveBeenCalledWith(['技能名称']);
    expect(mockHasReadableRowCellData).toHaveBeenCalledWith(['格斗'], 0);
    expect(mockUpdateCustomTableExports).toHaveBeenCalledWith(mergedData, false);
    expect(mockGwCreateLorebookEntries).toHaveBeenCalled();
  });

  it('只有 row_id 的空壳表按空数据处理并清理自定义导出', async () => {
    const mergedData = {
      sheet_0: { name: '空壳表', content: [['row_id'], ['1']] },
    };
    mockMergeAllIndependentTables.mockResolvedValue(mergedData);
    mockFormatJsonToReadable.mockReturnValue({
      readableText: '',
      importantPersonsTable: null,
      summaryTable: null,
      outlineTable: null,
    });

    await updateReadableLorebookEntry_ACU(true, false);

    expect(mockGetReadableContentStartColumn).toHaveBeenCalledWith(['row_id']);
    expect(mockHasReadableRowCellData).toHaveBeenCalledWith(['1'], 1);
    expect(mockUpdateCustomTableExports).toHaveBeenCalledWith(null, false);
    expect(mockGwCreateLorebookEntries).not.toHaveBeenCalled();
  });
});

describe('buildCombinedWorldbookContentByStrategy_ACU', () => {
  it('无世界书名称时返回空字符串', async () => {
    const result = await buildCombinedWorldbookContentByStrategy_ACU({ bookNames: [] });
    expect(result).toBe('');
  });

  it('组合常量和关键词触发的条目', async () => {
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: '常量条目', content: '常量内容', enabled: true, type: 'constant', key: [], keys: [] },
      { uid: 2, comment: '关键词条目', content: '关键词内容', enabled: true, type: 'keyword', key: ['测试'], keys: [] },
    ]);
    const result = await buildCombinedWorldbookContentByStrategy_ACU({
      bookNames: ['书A'],
      baseScanText: '这是一个测试文本',
      formatEntry: (entry: any) => entry.content,
      sortEntries: null,
    });
    expect(result).toContain('常量内容');
    expect(result).toContain('关键词内容');
  });

  it('排除禁用条目', async () => {
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: '禁用条目', content: '禁用内容', enabled: false, type: 'constant', key: [], keys: [] },
    ]);
    const result = await buildCombinedWorldbookContentByStrategy_ACU({
      bookNames: ['书A'],
      formatEntry: (entry: any) => entry.content,
    });
    expect(result).toBe('');
  });

  it('includeEntry 过滤器生效', async () => {
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: 'TavernDB-ACU-内部', content: '内部内容', enabled: true, type: 'constant', key: [], keys: [] },
      { uid: 2, comment: '用户条目', content: '用户内容', enabled: true, type: 'constant', key: [], keys: [] },
    ]);
    const result = await buildCombinedWorldbookContentByStrategy_ACU({
      bookNames: ['书A'],
      includeEntry: (entry: any) => !entry.comment.startsWith('TavernDB-ACU-'),
      formatEntry: (entry: any) => entry.content,
      sortEntries: null,
    });
    expect(result).toContain('用户内容');
    expect(result).not.toContain('内部内容');
  });

  it('递归触发关键词条目', async () => {
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: '常量', content: '包含关键词A的内容', enabled: true, type: 'constant', key: [], keys: [], prevent_recursion: false },
      { uid: 2, comment: '关键词A条目', content: '关键词A的详细内容', enabled: true, type: 'keyword', key: ['关键词a'], keys: [] },
    ]);
    const result = await buildCombinedWorldbookContentByStrategy_ACU({
      bookNames: ['书A'],
      baseScanText: '',
      formatEntry: (entry: any) => entry.content,
      sortEntries: null,
    });
    expect(result).toContain('关键词A的详细内容');
  });
});

describe('getCombinedWorldbookContent_ACU', () => {
  it('API 不可用时返回空字符串', async () => {
    mockIsWorldbookApiAvailable.mockReturnValue(false);
    const result = await getCombinedWorldbookContent_ACU();
    expect(result).toBe('');
  });

  it('character 模式获取角色世界书', async () => {
    mockGetCurrentWorldbookConfig.mockReturnValue({
      source: 'character',
      enabledEntries: {},
    });
    mockGetCharLorebooks.mockResolvedValue({ primary: '主世界书', additional: ['附加书'] });
    mockGwGetLorebookEntries.mockResolvedValue([]);
    await getCombinedWorldbookContent_ACU();
    expect(mockGetCharLorebooks).toHaveBeenCalled();
  });

  it('manual 模式使用手动选择', async () => {
    mockGetCurrentWorldbookConfig.mockReturnValue({
      source: 'manual',
      manualSelection: ['手动书A'],
      enabledEntries: {},
    });
    mockGwGetLorebookEntries.mockResolvedValue([]);
    await getCombinedWorldbookContent_ACU();
    // 不应调用 getCharLorebooks
    expect(mockGetCharLorebooks).not.toHaveBeenCalled();
  });

  it('过滤 TavernDB-ACU- 前缀的条目', async () => {
    mockGetCurrentWorldbookConfig.mockReturnValue({
      source: 'manual',
      manualSelection: ['书A'],
      enabledEntries: {},
    });
    mockGwGetLorebookEntries.mockResolvedValue([
      { uid: 1, comment: 'TavernDB-ACU-ReadableDataTable', content: '内部', enabled: true, type: 'constant', key: [], keys: [] },
      { uid: 2, comment: '用户条目', content: '用户内容', enabled: true, type: 'constant', key: [], keys: [] },
    ]);
    const result = await getCombinedWorldbookContent_ACU();
    expect(result).not.toContain('内部');
  });

  it('异常时返回空字符串', async () => {
    mockGetCurrentWorldbookConfig.mockReturnValue({ source: 'character', enabledEntries: {} });
    mockGetCharLorebooks.mockRejectedValue(new Error('网络错误'));
    const result = await getCombinedWorldbookContent_ACU();
    expect(result).toBe('');
  });
});
