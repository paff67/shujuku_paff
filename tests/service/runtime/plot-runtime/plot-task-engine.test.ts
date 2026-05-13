import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockSettings,
  mockAbortControllerRef,
  mockCurrentJsonTableDataRef,
  mockPlanningGuard,
  mockSetTempPlotToSave,
  mockSetCurrentJsonTableData,
  mockGetApiConfigByPreset,
  mockCallApi,
  mockCallApiWithPlotPreset,
  mockGetCharLorebooks,
  mockGetChatArray,
  mockGetPersonaDescription,
  mockGetCharDescription,
  mockBuildCombinedWorldbookContentByStrategy,
  mockEnsurePlotTasksCompat,
  mockGetPlotPromptContentById,
  mockNormalizePlotTask,
  mockNormalizePlotTasks,
  mockParseRandomTags,
  mockReplaceRandomVariables,
  mockGetLatestAIMessageContent,
  mockApplyContextTagFilters,
  mockApplyExcludeRulesToText,
  mockMergeAllIndependentTables,
  mockFormatSummaryIndexForPlot,
  mockFormatOutlineTableForPlot,
  mockGetNormalizedPlotMessageRole,
  mockTryRenderPlotTemplateWithEjs,
  mockRenderPlotTaskContentWithIsolatedVariables,
  mockExtractPlotTagsFromResponse,
  mockGetPlotPlaceholderTagNames,
  mockBuildPlotTagMapFromText,
  mockReplacePlotTagPlaceholders,
  mockAggregatePlotTaskTags,
  mockBuildPlotSaveContentFromTaskResults,
  mockBuildFinalPlotInjectionMessage,
  mockGetPlotFromHistory,
  mockSavePlotToLatestMessage,
  mockHashUserInput,
  mockIsEntryBlocked,
} = vi.hoisted(() => {
  const mockAbortControllerRef = { value: null as any };
  const mockCurrentJsonTableDataRef = {
    value: {
      sheet_0: {
        name: '纪要表',
        content: [['row_id', '内容'], ['1', '初始纪要']],
      },
    } as any,
  };

  return {
    mockSettings: {
      plotApiPreset: '',
      apiMode: 'custom',
      apiConfig: { useMainApi: true },
      plotSettings: {
        contextTurnCount: 2,
        contextExtractTags: '',
        contextExtractRules: [],
        contextExcludeTags: '',
        contextExcludeRules: [],
        loopSettings: { maxRetries: 3 },
      },
    } as any,
    mockAbortControllerRef,
    mockCurrentJsonTableDataRef,
    mockPlanningGuard: { ignoreNextGenerationEndedCount: 0 } as any,
    mockSetTempPlotToSave: vi.fn(),
    mockSetCurrentJsonTableData: vi.fn((value: any) => {
      mockCurrentJsonTableDataRef.value = value;
    }),
    mockGetApiConfigByPreset: vi.fn(),
    mockCallApi: vi.fn(),
    mockCallApiWithPlotPreset: vi.fn(),
    mockGetCharLorebooks: vi.fn(),
    mockGetChatArray: vi.fn(),
    mockGetPersonaDescription: vi.fn(),
    mockGetCharDescription: vi.fn(),
    mockBuildCombinedWorldbookContentByStrategy: vi.fn(),
    mockEnsurePlotTasksCompat: vi.fn(),
    mockGetPlotPromptContentById: vi.fn(),
    mockNormalizePlotTask: vi.fn(),
    mockNormalizePlotTasks: vi.fn(),
    mockParseRandomTags: vi.fn(),
    mockReplaceRandomVariables: vi.fn(),
    mockGetLatestAIMessageContent: vi.fn(),
    mockApplyContextTagFilters: vi.fn(),
    mockApplyExcludeRulesToText: vi.fn(),
    mockMergeAllIndependentTables: vi.fn(),
    mockFormatSummaryIndexForPlot: vi.fn(),
    mockFormatOutlineTableForPlot: vi.fn(),
    mockGetNormalizedPlotMessageRole: vi.fn(),
    mockTryRenderPlotTemplateWithEjs: vi.fn(),
    mockRenderPlotTaskContentWithIsolatedVariables: vi.fn(),
    mockExtractPlotTagsFromResponse: vi.fn(),
    mockGetPlotPlaceholderTagNames: vi.fn(),
    mockBuildPlotTagMapFromText: vi.fn(),
    mockReplacePlotTagPlaceholders: vi.fn(),
    mockAggregatePlotTaskTags: vi.fn(),
    mockBuildPlotSaveContentFromTaskResults: vi.fn(),
    mockBuildFinalPlotInjectionMessage: vi.fn(),
    mockGetPlotFromHistory: vi.fn(),
    mockSavePlotToLatestMessage: vi.fn(),
    mockHashUserInput: vi.fn((text: string) => `hash_${text}`),
    mockIsEntryBlocked: vi.fn((entry: any) => !!entry?.blocked),
  };
});

