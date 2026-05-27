/**
 * API preset draft helpers — 面板内新建/编辑表单的数据转换
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import {
  apiPresetDraftFromPreset,
  apiPresetFromDraft,
  applyConnectionMode,
  connectionModeFromDraft,
  createEmptyApiPresetDraft,
} from '../../../src/presentation-v2/composables/useApiPresetManagement';

describe('api preset draft helpers', () => {
  it('从空白草稿开始新建预设', () => {
    const draft = createEmptyApiPresetDraft();

    expect(draft.name).toBe('');
    expect(draft.apiMode).toBe('custom');
    expect(draft.useMainApi).toBe(true);
    expect(connectionModeFromDraft(draft)).toBe('main');
  });

  it('把预设转换为可编辑草稿', () => {
    const draft = apiPresetDraftFromPreset({
      name: 'preset-a',
      apiMode: 'custom',
      apiConfig: {
        url: 'https://a.test',
        apiKey: 'k',
        model: 'gpt-4',
        useMainApi: false,
        max_tokens: 4096,
        temperature: 0.7,
      },
      tavernProfile: '',
    });

    expect(draft.name).toBe('preset-a');
    expect(draft.url).toBe('https://a.test');
    expect(draft.model).toBe('gpt-4');
    expect(connectionModeFromDraft(draft)).toBe('custom');
  });

  it('连接方式切换会写回草稿字段', () => {
    const draft = createEmptyApiPresetDraft();

    applyConnectionMode(draft, 'tavern');
    expect(draft.apiMode).toBe('tavern');
    expect(draft.useMainApi).toBe(false);
    expect(connectionModeFromDraft(draft)).toBe('tavern');

    applyConnectionMode(draft, 'custom');
    expect(draft.apiMode).toBe('custom');
    expect(draft.useMainApi).toBe(false);
    expect(connectionModeFromDraft(draft)).toBe('custom');
  });

  it('保存前归一化名称、端点、模型和数字参数', () => {
    const preset = apiPresetFromDraft({
      ...createEmptyApiPresetDraft(),
      name: '  preset-b  ',
      useMainApi: false,
      url: '  https://b.test/v1  ',
      model: '  model-b  ',
      max_tokens: 128.8,
      temperature: Number.NaN,
    });

    expect(preset.name).toBe('preset-b');
    expect(preset.apiConfig.url).toBe('https://b.test/v1');
    expect(preset.apiConfig.model).toBe('model-b');
    expect(preset.apiConfig.max_tokens).toBe(128);
    expect(preset.apiConfig.temperature).toBe(1);
  });
});
