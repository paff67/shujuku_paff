/**
 * ContinuationPage 集成 — 智能续写页
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'acu_v2_ui_state';

function createSettings() {
  return {
    plotSettings: {
      enabled: true,
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
    contentOptimizationSettings: { apiPreset: '' },
  } as any;
}

async function mountContinuationPage(settings = createSettings()) {
  vi.resetModules();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ router: { activePageId: 'continuation' } }));
  const saveSettings = vi.fn(() => ({ saved: true }));

  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: settings,
    currentChatFileIdentifier_ACU: 'chat-continuation',
    currentJsonTableData_ACU: null,
    getCurrentIsolationKey_ACU: () => '',
    coreApisAreReady_ACU: true,
    loopState_ACU: {
      isLooping: false,
      isRetrying: false,
      timerId: null,
      retryCount: 0,
      startTime: 0,
      totalDuration: 0,
      tickInterval: null,
      awaitingReply: false,
    },
  }));
  vi.doMock('../../../src/service/settings/settings-service', () => ({
    saveSettings_ACU: saveSettings,
    setGlobalPlotEnabled_ACU: vi.fn(),
  }));
  vi.doMock('../../../src/service/ai/ai-service', () => ({
    getConnectionManagerProfiles_ACU: () => [],
    fetchAvailableModels_ACU: vi.fn(async () => ({ success: true, models: [] })),
  }));
  vi.doMock('../../../src/service/worldbook/pipeline', () => ({
    getWorldbookNames_ACU: vi.fn(async () => []),
    getLorebookEntriesByNames_ACU: vi.fn(async () => ({})),
  }));
  vi.doMock('../../../src/service/worldbook/worldbook-service', () => ({
    getCurrentCharPrimaryLorebook_ACU: vi.fn(async () => ''),
    getCharLorebooks_ACU: vi.fn(async () => ({ primary: '', additional: [] })),
  }));
  vi.doMock('../../../src/service/loop/loop-controller', async () => {
    const state = await import('../../../src/service/runtime/state-manager');
    return {
      validateLoopStartParams_ACU: vi.fn(() => null),
      initLoopState_ACU: vi.fn(() => {
        state.loopState_ACU.isLooping = true;
        state.loopState_ACU.startTime = Date.now();
        state.loopState_ACU.totalDuration = 20 * 60 * 1000;
        return { loopDuration: state.loopState_ACU.totalDuration };
      }),
      stopLoopState_ACU: vi.fn(() => {
        state.loopState_ACU.isLooping = false;
      }),
      getNextLoopPrompt_ACU: vi.fn(() => settings.plotSettings.loopSettings.quickReplyContent[0]),
    };
  });

  const mount = await import('../../../src/presentation-v2/bootstrap/mount');
  await mount.openAcuV2App();
  await new Promise(r => setTimeout(r, 0));
  return { mount, settings, saveSettings };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ContinuationPage', () => {
  it('渲染智能续写真实页面，不再是占位页', async () => {
    const { mount } = await mountContinuationPage();

    const page = document.querySelector('.acu-v2-continuation-page');
    expect(page).not.toBeNull();
    const text = page!.textContent || '';
    expect(text).toContain('循环提示词');
    expect(text).toContain('循环条件');
    expect(text).toContain('运行控制');
    expect(text).not.toContain('上下文过滤');
    const promptTextarea = page!.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(promptTextarea?.value).toBe('继续推进剧情');
    expect(Array.from(page!.querySelectorAll('.acu-panel__title')).map(el => el.textContent?.trim())).toEqual([
      '循环条件',
      '循环提示词',
      '运行控制',
    ]);
    expect(text).not.toContain('阶段 0 占位页');
    expect(text).not.toContain('外部导入');

    mount.__resetAcuV2MountForTests();
  });

  it('每个 AcuPanel 都附常驻说明信息条', async () => {
    const { mount } = await mountContinuationPage();

    const panels = document.querySelectorAll('.acu-v2-continuation-page .acu-panel');
    expect(panels).toHaveLength(3);
    panels.forEach(panel => {
      expect(panel.querySelector('.acu-panel__description-region .acu-info-banner')).not.toBeNull();
    });

    mount.__resetAcuV2MountForTests();
  });

  it('修改循环延时会写回 settings 并保存', async () => {
    const { mount, settings, saveSettings } = await mountContinuationPage();

    const delayPanel = Array.from(document.querySelectorAll('.acu-form-row'))
      .find(row => (row.textContent || '').includes('循环延时')) as HTMLElement | undefined;
    expect(delayPanel).not.toBeUndefined();
    const input = delayPanel!.querySelector('input[type="number"]') as HTMLInputElement;
    input.value = '9';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(settings.plotSettings.loopSettings.loopDelay).toBe(9);
    expect(saveSettings).toHaveBeenCalled();

    mount.__resetAcuV2MountForTests();
  });

  it('点击开始会写入酒馆输入框并触发发送按钮', async () => {
    const { mount } = await mountContinuationPage();

    const textarea = document.createElement('textarea');
    textarea.id = 'send_textarea';
    document.body.appendChild(textarea);
    const sendButton = document.createElement('button');
    sendButton.id = 'send_but';
    const sendSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);
    document.body.appendChild(sendButton);

    const startButton = Array.from(document.querySelectorAll('button'))
      .find(button => (button.textContent || '').includes('开始智能续写')) as HTMLButtonElement | undefined;
    expect(startButton).not.toBeUndefined();
    expect(startButton!.disabled).toBe(false);
    startButton!.click();
    await new Promise(r => setTimeout(r, 150));

    expect(textarea.value).toBe('继续推进剧情');
    expect(sendSpy).toHaveBeenCalled();
    expect((document.querySelector('.acu-v2-continuation-page__status') as HTMLElement).textContent || '').toContain('运行中');

    mount.__resetAcuV2MountForTests();
  });
});
