/**
 * useTableTemplatePresets — 表格模板预设状态语义
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function importComposable() {
  vi.resetModules();
  let selectedGlobal = 'global-A';
  let selectedChat = 'global-A';
  const applyTemplatePresetToCurrent_ACU = vi.fn(async () => ({ presetName: selectedChat }));
  const resolveTemplateForExport_ACU = vi.fn(() => ({ jsonData: { sheet_1: {} }, fromPresetName: selectedChat || '默认预设' }));

  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: {},
  }));
  vi.doMock('../../../src/service/template/chat-scope', () => ({
    listChatTemplatePresetEntries_ACU: () => [],
    sanitizeChatSheetsObject_ACU: (value: any) => value,
  }));
  vi.doMock('../../../src/shared/template-preset-utils', () => ({
    getCurrentTemplatePresetName_ACU: () => selectedGlobal,
    normalizeTemplatePresetSelectionValue_ACU: (value: string) => String(value || '').trim(),
    sanitizeFilenameComponent_ACU: (value: string) => String(value || '').trim(),
    deriveTemplatePresetNameForImport_ACU: () => '导入模板',
  }));
  vi.doMock('../../../src/service/template/template-preset-service', () => ({
    applyTemplatePresetToCurrent_ACU,
    deleteTemplatePreset_ACU: vi.fn(() => true),
    ensureUniqueTemplatePresetName_ACU: (name: string) => name,
    getDefaultTemplateSnapshot_ACU: () => ({ templateObj: { sheet_1: {} }, templateStr: '{"sheet_1":{}}' }),
    getTemplatePreset_ACU: () => ({ templateStr: '{"sheet_1":{}}' }),
    listTemplatePresetNames_ACU: () => ['global-A', 'chat-A'],
    normalizeTemplateForPresetSave_ACU: () => ({ templateStr: '{"sheet_1":{}}' }),
    parseImportedTemplateData_ACU: () => ({ templateStr: '{"sheet_1":{}}' }),
    resolveActiveTemplatePresetName_ACU: () => selectedChat,
    resolveTemplateForExport_ACU,
    upsertTemplatePreset_ACU: vi.fn(() => true),
  }));

  const { createPinia, setActivePinia } = await import('pinia');
  setActivePinia(createPinia());
  const [{ useTableTemplatePresets }, { useToastStore }] = await Promise.all([
    import('../../../src/presentation-v2/composables/useTableTemplatePresets'),
    import('../../../src/presentation-v2/stores/toast-store'),
  ]);
  return {
    useTableTemplatePresets,
    toast: useToastStore(),
    applyTemplatePresetToCurrent_ACU,
    resolveTemplateForExport_ACU,
    setSelectedGlobal: (value: string) => { selectedGlobal = value; },
    setSelectedChat: (value: string) => { selectedChat = value; },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useTableTemplatePresets', () => {
  it('isChatOverridden 仅在当前聊天选择偏离全局默认时为 true', async () => {
    const { useTableTemplatePresets, setSelectedChat, setSelectedGlobal } = await importComposable();
    const presets = useTableTemplatePresets();

    expect(presets.isChatOverridden.value).toBe(false);

    setSelectedChat('chat-A');
    presets.refresh();
    expect(presets.isChatOverridden.value).toBe(true);

    setSelectedChat('global-A');
    presets.refresh();
    expect(presets.isChatOverridden.value).toBe(false);

    setSelectedGlobal('');
    setSelectedChat('');
    presets.refresh();
    expect(presets.isChatOverridden.value).toBe(false);
  });

  it('操作失败时保留局部错误并显示短 toast', async () => {
    const { useTableTemplatePresets, toast, applyTemplatePresetToCurrent_ACU } = await importComposable();
    const presets = useTableTemplatePresets();
    applyTemplatePresetToCurrent_ACU.mockResolvedValueOnce(null as any);

    await presets.selectGlobalPreset('broken');

    expect(presets.message.value).toMatchObject({
      kind: 'error',
      text: '全局模板预设切换失败。',
    });
    expect(toast.items.at(-1)).toMatchObject({
      kind: 'error',
      text: '全局模板预设切换失败。',
    });
  });

  it('导出无法解析当前模板时显示短 toast', async () => {
    const { useTableTemplatePresets, toast, resolveTemplateForExport_ACU } = await importComposable();
    const presets = useTableTemplatePresets();
    resolveTemplateForExport_ACU.mockReturnValueOnce(null as any);

    presets.exportTemplate('global');

    expect(presets.message.value).toMatchObject({
      kind: 'error',
      text: '无法解析当前模板。',
    });
    expect(toast.items.at(-1)).toMatchObject({
      kind: 'error',
      text: '无法解析当前模板。',
    });
  });
});