vi.mock('../../../../src/shared/defaults-json.js', () => ({
  DEFAULT_PLOT_SETTINGS_ACU: {
    loopSettings: { maxRetries: 3 },
  },
}));

vi.mock('../../../../src/service/ai/api-call', () => ({
  callApi_ACU: mockCallApi,
  callApiWithPlotPreset_ACU: mockCallApiWithPlotPreset,
  getApiConfigByPreset_ACU: mockGetApiConfigByPreset,
}));

vi.mock('../../../../src/service/runtime/state-manager', () => ({
  settings_ACU: mockSettings,
  planningGuard_ACU: mockPlanningGuard,
  _set_tempPlotToSave_ACU: mockSetTempPlotToSave,
  _set_currentJsonTableData_ACU: mockSetCurrentJsonTableData,
  get currentJsonTableData_ACU() {
    return mockCurrentJsonTableDataRef.value;
  },
  get abortController_ACU() {
    return mockAbortControllerRef.value;
  },
}));

vi.mock('../../../../src/data/gateways/character-gateway', () => ({
  getCharLorebooks_ACU: mockGetCharLorebooks,
}));

vi.mock('../../../../src/data/gateways/chat-gateway', () => ({
  getChatArray_ACU: mockGetChatArray,
}));

vi.mock('../../../../src/data/gateways/host-state-gateway', () => ({
  getPersonaDescription_ACU: mockGetPersonaDescription,
  getCharDescription_ACU: mockGetCharDescription,
}));

vi.mock('../../../../src/service/worldbook/pipeline', () => ({
  buildCombinedWorldbookContentByStrategy_ACU: mockBuildCombinedWorldbookContentByStrategy,
}));

vi.mock('../../../../src/shared/utils', () => ({
  escapeRegExp_ACU: (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  hashUserInput_ACU: mockHashUserInput,
  isEntryBlocked_ACU: mockIsEntryBlocked,
  logDebug_ACU: vi.fn(),
  logError_ACU: vi.fn(),
  logWarn_ACU: vi.fn(),
  normalizeNonNegativeInteger_ACU: (value: any, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : fallback;
  },
  normalizePositiveInteger_ACU: (value: any, fallback = 1) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
  },
  normalizeExcludeRules_ACU: (rules: any) => Array.isArray(rules) ? rules : [],
  normalizeExtractRules_ACU: (rules: any) => Array.isArray(rules) ? rules : [],
}));

vi.mock('../../../../src/service/plot/plot-logic', () => ({
  ensurePlotTasksCompat_ACU: mockEnsurePlotTasksCompat,
  getPlotPromptContentByIdFromSettings_ACU: mockGetPlotPromptContentById,
  normalizePlotTask_ACU: mockNormalizePlotTask,
  normalizePlotTasks_ACU: mockNormalizePlotTasks,
}));

vi.mock('../../../../src/service/runtime/template-vars', () => ({
  parseRandomTags_ACU: mockParseRandomTags,
  replaceRandomVariables_ACU: mockReplaceRandomVariables,
  getLatestAIMessageContent_ACU: mockGetLatestAIMessageContent,
  replaceDbSqlVariables: vi.fn((s: string) => s),
}));

