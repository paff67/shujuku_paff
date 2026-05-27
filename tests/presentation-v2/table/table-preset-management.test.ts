/**
 * useTablePresetManagement — 表格模板预设管理行为
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function importManagement() {
  vi.resetModules();
  const deleteTemplatePreset = vi.fn(() => true);
  const applyTemplatePresetToCurrent = vi.fn(async () => ({ presetName: '', isDefault: true }));
  const openVisualizerSurface = vi.fn(async () => true);

  vi.doMock('../../../src/service/template/template-preset-service', () => ({
    applyTemplatePresetToCurrent_ACU: applyTemplatePresetToCurrent,
    deleteTemplatePreset_ACU: deleteTemplatePreset,
    ensureUniqueTemplatePresetName_ACU: (name: string) => name,
    getDefaultTemplateSnapshot_ACU: () => ({ templateStr: '{"mate":{"type":"chatSheets"},"sheet_a":{"name":"A","content":[],"sourceData":{}}}' }),
    getTemplatePreset_ACU: () => ({ templateStr: '{}' }),
    listTemplatePresetNames_ACU: () => ['global-A', 'global-B'],
    resolveActiveTemplatePresetName_ACU: () => 'global-A',
    resolveTemplateForExport_ACU: () => ({ jsonData: {}, fromPresetName: 'global-A' }),
    upsertTemplatePreset_ACU: vi.fn(() => true),
  }));
  vi.doMock('../../../src/service/template/chat-scope', () => ({
    sanitizeChatSheetsObject_ACU: (value: any) => value,
  }));
  vi.doMock('../../../src/shared/template-preset-utils', () => ({
    sanitizeFilenameComponent_ACU: (value: string) => value,
    normalizeTemplatePresetSelectionValue_ACU: (value: unknown) => String(value ?? '').trim(),
    getCurrentTemplatePresetName_ACU: () => 'global-A',
  }));
  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: { currentTemplatePresetName: 'global-A' },
  }));
  vi.doMock('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface', () => ({
    openVisualizerSurface_ACU: openVisualizerSurface,
  }));

  const { createPinia, setActivePinia } = await import('pinia');
  setActivePinia(createPinia());
  const { useTablePresetManagement } = await import('../../../src/presentation-v2/composables/useTablePresetManagement');
  return {
    management: useTablePresetManagement(),
    deleteTemplatePreset,
    applyTemplatePresetToCurrent,
    openVisualizerSurface,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useTablePresetManagement', () => {
  it('删除当前选中预设后，将全局默认和当前聊天回退到默认预设', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { management, deleteTemplatePreset, applyTemplatePresetToCurrent } = await importManagement();

    await management.deletePreset('global-A');

    expect(deleteTemplatePreset).toHaveBeenCalledWith('global-A');
    expect(applyTemplatePresetToCurrent).toHaveBeenCalledWith('', expect.objectContaining({
      updateGlobal: true,
      persistChatScope: false,
    }));
    expect(applyTemplatePresetToCurrent).toHaveBeenCalledWith('', expect.objectContaining({
      updateGlobal: false,
      persistChatScope: true,
    }));
  });

  it('从 v2 表格模板面板打开 v2 visualizer，不走旧 AutoCardUpdaterAPI', async () => {
    const { management, openVisualizerSurface } = await importManagement();

    await management.openVisualizer();

    expect(openVisualizerSurface).toHaveBeenCalledWith({ source: 'v2-shell' });
  });

  it('编辑指定预设时先切换聊天预设，再打开 v2 visualizer', async () => {
    const { management, applyTemplatePresetToCurrent, openVisualizerSurface } = await importManagement();

    await management.editPreset('global-B');

    expect(applyTemplatePresetToCurrent).toHaveBeenCalledWith('global-B', expect.objectContaining({
      source: 'v2_table_drawer_edit',
      persistChatScope: true,
    }));
    expect(openVisualizerSurface).toHaveBeenCalledWith({ source: 'v2-shell' });
  });
});
