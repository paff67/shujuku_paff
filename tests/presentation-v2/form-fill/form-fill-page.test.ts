/**
 * FormFillPage 集成 — 更新参数、规则列表、提示词段、手动填表
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'acu_v2_ui_state';

function createSettings() {
  return {
    autoUpdateThreshold: 3,
    autoUpdateFrequency: 2,
    updateBatchSize: 2,
    manualUpdateContextDepth: null,
    manualUpdateBatchSize: null,
    maxConcurrentGroups: 1,
    skipUpdateFloors: 0,
    retainRecentLayers: 100,
    autoUpdateTokenThreshold: 500,
    tableMaxRetries: 3,
    tableEditLastPairOnly: true,
    tableContextExtractTags: '',
    tableContextExtractRules: [{ start: '<正文>', end: '</正文>' }],
    tableContextExcludeTags: '',
    tableContextExcludeRules: [{ start: '<think>', end: '</think>' }],
    storageMode: 'native',
    apiPresets: [{ name: 'fast', apiMode: 'custom', apiConfig: { url: '', apiKey: '', model: '', useMainApi: true, max_tokens: 1000, temperature: 1 }, tavernProfile: '' }],
    defaultApiPresetName: 'fast',
    apiPresetBindingsByChat: {},
    tableApiPreset: '',
    manualSelectedTables: [],
    hasManualSelection: false,
    charCardPrompt: [
      { role: 'SYSTEM', content: '系统段', deletable: true },
      { role: 'USER', content: '主任务', mainSlot: 'A', isMain: true, deletable: false },
      { role: 'USER', content: '数据段', mainSlot: 'B', isMain2: true, deletable: false },
    ],
  } as any;
}

function createTableData() {
  return {
    sheet_a: { name: '角色状态', content: [['id'], ['1']], updateConfig: { updateFrequency: -1, skipFloors: -1 } },
    sheet_b: { name: '事件记录', content: [['id'], ['1'], ['2']], updateConfig: { updateFrequency: -1, skipFloors: -1 } },
  };
}

async function mountFormFillPage(settings = createSettings(), activePageId = 'form-fill') {
  vi.resetModules();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ router: { activePageId } }));
  const { ref, computed } = await import('vue');
  const saveSettings = vi.fn(() => ({ saved: true, storageType: 'memory' }));
  const orchestrate = vi.fn(async (..._args: any[]) => ({ success: true }));
  const executeCore = vi.fn(async (..._args: any[]) => ({ success: true, modifiedKeys: [] }));
  const processUpdatesBatch = vi.fn(async (indices: number[], mode: string, options: any, executeUpdate: any) => {
    if (options?.__skipExecuteForTest) return { success: true };
    return executeUpdate(
      [{ mes: 'AI回复' }],
      indices[indices.length - 1] ?? -1,
      mode,
      false,
      options?.targetSheetKeys ?? null,
      options?.requestOptions ?? null,
      { currentBatch: 1, totalBatches: 1 },
      {
        prepareAiCallOnly: options?.prepareAiCallOnly === true,
        deferApply: options?.deferApply === true,
        deferPersistence: options?.deferPersistence === true,
        deferredAiResponse: options?.deferredResponses?.[0] ?? null,
      },
    );
  });
  const manualExtraHintSetter = vi.fn();
  const openVisualizer = vi.fn(async () => {});

  const worldbookConfig: any = {
    source: 'character',
    manualSelection: [],
    enabledEntries: {},
    injectionTarget: 'character',
  };

  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: settings,
    currentChatFileIdentifier_ACU: 'chat-form-fill',
    currentJsonTableData_ACU: createTableData(),
    getCurrentIsolationKey_ACU: () => '',
    coreApisAreReady_ACU: true,
    _set_manualExtraHint_ACU: manualExtraHintSetter,
  }));
  vi.doMock('../../../src/service/settings/settings-service', () => ({
    saveSettings_ACU: saveSettings,
    setGlobalPlotEnabled_ACU: vi.fn((enabled: boolean) => { settings.plotSettings = { ...(settings.plotSettings || {}), enabled }; }),
    setZeroTkOccupyMode_ACU: vi.fn((enabled: boolean) => { settings.zeroTkOccupyModeDefault = enabled; }),
    setSummaryVectorIndexMode_ACU: vi.fn((enabled: boolean) => { settings.summaryVectorIndexModeDefault = enabled; }),
  }));
  vi.doMock('../../../src/service/chat/chat-service', () => ({
    getChatArray_ACU: () => [
      { is_user: true, mes: 'u1' },
      { is_user: false, mes: 'a1' },
      { is_user: true, mes: 'u2' },
      { is_user: false, mes: 'a2' },
      { is_user: false, mes: 'a3' },
    ],
  }));
  vi.doMock('../../../src/service/settings/settings-readers', () => ({
    getCurrentWorldbookConfig_ACU: () => worldbookConfig,
    getCurrentCharSettings_ACU: () => ({ worldbookConfig }),
  }));
  vi.doMock('../../../src/presentation-v2/composables/useTableTemplatePresets', () => ({
    useTableTemplatePresets: () => ({
      busy: ref(false),
      message: ref(null),
      selectedGlobalPreset: ref('global-A'),
      selectedChatPreset: ref('global-A'),
      isChatOverridden: computed(() => false),
      chatPresetItems: ref([
        { value: '', label: '默认预设', meta: '2 张表' },
        { value: 'global-A', label: 'global-A', meta: '2 张表' },
      ]),
      refresh: vi.fn(),
      selectGlobalPreset: vi.fn(async () => {}),
      selectChatPreset: vi.fn(async () => {}),
      importPresetForCurrentChat: vi.fn(async () => {}),
    }),
  }));
  vi.doMock('../../../src/presentation-v2/composables/useTablePresetManagement', () => ({
    useTablePresetManagement: () => ({
      drawerView: ref('closed'),
      isDrawerOpen: computed(() => false),
      title: computed(() => ''),
      busy: ref(false),
      message: ref(null),
      presetMeta: ref([]),
      defaultPresetName: ref('global-A'),
      refresh: vi.fn(),
      openManage: vi.fn(),
      closeDrawer: vi.fn(),
      openVisualizer,
      editPreset: vi.fn(async () => {}),
      setAsDefault: vi.fn(async () => {}),
      deletePreset: vi.fn(async () => {}),
      exportPreset: vi.fn(),
      renamePreset: vi.fn(async () => {}),
      createBlankPreset: vi.fn(async () => {}),
    }),
  }));
  vi.doMock('../../../src/service/table/storage-mode', () => ({
    getCurrentStorageMode: () => settings.storageMode,
  }));
  vi.doMock('../../../src/service/template/chat-scope', () => ({
    getSortedSheetKeys_ACU: (data: any) => Object.keys(data).filter(k => k.startsWith('sheet_')),
  }));
  vi.doMock('../../../src/service/template/template-preset-service', () => ({
    getActiveTemplatePresetMeta_ACU: () => ({ displayName: '默认预设', scopeLabel: '全局' }),
  }));
  vi.doMock('../../../src/service/table/table-history', () => ({
    resolveTableHistoryStateFromChat_ACU: (_chat: any[], options: any) => ({
      latestAiMessageIndex: 4,
      latestDataMessageIndex: 3,
      lastTrackedUpdateMessageIndex: options.sheetKey === 'sheet_a' ? 1 : -1,
      latestDataAiFloor: 2,
      lastTrackedUpdateAiFloor: options.sheetKey === 'sheet_a' ? 1 : 0,
      hasAnyData: true,
      hasTrackedUpdate: options.sheetKey === 'sheet_a',
    }),
  }));
  vi.doMock('../../../src/service/table/table-storage-strategy', () => ({
    reloadStorageProvider: vi.fn(async () => {}),
    switchStorageMode: vi.fn(async (mode: string) => { settings.storageMode = mode; }),
  }));
  vi.doMock('../../../src/service/table/update-orchestrator', () => ({
    orchestrateManualUpdate_ACU: orchestrate,
    processUpdatesBatch_ACU: processUpdatesBatch,
    executeCardUpdateCore_ACU: executeCore,
  }));
  vi.doMock('../../../src/service/ai/ai-service', () => ({
    getConnectionManagerProfiles_ACU: (): any[] => [],
    fetchAvailableModels_ACU: vi.fn(async () => ({ success: true, models: [] })),
  }));
  vi.doMock('../../../src/service/worldbook/pipeline', () => ({
    getWorldbookNames_ACU: vi.fn(async () => ['world-X', 'world-Y']),
    getLorebookEntriesByNames_ACU: vi.fn(async () => ({
      'CharBookFF': [
        { uid: 11, comment: '角色概念', name: '角色概念', enabled: true },
        { uid: 12, comment: '人物关系', name: '人物关系', enabled: true },
      ],
    })),
  }));
  vi.doMock('../../../src/service/worldbook/worldbook-service', () => ({
    getCurrentCharPrimaryLorebook_ACU: vi.fn(async () => 'CharBookFF'),
    getCharLorebooks_ACU: vi.fn(async () => ({ primary: 'CharBookFF', additional: [] })),
  }));

  vi.spyOn(window, 'confirm').mockReturnValue(false);

  const mount = await import('../../../src/presentation-v2/bootstrap/mount');
  await mount.openAcuV2App();
  await new Promise(r => setTimeout(r, 0));
  return {
    mount,
    settings,
    saveSettings,
    orchestrate,
    processUpdatesBatch,
    executeCore,
    worldbookConfig,
    manualExtraHintSetter,
    openVisualizer,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FormFillPage', () => {
  it('渲染填表工作台的状态、自动更新、表格模板与手动填表面板', async () => {
    const { mount } = await mountFormFillPage();

    const page = document.querySelector('.acu-v2-form-fill-page');
    expect(page).not.toBeNull();
    const text = page!.textContent || '';
    expect(document.querySelector('.acu-v2-app__page-title')?.textContent || '').toContain('填表工作台');
    expect(text).toContain('表格状态');
    expect(text).toContain('当前聊天');
    expect(text).toContain('chat-form-fill');
    expect(text).toContain('AI回复累计层数');
    expect(text).toContain('角色状态');
    expect(text).toContain('事件记录');
    expect(text).not.toContain('就绪:角色状态');
    expect(text).not.toContain('下一次:');
    const statusLine = page!.querySelector('.acu-v2-form-fill-page__status-line');
    expect(statusLine).not.toBeNull();
    expect((statusLine!.textContent || '').replace(/\s+/g, '')).toContain('当前聊天:chat-form-fill·AI回复累计层数:3');
    expect(text).toContain('自动更新设置');
    expect(text).toContain('自动填表间隔');
    expect(text).toContain('最新层不填表');
    expect(text).not.toContain('并发策略');
    expect(text).not.toContain('历史数据保留');
    expect(text).not.toContain('沿用当前自定义参数');
    expect(text).not.toContain('标签筛选');
    expect(text).not.toContain('内容过滤');
    expect(text).not.toContain('填表触发条件');
    expect(document.getElementById('form-fill-trigger-panel')).toBeNull();
    expect(text).not.toContain('高级数值');
    expect(text).not.toContain('填表注入目标世界书');
    expect(text).not.toContain('填表附加世界书条目');
    expect(text).not.toContain('注入目标世界书');
    expect(text).not.toContain('附加世界书条目');
    expect(text).not.toContain('填表提示词');
    expect(text).not.toContain('已自定义提示词');
    expect(text).not.toContain('段落数量');
    expect(text).not.toContain('保存状态');
    expect(text).not.toContain('编辑提示词');
    expect(text).toContain('手动填表');
    expect(text).toContain('填表 API 预设');
    expect(text).toContain('本次填表附加要求');
    expect(text).toContain('执行手动填表');
    expect(text).toContain('表格模板预设');
    expect(text).toContain('打开可视化表格编辑器');
    expect(text).not.toContain('立即构建交火纪要索引');
    expect(page!.querySelector('.acu-prompt-segs')).toBeNull();
    const panelTitles = Array.from(page!.querySelectorAll('.acu-v2-form-fill-page__grid > .acu-panel .acu-panel__title'))
      .map(title => (title.textContent || '').trim());
    expect(panelTitles).toEqual(['表格状态', '自动更新设置', '表格模板预设', '手动填表']);
    const mobileNavItems = Array.from(page!.querySelectorAll('.acu-mobile-panel-nav__item'))
      .map(item => (item.textContent || '').trim());
    expect(mobileNavItems).toEqual(['表格状态', '自动更新', '手动填表', '表格模板预设']);
    expect(document.getElementById('form-fill-update-panel')).not.toBeNull();
    expect(page!.querySelector('.acu-v2-form-fill-page__panel--manual')).not.toBeNull();

    mount.__resetAcuV2MountForTests();
  });

  it('标签筛选里的 tableEdit 解析开关会保存设置', async () => {
    const { mount, settings, saveSettings } = await mountFormFillPage(createSettings(), 'table');

    const toggle = document.querySelector(
      'button[data-acu-setting-key="tableEditLastPairOnly"]',
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    toggle.click();
    await Promise.resolve();

    expect(settings.tableEditLastPairOnly).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(saveSettings).toHaveBeenCalled();

    mount.__resetAcuV2MountForTests();
  });

  it('每个主页面板都渲染常驻说明信息条', async () => {
    const { mount } = await mountFormFillPage();

    const panels = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-form-fill-page > .acu-v2-form-fill-page__grid > .acu-panel'));
    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) {
      expect(panel.querySelector('.acu-panel__header .acu-info-banner')).toBeNull();
      expect(panel.querySelector('.acu-panel__description-region .acu-info-banner')).not.toBeNull();
    }

    mount.__resetAcuV2MountForTests();
  });

  it('填表 API 预设下拉的跟随项显示当前活动 API 预设名', async () => {
    const { mount } = await mountFormFillPage();

    const updatePanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-panel'))
      .find(panel => panel.querySelector('.acu-panel__title')?.textContent?.includes('自动更新设置'))!;
    const apiRow = Array.from(updatePanel.querySelectorAll<HTMLElement>('.acu-form-row'))
      .find(row => (row.textContent || '').includes('填表 API 预设'))!;
    const acuSelect = apiRow.querySelector('.acu-select') as HTMLElement | null;
    expect(acuSelect).not.toBeNull();
    const trigger = acuSelect!.querySelector('.acu-select__trigger') as HTMLButtonElement;
    expect(trigger.textContent).toContain('跟随当前活动 API（fast）');
    trigger.click();
    await Promise.resolve();

    const labels = Array.from(acuSelect!.querySelectorAll<HTMLElement>('.acu-select__item'))
      .map(item => (item.textContent || '').trim());
    expect(labels[0]).toBe('跟随当前活动 API（fast）');
    expect(labels).toContain('fast');

    mount.__resetAcuV2MountForTests();
  });

  it('高级参数中的触发条件数字字段会归一化并保存 settings', async () => {
    const { mount, settings, saveSettings } = await mountFormFillPage();

    const updatePanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-panel'))
      .find(panel => panel.querySelector('.acu-panel__title')?.textContent?.includes('自动更新设置'))!;
    const advancedHeader = Array.from(updatePanel.querySelectorAll<HTMLButtonElement>('.acu-disclosure-group__header'))
      .find(btn => (btn.textContent || '').includes('高级参数'))!;
    advancedHeader.click();
    await Promise.resolve();

    const tokenRow = Array.from(updatePanel.querySelectorAll<HTMLElement>('.acu-disclosure-group .acu-form-row'))
      .find(row => (row.textContent || '').includes('AI 回复最小长度'))!;
    const tokenInput = tokenRow.querySelector<HTMLInputElement>('input[type="number"]')!;
    tokenInput.value = '7';
    tokenInput.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(settings.autoUpdateTokenThreshold).toBe(7);
    expect(saveSettings).toHaveBeenCalled();
    expect(document.querySelector('.acu-v2-form-fill-page')?.textContent || '').not.toContain('设置已保存');

    mount.__resetAcuV2MountForTests();
  });

  it('自动更新设置选项会写入更新间隔与保留最新层字段', async () => {
    const optionSettings = {
      ...createSettings(),
      autoUpdateThreshold: 3,
      autoUpdateFrequency: 1,
      updateBatchSize: 3,
      maxConcurrentGroups: 1,
      skipUpdateFloors: 0,
      retainRecentLayers: 100,
    };
    const { mount, settings, saveSettings } = await mountFormFillPage(optionSettings);

    const updatePanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-panel'))
      .find(panel => panel.querySelector('.acu-panel__title')?.textContent?.includes('自动更新设置'))!;
    expect(updatePanel.querySelectorAll<HTMLInputElement>('input[type="number"]')).toHaveLength(0);
    expect(updatePanel.textContent || '').toContain('高级参数');

    const intervalRow = Array.from(updatePanel.querySelectorAll<HTMLElement>('.acu-form-row'))
      .find(row => (row.textContent || '').includes('自动填表间隔'))!;
    const intervalTrigger = intervalRow.querySelector<HTMLButtonElement>('.acu-select__trigger')!;
    intervalTrigger.click();
    await Promise.resolve();
    expect(intervalRow.textContent || '').toContain('每 1 层：最及时');
    expect(intervalRow.textContent || '').not.toContain('每 2 层：常用节奏');
    expect(intervalRow.textContent || '').toContain('每 3 层：均衡');
    expect(intervalRow.textContent || '').toContain('每 5 层：低频省 API');
    expect(Array.from(intervalRow.querySelectorAll<HTMLElement>('.acu-select__item'))
      .map(item => (item.textContent || '').trim())).not.toContain('自定义');
    const everyOne = Array.from(intervalRow.querySelectorAll<HTMLElement>('.acu-select__item'))
      .find(item => (item.textContent || '').trim() === '每 1 层：最及时')!;
    everyOne.click();
    await Promise.resolve();
    expect(settings.autoUpdateThreshold).toBe(3);
    expect(settings.autoUpdateFrequency).toBe(1);
    expect(settings.updateBatchSize).toBe(3);

    intervalTrigger.click();
    await Promise.resolve();
    const everyThree = Array.from(intervalRow.querySelectorAll<HTMLElement>('.acu-select__item'))
      .find(item => (item.textContent || '').trim() === '每 3 层：均衡')!;
    everyThree.click();
    await Promise.resolve();
    expect(settings.autoUpdateThreshold).toBe(3);
    expect(settings.autoUpdateFrequency).toBe(3);
    expect(settings.updateBatchSize).toBe(3);

    intervalTrigger.click();
    await Promise.resolve();
    const everyFive = Array.from(intervalRow.querySelectorAll<HTMLElement>('.acu-select__item'))
      .find(item => (item.textContent || '').trim() === '每 5 层：低频省 API')!;
    everyFive.click();
    await Promise.resolve();
    expect(settings.autoUpdateThreshold).toBe(5);
    expect(settings.autoUpdateFrequency).toBe(5);
    expect(settings.updateBatchSize).toBe(5);

    const skipRow = Array.from(updatePanel.querySelectorAll<HTMLElement>('.acu-form-row'))
      .find(row => (row.textContent || '').includes('最新层不填表'))!;
    skipRow.querySelector<HTMLButtonElement>('.acu-toggle')!.click();
    await Promise.resolve();
    expect(settings.skipUpdateFloors).toBe(1);
    expect(updatePanel.textContent || '').not.toContain('并发策略');
    expect(updatePanel.textContent || '').not.toContain('历史数据保留');

    expect(saveSettings).toHaveBeenCalled();

    mount.__resetAcuV2MountForTests();
  });

  it('高级参数可编辑自动更新字段和触发条件字段，改成非快捷组合后显示自定义', async () => {
    const { mount, settings, saveSettings } = await mountFormFillPage({
      ...createSettings(),
      autoUpdateThreshold: 3,
      autoUpdateFrequency: 3,
      updateBatchSize: 3,
      skipUpdateFloors: 0,
    });

    const updatePanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-panel'))
      .find(panel => panel.querySelector('.acu-panel__title')?.textContent?.includes('自动更新设置'))!;
    const intervalRow = Array.from(updatePanel.querySelectorAll<HTMLElement>('.acu-form-row'))
      .find(row => (row.textContent || '').includes('自动填表间隔'))!;
    expect(intervalRow.querySelector('.acu-select__trigger')?.textContent || '').toContain('每 3 层：均衡');

    const advancedHeader = Array.from(updatePanel.querySelectorAll<HTMLButtonElement>('.acu-disclosure-group__header'))
      .find(btn => (btn.textContent || '').includes('高级参数'))!;
    advancedHeader.click();
    await Promise.resolve();

    const advancedRows = Array.from(updatePanel.querySelectorAll<HTMLElement>('.acu-disclosure-group .acu-form-row'));
    expect(advancedRows.map(row => (row.textContent || '').trim()).join('|')).toContain('填表上下文层数');
    expect(advancedRows.map(row => (row.textContent || '').trim()).join('|')).toContain('自动填表频率');
    expect(advancedRows.map(row => (row.textContent || '').trim()).join('|')).toContain('批处理层数');
    expect(advancedRows.map(row => (row.textContent || '').trim()).join('|')).toContain('跳过最新回复数');
    expect(advancedRows.map(row => (row.textContent || '').trim()).join('|')).toContain('AI 回复最小长度');
    expect(advancedRows.map(row => (row.textContent || '').trim()).join('|')).toContain('填表最大重试');
    expect(advancedRows).toHaveLength(6);

    const batchRow = advancedRows.find(row => (row.textContent || '').includes('批处理层数'))!;
    const batchInput = batchRow.querySelector<HTMLInputElement>('input[type="number"]')!;
    batchInput.value = '2';
    batchInput.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(settings.updateBatchSize).toBe(2);
    expect(intervalRow.querySelector('.acu-select__trigger')?.textContent || '').toContain('自定义');
    intervalRow.querySelector<HTMLButtonElement>('.acu-select__trigger')!.click();
    await Promise.resolve();
    expect(Array.from(intervalRow.querySelectorAll<HTMLElement>('.acu-select__item'))
      .map(item => (item.textContent || '').trim())).not.toContain('自定义');

    const skipRow = advancedRows.find(row => (row.textContent || '').includes('跳过最新回复数'))!;
    const skipInput = skipRow.querySelector<HTMLInputElement>('input[type="number"]')!;
    skipInput.value = '2';
    skipInput.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(settings.skipUpdateFloors).toBe(2);
    expect(updatePanel.textContent || '').toContain('最新层不填表：自定义');
    expect(saveSettings).toHaveBeenCalled();

    mount.__resetAcuV2MountForTests();
  });

  it('打开提示词抽屉时不显示其他面板的保存消息', async () => {
    const { mount } = await mountFormFillPage(createSettings(), 'table');

    const toggle = document.querySelector(
      'button[data-acu-setting-key="tableEditLastPairOnly"]',
    ) as HTMLButtonElement;
    toggle.click();
    await Promise.resolve();

    const openButton = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('编辑提示词')) as HTMLButtonElement;
    openButton.click();
    await Promise.resolve();

    const drawer = document.querySelector('.acu-v2-drawer') as HTMLElement;
    expect(drawer).not.toBeNull();
    expect(drawer.textContent || '').not.toContain('设置已保存');

    mount.__resetAcuV2MountForTests();
  });

  it('添加排除规则会写入结构化规则', async () => {
    const { mount, settings, saveSettings } = await mountFormFillPage(createSettings(), 'table');

    const excludePanel = Array.from(document.querySelectorAll('.acu-panel'))
      .find(panel => (panel.textContent || '').includes('排除规则')) as HTMLElement;
    // 非空规则列表默认折叠：先展开“排除规则”再点击“添加”按钮。
    const expandHeader = Array.from(excludePanel.querySelectorAll<HTMLButtonElement>('.acu-rule-pair-list__header'))
      .find(btn => (btn.textContent || '').includes('排除规则')) as HTMLButtonElement;
    expect(expandHeader).toBeDefined();
    expandHeader.click();
    await Promise.resolve();
    const excludeList = expandHeader.closest('.acu-rule-pair-list') as HTMLElement;
    const addButton = Array.from(excludePanel.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('添加排除规则')) as HTMLButtonElement;
    addButton.click();
    await Promise.resolve();

    let rows = Array.from(excludeList.querySelectorAll<HTMLElement>('.acu-rule-pair-list__row'));
    expect(rows.length).toBe(2);
    expect(settings.tableContextExcludeRules.length).toBe(1);
    expect(settings.tableContextExcludeRules[0]).toEqual({ start: '<think>', end: '</think>' });

    const inputs = rows[1].querySelectorAll<HTMLInputElement>('input');
    inputs[0].value = '<note>';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
    expect(settings.tableContextExcludeRules.length).toBe(1);

    rows = Array.from(excludeList.querySelectorAll<HTMLElement>('.acu-rule-pair-list__row'));
    const nextInputs = rows[1].querySelectorAll<HTMLInputElement>('input');
    nextInputs[1].value = '</note>';
    nextInputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    expect(settings.tableContextExcludeRules).toContainEqual({ start: '<note>', end: '</note>' });
    expect(saveSettings).toHaveBeenCalled();

    mount.__resetAcuV2MountForTests();
  });

  it('提示词编辑器只在侧抽屉中出现，保存后写回 charCardPrompt', async () => {
    const { mount, settings, saveSettings } = await mountFormFillPage(createSettings(), 'table');

    expect(document.querySelector('.acu-v2-table-page .acu-prompt-segs')).toBeNull();
    const openButton = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('编辑提示词')) as HTMLButtonElement;
    openButton.click();
    await Promise.resolve();

    const drawer = document.querySelector('.acu-v2-drawer') as HTMLElement;
    expect(drawer).not.toBeNull();
    const textareas = Array.from(drawer.querySelectorAll<HTMLTextAreaElement>('.acu-prompt-segs textarea'));
    expect(textareas.length).toBeGreaterThan(0);
    textareas[0].value = '新的系统段';
    textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    const saveButton = Array.from(drawer.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('保存提示词')) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    saveButton.click();
    await Promise.resolve();

    expect(settings.charCardPrompt[0].content).toBe('新的系统段');
    expect(saveSettings).toHaveBeenCalled();

    mount.__resetAcuV2MountForTests();
  });

  it('关闭有未保存修改的提示词抽屉会确认', async () => {
    const { mount } = await mountFormFillPage(createSettings(), 'table');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const openButton = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('编辑提示词')) as HTMLButtonElement;
    openButton.click();
    await Promise.resolve();

    const drawer = document.querySelector('.acu-v2-drawer') as HTMLElement;
    const textarea = drawer.querySelector<HTMLTextAreaElement>('.acu-prompt-segs textarea')!;
    textarea.value = '未保存修改';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    const closeButton = drawer.querySelector<HTMLButtonElement>('[title="关闭"]')!;
    closeButton.click();
    await Promise.resolve();

    expect(confirmSpy).toHaveBeenCalled();
    expect(document.querySelector('.acu-v2-drawer')).not.toBeNull();

    mount.__resetAcuV2MountForTests();
  });

  it('提示词抽屉有未保存修改时关闭整个 UI 会确认', async () => {
    const { mount } = await mountFormFillPage(createSettings(), 'table');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const openButton = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('编辑提示词')) as HTMLButtonElement;
    openButton.click();
    await Promise.resolve();

    const drawer = document.querySelector('.acu-v2-drawer') as HTMLElement;
    const textarea = drawer.querySelector<HTMLTextAreaElement>('.acu-prompt-segs textarea')!;
    textarea.value = '未保存修改';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    const appClose = document.querySelector<HTMLButtonElement>('.acu-v2-app__close')!;
    appClose.click();
    await Promise.resolve();

    expect(confirmSpy).toHaveBeenCalled();
    expect(document.getElementById('acu-app-v2')!.style.display).not.toBe('none');
    expect(document.querySelector('.acu-v2-drawer')).not.toBeNull();

    mount.__resetAcuV2MountForTests();
  });

});

describe('FormFillPage · 手动填表面板', () => {
  it('渲染手动填表面板和常驻说明信息条，运行配置不混入手动面板', async () => {
    const { mount } = await mountFormFillPage();

    const page = document.querySelector('.acu-v2-form-fill-page');
    expect(page).not.toBeNull();
    const panel = Array.from(page!.querySelectorAll<HTMLElement>('.acu-v2-form-fill-page__grid > .acu-panel'))
      .find(item => item.querySelector('.acu-panel__title')?.textContent?.includes('手动填表'))!;
    const text = panel.textContent || '';
    expect(text).not.toContain('填表 API 预设');
    expect(text).toContain('手动处理最近 N 层');
    expect(text).toContain('每 N 层合并为一次填表');
    expect(text).toContain('本次填表附加要求');
    expect(text).toContain('执行手动填表');
    expect(panel.querySelector('.acu-v2-form-fill-page__manual-extra .acu-toggle')).toBeNull();
    expect(panel.querySelector('.acu-v2-form-fill-page__manual-extra textarea')).not.toBeNull();

    expect(panel.querySelector('.acu-panel__description-region .acu-info-banner')).not.toBeNull();

    const runPanel = Array.from(page!.querySelectorAll<HTMLElement>('.acu-v2-form-fill-page__grid > .acu-panel'))
      .find(item => item.querySelector('.acu-panel__title')?.textContent?.includes('自动更新设置'))!;
    expect(runPanel.textContent || '').toContain('填表 API 预设');

    mount.__resetAcuV2MountForTests();
  });

  it('手动参数保存到独立字段，不改自动更新设置', async () => {
    const { mount, settings, saveSettings } = await mountFormFillPage();

    const panel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-form-fill-page__grid > .acu-panel'))
      .find(item => item.querySelector('.acu-panel__title')?.textContent?.includes('手动填表'))!;
    const depthRow = Array.from(panel.querySelectorAll<HTMLElement>('.acu-form-row'))
      .find(row => (row.textContent || '').includes('手动处理最近 N 层'))!;
    const batchRow = Array.from(panel.querySelectorAll<HTMLElement>('.acu-form-row'))
      .find(row => (row.textContent || '').includes('每 N 层合并为一次填表'))!;
    const depthInput = depthRow.querySelector<HTMLInputElement>('input[type="number"]')!;
    const batchInput = batchRow.querySelector<HTMLInputElement>('input[type="number"]')!;

    expect(depthInput.value).toBe('3');
    expect(batchInput.value).toBe('3');

    depthInput.value = '100';
    depthInput.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    batchInput.value = '2';
    batchInput.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(settings.manualUpdateContextDepth).toBe(100);
    expect(settings.manualUpdateBatchSize).toBe(2);
    expect(settings.autoUpdateThreshold).toBe(3);
    expect(settings.updateBatchSize).toBe(2);
    expect(saveSettings).toHaveBeenCalled();

    mount.__resetAcuV2MountForTests();
  });

  it('执行手动填表时临时把独立参数桥接给 service，结束后恢复自动更新设置', async () => {
    const settings = createSettings();
    settings.autoUpdateThreshold = 3;
    settings.updateBatchSize = 2;
    settings.manualUpdateContextDepth = 100;
    settings.manualUpdateBatchSize = 4;
    const { mount, orchestrate } = await mountFormFillPage(settings);
    const observedSettings: Array<{ threshold: number; batchSize: number }> = [];
    orchestrate.mockImplementation(async () => {
      observedSettings.push({
        threshold: settings.autoUpdateThreshold,
        batchSize: settings.updateBatchSize,
      });
      return { success: true };
    });

    const button = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('执行手动填表')) as HTMLButtonElement;
    button.click();
    await new Promise(r => setTimeout(r, 0));

    expect(observedSettings).toEqual([{ threshold: 100, batchSize: 4 }]);
    expect(settings.autoUpdateThreshold).toBe(3);
    expect(settings.updateBatchSize).toBe(2);

    mount.__resetAcuV2MountForTests();
  });

  it('执行手动填表会把已选表传给 service 编排，空附加要求不传入额外内容', async () => {
    const { mount, orchestrate, manualExtraHintSetter } = await mountFormFillPage();

    const button = Array.from(document.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('执行手动填表')) as HTMLButtonElement;
    expect(button).not.toBeUndefined();
    button.click();
    await new Promise(r => setTimeout(r, 0));

    expect(orchestrate).toHaveBeenCalled();
    expect(orchestrate.mock.calls[0][0]).toEqual(['sheet_a', 'sheet_b']);
    expect(manualExtraHintSetter).not.toHaveBeenCalled();

    mount.__resetAcuV2MountForTests();
  });

  it('手动填表展示 orchestrator 的具体进度文案，不把分组数显示成重试次数', async () => {
    const { mount, orchestrate } = await mountFormFillPage();
    let releaseOrchestrate = () => {};
    orchestrate.mockImplementation(async (...args: any[]) => {
      const onProgress = args[4] as ((event: any) => void) | undefined;
      expect(onProgress).toEqual(expect.any(Function));
      onProgress?.({
        phase: 'calling_ai',
        currentBatch: 1,
        totalBatches: 1,
        attempt: 1,
        maxRetries: 20,
        message: '正在生成第 1/20 组 AI 响应...',
      });
      await new Promise<void>(resolve => {
        releaseOrchestrate = resolve;
      });
      return { success: true };
    });

    const panel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-form-fill-page__grid > .acu-panel'))
      .find(item => item.querySelector('.acu-panel__title')?.textContent?.includes('手动填表'))!;
    const button = Array.from(panel.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('执行手动填表')) as HTMLButtonElement;
    button.click();
    await new Promise(r => setTimeout(r, 0));

    const toastText = document.querySelector('.acu-toast-viewport')?.textContent || '';
    expect(toastText).toContain('批次 1/1 · 正在生成第 1/20 组手动填表结果...');
    expect(toastText).not.toContain('调用 AI (1/20)');
    expect(button.textContent || '').toContain('填表中...');

    expect(orchestrate).toHaveBeenCalled();
    releaseOrchestrate();
    await new Promise(r => setTimeout(r, 0));

    mount.__resetAcuV2MountForTests();
  });

  it('手动填表适配器会把 prepare/defer 执行选项转交给核心执行器', async () => {
    const { mount, orchestrate, executeCore } = await mountFormFillPage();
    orchestrate.mockImplementation(async (_targetKeys: string[], processBatch: any) => {
      await processBatch([7], 'manual_independent', {
        targetSheetKeys: ['sheet_a'],
        batchSize: 1,
        prepareAiCallOnly: true,
        deferApply: true,
        deferPersistence: true,
      });
      return { success: true };
    });

    const panel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-form-fill-page__grid > .acu-panel'))
      .find(item => item.querySelector('.acu-panel__title')?.textContent?.includes('手动填表'))!;
    const button = Array.from(panel.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('执行手动填表')) as HTMLButtonElement;
    button.click();
    await new Promise(r => setTimeout(r, 0));

    expect(executeCore).toHaveBeenCalled();
    expect(executeCore.mock.calls[0][10]).toEqual({
      prepareAiCallOnly: true,
      deferApply: true,
      deferPersistence: true,
      deferredAiResponse: null,
    });

    mount.__resetAcuV2MountForTests();
  });

  it('手动填表附加要求常驻显示，填写后传给本次执行', async () => {
    const { mount, manualExtraHintSetter } = await mountFormFillPage();

    const panel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-form-fill-page__grid > .acu-panel'))
      .find(item => item.querySelector('.acu-panel__title')?.textContent?.includes('手动填表'))!;
    const textarea = panel.querySelector<HTMLTextAreaElement>('.acu-v2-form-fill-page__manual-extra textarea')!;
    expect(textarea).not.toBeNull();

    textarea.value = '只更新角色状态。';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    const button = Array.from(panel.querySelectorAll('button'))
      .find(btn => btn.textContent?.includes('执行手动填表')) as HTMLButtonElement;
    button.click();
    await new Promise(r => setTimeout(r, 0));

    expect(manualExtraHintSetter).toHaveBeenCalledWith(
      '以下为用户的额外填表要求,请严格遵守:\n只更新角色状态。',
    );

    mount.__resetAcuV2MountForTests();
  });
});