vi.mock('../../../../src/service/runtime/helpers-context-tags', () => ({
  applyContextTagFilters_ACU: mockApplyContextTagFilters,
  applyExcludeRulesToText_ACU: mockApplyExcludeRulesToText,
}));

vi.mock('../../../../src/service/runtime/helpers-data-merge', () => ({
  mergeAllIndependentTables_ACU: mockMergeAllIndependentTables,
}));

vi.mock('../../../../src/service/runtime/plot-runtime/plot-data-format', () => ({
  formatTableDataForLLM_ACU: vi.fn(),
  formatOutlineTableForPlot_ACU: mockFormatOutlineTableForPlot,
  formatSummaryIndexForPlot_ACU: mockFormatSummaryIndexForPlot,
  getSummaryIndexContentForPlot_ACU: vi.fn(),
}));

vi.mock('../../../../src/service/runtime/plot-runtime/plot-tag-utils', () => ({
  getNormalizedPlotMessageRole_ACU: mockGetNormalizedPlotMessageRole,
  tryRenderPlotTemplateWithEjs_ACU: mockTryRenderPlotTemplateWithEjs,
  renderPlotTaskContentWithIsolatedVariables_ACU: mockRenderPlotTaskContentWithIsolatedVariables,
  extractPlotTagsFromResponse_ACU: mockExtractPlotTagsFromResponse,
  getPlotPlaceholderTagNames_ACU: mockGetPlotPlaceholderTagNames,
  buildPlotTagMapFromText_ACU: mockBuildPlotTagMapFromText,
  replacePlotTagPlaceholders_ACU: mockReplacePlotTagPlaceholders,
  sortPlotTaskResults_ACU: vi.fn(),
  aggregatePlotTaskTags_ACU: mockAggregatePlotTaskTags,
  buildPlotSaveContentFromTaskResults_ACU: mockBuildPlotSaveContentFromTaskResults,
  buildFinalPlotInjectionMessage_ACU: mockBuildFinalPlotInjectionMessage,
}));

vi.mock('../../../../src/service/runtime/plot-runtime/plot-history-preset', () => ({
  getPlotFromHistory_ACU: mockGetPlotFromHistory,
  savePlotToLatestMessage_ACU: mockSavePlotToLatestMessage,
}));

import {
  willPlotUseMainApiGenerateRaw_ACU,
  runPlotTasksRuntime_ACU,
  getWorldbookContentForPlot_ACU,
} from '../../../../src/service/runtime/plot-runtime/plot-task-engine';

