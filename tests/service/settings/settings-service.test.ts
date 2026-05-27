/**
 * tests/service/settings/settings-service.test.ts
 * 设置加载/保存编排 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSettings,
  mockGlobalMeta,
  mockGetConfigStorage,
  mockIsIndexedDbAvailable,
  mockInitTavernSettingsBridge,
  mockPersistSettingsToStorage,
  mockAddDataIsolationHistory,
  mockNormalizeDataIsolationHistory,
  mockSaveGlobalMeta,
  mockLoadGlobalMeta,
  mockReadProfileSettings,
  mockReadProfileTemplate,
  mockWriteProfileSettings,
  mockWriteProfileTemplate,
  mockSanitizeSettingsForProfileSave,
  mockEnsureProfileExists,
  mockSetSettings,
  mockSetTableTemplate,
  mockGetCurrentIsolationKey,
  mockGetCurrentCharSettings,
  mockGetCurrentWorldbookConfig,
  mockEnsureTagRulesCompat,
  mockNormalizeTemplatePresetSelectionValue,
  mockGetCurrentTemplatePresetName,
  mockGetCurrentChatTemplateScopeState,
  mockMigrateLegacyTemplateScopeForCurrentChat,
  mockNormalizeTemplateScopeIsolationKey,
  mockSanitizeTemplateSnapshotForChat,
  mockGetTemplatePreset,
  mockGetDefaultTemplateSnapshot,
  mockGetGlobalTemplateSnapshotForCurrentProfile,
  mockSanitizeChatSheetsObject,
  mockEnsureSheetOrderNumbers,
  mockEnsureConfigIdbCacheLoaded,
  mockMigrateKeyToTavernStorage,
  mockSetPendingSettingsReloadFromIdb,
} = vi.hoisted(() => {
  const mockSettings: any = {
    dataIsolationCode: '',
    dataIsolationEnabled: false,
    charCardPrompt: [],
    mergeSummaryPrompt: '',
    mergeTargetCount: 1,
    mergeBatchSize: 5,
    mergeStartIndex: 1,
    mergeEndIndex: null,
    autoMergeEnabled: false,
    autoMergeThreshold: 20,
    autoMergeReserve: 0,
    deleteStartFloor: null,
    deleteEndFloor: null,
    plotSettings: { plotWorldbookConfig: null },
    plotPresetBindings: {},
    currentTemplatePresetName: '',
    maxConcurrentGroups: 1,
    zeroTkOccupyModeDefault: false,
    characterSettings: {},
  };
  const mockGlobalMeta: any = {
    activeIsolationCode: '',
    isolationCodeList: [],
    migratedLegacySingleStore: true,
    zeroTkOccupyModeGlobal: false,
  };
  return {
    mockSettings,
    mockGlobalMeta,
    mockGetConfigStorage: vi.fn(),
    mockIsIndexedDbAvailable: vi.fn(() => false),
    mockInitTavernSettingsBridge: vi.fn().mockResolvedValue(undefined),
    mockPersistSettingsToStorage: vi.fn(),
    mockAddDataIsolationHistory: vi.fn(),
    mockNormalizeDataIsolationHistory: vi.fn(),
    mockSaveGlobalMeta: vi.fn(),
    mockLoadGlobalMeta: vi.fn(),
    mockReadProfileSettings: vi.fn(() => null),
    mockReadProfileTemplate: vi.fn(() => null),
    mockWriteProfileSettings: vi.fn(),
    mockWriteProfileTemplate: vi.fn(),
    mockSanitizeSettingsForProfileSave: vi.fn((obj: any) => ({ ...obj })),
    mockEnsureProfileExists: vi.fn(),
    mockSetSettings: vi.fn((newSettings: any) => {
      Object.assign(mockSettings, newSettings);
    }),
    mockSetTableTemplate: vi.fn(),
    mockGetCurrentIsolationKey: vi.fn(() => ''),
    mockGetCurrentCharSettings: vi.fn(() => ({ worldbookConfig: { zeroTkOccupyMode: false, outlineEntryEnabled: true } })),
    mockGetCurrentWorldbookConfig: vi.fn(() => ({ zeroTkOccupyMode: false, outlineEntryEnabled: true })),
    mockEnsureTagRulesCompat: vi.fn(),
    mockNormalizeTemplatePresetSelectionValue: vi.fn((v: any) => v || ''),
    mockGetCurrentTemplatePresetName: vi.fn(() => ''),
    mockGetCurrentChatTemplateScopeState: vi.fn(() => null),
    mockMigrateLegacyTemplateScopeForCurrentChat: vi.fn(() => null),
    mockNormalizeTemplateScopeIsolationKey: vi.fn((key: any) => key || ''),
    mockSanitizeTemplateSnapshotForChat: vi.fn((str: any) => str ? { templateStr: str } : null),
    mockGetTemplatePreset: vi.fn(() => null),
    mockGetDefaultTemplateSnapshot: vi.fn(() => null),
    mockGetGlobalTemplateSnapshotForCurrentProfile: vi.fn(() => null),
    mockSanitizeChatSheetsObject: vi.fn((obj: any) => obj),
    mockEnsureSheetOrderNumbers: vi.fn(() => false),
    mockEnsureConfigIdbCacheLoaded: vi.fn().mockResolvedValue(undefined),
    mockMigrateKeyToTavernStorage: vi.fn(),
    mockSetPendingSettingsReloadFromIdb: vi.fn(),
  };
});

vi.mock('../../../src/shared/data-constants', () => ({
  STORAGE_KEY_ALL_SETTINGS_ACU: 'ACU_ALL_SETTINGS',
  STORAGE_KEY_CUSTOM_TEMPLATE_ACU: 'ACU_CUSTOM_TEMPLATE',
  normalizeIsolationCode_ACU: (code: any) => String(code || '').trim(),
}));

vi.mock('../../../src/shared/defaults-json.js', () => ({
  DEFAULT_CHAR_CARD_PROMPT_ACU: [{ role: 'USER', content: '默认提示词' }],
  DEFAULT_MERGE_SUMMARY_PROMPT_ACU: '默认合并提示词',
  DEFAULT_PLOT_SETTINGS_ACU: { enabled: false },
  DEFAULT_TABLE_TEMPLATE_ACU: '{"mate":{"type":"chatSheets","version":1},"sheet_0":{"name":"默认表"}}',
  get TABLE_TEMPLATE_ACU() { return '{"mate":{"type":"chatSheets","version":1}}'; },
  _set_TABLE_TEMPLATE_ACU: mockSetTableTemplate,
}));

vi.mock('../../../src/shared/defaults', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/shared/defaults')>();
  return {
    ...actual,
    DEFAULT_AUTO_UPDATE_FREQUENCY_ACU: 1,
    DEFAULT_AUTO_UPDATE_THRESHOLD_ACU: 3,
    DEFAULT_AUTO_UPDATE_TOKEN_THRESHOLD_ACU: 500,
    buildDefaultPlotWorldbookConfig_ACU: () => ({ source: 'character', manualSelection: [] }),
    buildDefaultContentOptimizationPromptGroup_ACU: () => [],
  };
});

vi.mock('../../../src/data/repositories/isolation-repo', () => ({
  addDataIsolationHistory_ACU: mockAddDataIsolationHistory,
  ensureProfileExists_ACU: mockEnsureProfileExists,
  normalizeDataIsolationHistory_ACU: mockNormalizeDataIsolationHistory,
}));

vi.mock('../../../src/data/repositories/profile-repo', () => ({
  globalMeta_ACU: mockGlobalMeta,
  loadGlobalMeta_ACU: mockLoadGlobalMeta,
  readProfileSettingsFromStorage_ACU: mockReadProfileSettings,
  readProfileTemplateFromStorage_ACU: mockReadProfileTemplate,
  sanitizeSettingsForProfileSave_ACU: mockSanitizeSettingsForProfileSave,
  saveGlobalMeta_ACU: mockSaveGlobalMeta,
  writeProfileSettingsToStorage_ACU: mockWriteProfileSettings,
  writeProfileTemplateToStorage_ACU: mockWriteProfileTemplate,
}));

vi.mock('../../../src/shared/template-preset-utils', () => ({
  getCurrentTemplatePresetName_ACU: mockGetCurrentTemplatePresetName,
  normalizeTemplatePresetSelectionValue_ACU: mockNormalizeTemplatePresetSelectionValue,
}));

vi.mock('../../../src/data/storage/config-storage', () => ({
  persistSettingsToStorage_ACU: mockPersistSettingsToStorage,
}));

vi.mock('../../../src/shared/idb-import-temp', () => ({
  isIndexedDbAvailable_ACU: mockIsIndexedDbAvailable,
}));

vi.mock('../../../src/data/storage/tavern-storage', () => ({
  configIdbCacheLoaded_ACU: false,
  ensureConfigIdbCacheLoaded_ACU: mockEnsureConfigIdbCacheLoaded,
  getConfigStorage_ACU: mockGetConfigStorage,
  initTavernSettingsBridge_ACU: mockInitTavernSettingsBridge,
  migrateKeyToTavernStorageIfNeeded_ACU: mockMigrateKeyToTavernStorage,
  pendingSettingsReloadFromIdb_ACU: false,
  _set_pendingSettingsReloadFromIdb_ACU: mockSetPendingSettingsReloadFromIdb,
  persistTavernSettings_ACU: vi.fn(),
}));

vi.mock('../../../src/service/plot/plot-logic', () => ({
  ensureTagRulesCompat_ACU: mockEnsureTagRulesCompat,
}));

vi.mock('../../../src/service/template/template-preset-service', () => ({
  getDefaultTemplateSnapshot_ACU: mockGetDefaultTemplateSnapshot,
  getTemplatePreset_ACU: mockGetTemplatePreset,
}));

vi.mock('../../../src/service/runtime/state-manager', () => ({
  currentChatFileIdentifier_ACU: 'test-char',
  getCurrentIsolationKey_ACU: mockGetCurrentIsolationKey,
  settings_ACU: mockSettings,
  _set_settings_ACU: mockSetSettings,
}));

vi.mock('../../../src/service/settings/settings-readers', () => ({
  getCurrentCharSettings_ACU: mockGetCurrentCharSettings,
  getCurrentWorldbookConfig_ACU: mockGetCurrentWorldbookConfig,
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  getCurrentChatTemplateScopeState_ACU: mockGetCurrentChatTemplateScopeState,
  getGlobalTemplateSnapshotForCurrentProfile_ACU: mockGetGlobalTemplateSnapshotForCurrentProfile,
  migrateLegacyTemplateScopeForCurrentChat_ACU: mockMigrateLegacyTemplateScopeForCurrentChat,
  normalizeTemplateScopeIsolationKey_ACU: mockNormalizeTemplateScopeIsolationKey,
  sanitizeChatSheetsObject_ACU: mockSanitizeChatSheetsObject,
  sanitizeTemplateSnapshotForChat_ACU: mockSanitizeTemplateSnapshotForChat,
}));

vi.mock('../../../src/shared/json-helpers', () => ({
  safeJsonParse_ACU: (json: string, fallback: any) => {
    try { return JSON.parse(json); } catch { return fallback; }
  },
}));

vi.mock('../../../src/shared/utils', () => ({
  deepMerge_ACU: (target: any, source: any) => ({ ...target, ...source }),
  ensureSheetOrderNumbers_ACU: mockEnsureSheetOrderNumbers,
  logDebug_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
}));

import {
  saveSettings_ACU,
  loadSettings_ACU,
  buildDefaultSettings_ACU,
  applyTemplateScopeForCurrentChat_ACU,
  persistCurrentTemplatePresetName_ACU,
  setZeroTkOccupyMode_ACU,
  applyCombinedSettingsImport_ACU,
} from '../../../src/service/settings/settings-service';

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings.dataIsolationCode = '';
  mockSettings.dataIsolationEnabled = false;
  mockSettings.charCardPrompt = [];
  mockSettings.mergeSummaryPrompt = '';
  mockSettings.plotSettings = { plotWorldbookConfig: null };
  mockSettings.plotPresetBindings = {};
  mockSettings.currentTemplatePresetName = '';
  mockSettings.maxConcurrentGroups = 1;
  mockSettings.zeroTkOccupyModeDefault = false;
  mockSettings.characterSettings = {};
  mockGlobalMeta.activeIsolationCode = '';
  mockGlobalMeta.isolationCodeList = [];
  mockGlobalMeta.migratedLegacySingleStore = true;
  mockGlobalMeta.zeroTkOccupyModeGlobal = false;
});

// ═══ saveSettings_ACU ═══
describe('saveSettings_ACU', () => {
  it('tavern 存储正常时返回 { saved: true, storageType: "tavern" }', () => {
    loadSettings_ACU();
    mockPersistSettingsToStorage.mockClear();
    mockSaveGlobalMeta.mockClear();
    mockGetConfigStorage.mockReturnValue({ _isTavern: true, getItem: vi.fn(), setItem: vi.fn() });
    const result = saveSettings_ACU();
    expect(result).toEqual({ saved: true, storageType: 'tavern' });
    expect(mockPersistSettingsToStorage).toHaveBeenCalledTimes(1);
    expect(mockSaveGlobalMeta).toHaveBeenCalledTimes(1);
  });

  it('非 tavern + IndexedDB 可用时返回 indexeddb 并带 warning', () => {
    loadSettings_ACU();
    mockGetConfigStorage.mockReturnValue({ _isTavern: false });
    mockIsIndexedDbAvailable.mockReturnValue(true);
    const result = saveSettings_ACU();
    expect(result.saved).toBe(true);
    expect(result.storageType).toBe('indexeddb');
    expect(result.warning).toBeDefined();
  });

  it('非 tavern + IndexedDB 不可用时返回 memory 并带 warning', () => {
    loadSettings_ACU();
    mockGetConfigStorage.mockReturnValue({ _isTavern: false });
    mockIsIndexedDbAvailable.mockReturnValue(false);
    const result = saveSettings_ACU();
    expect(result.saved).toBe(true);
    expect(result.storageType).toBe('memory');
    expect(result.warning).toContain('刷新后会丢失');
  });

  it('getConfigStorage 抛错时返回 { saved: false, error }', () => {
    loadSettings_ACU();
    mockGetConfigStorage.mockImplementation(() => { throw new Error('存储异常'); });
    const result = saveSettings_ACU();
    expect(result.saved).toBe(false);
    expect(result.storageType).toBe('memory');
    expect(result.error).toBeDefined();
  });
});

// ═══ buildDefaultSettings_ACU ═══
describe('buildDefaultSettings_ACU', () => {
  it('返回包含所有必要字段的默认设置对象', () => {
    const defaults = buildDefaultSettings_ACU();
    expect(defaults.apiConfig).toBeDefined();
    expect(defaults.apiConfig.useMainApi).toBe(true);
    expect(defaults.autoUpdateThreshold).toBe(3);
    expect(defaults.manualUpdateContextDepth).toBeNull();
    expect(defaults.manualUpdateBatchSize).toBeNull();
    expect(defaults.autoUpdateEnabled).toBe(true);
    expect(defaults.continuationPageEnabled).toBe(true);
    expect(defaults.externalImportPageEnabled).toBe(true);
    expect(defaults.maxConcurrentGroups).toBe(1);
    expect(defaults.storageMode).toBe('native');
    expect(defaults.promptTemplateSettings).toBeDefined();
    expect(defaults.promptTemplateSettings.enabled).toBe(true);
    expect(defaults.contentOptimizationSettings).toBeDefined();
    expect(defaults.contentOptimizationSettings.enabled).toBe(false);
  });

  it('plotSettings 是深拷贝，修改不影响默认常量', () => {
    const defaults1 = buildDefaultSettings_ACU();
    const defaults2 = buildDefaultSettings_ACU();
    defaults1.plotSettings.customField = 'modified';
    expect(defaults2.plotSettings.customField).toBeUndefined();
  });

  it('characterSettings 初始为空对象', () => {
    const defaults = buildDefaultSettings_ACU();
    expect(defaults.characterSettings).toEqual({});
  });
});

// ═══ applyCombinedSettingsImport_ACU ═══
describe('applyCombinedSettingsImport_ACU', () => {
  beforeEach(() => {
    // saveSettings_ACU 内部会调用 getConfigStorage，需要 mock
    mockGetConfigStorage.mockReturnValue({ _isTavern: true });
  });

  it('导入 prompt 字段', () => {
    const fields = applyCombinedSettingsImport_ACU({
      prompt: [{ role: 'USER', content: '新提示词' }],
    });
    expect(fields).toContain('charCardPrompt');
    expect(mockSettings.charCardPrompt).toEqual([{ role: 'USER', content: '新提示词' }]);
  });

  it('导入合并设置字段', () => {
    const fields = applyCombinedSettingsImport_ACU({
      autoMergeEnabled: true,
      autoMergeThreshold: 30,
      mergeBatchSize: 10,
    });
    expect(fields).toContain('autoMergeEnabled');
    expect(fields).toContain('autoMergeThreshold');
    expect(mockSettings.autoMergeEnabled).toBe(true);
    expect(mockSettings.autoMergeThreshold).toBe(30);
    expect(mockSettings.mergeBatchSize).toBe(10);
  });

  it('空对象不修改任何字段', () => {
    const fields = applyCombinedSettingsImport_ACU({});
    // 不包含 charCardPrompt（因为 combinedData.prompt 不是数组）
    expect(fields).not.toContain('charCardPrompt');
  });

  it('导入后调用 saveSettings_ACU 持久化', () => {
    applyCombinedSettingsImport_ACU({ prompt: [{ role: 'USER', content: '测试' }] });
    expect(mockPersistSettingsToStorage).toHaveBeenCalled();
  });
});

// ═══ persistCurrentTemplatePresetName_ACU ═══
describe('persistCurrentTemplatePresetName_ACU', () => {
  it('settingsObj 为 null 时返回空字符串', () => {
    expect(persistCurrentTemplatePresetName_ACU(null, '预设A')).toBe('');
  });

  it('save=true 时触发持久化', () => {
    const obj: any = { dataIsolationCode: 'code1' };
    persistCurrentTemplatePresetName_ACU(obj, '预设A', { save: true });
    expect(obj.currentTemplatePresetName).toBe('预设A');
    expect(mockPersistSettingsToStorage).toHaveBeenCalledWith(obj, 'code1');
  });

  it('save=false 时不触发持久化', () => {
    const obj: any = {};
    persistCurrentTemplatePresetName_ACU(obj, '预设B', { save: false });
    expect(obj.currentTemplatePresetName).toBe('预设B');
    expect(mockPersistSettingsToStorage).not.toHaveBeenCalled();
  });
});

// ═══ setZeroTkOccupyMode_ACU ═══
describe('setZeroTkOccupyMode_ACU', () => {
  beforeEach(() => {
    mockGetConfigStorage.mockReturnValue({ _isTavern: true });
  });

  it('启用时设置 zeroTkOccupyMode=true 且 outlineEntryEnabled=false', () => {
    const cfg: any = { zeroTkOccupyMode: false, outlineEntryEnabled: true };
    mockGetCurrentWorldbookConfig.mockReturnValue(cfg);
    setZeroTkOccupyMode_ACU(true);
    expect(cfg.zeroTkOccupyMode).toBe(true);
    expect(cfg.outlineEntryEnabled).toBe(false);
    expect(mockSettings.zeroTkOccupyModeDefault).toBe(true);
    expect(mockGlobalMeta.zeroTkOccupyModeGlobal).toBe(true);
    expect(mockSaveGlobalMeta).toHaveBeenCalled();
  });

  it('禁用时设置 zeroTkOccupyMode=false 且 outlineEntryEnabled=true', () => {
    const cfg: any = { zeroTkOccupyMode: true, outlineEntryEnabled: false };
    mockGetCurrentWorldbookConfig.mockReturnValue(cfg);
    setZeroTkOccupyMode_ACU(false);
    expect(cfg.zeroTkOccupyMode).toBe(false);
    expect(cfg.outlineEntryEnabled).toBe(true);
    expect(mockSettings.zeroTkOccupyModeDefault).toBe(false);
  });
});

// ═══ applyTemplateScopeForCurrentChat_ACU ═══
describe('applyTemplateScopeForCurrentChat_ACU', () => {
  it('chat_override 模式：使用聊天级模板覆盖', () => {
    mockGetCurrentChatTemplateScopeState.mockReturnValue({
      mode: 'chat_override',
      templateStr: '{"mate":{"type":"chatSheets"},"sheet_0":{"name":"覆盖表"}}',
      presetName: '预设X',
    });
    mockSanitizeTemplateSnapshotForChat.mockReturnValue({
      templateStr: '{"mate":{"type":"chatSheets"},"sheet_0":{"name":"覆盖表"}}',
    });

    const result = applyTemplateScopeForCurrentChat_ACU();
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('chat_override');
    expect(mockSetTableTemplate).toHaveBeenCalled();
  });

  it('preset_link 模式：使用链接的全局预设', () => {
    mockGetCurrentChatTemplateScopeState.mockReturnValue({
      mode: 'preset_link',
      presetName: '预设A',
    });
    mockNormalizeTemplatePresetSelectionValue.mockReturnValue('预设A');
    mockGetTemplatePreset.mockReturnValue({ templateStr: '{"sheet_0":{}}' });
    mockSanitizeTemplateSnapshotForChat.mockReturnValue({ templateStr: '{"sheet_0":{}}' });

    const result = applyTemplateScopeForCurrentChat_ACU();
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('preset_link');
    expect(result!.presetName).toBe('预设A');
  });

  it('无有效快照时回退到全局模板', () => {
    mockGetCurrentChatTemplateScopeState.mockReturnValue(null);
    mockMigrateLegacyTemplateScopeForCurrentChat.mockReturnValue(null);
    mockGetGlobalTemplateSnapshotForCurrentProfile.mockReturnValue({
      templateStr: '{"sheet_0":{"name":"全局表"}}',
    });

    const result = applyTemplateScopeForCurrentChat_ACU();
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('inherit_global');
  });

  it('所有快照都无效时返回 null', () => {
    mockGetCurrentChatTemplateScopeState.mockReturnValue(null);
    mockMigrateLegacyTemplateScopeForCurrentChat.mockReturnValue(null);
    mockGetGlobalTemplateSnapshotForCurrentProfile.mockReturnValue(null);

    const result = applyTemplateScopeForCurrentChat_ACU();
    expect(result).toBeNull();
  });
});

// ═══ loadSettings_ACU ═══
describe('loadSettings_ACU', () => {
  beforeEach(() => {
    mockGetConfigStorage.mockReturnValue({
      _isTavern: true,
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
    });
    mockReadProfileSettings.mockReturnValue(null);
    mockReadProfileTemplate.mockReturnValue(null);
  });

  it('无保存设置时使用默认值', () => {
    loadSettings_ACU();
    // _set_settings_ACU 应被调用，传入默认设置
    expect(mockSetSettings).toHaveBeenCalled();
    const calledWith = mockSetSettings.mock.calls[0][0];
    expect(calledWith.autoUpdateEnabled).toBe(true);
    expect(calledWith.maxConcurrentGroups).toBe(1);
  });

  it('有保存设置时 deepMerge 合并', () => {
    mockReadProfileSettings.mockReturnValue({
      autoUpdateEnabled: false,
      customField: '自定义值',
    });
    loadSettings_ACU();
    expect(mockSetSettings).toHaveBeenCalled();
    // deepMerge 的 mock 实现是 { ...target, ...source }，source 覆盖 target
    const calledWith = mockSetSettings.mock.calls[0][0];
    expect(calledWith.autoUpdateEnabled).toBe(false);
    expect(calledWith.customField).toBe('自定义值');
  });

  it('解析异常时回退到默认设置', () => {
    mockReadProfileSettings.mockImplementation(() => { throw new Error('解析失败'); });
    loadSettings_ACU();
    expect(mockSetSettings).toHaveBeenCalled();
    // 异常路径也会调用 _set_settings_ACU(buildDefaultSettings_ACU())
    const calledWith = mockSetSettings.mock.calls[0][0];
    expect(calledWith.autoUpdateEnabled).toBe(true);
  });
});
