/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function importHelpers(settings: any, chatKey = 'chat-A') {
  vi.resetModules();
  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: settings,
    currentChatFileIdentifier_ACU: chatKey,
  }));
  const mod = await import('../../../src/service/ai/api-call');
  return {
    resolveCurrentChatApiPresetName_ACU: mod.resolveCurrentChatApiPresetName_ACU,
    applyCurrentChatApiPresetSelection_ACU: mod.applyCurrentChatApiPresetSelection_ACU,
  };
}

function createSettings() {
  return {
    apiMode: 'custom',
    apiConfig: { url: '', apiKey: '', model: '', useMainApi: true },
    tavernProfile: '',
    apiPresets: [
      {
        name: 'default-api',
        apiMode: 'custom',
        apiConfig: { url: 'https://default.test', apiKey: 'kd', model: 'md', useMainApi: false },
        tavernProfile: '',
      },
      {
        name: 'chat-api',
        apiMode: 'tavern',
        apiConfig: { url: '', apiKey: '', model: '', useMainApi: true },
        tavernProfile: 'profile-chat',
      },
    ],
    defaultApiPresetName: 'default-api',
    apiPresetBindingsByChat: {},
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('current chat API preset selection', () => {
  it('当前聊天绑定优先于默认星标', async () => {
    const settings = createSettings();
    settings.apiPresetBindingsByChat['chat-A'] = { presetName: 'chat-api', updatedAt: 1 };
    const helpers = await importHelpers(settings);

    expect(helpers.resolveCurrentChatApiPresetName_ACU()).toBe('chat-api');
    expect(helpers.applyCurrentChatApiPresetSelection_ACU()).toBe('chat-api');
    expect(settings.apiMode).toBe('tavern');
    expect(settings.tavernProfile).toBe('profile-chat');
  });

  it('无聊天绑定时回退到默认星标并投影到旧当前配置', async () => {
    const settings = createSettings();
    const helpers = await importHelpers(settings);

    expect(helpers.resolveCurrentChatApiPresetName_ACU()).toBe('default-api');
    expect(helpers.applyCurrentChatApiPresetSelection_ACU()).toBe('default-api');
    expect(settings.apiMode).toBe('custom');
    expect(settings.apiConfig.url).toBe('https://default.test');
    expect(settings.apiConfig.model).toBe('md');
  });

  it('绑定和默认都失效时不覆盖旧当前配置', async () => {
    const settings = createSettings();
    settings.defaultApiPresetName = 'missing';
    settings.apiPresetBindingsByChat['chat-A'] = { presetName: 'also-missing', updatedAt: 1 };
    const helpers = await importHelpers(settings);

    expect(helpers.resolveCurrentChatApiPresetName_ACU()).toBe('');
    expect(helpers.applyCurrentChatApiPresetSelection_ACU()).toBe('');
    expect(settings.apiConfig.useMainApi).toBe(true);
  });
});