beforeEach(() => {
  vi.clearAllMocks();

  mockSettings.plotApiPreset = '';
  mockSettings.apiMode = 'custom';
  mockSettings.apiConfig = { useMainApi: true };
  mockSettings.plotSettings = {
    contextTurnCount: 2,
    contextExtractTags: '',
    contextExtractRules: [],
    contextExcludeTags: '',
    contextExcludeRules: [],
    loopSettings: { maxRetries: 3 },
  };

  mockAbortControllerRef.value = null;
  mockCurrentJsonTableDataRef.value = {
    sheet_0: {
      name: '纪要表',
      content: [['row_id', '内容'], ['1', '初始纪要']],
    },
  };
  mockPlanningGuard.ignoreNextGenerationEndedCount = 0;

  mockGetApiConfigByPreset.mockReturnValue({
    apiMode: 'custom',
    apiConfig: { useMainApi: true },
  });
  mockGetChatArray.mockReturnValue([
    { is_user: false, mes: '前文AI-1' },
    { is_user: false, mes: '前文AI-2' },
    { is_user: true, mes: '本轮输入' },
  ]);
  mockGetPersonaDescription.mockReturnValue('用户设定');
  mockGetCharDescription.mockReturnValue('角色设定');
  mockBuildCombinedWorldbookContentByStrategy.mockResolvedValue('世界书内容');

  mockEnsurePlotTasksCompat.mockImplementation(() => undefined);
  mockGetPlotPromptContentById.mockReturnValue('');
  mockNormalizePlotTasks.mockImplementation((plotSettings: any) => {
    if (Array.isArray(plotSettings?.tasks)) return plotSettings.tasks;
    if (Array.isArray(plotSettings?.plotTasks)) return plotSettings.plotTasks;
    return [];
  });
  mockNormalizePlotTask.mockImplementation((task: any) => ({
    enabled: true,
    stage: 1,
    order: 0,
    maxRetries: 1,
    minLength: 0,
    extractTags: '',
    promptGroup: [],
    ...task,
  }));

  mockParseRandomTags.mockImplementation((text: string) => text);
  mockReplaceRandomVariables.mockImplementation((text: string) => text);
  mockGetLatestAIMessageContent.mockReturnValue('最近一条AI内容');
  mockApplyContextTagFilters.mockImplementation((text: string) => text);
  mockApplyExcludeRulesToText.mockImplementation((text: string) => String(text ?? ''));
  mockMergeAllIndependentTables.mockResolvedValue(null);
  mockFormatSummaryIndexForPlot.mockReturnValue({ success: true, content: '纪要索引' });
  mockFormatOutlineTableForPlot.mockReturnValue('总体大纲');
  mockGetNormalizedPlotMessageRole.mockImplementation((role: any) => String(role || 'user').toLowerCase());
  mockTryRenderPlotTemplateWithEjs.mockImplementation(async (text: string) => text);
  mockRenderPlotTaskContentWithIsolatedVariables.mockImplementation((text: string) => text);
  mockExtractPlotTagsFromResponse.mockImplementation(() => ({ tagNames: [], extractedTags: {}, injectedFragments: [], injectOnlyTags: {}, injectOnlyFragments: [], injectOnlyTagNames: [] }));
  mockGetPlotPlaceholderTagNames.mockReturnValue([]);
  mockBuildPlotTagMapFromText.mockReturnValue(new Map());
  mockReplacePlotTagPlaceholders.mockImplementation((text: string) => text);
  mockAggregatePlotTaskTags.mockImplementation((results: any[]) => ({ aggregated: new Map(results.map((result: any) => [result.taskId, result.taskName])), injectOnlyTagNames: new Set<string>() }));
  mockBuildPlotSaveContentFromTaskResults.mockReturnValue('保存的剧情内容');
  mockBuildFinalPlotInjectionMessage.mockReturnValue('最终注入消息');
  mockGetPlotFromHistory.mockReturnValue('上一轮剧情');
  mockSavePlotToLatestMessage.mockResolvedValue(undefined);
  mockCallApiWithPlotPreset.mockResolvedValue('任务输出');
});

describe('willPlotUseMainApiGenerateRaw_ACU', () => {
  it('预设为非 tavern 且 useMainApi=true 时返回 true', () => {
    mockGetApiConfigByPreset.mockReturnValue({
      apiMode: 'custom',
      apiConfig: { useMainApi: true },
    });

    expect(willPlotUseMainApiGenerateRaw_ACU()).toBe(true);
  });

  it('预设为 tavern 模式时返回 false', () => {
    mockGetApiConfigByPreset.mockReturnValue({
      apiMode: 'tavern',
      apiConfig: { useMainApi: true },
    });

    expect(willPlotUseMainApiGenerateRaw_ACU()).toBe(false);
  });

  it('读取预设失败时回退到全局设置', () => {
    mockSettings.apiMode = 'custom';
    (mockSettings as any).useMainApi = true;
    mockGetApiConfigByPreset.mockImplementation(() => {
      throw new Error('preset broken');
    });

    expect(willPlotUseMainApiGenerateRaw_ACU()).toBe(true);
  });
});

