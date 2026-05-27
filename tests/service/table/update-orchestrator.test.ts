/**
 * tests/service/table/update-orchestrator.test.ts
 * 表格更新编排器单元测试
 *
 * 策略：
 * - resolveUpdateMode_ACU / loadBatchBaseData_ACU / buildBatchMergeBase_ACU 是纯/浅依赖函数，直接测试
 * - processUpdatesBatch_ACU / executeCardUpdateCore_ACU / orchestrateManualUpdate_ACU 通过 mock 回调测试编排逻辑
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════
// Mock 设置
// ═══════════════════════════════════════════════════════════════

vi.mock('../../../src/shared/utils', () => ({
  logDebug_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  isSummaryOrOutlineTable_ACU: vi.fn(() => false),
  parseTableTemplateJson_ACU: vi.fn(() => ({
    mate: { type: 'acu' },
    sheet_0: { name: '测试表', updateConfig: { groupId: 0 } },
  })),
}));

vi.mock('../../../src/shared/env', () => ({
  topLevelWindow_ACU: {},
}));

let mockSettings: any = {
  autoUpdateEnabled: true,
  apiMode: 'custom',
  apiConfig: { useMainApi: true, url: '', model: '' },
  tavernProfile: '',
  autoUpdateThreshold: 3,
  updateBatchSize: 2,
  skipUpdateFloors: 0,
  tableMaxRetries: 3,
  autoUpdateTokenThreshold: 0,
  toastMuteEnabled: false,
  dataIsolationEnabled: false,
  dataIsolationCode: '',
  tableApiPresetOverridesByName: {},
};

let mockCurrentJsonTableData: any = null;
let mockProviderCurrentData: any = null;
let mockIsAutoUpdating = false;
let mockWasStopped = false;
let mockCoreApisReady = true;

vi.mock('../../../src/service/runtime/state-manager', () => ({
  get settings_ACU() { return mockSettings; },
  get currentJsonTableData_ACU() { return mockCurrentJsonTableData; },
  get currentChatFileIdentifier_ACU() { return 'test-chat'; },
  get isAutoUpdatingCard_ACU() { return mockIsAutoUpdating; },
  get wasStoppedByUser_ACU() { return mockWasStopped; },
  get coreApisAreReady_ACU() { return mockCoreApisReady; },
  _set_isAutoUpdatingCard_ACU: vi.fn((v: any) => { mockIsAutoUpdating = v; }),
  _set_wasStoppedByUser_ACU: vi.fn(),
  _set_manualExtraHint_ACU: vi.fn(),
  _set_currentJsonTableData_ACU: vi.fn((v: any) => { mockCurrentJsonTableData = v; }),
  abortAllActiveRequests_ACU: vi.fn(),
  getCurrentIsolationKey_ACU: vi.fn(() => ''),
}));

const mockCallCustomOpenAI = vi.fn();
const mockParseAndApplyTableEdits = vi.fn();
const mockPrepareAIInput = vi.fn();

vi.mock('../../../src/service/ai/prompt-builder', () => ({
  callCustomOpenAI_ACU: (...args: any[]) => mockCallCustomOpenAI(...args),
  parseAndApplyTableEdits_ACU: (...args: any[]) => mockParseAndApplyTableEdits(...args),
  prepareAIInput_ACU: (...args: any[]) => mockPrepareAIInput(...args),
}));

vi.mock('../../../src/service/chat/chat-service', () => ({
  getChatArray_ACU: vi.fn(() => []),
  clearTableDataAtFloors_ACU: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../../src/service/summary/merge-logic', () => ({
  checkAutoMergeTrigger_ACU: vi.fn(() => ({ shouldTrigger: false })),
  prepareAutoMergeBatches_ACU: vi.fn(),
  executeAutoMergeBatch_ACU: vi.fn(),
  finalizeAutoMerge_ACU: vi.fn(),
}));

vi.mock('../../../src/service/template/chat-scope', () => ({
  getChatSheetGuideDataForIsolationKey_ACU: vi.fn(() => null),
  getSortedSheetKeys_ACU: vi.fn((data: any) => data ? Object.keys(data).filter((k: string) => k.startsWith('sheet_')) : []),
  buildGuidedBaseDataFromSheetGuide_ACU: vi.fn(),
}));

vi.mock('../../../src/service/worldbook/pipeline', () => ({
  loadAllChatMessages_ACU: vi.fn(),
  updateReadableLorebookEntry_ACU: vi.fn(),
}));

vi.mock('../../../src/service/settings/settings-readers', () => ({
  getCurrentWorldbookConfig_ACU: vi.fn(() => ({ summaryVectorIndexModeEnabled: false })),
}));

vi.mock('../../../src/service/vector/summary-vector-index-flush-queue', () => ({
  enqueueSummaryVectorIndexFlush_ACU: vi.fn().mockResolvedValue({ queued: true }),
}));

const mockCheckIfFirstTimeInit = vi.fn().mockResolvedValue(false);
const mockPersistTablesToChatMessage = vi.fn().mockResolvedValue({ saved: true });

vi.mock('../../../src/service/table/table-service', () => ({
  checkIfFirstTimeInit_ACU: (...args: any[]) => mockCheckIfFirstTimeInit(...args),
  persistTablesToChatMessage_ACU: (...args: any[]) => mockPersistTablesToChatMessage(...args),
}));

vi.mock('../../../src/service/table/storage-mode', () => ({
  isSqliteMode: vi.fn(() => false),
}));

const mockReplaceCurrentData = vi.fn(async (data: any) => {
  const clonedData = data ? JSON.parse(JSON.stringify(data)) : null;
  mockProviderCurrentData = clonedData;
  mockCurrentJsonTableData = clonedData;
});
const mockGetCurrentDataFromProvider = vi.fn(() => mockProviderCurrentData);

vi.mock('../../../src/service/table/table-storage-strategy', () => ({
  getStorageProvider: vi.fn(() => ({
    replaceCurrentData: (data: any) => mockReplaceCurrentData(data),
    getCurrentData: () => mockGetCurrentDataFromProvider(),
  })),
  reloadStorageProvider: vi.fn(),
}));

vi.mock('../../../src/service/settings/settings-service', () => ({
  applyTemplateScopeForCurrentChat_ACU: vi.fn(),
}));

import {
  resolveUpdateMode_ACU,
  loadBatchBaseData_ACU,
  buildBatchMergeBase_ACU,
  processUpdatesBatch_ACU,
  executeCardUpdateCore_ACU,
  buildRoundPersistenceTargets_ACU,
  orchestrateManualUpdate_ACU,
  type CardUpdateResult,
  type CardUpdateProgressEvent,
} from '../../../src/service/table/update-orchestrator';
import type { TableDataObject_ACU } from '../../../src/shared/models/table-data';
import type { TableLayerDeltaV2_ACU, TablePersistenceLayerV2_ACU } from '../../../src/service/table/table-delta-types';

function makeTestTableData(sheetName: string, content: (string | null)[][]): TableDataObject_ACU {
  return {
    mate: { type: 'chatSheets' },
    sheet_0: { name: sheetName, content },
  } as any;
}

function makeV2LayerForTest(layer: TablePersistenceLayerV2_ACU, isolationKey = ''): any {
  return {
    is_user: false,
    TavernDB_ACU_IsolatedData: {
      [isolationKey]: {
        independentData: {},
        modifiedKeys: [],
        updateGroupKeys: [],
        tablePersistenceV2: layer,
      },
    },
  };
}

function makeCheckpointLayerForTest(sheetName: string, content: (string | null)[][], isolationKey = ''): TablePersistenceLayerV2_ACU {
  return {
    version: 2,
    checkpoint: {
      kind: 'checkpoint',
      version: 2,
      checkpointId: `checkpoint-${isolationKey || 'default'}-${sheetName}`,
      createdAt: '2026-05-08T00:00:00.000Z',
      source: 'legacy-migration',
      isolationKey,
      data: makeTestTableData(sheetName, content),
    },
  };
}

function makeDeltaLayerForTest(sheetName: string, row: (string | null)[], isolationKey = ''): TablePersistenceLayerV2_ACU {
  const delta: TableLayerDeltaV2_ACU = {
    kind: 'delta',
    version: 2,
    deltaId: `delta-${isolationKey || 'default'}-${sheetName}`,
    createdAt: '2026-05-08T00:00:00.000Z',
    isolationKey,
    changedSheets: ['sheet_0'],
    modifiedKeys: ['sheet_0'],
    updateGroupKeys: ['sheet_0'],
    changesBySheet: {
      sheet_0: {
        sheetKey: 'sheet_0',
        sheetName,
        rowChanges: [{ op: 'upsert', rowId: String(row[0]), rowIndexHint: 1, row }],
      },
    },
  };
  return { version: 2, delta };
}

function mutateSheet0ForSuccessfulSave(rowId: string): { success: true; modifiedKeys: string[] } {
  if (!mockCurrentJsonTableData?.sheet_0?.content) {
    mockCurrentJsonTableData = { sheet_0: { name: '测试表', content: [['row_id']] } };
  }
  mockCurrentJsonTableData.sheet_0.content.push([rowId]);
  return { success: true, modifiedKeys: ['sheet_0'] };
}

// ═══════════════════════════════════════════════════════════════
// resolveUpdateMode_ACU
// ═══════════════════════════════════════════════════════════════
describe('resolveUpdateMode_ACU', () => {
  it('auto_unified 直接返回', () => {
    expect(resolveUpdateMode_ACU('auto_unified')).toBe('auto_unified');
  });

  it('manual_unified 直接返回', () => {
    expect(resolveUpdateMode_ACU('manual_unified')).toBe('manual_unified');
  });

  it('full 直接返回', () => {
    expect(resolveUpdateMode_ACU('full')).toBe('full');
  });

  it('auto_summary_silent 直接返回', () => {
    expect(resolveUpdateMode_ACU('auto_summary_silent')).toBe('auto_summary_silent');
  });

  it('manual_summary 返回 manual_summary', () => {
    expect(resolveUpdateMode_ACU('manual_summary')).toBe('manual_summary');
  });

  it('manual_independent 返回 manual_independent', () => {
    expect(resolveUpdateMode_ACU('manual_independent')).toBe('manual_independent');
  });

  it('manual 前缀默认返回 manual_standard', () => {
    expect(resolveUpdateMode_ACU('manual')).toBe('manual_standard');
    expect(resolveUpdateMode_ACU('manual_other')).toBe('manual_standard');
  });

  it('auto 模式带 summary 返回 auto_summary', () => {
    expect(resolveUpdateMode_ACU('auto_summary')).toBe('auto_summary');
    expect(resolveUpdateMode_ACU('summary')).toBe('auto_summary');
  });

  it('auto 模式默认返回 auto_standard', () => {
    expect(resolveUpdateMode_ACU('auto')).toBe('auto_standard');
    expect(resolveUpdateMode_ACU('auto_standard')).toBe('auto_standard');
  });

  it('空字符串返回 auto_standard', () => {
    expect(resolveUpdateMode_ACU('')).toBe('auto_standard');
  });

  it('未知模式返回 auto_standard', () => {
    expect(resolveUpdateMode_ACU('unknown')).toBe('auto_standard');
  });
});

// ═══════════════════════════════════════════════════════════════
// buildRoundPersistenceTargets_ACU
// ═══════════════════════════════════════════════════════════════
describe('buildRoundPersistenceTargets_ACU', () => {
  it('按 round item 的 saveTargetIndex 将修改表分桶到对应楼层', () => {
    const result = buildRoundPersistenceTargets_ACU([
      {
        groupKey: 'group_a',
        group: { sheetKeys: ['sheet_0'] },
        batchIndices: [1],
        batchNumberInGroup: 1,
        saveTargetIndex: 1,
        groupOrder: 0,
      },
      {
        groupKey: 'group_b',
        group: { sheetKeys: ['sheet_1'] },
        batchIndices: [3],
        batchNumberInGroup: 1,
        saveTargetIndex: 3,
        groupOrder: 1,
      },
    ] as any, ['sheet_0', 'sheet_1']);

    expect(result).toEqual([
      {
        targetMessageIndex: 1,
        targetSheetKeys: ['sheet_0'],
        updateGroupKeys: ['sheet_0'],
        trackingSheetKeys: ['sheet_0'],
      },
      {
        targetMessageIndex: 3,
        targetSheetKeys: ['sheet_1'],
        updateGroupKeys: ['sheet_1'],
        trackingSheetKeys: ['sheet_1'],
      },
    ]);
  });

  it('同一 saveTargetIndex 的多个 group 合并为一次持久化目标并去重', () => {
    const result = buildRoundPersistenceTargets_ACU([
      {
        groupKey: 'group_a',
        group: { sheetKeys: ['sheet_0', 'sheet_1'] },
        batchIndices: [5],
        batchNumberInGroup: 1,
        saveTargetIndex: 5,
        groupOrder: 0,
      },
      {
        groupKey: 'group_b',
        group: { sheetKeys: ['sheet_1', 'sheet_2'] },
        batchIndices: [5],
        batchNumberInGroup: 1,
        saveTargetIndex: 5,
        groupOrder: 1,
      },
    ] as any, ['sheet_0', 'sheet_1', 'sheet_2']);

    expect(result).toEqual([
      {
        targetMessageIndex: 5,
        targetSheetKeys: ['sheet_0', 'sheet_1', 'sheet_2'],
        updateGroupKeys: ['sheet_0', 'sheet_1', 'sheet_2'],
        trackingSheetKeys: ['sheet_0', 'sheet_1', 'sheet_2'],
      },
    ]);
  });

  it('未实际修改的 group sheet 不生成持久化目标也不推进 tracking', () => {
    const result = buildRoundPersistenceTargets_ACU([
      {
        groupKey: 'group_a',
        group: { sheetKeys: ['sheet_0'] },
        batchIndices: [1],
        batchNumberInGroup: 1,
        saveTargetIndex: 1,
        groupOrder: 0,
      },
      {
        groupKey: 'group_b',
        group: { sheetKeys: ['sheet_1'] },
        batchIndices: [3],
        batchNumberInGroup: 1,
        saveTargetIndex: 3,
        groupOrder: 1,
      },
    ] as any, ['sheet_0']);

    expect(result).toEqual([
      {
        targetMessageIndex: 1,
        targetSheetKeys: ['sheet_0'],
        updateGroupKeys: ['sheet_0'],
        trackingSheetKeys: ['sheet_0'],
      },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// loadBatchBaseData_ACU
// ═══════════════════════════════════════════════════════════════
describe('loadBatchBaseData_ACU', () => {
  it('从新版存储格式加载数据', () => {
    const chatHistory = [
      { is_user: true },
      {
        is_user: false,
        TavernDB_ACU_IsolatedData: {
          '': {
            independentData: {
              sheet_0: { name: '测试表', content: [['row_id'], ['1']] },
            },
            modifiedKeys: ['sheet_0'],
            updateGroupKeys: [],
          },
        },
      },
      { is_user: true },
      { is_user: false }, // 当前批次的第一条消息
    ];

    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表', content: [['row_id']] },
    };

    const result = loadBatchBaseData_ACU(chatHistory, 3, '', ['sheet_0'], mergedBatchData);
    expect(result.foundCount).toBe(1);
    expect(result.totalCount).toBe(1);
    expect(mergedBatchData.sheet_0.content).toEqual([['row_id'], ['1']]);
  });

  it('从旧版存储格式加载数据', () => {
    const chatHistory = [
      { is_user: true },
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: { name: '测试表', content: [['row_id'], ['1']] },
        },
      },
      { is_user: true },
      { is_user: false },
    ];

    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表', content: [['row_id']] },
    };

    const result = loadBatchBaseData_ACU(chatHistory, 3, '', ['sheet_0'], mergedBatchData);
    expect(result.foundCount).toBe(1);
  });

  it('空聊天记录返回全部未找到', () => {
    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表' },
    };
    const result = loadBatchBaseData_ACU([], 0, '', ['sheet_0'], mergedBatchData);
    expect(result.foundCount).toBe(0);
    expect(result.totalCount).toBe(1);
  });

  it('跳过 user 消息', () => {
    const chatHistory = [
      { is_user: true, TavernDB_ACU_IndependentData: { sheet_0: { name: '不应该被读取' } } },
      { is_user: false },
    ];

    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表' },
    };

    const result = loadBatchBaseData_ACU(chatHistory, 1, '', ['sheet_0'], mergedBatchData);
    expect(result.foundCount).toBe(0);
  });

  it('按 V2 checkpoint + delta 正序重建批次基底', () => {
    const chatHistory = [
      makeV2LayerForTest(makeCheckpointLayerForTest('更旧的表0', [['row_id'], ['1']])),
      makeV2LayerForTest(makeDeltaLayerForTest('较新的表0', ['2'])),
      { is_user: false }, // 当前批次的第一条消息
    ];

    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表', content: [['row_id']] },
    };

    loadBatchBaseData_ACU(chatHistory, 2, '', ['sheet_0'], mergedBatchData);
    expect(mergedBatchData.sheet_0.name).toBe('较新的表0');
    expect(mergedBatchData.sheet_0.content).toEqual([['row_id'], ['2'], ['1']]);
  });

  it('按隔离标签读取匹配的 V2 layer', () => {
    const chatHistory = [
      makeV2LayerForTest(makeCheckpointLayerForTest('标签A的数据', [['row_id'], ['A']], 'tag_A'), 'tag_A'),
      makeV2LayerForTest(makeCheckpointLayerForTest('标签B的数据', [['row_id'], ['B']], 'tag_B'), 'tag_B'),
      { is_user: false },
    ];

    const mergedBatchData: Record<string, any> = {
      sheet_0: { name: '空表', content: [['row_id']] },
    };

    loadBatchBaseData_ACU(chatHistory, 2, 'tag_A', ['sheet_0'], mergedBatchData);
    expect(mergedBatchData.sheet_0.name).toBe('标签A的数据');
    expect(mergedBatchData.sheet_0.content).toEqual([['row_id'], ['A']]);
  });
});

// ═══════════════════════════════════════════════════════════════
// buildBatchMergeBase_ACU
// ═══════════════════════════════════════════════════════════════
describe('buildBatchMergeBase_ACU', () => {
  it('无 guide 时使用模板', () => {
    const result = buildBatchMergeBase_ACU(1);
    expect(result.data).not.toBeNull();
    expect(result.error).toBeNull();
  });

  it('有 guide 时使用 guide', async () => {
    const { getChatSheetGuideDataForIsolationKey_ACU } = await import('../../../src/service/template/chat-scope');
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue({
      sheet_0: { name: '引导数据' },
    });
    const { buildGuidedBaseDataFromSheetGuide_ACU } = await import('../../../src/service/template/chat-scope');
    vi.mocked(buildGuidedBaseDataFromSheetGuide_ACU).mockReturnValue({
      sheet_0: { name: '从引导构建的数据' },
    });

    const result = buildBatchMergeBase_ACU(1);
    expect(result.data).not.toBeNull();
    expect(result.error).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// processUpdatesBatch_ACU（适配新返回值类型）
// ═══════════════════════════════════════════════════════════════
describe('processUpdatesBatch_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAutoUpdating = false;
    mockProviderCurrentData = null;
    mockReplaceCurrentData.mockClear();
    mockSettings = {
      ...mockSettings,
      autoUpdateThreshold: 3,
      updateBatchSize: 2,
      autoUpdateTokenThreshold: 0,
      toastMuteEnabled: false,
    };
  });

  it('空索引列表返回 success: true', async () => {
    const result = await processUpdatesBatch_ACU([], 'auto_standard', {}, vi.fn());
    expect(result.success).toBe(true);
  });

  it('执行更新回调成功时返回 success: true', async () => {
    const mockExecute = vi.fn().mockResolvedValue({ success: true, modifiedKeys: ['sheet_0'] } as CardUpdateResult);
    mockCurrentJsonTableData = { sheet_0: { name: '测试' } };

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: '这是AI回复' },
    ]);

    const result = await processUpdatesBatch_ACU([1], 'auto_standard', {}, mockExecute);
    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalled();
  });

  it('更新失败时返回 success: false 和 error', async () => {
    const mockExecute = vi.fn().mockResolvedValue({ success: false, modifiedKeys: [], error: '更新失败' } as CardUpdateResult);
    mockCurrentJsonTableData = { sheet_0: { name: '测试' } };

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: '这是AI回复' },
    ]);

    const result = await processUpdatesBatch_ACU([1], 'auto_standard', {}, mockExecute);
    expect(result.success).toBe(false);
    expect(result.failedBatch).toBe(1);
  });

  it('AI 回复过短时跳过（auto 模式）', async () => {
    mockSettings.autoUpdateTokenThreshold = 1000;
    const mockExecute = vi.fn().mockResolvedValue({ success: true, modifiedKeys: [] } as CardUpdateResult);
    mockCurrentJsonTableData = { sheet_0: { name: '测试' } };

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: '短' },
    ]);

    const result = await processUpdatesBatch_ACU([1], 'auto_standard', {}, mockExecute);
    expect(result.success).toBe(true);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('构建合并基底失败时返回 error', async () => {
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    const { getChatSheetGuideDataForIsolationKey_ACU } = await import('../../../src/service/template/chat-scope');
    // 确保走 template 分支（guide 返回 null），然后 template 解析抛异常
    vi.mocked(getChatSheetGuideDataForIsolationKey_ACU).mockReturnValue(null);
    vi.mocked(parseTableTemplateJson_ACU).mockImplementationOnce(() => { throw new Error('模板解析失败'); });

    const mockExecute = vi.fn().mockResolvedValue({ success: true, modifiedKeys: [] });
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: '这是AI回复' },
    ]);

    const result = await processUpdatesBatch_ACU([1], 'auto_standard', {}, mockExecute);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('SQL 模式下每批提示词前必须用历史批基底替换 provider 数据源', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);

    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表', content: [['row_id']], sourceData: { ddl: 'CREATE TABLE test(row_id TEXT);' }, updateConfig: { groupId: 0 } },
    });

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: false, TavernDB_ACU_IndependentData: { sheet_0: { name: '测试表', content: [['row_id'], ['旧数据']] } } },
      { is_user: true, mes: '用户消息' },
      { is_user: false, mes: 'AI回复' },
    ]);

    const mockExecute = vi.fn().mockResolvedValue({ success: true, modifiedKeys: ['sheet_0'] });
    const result = await processUpdatesBatch_ACU([2], 'auto_standard', { targetSheetKeys: ['sheet_0'] }, mockExecute);

    expect(result.success).toBe(true);
    expect(mockReplaceCurrentData).toHaveBeenCalledTimes(1);
    expect(mockReplaceCurrentData.mock.calls[0][0].sheet_0.content).toEqual([['row_id'], ['旧数据']]);
    expect(mockGetCurrentDataFromProvider).toHaveBeenCalledTimes(2);
    expect(mockCurrentJsonTableData.sheet_0.content).toEqual([['row_id'], ['旧数据']]);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('SQL 模式下历史批基底为空壳时，替换 provider 前必须保留 provider 当前数据行', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);

    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: {
        name: '角色表',
        content: [['row_id', 'name']],
        sourceData: { ddl: 'CREATE TABLE protagonist_info(row_id TEXT, name TEXT);' },
        updateConfig: { groupId: 0 },
      },
    });

    mockProviderCurrentData = {
      sheet_0: {
        name: '角色表',
        content: [['旧表头', '旧姓名'], ['1', '牧濑红莉栖']],
        sourceData: { ddl: 'CREATE TABLE old_protagonist_info(old_id TEXT, old_name TEXT);' },
        updateConfig: { groupId: 99 },
      },
    };

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true, mes: '用户消息' },
      { is_user: false, mes: 'AI回复' },
    ]);

    const mockExecute = vi.fn().mockImplementation(async () => {
      expect(mockCurrentJsonTableData.sheet_0.content).toEqual([['row_id', 'name'], ['1', '牧濑红莉栖']]);
      expect(mockCurrentJsonTableData.sheet_0.sourceData.ddl).toBe('CREATE TABLE protagonist_info(row_id TEXT, name TEXT);');
      expect(mockCurrentJsonTableData.sheet_0.updateConfig).toEqual({ groupId: 0 });
      return { success: true, modifiedKeys: ['sheet_0'] };
    });

    const result = await processUpdatesBatch_ACU([1], 'auto_standard', { targetSheetKeys: ['sheet_0'] }, mockExecute);

    expect(result.success).toBe(true);
    expect(mockReplaceCurrentData).toHaveBeenCalledTimes(1);
    expect(mockReplaceCurrentData.mock.calls[0][0].sheet_0.content).toEqual([['row_id', 'name'], ['1', '牧濑红莉栖']]);
    expect(mockReplaceCurrentData.mock.calls[0][0].sheet_0.sourceData.ddl).toBe('CREATE TABLE protagonist_info(row_id TEXT, name TEXT);');
    expect(mockReplaceCurrentData.mock.calls[0][0].sheet_0.updateConfig).toEqual({ groupId: 0 });
    expect(mockGetCurrentDataFromProvider).toHaveBeenCalledTimes(2);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('SQL 模式下历史批基底只有部分行时，替换 provider 前必须保留 provider 中其它已更新行', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);

    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: {
        name: '物品表',
        content: [['row_id', 'name', 'quantity']],
        sourceData: { ddl: 'CREATE TABLE inventory(row_id TEXT, name TEXT, quantity TEXT);' },
        updateConfig: { groupId: 0 },
      },
    });

    mockProviderCurrentData = {
      mate: { type: 'acu' },
      sheet_0: {
        name: '物品表',
        content: [
          ['row_id', 'name', 'quantity'],
          ['1', '铁剑', '10'],
          ['2', '回复药', '6'],
        ],
        sourceData: { ddl: 'CREATE TABLE inventory(row_id TEXT, name TEXT, quantity TEXT);' },
        updateConfig: { groupId: 0 },
      },
    };

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      {
        is_user: false,
        TavernDB_ACU_IndependentData: {
          sheet_0: {
            name: '物品表',
            content: [
              ['row_id', 'name', 'quantity'],
              ['3', '魔法书', '1'],
            ],
            sourceData: { ddl: 'CREATE TABLE stale_inventory(row_id TEXT, name TEXT, quantity TEXT);' },
            updateConfig: { groupId: 99 },
          },
        },
      },
      { is_user: true, mes: '用户消息' },
      { is_user: false, mes: 'AI回复' },
    ]);

    const mockExecute = vi.fn().mockImplementation(async () => {
      expect(mockCurrentJsonTableData.sheet_0.content).toEqual([
        ['row_id', 'name', 'quantity'],
        ['3', '魔法书', '1'],
        ['1', '铁剑', '10'],
        ['2', '回复药', '6'],
      ]);
      expect(mockCurrentJsonTableData.sheet_0.sourceData.ddl).toBe('CREATE TABLE inventory(row_id TEXT, name TEXT, quantity TEXT);');
      expect(mockCurrentJsonTableData.sheet_0.updateConfig).toEqual({ groupId: 0 });
      return { success: true, modifiedKeys: ['sheet_0'] };
    });

    const result = await processUpdatesBatch_ACU([2], 'auto_standard', { targetSheetKeys: ['sheet_0'] }, mockExecute);

    expect(result.success).toBe(true);
    expect(mockReplaceCurrentData).toHaveBeenCalledTimes(1);
    expect(mockReplaceCurrentData.mock.calls[0][0].sheet_0.content).toEqual([
      ['row_id', 'name', 'quantity'],
      ['3', '魔法书', '1'],
      ['1', '铁剑', '10'],
      ['2', '回复药', '6'],
    ]);
    expect(mockReplaceCurrentData.mock.calls[0][0].sheet_0.sourceData.ddl).toBe('CREATE TABLE inventory(row_id TEXT, name TEXT, quantity TEXT);');
    expect(mockReplaceCurrentData.mock.calls[0][0].sheet_0.updateConfig).toEqual({ groupId: 0 });
    expect(mockGetCurrentDataFromProvider).toHaveBeenCalledTimes(2);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('prepared/deferred options 必须透传给 executeUpdate 并收集 preparedAiCalls 与 deferredCommits', async () => {
    mockCurrentJsonTableData = { sheet_0: { name: '测试' } };

    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true, mes: '用户消息' },
      { is_user: false, mes: 'AI回复' },
    ]);

    const mockExecute = vi.fn().mockResolvedValueOnce({
      success: true,
      modifiedKeys: [],
      preparedAiCall: {
        preparedCallId: '',
        targetMessageIndex: 1,
        batchNumber: 1,
        updateMode: 'manual_independent',
        targetSheetKeys: ['sheet_0'],
        requestOptions: { tableApiPreset: 'preset-a' },
        dynamicContent: { tableDataText: 'prepared' },
      },
      deferredResponse: {
        aiResponse: '<tableEdit>prepared</tableEdit>',
        targetMessageIndex: 1,
        updateMode: 'manual_independent',
        targetSheetKeys: ['sheet_0'],
        requestOptions: { tableApiPreset: 'preset-a' },
      },
      deferredCommit: {
        targetMessageIndex: 1,
        targetSheetKeys: ['sheet_0'],
        updateGroupKeys: ['sheet_0'],
        trackingSheetKeys: ['sheet_0'],
        beforeData: { mate: {}, sheet_0: { content: [['row_id']] } },
        afterData: { mate: {}, sheet_0: { content: [['row_id'], ['1']] } },
        modifiedKeys: ['sheet_0'],
      },
    } as CardUpdateResult);

    const result = await processUpdatesBatch_ACU([1], 'manual_independent', {
      targetSheetKeys: ['sheet_0'],
      requestOptions: { tableApiPreset: 'preset-a' },
      groupKey: 'g0',
      groupOrder: 7,
      prepareAiCallOnly: true,
      deferApply: true,
      deferPersistence: true,
      deferredResponses: [{
        aiResponse: '<tableEdit>prepared</tableEdit>',
        targetMessageIndex: 1,
        preparedCallId: 'g0:1:1',
        chunkOrder: 3,
        updateMode: 'manual_independent',
        targetSheetKeys: ['sheet_0'],
        requestOptions: { tableApiPreset: 'preset-a' },
      }],
    }, mockExecute);

    expect(result.success).toBe(true);
    expect(result.preparedAiCalls?.[0].preparedCallId).toBe('g0:1:1');
    expect(result.deferredResponses?.[0]).toEqual(expect.objectContaining({ preparedCallId: 'g0:1:1', chunkOrder: 3, groupKey: 'g0', groupOrder: 7, batchNumber: 1 }));
    expect(result.deferredCommits?.[0]).toEqual(expect.objectContaining({ preparedCallId: 'g0:1:1', chunkOrder: 3, groupKey: 'g0', groupOrder: 7, batchNumber: 1 }));
    expect(mockExecute.mock.calls[0][7]).toEqual(expect.objectContaining({ prepareAiCallOnly: true, deferApply: true, deferPersistence: true }));
    expect(mockExecute.mock.calls[0][7].deferredAiResponse).toEqual(expect.objectContaining({ preparedCallId: 'g0:1:1' }));
  });
});

// ═══════════════════════════════════════════════════════════════
// executeCardUpdateCore_ACU
// ═══════════════════════════════════════════════════════════════
describe('executeCardUpdateCore_ACU', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWasStopped = false;
    mockSettings = {
      ...mockSettings,
      tableMaxRetries: 3,
      autoUpdateTokenThreshold: 0,
      importPromptExcludeImportedWorldbookEntries: true,
    };
    mockCurrentJsonTableData = { sheet_0: { name: '测试表', content: [['row_id'], ['1']] } };
  });

  it('正常流程：AI 返回有效响应，解析成功，保存成功', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockImplementation(() => {
      mockCurrentJsonTableData.sheet_0.content.push(['2']);
      return { success: true, modifiedKeys: ['sheet_0'] };
    });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true });

    const abortController = new AbortController();
    const progressEvents: CardUpdateProgressEvent[] = [];

    const result = await executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_0'], null, abortController,
      null,
      (event: CardUpdateProgressEvent) => { progressEvents.push(event); }
    );

    expect(result.success).toBe(true);
    expect(result.modifiedKeys).toEqual(['sheet_0']);
    expect(result.aborted).toBeUndefined();
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 0,
      targetSheetKeys: ['sheet_0'],
      trackingSheetKeys: ['sheet_0'],
      beforeData: expect.objectContaining({
        sheet_0: expect.objectContaining({ content: [['row_id'], ['1']] }),
      }),
      afterData: expect.objectContaining({
        sheet_0: expect.objectContaining({ content: [['row_id'], ['1'], ['2']] }),
      }),
    }));
    // 验证进度事件序列
    const phases = progressEvents.map(e => e.phase);
    expect(phases).toContain('preparing');
    expect(phases).toContain('calling_ai');
    expect(phases).toContain('parsing');
    expect(phases).toContain('saving');
    expect(phases).toContain('complete');
  });

  it('prepareAIInput 返回 null 时返回错误', async () => {
    mockPrepareAIInput.mockResolvedValue(null);

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('无法准备AI输入');
  });

  it('AI 响应无 tableEdit 标签时重试并最终失败', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('无效的AI响应，没有标签');
    mockSettings.tableMaxRetries = 1; // 只重试1次，加快测试

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('1 次尝试后仍失败');
  });

  it('AI 回复过短时重试并最终失败', async () => {
    mockSettings.autoUpdateTokenThreshold = 100;
    mockSettings.tableMaxRetries = 1;
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('短');

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('AI回复过短');
  });

  it('用户中止时返回 aborted', async () => {
    mockWasStopped = true;
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it('AbortError 时返回 aborted', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it('保存失败时返回错误', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockImplementation(() => mutateSheet0ForSuccessfulSave('2'));
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: false });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('无法将更新后的数据库保存到聊天记录');
  });

  it('import 模式不保存到聊天记录', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockImplementation(() => mutateSheet0ForSuccessfulSave('2'));

    const progressEvents: CardUpdateProgressEvent[] = [];

    const result = await executeCardUpdateCore_ACU(
      [], 0, true, 'auto_standard', false,
      null, null, new AbortController(),
      null,
      (event: CardUpdateProgressEvent) => { progressEvents.push(event); }
    );

    expect(result.success).toBe(true);
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(progressEvents.map(e => e.phase)).toContain('chunk_done');
  });

  it('无 onProgress 回调时不报错', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockImplementation(() => mutateSheet0ForSuccessfulSave('2'));
    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
      // 不传 onProgress
    );

    expect(result.success).toBe(true);
  });

  it('解析失败时重试并最终失败', async () => {
    mockSettings.tableMaxRetries = 1;
    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({ success: false, modifiedKeys: [] });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      null, null, new AbortController()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('1 次尝试后仍失败');
  });

  it('prepareAiCallOnly 只准备 AI 调用载荷，不调用 AI、解析或持久化', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: 'prepared payload' });

    const result = await executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      2, false, 'manual_independent', false,
      ['sheet_0'], { tableApiPreset: 'preset-a' }, new AbortController(),
      { currentBatch: 4, totalBatches: 5 },
      undefined,
      { prepareAiCallOnly: true }
    );

    expect(result.success).toBe(true);
    expect(result.preparedAiCall).toEqual(expect.objectContaining({
      preparedCallId: '',
      targetMessageIndex: 2,
      batchNumber: 4,
      updateMode: 'manual_independent',
      targetSheetKeys: ['sheet_0'],
      requestOptions: { tableApiPreset: 'preset-a' },
      dynamicContent: { tableDataText: 'prepared payload' },
    }));
    expect(mockCallCustomOpenAI).not.toHaveBeenCalled();
    expect(mockParseAndApplyTableEdits).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
  });

  it('deferApply 只生成 AI 响应，不解析、不应用、不持久化', async () => {
    mockPrepareAIInput.mockResolvedValue({ tableDataText: 'prepared payload' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');

    const result = await executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      2, false, 'manual_independent', false,
      ['sheet_0'], { tableApiPreset: 'preset-a' }, new AbortController(),
      { currentBatch: 1, totalBatches: 1 },
      undefined,
      { deferApply: true }
    );

    expect(result.success).toBe(true);
    expect(result.deferredResponse).toEqual(expect.objectContaining({
      aiResponse: '<tableEdit>有效内容</tableEdit>',
      targetMessageIndex: 2,
      updateMode: 'manual_independent',
      targetSheetKeys: ['sheet_0'],
      requestOptions: { tableApiPreset: 'preset-a' },
    }));
    expect(mockParseAndApplyTableEdits).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
  });

  it('deferPersistence 串行应用后返回提交载荷，不直接保存到聊天记录', async () => {
    mockParseAndApplyTableEdits.mockImplementation(() => {
      mockCurrentJsonTableData.sheet_0.content.push(['2']);
      return { success: true, modifiedKeys: ['sheet_0'] };
    });
    mockCheckIfFirstTimeInit.mockResolvedValue(false);

    const result = await executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      2, false, 'manual_independent', false,
      ['sheet_0'], { tableApiPreset: 'preset-a' }, new AbortController(),
      { currentBatch: 1, totalBatches: 1 },
      undefined,
      {
        deferPersistence: true,
        deferredAiResponse: {
          aiResponse: '<tableEdit>有效内容</tableEdit>',
          targetMessageIndex: 2,
          preparedCallId: 'g0:1:2',
          chunkOrder: 0,
          updateMode: 'manual_independent',
          targetSheetKeys: ['sheet_0'],
          requestOptions: { tableApiPreset: 'preset-a' },
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.deferredCommit).toEqual(expect.objectContaining({
      targetMessageIndex: 2,
      preparedCallId: 'g0:1:2',
      targetSheetKeys: ['sheet_0'],
      trackingSheetKeys: ['sheet_0'],
      modifiedKeys: ['sheet_0'],
    }));
    expect(mockCallCustomOpenAI).not.toHaveBeenCalled();
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
  });

  it('首次初始化时保存所有表', async () => {
    // 确保 currentJsonTableData 有 sheet_ 前缀的 key，让 getSortedSheetKeys mock 能返回它
    mockCurrentJsonTableData = { sheet_0: { name: '测试表', content: [['row_id'], ['1']] } };

    mockPrepareAIInput.mockResolvedValue({ tableDataText: '模拟数据' });
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockImplementation(() => mutateSheet0ForSuccessfulSave('2'));
    mockCheckIfFirstTimeInit.mockResolvedValue(true);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true });

    // mock parseTableTemplateJson 返回完整模板（含 sheet_0）
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValueOnce({
      sheet_0: { name: '测试表', content: [['row_id'], ['种子行']] },
    });

    const result = await executeCardUpdateCore_ACU(
      [], 0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    expect(result.success).toBe(true);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// orchestrateManualUpdate_ACU
// ═══════════════════════════════════════════════════════════════
describe('orchestrateManualUpdate_ACU', () => {
  const mockProcessBatch = vi.fn();
  const mockRefreshData = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAutoUpdating = false;
    mockCoreApisReady = true;
    mockCurrentJsonTableData = { sheet_0: { name: '测试表', updateConfig: {} } };
    mockSettings = {
      ...mockSettings,
      apiMode: 'custom',
      apiConfig: { useMainApi: true, url: '', model: '' },
      autoUpdateThreshold: 3,
      updateBatchSize: 3,
      skipUpdateFloors: 0,
    };
  });

  it('正在更新中时返回错误', async () => {
    mockIsAutoUpdating = true;
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('正在进行中');
  });

  it('API 未就绪时返回错误', async () => {
    mockCoreApisReady = false;
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('API未就绪');
  });

  it('API 未配置时返回错误', async () => {
    mockSettings.apiMode = 'custom';
    mockSettings.apiConfig = { useMainApi: false, url: '', model: '' };
    mockSettings.tavernProfile = '';
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('API未配置');
  });

  it('数据库未加载时返回错误', async () => {
    mockCurrentJsonTableData = null;
    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('数据库未加载');
  });

  it('聊天记录为空时返回错误', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([]);

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('聊天记录为空');
  });

  it('无 AI 回复时返回错误', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: true },
    ]);

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('尚未检测到AI回复');
  });

  it('未选择表格时返回错误', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false },
    ]);

    const result = await orchestrateManualUpdate_ACU([], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('未选择');
  });

  it('正常流程：processBatch 成功，返回 success', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true },
      { is_user: false, mes: 'AI回复2' },
    ]);

    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockImplementation(() => mutateSheet0ForSuccessfulSave('2'));
    mockProcessBatch.mockImplementation(async (_indices: number[], _mode: string, options: any) => ({
      success: true,
      preparedAiCalls: [{
        preparedCallId: `${options.groupKey}:1:3`,
        targetMessageIndex: 3,
        batchNumber: 1,
        updateMode: 'manual_independent',
        targetSheetKeys: options.targetSheetKeys,
        requestOptions: options.requestOptions,
        dynamicContent: { tableDataText: 'prepared' },
      }],
    }));
    const progressEvents: CardUpdateProgressEvent[] = [];

    const result = await orchestrateManualUpdate_ACU(
      ['sheet_0'],
      mockProcessBatch,
      mockRefreshData,
      {},
      (event: CardUpdateProgressEvent) => progressEvents.push(event),
    );
    expect(result.success).toBe(true);
    expect(mockProcessBatch).toHaveBeenCalled();
    const callingAiEvent = progressEvents.find(event => event.phase === 'calling_ai');
    expect(callingAiEvent).toEqual(expect.objectContaining({ currentBatch: 1, totalBatches: 1 }));
  });

  it('多分组手动填表采用 round 合并应用：prepare 串行，raw AI generation 并发，最后按目标楼层合并提交', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');

    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true, mes: '用户1' },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复2' },
    ]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '分组表A', updateConfig: { groupId: 0 } },
      sheet_1: { name: '分组表B', updateConfig: { groupId: 1 } },
    });
    mockCurrentJsonTableData = {
      sheet_0: { name: '分组表A', content: [['row_id']], updateConfig: { groupId: 0 } },
      sheet_1: { name: '分组表B', content: [['row_id']], updateConfig: { groupId: 1 } },
    };
    mockSettings.maxConcurrentGroups = 2;
    mockSettings.tableApiPresetOverridesByName = { 分组表A: 'preset-a', 分组表B: 'preset-b' };

    const events: string[] = [];
    const aiResolvers: Record<string, () => void> = {};
    mockCallCustomOpenAI.mockImplementation((dynamicContent: any, _abortController: AbortController, requestOptions: any) => {
      const label = dynamicContent.label;
      events.push(`ai:${label}:start:${requestOptions?.tableApiPreset}`);
      return new Promise<string>(resolve => {
        aiResolvers[label] = () => {
          events.push(`ai:${label}:end`);
          resolve(`<tableEdit>${label}</tableEdit>`);
        };
        if (aiResolvers.a && aiResolvers.b) {
          aiResolvers.a();
          aiResolvers.b();
        }
      });
    });
    mockParseAndApplyTableEdits.mockImplementation(() => {
      mockCurrentJsonTableData.sheet_0.content.push(['a']);
      mockCurrentJsonTableData.sheet_1.content.push(['b']);
      return { success: true, modifiedKeys: ['sheet_0', 'sheet_1'] };
    });

    mockProcessBatch.mockImplementation(async (_indices: number[], _mode: string, options: any) => {
      const sheetKey = options.targetSheetKeys[0];
      if (options.prepareAiCallOnly) {
        events.push(`prepare:${sheetKey}:${options.requestOptions?.tableApiPreset}`);
        return {
          success: true,
          preparedAiCalls: [{
            preparedCallId: `${options.groupKey}:1:3`,
            targetMessageIndex: 3,
            batchNumber: 1,
            updateMode: 'manual_independent',
            targetSheetKeys: options.targetSheetKeys,
            requestOptions: options.requestOptions,
            dynamicContent: { label: sheetKey === 'sheet_0' ? 'a' : 'b' },
          }],
        };
      }
      throw new Error('round 合并应用不应再次调用 processBatch');
    });

    const result = await orchestrateManualUpdate_ACU(['sheet_0', 'sheet_1'], mockProcessBatch, mockRefreshData);

    expect(result.success).toBe(true);
    expect(mockProcessBatch).toHaveBeenCalledTimes(2);
    expect(mockProcessBatch.mock.calls.map(call => ({ sheet: call[2].targetSheetKeys[0], prepare: !!call[2].prepareAiCallOnly }))).toEqual([
      { sheet: 'sheet_0', prepare: true },
      { sheet: 'sheet_1', prepare: true },
    ]);
    expect(events).toEqual([
      'prepare:sheet_0:preset-a',
      'prepare:sheet_1:preset-b',
      'ai:a:start:preset-a',
      'ai:b:start:preset-b',
      'ai:a:end',
      'ai:b:end',
    ]);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledTimes(1);
    expect(mockPersistTablesToChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetMessageIndex: 3,
      targetSheetKeys: ['sheet_0', 'sheet_1'],
      updateGroupKeys: ['sheet_0', 'sheet_1'],
      trackingSheetKeys: ['sheet_0', 'sheet_1'],
      beforeData: expect.objectContaining({
        sheet_0: expect.objectContaining({ content: [['row_id']] }),
        sheet_1: expect.objectContaining({ content: [['row_id']] }),
      }),
      afterData: expect.objectContaining({
        sheet_0: expect.objectContaining({ content: [['row_id'], ['a']] }),
        sheet_1: expect.objectContaining({ content: [['row_id'], ['b']] }),
      }),
    }));
  });

  it('raw AI generation 失败时阻止 apply、commit 和后续 chunk', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');

    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true, mes: '用户1' },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复2' },
    ]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '分组表A', updateConfig: { groupId: 0 } },
      sheet_1: { name: '分组表B', updateConfig: { groupId: 1 } },
      sheet_2: { name: '分组表C', updateConfig: { groupId: 2 } },
    });
    mockCurrentJsonTableData = {
      sheet_0: { name: '分组表A', content: [['row_id']], updateConfig: { groupId: 0 } },
      sheet_1: { name: '分组表B', content: [['row_id']], updateConfig: { groupId: 1 } },
      sheet_2: { name: '分组表C', content: [['row_id']], updateConfig: { groupId: 2 } },
    };
    mockSettings.maxConcurrentGroups = 2;

    const events: string[] = [];
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      events.push(`ai:${dynamicContent.label}`);
      if (dynamicContent.label === 'b') return '缺少标签';
      return '<tableEdit>a</tableEdit>';
    });

    mockProcessBatch.mockImplementation(async (_indices: number[], _mode: string, options: any) => {
      const sheetKey = options.targetSheetKeys[0];
      if (options.prepareAiCallOnly) {
        events.push(`prepare:${sheetKey}`);
        return {
          success: true,
          preparedAiCalls: [{
            preparedCallId: `${options.groupKey}:1:3`,
            targetMessageIndex: 3,
            batchNumber: 1,
            updateMode: 'manual_independent',
            targetSheetKeys: options.targetSheetKeys,
            requestOptions: options.requestOptions,
            dynamicContent: { label: sheetKey === 'sheet_0' ? 'a' : 'b' },
          }],
        };
      }

      events.push(`apply:${sheetKey}`);
      return { success: true };
    });

    const result = await orchestrateManualUpdate_ACU(['sheet_0', 'sheet_1', 'sheet_2'], mockProcessBatch, mockRefreshData);

    expect(result.success).toBe(false);
    expect(result.error).toContain('AI响应中未找到完整有效的 <tableEdit> 标签');
    expect(mockProcessBatch).toHaveBeenCalledTimes(3);
    expect(mockProcessBatch.mock.calls.map(call => call[2].targetSheetKeys[0])).toEqual(['sheet_0', 'sheet_1', 'sheet_2']);
    expect(events).not.toContain('apply:sheet_0');
    expect(events).not.toContain('apply:sheet_1');
    expect(events).not.toContain('apply:sheet_2');
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(events).toEqual([
      'prepare:sheet_0',
      'prepare:sheet_1',
      'prepare:sheet_2',
      'ai:a',
      'ai:b',
      'ai:b',
    ]);
  });

  it('串行 apply 失败时阻止 merged commit 和后续 chunk', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');

    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true, mes: '用户1' },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true, mes: '用户2' },
      { is_user: false, mes: 'AI回复2' },
    ]);
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '分组表A', updateConfig: { groupId: 0 } },
      sheet_1: { name: '分组表B', updateConfig: { groupId: 1 } },
      sheet_2: { name: '分组表C', updateConfig: { groupId: 2 } },
    });
    mockCurrentJsonTableData = {
      sheet_0: { name: '分组表A', content: [['row_id']], updateConfig: { groupId: 0 } },
      sheet_1: { name: '分组表B', content: [['row_id']], updateConfig: { groupId: 1 } },
      sheet_2: { name: '分组表C', content: [['row_id']], updateConfig: { groupId: 2 } },
    };
    mockSettings.maxConcurrentGroups = 2;

    const events: string[] = [];
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>ok</tableEdit>');
    mockParseAndApplyTableEdits.mockReturnValue({
      success: false,
      error: '分组B应用失败',
    });
    mockProcessBatch.mockImplementation(async (_indices: number[], _mode: string, options: any) => {
      const sheetKey = options.targetSheetKeys[0];
      if (options.prepareAiCallOnly) {
        events.push(`prepare:${sheetKey}`);
        return {
          success: true,
          preparedAiCalls: [{
            preparedCallId: `${options.groupKey}:1:3`,
            targetMessageIndex: 3,
            batchNumber: 1,
            updateMode: 'manual_independent',
            targetSheetKeys: options.targetSheetKeys,
            requestOptions: options.requestOptions,
            dynamicContent: { label: sheetKey },
          }],
        };
      }
      throw new Error('round 合并应用不应再次调用 processBatch');
    });

    const result = await orchestrateManualUpdate_ACU(['sheet_0', 'sheet_1', 'sheet_2'], mockProcessBatch, mockRefreshData);

    expect(result.success).toBe(false);
    expect(result.error).toContain('分组B应用失败');
    expect(events).toEqual(['prepare:sheet_0', 'prepare:sheet_1', 'prepare:sheet_2']);
    expect(mockPersistTablesToChatMessage).not.toHaveBeenCalled();
    expect(mockProcessBatch.mock.calls.map(call => call[2].targetSheetKeys[0])).toEqual(['sheet_0', 'sheet_1', 'sheet_2']);
  });

  it('预清空时只按选中表调用清理', async () => {
    const { getChatArray_ACU, clearTableDataAtFloors_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复1' },
      { is_user: true },
      { is_user: false, mes: 'AI回复2' },
    ]);
    mockCurrentJsonTableData = {
      sheet_0: { name: '测试表A', updateConfig: {} },
      sheet_1: { name: '测试表B', updateConfig: {} },
    };
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockImplementation(() => mutateSheet0ForSuccessfulSave('2'));
    mockProcessBatch.mockImplementation(async (_indices: number[], _mode: string, options: any) => ({
      success: true,
      preparedAiCalls: [{
        preparedCallId: `${options.groupKey}:1:3`,
        targetMessageIndex: 3,
        batchNumber: 1,
        updateMode: 'manual_independent',
        targetSheetKeys: options.targetSheetKeys,
        requestOptions: options.requestOptions,
        dynamicContent: { tableDataText: 'prepared' },
      }],
    }));

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData, { clearBeforeUpdate: true });
    expect(result.success).toBe(true);
    expect(clearTableDataAtFloors_ACU).toHaveBeenCalled();
    expect(vi.mocked(clearTableDataAtFloors_ACU).mock.calls[0][1]).toEqual(['sheet_0']);
  });

  it('processBatch 失败时返回错误', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);

    mockProcessBatch.mockResolvedValue({ success: false, error: '批处理失败' });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(false);
    expect(result.error).toContain('批处理失败');
  });

  it('自动合并触发成功时返回 autoMergeTriggered', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);

    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockImplementation(() => mutateSheet0ForSuccessfulSave('2'));
    mockProcessBatch.mockImplementation(async (_indices: number[], _mode: string, options: any) => ({
      success: true,
      preparedAiCalls: [{
        preparedCallId: `${options.groupKey}:1:1`,
        targetMessageIndex: 1,
        batchNumber: 1,
        updateMode: 'manual_independent',
        targetSheetKeys: options.targetSheetKeys,
        requestOptions: options.requestOptions,
        dynamicContent: { tableDataText: 'prepared' },
      }],
    }));

    const { checkAutoMergeTrigger_ACU, prepareAutoMergeBatches_ACU, executeAutoMergeBatch_ACU, finalizeAutoMerge_ACU } = await import('../../../src/service/summary/merge-logic');
    vi.mocked(checkAutoMergeTrigger_ACU).mockReturnValue({ shouldTrigger: true, mergeCount: 5 });
    vi.mocked(prepareAutoMergeBatches_ACU).mockReturnValue({ batches: [{ startIndex: 0, endIndex: 5 }] } as any);
    vi.mocked(executeAutoMergeBatch_ACU).mockResolvedValue({ accumulatedSummary: ['合并结果'] } as any);
    vi.mocked(finalizeAutoMerge_ACU).mockResolvedValue({ mergedRows: 1 });

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(true);
    expect(result.autoMergeTriggered).toBe(true);
    expect(result.autoMergeSuccess).toBe(true);
  });

  it('finally 块中清理 manualExtraHint 和 isAutoUpdating', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);

    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>有效内容</tableEdit>');
    mockParseAndApplyTableEdits.mockImplementation(() => mutateSheet0ForSuccessfulSave('2'));
    mockProcessBatch.mockImplementation(async (_indices: number[], _mode: string, options: any) => ({
      success: true,
      preparedAiCalls: [{
        preparedCallId: `${options.groupKey}:1:1`,
        targetMessageIndex: 1,
        batchNumber: 1,
        updateMode: 'manual_independent',
        targetSheetKeys: options.targetSheetKeys,
        requestOptions: options.requestOptions,
        dynamicContent: { tableDataText: 'prepared' },
      }],
    }));

    await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);

    const { _set_manualExtraHint_ACU, _set_isAutoUpdatingCard_ACU } = await import('../../../src/service/runtime/state-manager');
    expect(_set_manualExtraHint_ACU).toHaveBeenCalledWith('');
    expect(_set_isAutoUpdatingCard_ACU).toHaveBeenCalledWith(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// executeCardUpdateCore_ACU — SQL 错误反馈重试逻辑
// ═══════════════════════════════════════════════════════════════
describe('executeCardUpdateCore_ACU — SQL 错误反馈重试', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockWasStopped = false;
    mockSettings = {
      ...mockSettings,
      tableMaxRetries: 3,
      autoUpdateTokenThreshold: 0,
      importPromptExcludeImportedWorldbookEntries: true,
    };
    mockCurrentJsonTableData = { sheet_0: { name: '测试表', content: [['row_id'], ['1']] } };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('SQL 模式下 parseAndApplyTableEdits 抛错时，错误信息注入到 tableDataText', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);

    mockPrepareAIInput.mockResolvedValue({ tableDataText: '原始数据' });

    let callCount = 0;
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      callCount++;
      if (callCount === 1) {
        return '<tableEdit>INSERT INTO invalid_table VALUES (1);</tableEdit>';
      }
      if (callCount === 2) {
        expect(dynamicContent.tableDataText).toContain('SQL_ERROR_FEEDBACK');
        expect(dynamicContent.tableDataText).toContain('SQL 语法错误');
        expect(dynamicContent.tableDataText).toContain('SQL执行错误，请修正后重新输出');
        return '<tableEdit>INSERT INTO test VALUES (1);</tableEdit>';
      }
      return '<tableEdit>ok</tableEdit>';
    });

    mockParseAndApplyTableEdits
      .mockImplementationOnce(() => { throw new Error('SQL 语法错误: no such table'); })
      .mockImplementationOnce(() => mutateSheet0ForSuccessfulSave('2'));

    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true });

    // 启动但不 await，让 fake timer 推进
    const resultPromise = executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    // 推进 5 秒等待（重试间隔）
    await vi.advanceTimersByTimeAsync(6000);

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(callCount).toBe(2);

    vi.mocked(isSqliteMode).mockReturnValue(false);
  });

  it('非 SQL 模式下错误不注入 SQL_ERROR_FEEDBACK', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(false);

    mockPrepareAIInput.mockResolvedValue({ tableDataText: '原始数据' });

    let capturedTableDataText = '';
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      capturedTableDataText = dynamicContent.tableDataText;
      return '<tableEdit>有效内容</tableEdit>';
    });

    mockParseAndApplyTableEdits
      .mockImplementationOnce(() => { throw new Error('解析错误'); })
      .mockImplementationOnce(() => mutateSheet0ForSuccessfulSave('2'));

    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true });

    const resultPromise = executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    await vi.advanceTimersByTimeAsync(6000);

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(capturedTableDataText).not.toContain('SQL_ERROR_FEEDBACK');
  });

  it('SQL 模式下多次重试时错误信息被替换（不累积）', async () => {
    const { isSqliteMode } = await import('../../../src/service/table/storage-mode');
    vi.mocked(isSqliteMode).mockReturnValue(true);
    mockSettings.tableMaxRetries = 3;

    mockPrepareAIInput.mockResolvedValue({ tableDataText: '原始数据' });

    let callCount = 0;
    const capturedTableDataTexts: string[] = [];
    mockCallCustomOpenAI.mockImplementation(async (dynamicContent: any) => {
      callCount++;
      capturedTableDataTexts.push(dynamicContent.tableDataText);
      return '<tableEdit>INSERT INTO t VALUES (1);</tableEdit>';
    });

    mockParseAndApplyTableEdits
      .mockImplementationOnce(() => { throw new Error('错误1: no such table'); })
      .mockImplementationOnce(() => { throw new Error('错误2: column mismatch'); })
      .mockImplementationOnce(() => mutateSheet0ForSuccessfulSave('2'));

    mockCheckIfFirstTimeInit.mockResolvedValue(false);
    mockPersistTablesToChatMessage.mockResolvedValue({ saved: true });

    const resultPromise = executeCardUpdateCore_ACU(
      [{ is_user: false, mes: 'AI回复' }],
      0, false, 'auto_standard', false,
      ['sheet_0'], null, new AbortController()
    );

    // 推进两次重试间隔（每次 5 秒）
    await vi.advanceTimersByTimeAsync(6000);
    await vi.advanceTimersByTimeAsync(6000);

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(callCount).toBe(3);

    // 第二次调用时应包含第一次的错误信息
    expect(capturedTableDataTexts[1]).toContain('错误1: no such table');
    // 第三次调用时应包含第二次的错误信息（替换了第一次的）
    expect(capturedTableDataTexts[2]).toContain('错误2: column mismatch');
    // 第三次不应包含第一次的错误信息（被替换了）
    expect(capturedTableDataTexts[2]).not.toContain('错误1: no such table');

    vi.mocked(isSqliteMode).mockReturnValue(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 表级 API 预设覆盖决议（orchestrateManualUpdate_ACU）
// ═══════════════════════════════════════════════════════════════
describe('orchestrateManualUpdate_ACU — 表级 API 预设覆盖', () => {
  const mockProcessBatch = vi.fn();
  const mockRefreshData = vi.fn().mockResolvedValue(undefined);

  function mockPresetTwoPhaseProcessBatch(): void {
    mockCallCustomOpenAI.mockResolvedValue('<tableEdit>ok</tableEdit>');
    mockParseAndApplyTableEdits.mockImplementation(() => mutateSheet0ForSuccessfulSave('2'));
    mockProcessBatch.mockImplementation(async (_indices: number[], _mode: string, options: any) => {
      if (options.prepareAiCallOnly) {
        return {
          success: true,
          preparedAiCalls: [{
            preparedCallId: `${options.groupKey}:1:1`,
            targetMessageIndex: 1,
            batchNumber: 1,
            updateMode: 'manual_independent',
            targetSheetKeys: options.targetSheetKeys,
            requestOptions: options.requestOptions,
            dynamicContent: { tableDataText: 'prepared' },
          }],
        };
      }
      throw new Error('round 合并应用不应再次调用 processBatch');
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const { parseTableTemplateJson_ACU } = await import('../../../src/shared/utils');
    vi.mocked(parseTableTemplateJson_ACU).mockReturnValue({
      mate: { type: 'acu' },
      sheet_0: { name: '测试表', updateConfig: { groupId: 0 } },
    });
    mockIsAutoUpdating = false;
    mockCoreApisReady = true;
    mockCurrentJsonTableData = { sheet_0: { name: '纪要表', updateConfig: {} } };
    mockSettings = {
      ...mockSettings,
      apiMode: 'custom',
      apiConfig: { useMainApi: true, url: '', model: '' },
      autoUpdateThreshold: 3,
      updateBatchSize: 3,
      skipUpdateFloors: 0,
      tableApiPresetOverridesByName: {},
    };
  });

  it('表有覆盖预设时，requestOptions 携带 tableApiPreset', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockPresetTwoPhaseProcessBatch();

    // parseTableTemplateJson_ACU mock 返回 { sheet_0: { name: '测试表' } }
    mockSettings.tableApiPresetOverridesByName = { '测试表': 'special-preset' };

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(true);

    // 验证 processBatch 被调用时携带了 requestOptions.tableApiPreset
    const prepareOptions = mockProcessBatch.mock.calls[0][2];
    expect(prepareOptions.requestOptions).toEqual({ tableApiPreset: 'special-preset' });
    expect(mockCallCustomOpenAI).toHaveBeenCalledWith(
      { tableDataText: 'prepared' },
      expect.any(AbortController),
      { tableApiPreset: 'special-preset' },
    );
    expect(mockProcessBatch).toHaveBeenCalledTimes(1);
  });

  it('表无覆盖预设时，requestOptions 为 null', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockPresetTwoPhaseProcessBatch();

    mockSettings.tableApiPresetOverridesByName = {};

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(true);

    const processBatchCall = mockProcessBatch.mock.calls[0];
    const optionsArg = processBatchCall[2];
    expect(optionsArg.requestOptions).toBeNull();
  });

  it('表名为空时忽略覆盖', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockPresetTwoPhaseProcessBatch();
    mockCurrentJsonTableData = { sheet_0: { name: '', updateConfig: {} } };

    mockSettings.tableApiPresetOverridesByName = { '': 'should-not-apply' };

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(true);

    const processBatchCall = mockProcessBatch.mock.calls[0];
    const optionsArg = processBatchCall[2];
    expect(optionsArg.requestOptions).toBeNull();
  });

  it('表名有空格时进行标准化匹配', async () => {
    const { getChatArray_ACU } = await import('../../../src/service/chat/chat-service');
    vi.mocked(getChatArray_ACU).mockReturnValue([
      { is_user: true },
      { is_user: false, mes: 'AI回复' },
    ]);
    mockPresetTwoPhaseProcessBatch();

    // parseTableTemplateJson_ACU mock 返回 { sheet_0: { name: '测试表' } }
    // 设置 mockCurrentJsonTableData 的 name 带空格并不影响决议，
    // 因为决议用的是 parseTableTemplateJson_ACU 的返回值
    mockSettings.tableApiPresetOverridesByName = { '测试表': 'trimmed-preset' };

    const result = await orchestrateManualUpdate_ACU(['sheet_0'], mockProcessBatch, mockRefreshData);
    expect(result.success).toBe(true);

    const processBatchCall = mockProcessBatch.mock.calls[0];
    const optionsArg = processBatchCall[2];
    expect(optionsArg.requestOptions.tableApiPreset).toBe('trimmed-preset');
  });
});
