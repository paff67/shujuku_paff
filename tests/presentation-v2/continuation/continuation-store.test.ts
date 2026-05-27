/**
 * continuation-store — 智能续写 v2 设置边界
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function createSettings() {
  return {
    plotSettings: {
      contextTurnCount: 3,
      contextExtractTags: '',
      contextExtractRules: [{ start: '<content>', end: '</content>' }],
      contextExcludeTags: '',
      contextExcludeRules: [{ start: '<think>', end: '</think>' }],
      loopSettings: {
        quickReplyContent: ['继续推进剧情'],
        currentPromptIndex: 0,
        loopTags: 'content',
        loopDelay: 5,
        retryDelay: 3,
        loopTotalDuration: 20,
        maxRetries: 3,
      },
    },
  } as any;
}

async function importStore(settings: any) {
  vi.resetModules();
  const saveSettings = vi.fn(() => ({ saved: true }));
  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: settings,
    currentChatFileIdentifier_ACU: 'chat-continuation',
  }));
  vi.doMock('../../../src/service/settings/settings-service', () => ({
    saveSettings_ACU: saveSettings,
  }));

  const [{ setActivePinia, createPinia }, { useContinuationStore }] = await Promise.all([
    import('pinia'),
    import('../../../src/presentation-v2/stores/continuation-store'),
  ]);
  setActivePinia(createPinia());
  return { store: useContinuationStore(), saveSettings };
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('useContinuationStore', () => {
  it('从 plotSettings.loopSettings 读取智能续写配置', async () => {
    const settings = createSettings();
    const { store } = await importStore(settings);

    store.refreshFromSettings();

    expect(store.prompts).toEqual(['继续推进剧情']);
    expect(store.loopTags).toBe('content');
    expect(store.loopDelay).toBe(5);
    expect(store.loopTotalDuration).toBe(20);
    expect(store.maxRetries).toBe(3);
    expect(store.contextTurnCount).toBe(3);
    expect(store.contextExtractRules).toEqual([{ start: '<content>', end: '</content>' }]);
  });

  it('编辑提示词会写回 quickReplyContent 并重置索引', async () => {
    const settings = createSettings();
    settings.plotSettings.loopSettings.currentPromptIndex = 2;
    const { store, saveSettings } = await importStore(settings);
    store.refreshFromSettings();

    store.setPrompt(0, '新的续写提示');

    expect(settings.plotSettings.loopSettings.quickReplyContent).toEqual(['新的续写提示']);
    expect(settings.plotSettings.loopSettings.currentPromptIndex).toBe(0);
    expect(saveSettings).toHaveBeenCalled();
  });

  it('规则编辑写入结构化规则并移除旧 tags 字段', async () => {
    const settings = createSettings();
    const { store } = await importStore(settings);
    store.refreshFromSettings();

    store.setContextExtractRules([{ start: '<正文>', end: '</正文>' }]);
    store.setContextExcludeRules([{ start: '<thinking>', end: '</thinking>' }]);

    expect(settings.plotSettings.contextExtractRules).toEqual([{ start: '<正文>', end: '</正文>' }]);
    expect(settings.plotSettings.contextExcludeRules).toEqual([{ start: '<thinking>', end: '</thinking>' }]);
    expect(settings.plotSettings.contextExtractTags).toBeUndefined();
    expect(settings.plotSettings.contextExcludeTags).toBeUndefined();
  });

  it('失败上限设为 49 时只解锁正文替换开关；未触碰过开关时默认关闭', async () => {
    localStorage.setItem('acu_v2_ui_state', JSON.stringify({ uiMode: { mode: 'advanced' } }));
    const settings = createSettings();
    const { store } = await importStore(settings);
    const { useRouterStore } = await import('../../../src/presentation-v2/stores/router-store');
    const { FEATURE_GATE_CONTENT_REPLACE } = await import('../../../src/presentation-v2/router/page-registry');
    const router = useRouterStore();
    store.refreshFromSettings();

    expect(router.visiblePages.map(p => p.id)).not.toContain('content-replace');
    store.setMaxRetries(49);

    expect(settings.plotSettings.loopSettings.maxRetries).toBe(49);
    expect(settings.contentOptimizationSettings.enabled).toBe(false);
    expect(router.featureGates[FEATURE_GATE_CONTENT_REPLACE]).toBe(false);
    expect(router.visiblePages.map(p => p.id)).not.toContain('content-replace');

    expect(settings.contentOptimizationSettings.enabledSwitchTouched).not.toBe(true);
  });

  it('从非 49 改填 49 时，如果开关从未被开启过，即使旧配置残留 enabled=true 也默认关闭', async () => {
    localStorage.setItem('acu_v2_ui_state', JSON.stringify({ uiMode: { mode: 'advanced' } }));
    const settings = createSettings();
    settings.contentOptimizationSettings = { enabled: true };
    const { store } = await importStore(settings);
    const { useRouterStore } = await import('../../../src/presentation-v2/stores/router-store');
    const { FEATURE_GATE_CONTENT_REPLACE } = await import('../../../src/presentation-v2/router/page-registry');
    const router = useRouterStore();
    store.refreshFromSettings();

    store.setMaxRetries(49);

    expect(settings.plotSettings.loopSettings.maxRetries).toBe(49);
    expect(settings.contentOptimizationSettings.enabled).toBe(false);
    expect(router.featureGates[FEATURE_GATE_CONTENT_REPLACE]).toBe(false);
    expect(router.visiblePages.map(p => p.id)).not.toContain('content-replace');
  });

  it('正文替换开关被用户开启过后，非 49 和 49 来回切换会保留开启偏好', async () => {
    localStorage.setItem('acu_v2_ui_state', JSON.stringify({ uiMode: { mode: 'advanced' } }));
    const settings = createSettings();
    const { store } = await importStore(settings);
    const { useRouterStore } = await import('../../../src/presentation-v2/stores/router-store');
    const { FEATURE_GATE_CONTENT_REPLACE } = await import('../../../src/presentation-v2/router/page-registry');
    const router = useRouterStore();
    store.refreshFromSettings();

    store.setMaxRetries(49);
    router.setFeatureGate(FEATURE_GATE_CONTENT_REPLACE, true);

    expect(settings.contentOptimizationSettings.enabled).toBe(true);
    expect(settings.contentOptimizationSettings.enabledSwitchTouched).toBe(true);
    expect(settings.contentOptimizationSettings.enabledPreference).toBe(true);
    expect(router.visiblePages.map(p => p.id)).toContain('content-replace');

    store.setMaxRetries(3);

    expect(settings.contentOptimizationSettings.enabled).toBe(false);
    expect(settings.contentOptimizationSettings.enabledPreference).toBe(true);
    expect(router.visiblePages.map(p => p.id)).not.toContain('content-replace');

    store.setMaxRetries(49);

    expect(settings.contentOptimizationSettings.enabled).toBe(true);
    expect(router.featureGates[FEATURE_GATE_CONTENT_REPLACE]).toBe(true);
    expect(router.visiblePages.map(p => p.id)).toContain('content-replace');
  });
});