describe('getWorldbookContentForPlot_ACU', () => {
  it('apiSettings 为空时返回空字符串', async () => {
    await expect(getWorldbookContentForPlot_ACU(null as any, '用户输入')).resolves.toBe('');
    expect(mockBuildCombinedWorldbookContentByStrategy).not.toHaveBeenCalled();
  });

  it('手动模式会去重书名，并把过滤/选择回调正确传给聚合器', async () => {
    mockGetChatArray.mockReturnValue([
      { mes: '旧消息1' },
      { mes: '旧消息2' },
      { mes: '旧消息3' },
    ]);

    const result = await getWorldbookContentForPlot_ACU(
      {
        contextTurnCount: 2,
        plotWorldbookConfig: {
          source: 'manual',
          manualSelection: ['书A', '书A', '书B'],
          enabledEntries: {
            书A: [1],
          },
        },
      },
      '当前输入',
      '附加剧情',
    );

    expect(result).toBe('世界书内容');
    expect(mockBuildCombinedWorldbookContentByStrategy).toHaveBeenCalledTimes(1);

    const options = mockBuildCombinedWorldbookContentByStrategy.mock.calls[0][0];
    expect(options.bookNames).toEqual(['书A', '书B']);
    expect(options.baseScanText).toContain('旧消息2');
    expect(options.baseScanText).toContain('旧消息3');
    expect(options.baseScanText).toContain('当前输入');
    expect(options.baseScanText).toContain('附加剧情');

    expect(options.includeEntry({ normalizedComment: 'TavernDB-ACU-OutlineTable-1' })).toBe(false);
    expect(options.includeEntry({ normalizedComment: 'TavernDB-ACU-CustomExport-纪要索引-1' })).toBe(false);
    expect(options.includeEntry({ normalizedComment: '普通条目', blocked: true, rawComment: '普通条目' })).toBe(false);
    expect(options.includeEntry({ normalizedComment: 'TavernDB-ACU-自动生成条目', blocked: true })).toBe(true);

    expect(options.isSelected({ bookName: '书A', uid: 1, normalizedComment: '普通条目' })).toBe(true);
    expect(options.isSelected({ bookName: '书A', uid: 2, normalizedComment: '普通条目' })).toBe(false);
    expect(options.isSelected({ bookName: '书B', uid: 9, normalizedComment: '普通条目' })).toBe(true);
    expect(options.isSelected({ bookName: '书A', uid: 999, normalizedComment: 'TavernDB-ACU-自动生成条目' })).toBe(true);
  });

  it('角色模式会合并 primary 和 additional 世界书并去重', async () => {
    mockGetCharLorebooks.mockResolvedValue({
      primary: '主书',
      additional: ['副书', '主书'],
    });

    const result = await getWorldbookContentForPlot_ACU(
      { plotWorldbookConfig: { source: 'character' } },
      '继续推进',
    );

    expect(result).toBe('世界书内容');
    expect(mockGetCharLorebooks).toHaveBeenCalledWith({ type: 'all' });
    expect(mockBuildCombinedWorldbookContentByStrategy.mock.calls[0][0].bookNames).toEqual(['主书', '副书']);
  });

  it('角色世界书读取失败时返回空字符串', async () => {
    mockGetCharLorebooks.mockRejectedValue(new Error('读取失败'));

    await expect(
      getWorldbookContentForPlot_ACU({ plotWorldbookConfig: { source: 'character' } }, '继续推进'),
    ).resolves.toBe('');
  });

  it('没有任何可用世界书时直接返回空字符串', async () => {
    const result = await getWorldbookContentForPlot_ACU(
      {
        plotWorldbookConfig: {
          source: 'manual',
          manualSelection: [],
        },
      },
      '继续推进',
    );

    expect(result).toBe('');
    expect(mockBuildCombinedWorldbookContentByStrategy).not.toHaveBeenCalled();
  });
});

describe('runPlotTasksRuntime_ACU', () => {
  it('没有启用任务时返回空结果，并确保兼容处理被调用', async () => {
    const plotSettings = {
      tasks: [],
    };

    const result = await runPlotTasksRuntime_ACU(plotSettings, '当前输入');

    expect(mockEnsurePlotTasksCompat).toHaveBeenCalledWith(plotSettings, { syncLegacy: true });
    expect(result).toEqual({
      finalMessage: null,
      successfulResults: [],
      failedResults: [],
      aggregatedTags: new Map(),
      enabledTaskCount: 0,
    });
    expect(mockCallApiWithPlotPreset).not.toHaveBeenCalled();
  });

  it('成功执行时会按 stage 与 order 排序、暂存剧情并保存到最新消息', async () => {
    const plotSettings = {
      tasks: [
        {
          id: 'task-c',
          name: '任务C',
          stage: 2,
          order: 1,
          maxRetries: 1,
          promptGroup: [{ role: 'user', content: 'stage-2-task-c' }],
        },
        {
          id: 'task-b',
          name: '任务B',
          stage: 1,
          order: 2,
          maxRetries: 1,
          promptGroup: [{ role: 'user', content: 'stage-1-task-b' }],
        },
        {
          id: 'task-a',
          name: '任务A',
          stage: 1,
          order: 1,
          maxRetries: 1,
          promptGroup: [{ role: 'user', content: 'stage-1-task-a' }],
        },
      ],
    };

    mockCallApiWithPlotPreset
      .mockResolvedValueOnce('结果A')
      .mockResolvedValueOnce('结果B')
      .mockResolvedValueOnce('结果C');

    const result = await runPlotTasksRuntime_ACU(plotSettings, '当前输入');

    expect(result.finalMessage).toBe('最终注入消息');
    expect(result.successfulResults).toHaveLength(3);
    expect(result.failedResults).toHaveLength(0);
    expect(result.enabledTaskCount).toBe(3);

    expect(mockCallApiWithPlotPreset.mock.calls[0][0][0].content).toBe('stage-1-task-a');
    expect(mockCallApiWithPlotPreset.mock.calls[1][0][0].content).toBe('stage-1-task-b');
    expect(mockCallApiWithPlotPreset.mock.calls[2][0][0].content).toBe('stage-2-task-c');

    expect(mockSetTempPlotToSave).toHaveBeenCalledWith(expect.objectContaining({
      content: '保存的剧情内容',
      userInputHash: 'hash_当前输入',
      userInputText: '当前输入',
      taskResults: expect.arrayContaining([
        expect.objectContaining({ taskId: 'task-a', success: true, rawResponse: '结果A' }),
        expect.objectContaining({ taskId: 'task-b', success: true, rawResponse: '结果B' }),
        expect.objectContaining({ taskId: 'task-c', success: true, rawResponse: '结果C' }),
      ]),
    }));
    expect(mockSavePlotToLatestMessage).toHaveBeenCalledWith(true);
  });

  it('某个 stage 失败时会阻断后续 stage', async () => {
    const plotSettings = {
      tasks: [
        {
          id: 'task-ok',
          name: '成功任务',
          stage: 1,
          order: 1,
          maxRetries: 1,
          promptGroup: [{ role: 'user', content: 'stage-1-ok' }],
        },
        {
          id: 'task-fail',
          name: '失败任务',
          stage: 1,
          order: 2,
          maxRetries: 1,
          promptGroup: [{ role: 'user', content: 'stage-1-fail' }],
        },
        {
          id: 'task-never',
          name: '不应执行的任务',
          stage: 2,
          order: 1,
          maxRetries: 1,
          promptGroup: [{ role: 'user', content: 'stage-2-never' }],
        },
      ],
    };

    mockCallApiWithPlotPreset.mockImplementation(async (messages: any[]) => {
      const content = messages[0]?.content;
      if (content === 'stage-1-fail') {
        throw new Error('接口失败');
      }
      return '成功结果';
    });

    const result = await runPlotTasksRuntime_ACU(plotSettings, '当前输入');

    expect(result.finalMessage).toBeNull();
    expect(result.abortedByStageFailure).toBe(true);
    expect(result.failedStage).toBe(1);
    expect(result.errorMessage).toContain('失败任务');
    expect(mockCallApiWithPlotPreset).toHaveBeenCalledTimes(2);
    expect(mockCallApiWithPlotPreset.mock.calls.some((call: any[]) => call[0][0].content === 'stage-2-never')).toBe(false);
  });

  it('用户中止时抛出 TaskAbortedByUser', async () => {
    mockAbortControllerRef.value = { signal: { aborted: true } };
    const plotSettings = {
      tasks: [
        {
          id: 'task-a',
          name: '任务A',
          stage: 1,
          order: 1,
          maxRetries: 1,
          promptGroup: [{ role: 'user', content: 'stage-1-task-a' }],
        },
      ],
    };

    await expect(runPlotTasksRuntime_ACU(plotSettings, '当前输入')).rejects.toThrow('TaskAbortedByUser');
    expect(mockCallApiWithPlotPreset).not.toHaveBeenCalled();
  });

  it('内存表格为空时会尝试合并独立表并写回运行时状态', async () => {
    mockCurrentJsonTableDataRef.value = null;
    mockMergeAllIndependentTables.mockResolvedValue({
      sheet_merged: {
        name: '合并表',
        content: [['row_id', '字段'], ['1', '合并值']],
      },
    });

    const plotSettings = {
      tasks: [
        {
          id: 'task-a',
          name: '任务A',
          stage: 1,
          order: 1,
          maxRetries: 1,
          promptGroup: [{ role: 'user', content: 'stage-1-task-a' }],
        },
      ],
    };

    const result = await runPlotTasksRuntime_ACU(plotSettings, '当前输入');

    expect(result.finalMessage).toBe('最终注入消息');
    expect(mockMergeAllIndependentTables).toHaveBeenCalledTimes(1);
    expect(mockSetCurrentJsonTableData).toHaveBeenCalledWith({
      sheet_merged: {
        name: '合并表',
        content: [['row_id', '字段'], ['1', '合并值']],
      },
    });
  });

  it('使用主 API 时会为每次任务执行递增 ignoreNextGenerationEndedCount', async () => {
    mockGetApiConfigByPreset.mockReturnValue({
      apiMode: 'custom',
      apiConfig: { useMainApi: true },
    });

    const plotSettings = {
      tasks: [
        {
          id: 'task-a',
          name: '任务A',
          stage: 1,
          order: 1,
          maxRetries: 1,
          promptGroup: [{ role: 'user', content: 'task-a' }],
        },
        {
          id: 'task-b',
          name: '任务B',
          stage: 1,
          order: 2,
          maxRetries: 1,
          promptGroup: [{ role: 'user', content: 'task-b' }],
        },
      ],
    };

    await runPlotTasksRuntime_ACU(plotSettings, '当前输入');

    expect(mockPlanningGuard.ignoreNextGenerationEndedCount).toBe(2);
  });

  // ═══════════════════════════════════════════════════════════════
  // task 级 effective preset
  // ═══════════════════════════════════════════════════════════════
  it('同 stage 多任务时，显式 taskApiPreset 只作用于对应任务', async () => {
    mockCallApiWithPlotPreset.mockResolvedValue('AI回复内容');
    mockExtractPlotTagsFromResponse.mockReturnValue({
      tagNames: ['tag1'],
      extractedTags: { tag1: '内容' },
      injectedFragments: [],
      injectOnlyTags: {},
      injectOnlyFragments: [],
      injectOnlyTagNames: [],
    });

    const plotSettings = {
      enabled: true,
      contextTurnCount: 1,
      contextExtractTags: '',
      contextExtractRules: [],
      contextExcludeTags: '',
      contextExcludeRules: [],
      loopSettings: { maxRetries: 1 },
      tasks: [
        { id: 't1', name: '任务1', enabled: true, stage: 1, order: 0, promptGroup: [{ role: 'USER', content: '提示词1' }], extractTags: 'tag1', taskApiPreset: 'preset-A' },
        { id: 't2', name: '任务2', enabled: true, stage: 1, order: 1, promptGroup: [{ role: 'USER', content: '提示词2' }], extractTags: 'tag1', taskApiPreset: '' },
      ],
    };

    await runPlotTasksRuntime_ACU(plotSettings, '当前输入');

    const allCalls = mockCallApiWithPlotPreset.mock.calls;
    expect(allCalls.length).toBeGreaterThanOrEqual(2);
    // 第一个任务的 effectivePreset 应为显式 taskApiPreset。
    expect(allCalls[0][1]).toBe('preset-A');
    // 第二个任务没有显式 taskApiPreset，应按任务级规则回退到全局 plotApiPreset（本用例为空）。
    expect(allCalls[1][1]).toBe('');
  });

  it('同 stage 无任务有显式 taskApiPreset 时，统一回退到全局 plotApiPreset', async () => {
    mockCallApiWithPlotPreset.mockResolvedValue('AI回复内容');
    mockExtractPlotTagsFromResponse.mockReturnValue({
      tagNames: ['tag1'],
      extractedTags: { tag1: '内容' },
      injectedFragments: [],
      injectOnlyTags: {},
      injectOnlyFragments: [],
      injectOnlyTagNames: [],
    });
    mockSettings.plotApiPreset = 'global-plot-preset';

    const plotSettings = {
      enabled: true,
      contextTurnCount: 1,
      contextExtractTags: '',
      contextExtractRules: [],
      contextExcludeTags: '',
      contextExcludeRules: [],
      loopSettings: { maxRetries: 1 },
      tasks: [
        { id: 't1', name: '任务1', enabled: true, stage: 1, order: 0, promptGroup: [{ role: 'USER', content: '提示词1' }], extractTags: 'tag1', taskApiPreset: '' },
        { id: 't2', name: '任务2', enabled: true, stage: 1, order: 1, promptGroup: [{ role: 'USER', content: '提示词2' }], extractTags: 'tag1', taskApiPreset: '' },
      ],
    };

    await runPlotTasksRuntime_ACU(plotSettings, '当前输入');

    const allCalls = mockCallApiWithPlotPreset.mock.calls;
    expect(allCalls.length).toBeGreaterThanOrEqual(2);
    expect(allCalls[0][1]).toBe('global-plot-preset');
    expect(allCalls[1][1]).toBe('global-plot-preset');
  });

  it('不同 stage 的任务使用各自的 stageEffectivePreset', async () => {
    mockCallApiWithPlotPreset.mockResolvedValue('AI回复内容');
    mockExtractPlotTagsFromResponse.mockReturnValue({
      tagNames: ['tag1'],
      extractedTags: { tag1: '内容' },
      injectedFragments: [],
      injectOnlyTags: {},
      injectOnlyFragments: [],
      injectOnlyTagNames: [],
    });
    mockSettings.plotApiPreset = 'global-default';

    const plotSettings = {
      enabled: true,
      contextTurnCount: 1,
      contextExtractTags: '',
      contextExtractRules: [],
      contextExcludeTags: '',
      contextExcludeRules: [],
      loopSettings: { maxRetries: 1 },
      plotTasks: [
        { id: 't1', name: '任务1', enabled: true, stage: 1, order: 0, promptGroup: [{ role: 'USER', content: '提示词1' }], extractTags: 'tag1', taskApiPreset: 'stage1-preset' },
        { id: 't2', name: '任务2', enabled: true, stage: 2, order: 0, promptGroup: [{ role: 'USER', content: '提示词2' }], extractTags: 'tag1', taskApiPreset: '' },
      ],
    };

    await runPlotTasksRuntime_ACU(plotSettings, '当前输入');

    const allCalls = mockCallApiWithPlotPreset.mock.calls;
    expect(allCalls.length).toBeGreaterThanOrEqual(2);
    // stage 1 任务使用 stage1-preset
    expect(allCalls[0][1]).toBe('stage1-preset');
    // stage 2 任务无显式 preset，回退到全局
    expect(allCalls[1][1]).toBe('global-default');
  });
});