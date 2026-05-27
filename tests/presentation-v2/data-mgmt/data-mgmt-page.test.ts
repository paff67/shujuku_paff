/**
 * DataMgmtPage 集成 — 数据管理页结构与关键动作
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'acu_v2_ui_state';

function createSettings() {
  return {
    dataIsolationEnabled: true,
    dataIsolationCode: 'alpha',
    deleteStartFloor: 1,
    deleteEndFloor: null,
    charCardPrompt: [{ role: 'system', content: 'prompt' }],
    mergeSummaryPrompt: 'merge prompt',
    mergeTargetCount: 1,
    mergeBatchSize: 5,
    mergeStartIndex: 1,
    mergeEndIndex: null,
    autoMergeEnabled: false,
    autoMergeThreshold: 20,
    autoMergeReserve: 0,
    apiPresets: [],
    defaultApiPresetName: '',
    apiPresetBindingsByChat: {},
    contentOptimizationSettings: { apiPreset: '' },
    tableApiPresetOverridesByName: {},
    retainRecentLayers: 100,
  } as any;
}

async function mountDataMgmtPage() {
  vi.resetModules();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ router: { activePageId: 'data-mgmt' } }));

  const settings = createSettings();
  const isolationHistory = ['alpha', 'beta'];
  const saveSettings = vi.fn(() => ({ saved: true, storageType: 'memory' }));
  const applyTemplateScope = vi.fn(() => ({
    mode: 'chat_override',
    isolationKey: settings.dataIsolationCode,
    presetName: 'chat-template',
  }));
  const switchIsolation = vi.fn(async (code: string) => {
    settings.dataIsolationCode = code;
    settings.dataIsolationEnabled = !!code;
    if (code && !isolationHistory.includes(code)) isolationHistory.unshift(code);
  });
  const removeHistory = vi.fn((code: string) => {
    const index = isolationHistory.indexOf(code);
    if (index >= 0) isolationHistory.splice(index, 1);
  });
  const deleteGenerated = vi.fn(async () => undefined);
  const deleteLocalData = vi.fn(async () => 2);
  const cleanupWorldbook = vi.fn(async () => 1);
  const overrideLatest = vi.fn(async () => 3);
  const loadOrCreate = vi.fn(async () => ({ ok: true }));
  const refreshMerged = vi.fn(async () => ({ ok: true }));
  const applyTemplate = vi.fn(async () => ({ templateStr: '{}', templateObj: {} }));

  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:acu-test'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: settings,
    currentChatFileIdentifier_ACU: 'chat-data',
    currentJsonTableData_ACU: {
      mate: { type: 'chatSheets' },
      sheet_a: { name: 'A', content: [['h']], sourceData: {} },
      sheet_b: { name: 'B', content: [['h']], sourceData: {} },
    },
    getCurrentIsolationKey_ACU: () => settings.dataIsolationCode || '',
    coreApisAreReady_ACU: true,
  }));
  vi.doMock('../../../src/service/settings/settings-service', () => ({
    applyTemplateScopeForCurrentChat_ACU: applyTemplateScope,
    getDataIsolationHistory_ACU: () => [...isolationHistory],
    removeDataIsolationHistory_ACU: removeHistory,
    saveSettings_ACU: saveSettings,
    switchIsolationProfile_ACU: switchIsolation,
    applyCombinedSettingsImport_ACU: vi.fn(() => ['charCardPrompt']),
  }));
  vi.doMock('../../../src/service/chat/chat-service', () => ({
    getChatArray_ACU: () => [
      { is_user: true, mes: 'u' },
      { is_user: false, TavernDB_ACU_IsolatedData: { alpha: {} } },
      { is_user: false, TavernDB_ACU_IsolatedData: { alpha: {} } },
    ],
    deleteLocalDataInChatCore_ACU: deleteLocalData,
    overrideLatestLayerWithTemplateCore_ACU: overrideLatest,
  }));
  vi.doMock('../../../src/service/table/table-service', () => ({
    loadOrCreateJsonTableFromChatHistory_ACU: loadOrCreate,
  }));
  vi.doMock('../../../src/service/worldbook/worldbook-cleanup', () => ({
    cleanupWorldbookEntriesAfterDataDeletion_ACU: cleanupWorldbook,
  }));
  vi.doMock('../../../src/service/worldbook/pipeline', () => ({
    deleteAllGeneratedEntries_ACU: deleteGenerated,
    refreshMergedDataAndNotify_ACU: refreshMerged,
  }));
  vi.doMock('../../../src/service/template/template-preset-service', () => ({
    applyTemplateSnapshotToScope_ACU: applyTemplate,
    getDefaultTemplateSnapshot_ACU: () => ({
      templateStr: JSON.stringify({
        mate: { type: 'chatSheets' },
        sheet_a: { name: 'A', content: [['h']], sourceData: {} },
      }),
      templateObj: {
        mate: { type: 'chatSheets' },
        sheet_a: { name: 'A', content: [['h']], sourceData: {} },
      },
    }),
  }));
  vi.doMock('../../../src/service/table/storage-mode', () => ({
    isSqliteMode: () => false,
  }));

  const mount = await import('../../../src/presentation-v2/bootstrap/mount');
  await mount.openAcuV2App();
  await new Promise(r => setTimeout(r, 0));

  return {
    mount,
    settings,
    applyTemplateScope,
    saveSettings,
    switchIsolation,
    removeHistory,
    deleteGenerated,
    deleteLocalData,
    cleanupWorldbook,
    overrideLatest,
    loadOrCreate,
    refreshMerged,
    applyTemplate,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DataMgmtPage', () => {
  it('渲染数据管理页三个面板，不包含交火模式索引管理', async () => {
    const { mount } = await mountDataMgmtPage();

    const page = document.querySelector('.acu-v2-data-mgmt-page');
    expect(page).not.toBeNull();
    const text = page!.textContent || '';
    expect(document.querySelector('.acu-v2-app__page-title')?.textContent?.trim()).toBe('数据管理');
    expect(text).toContain('数据隔离');
    expect(text).toContain('备份与恢复');
    expect(text).toContain('删除与清理');
    expect(text).toContain('删除当前标识注入条目');
    expect(text).not.toContain('交火模式索引管理');
    expect(text).not.toContain('删除当前交火索引');
    expect(text).not.toContain('清空临时缓存');

    mount.__resetAcuV2MountForTests();
  });

  it('数据隔离面板承载标识应用和当前标识注入条目清理', async () => {
    const { mount } = await mountDataMgmtPage();

    const isolationPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'))!;
    const labels = Array.from(isolationPanel.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page__actions button'))
      .map(button => button.textContent?.trim() || '');

    expect(labels).toEqual(['删除当前标识注入条目', '保存并应用']);

    mount.__resetAcuV2MountForTests();
  });

  it('每个面板都渲染常驻说明信息条', async () => {
    const { mount } = await mountDataMgmtPage();

    const panels = document.querySelectorAll('.acu-v2-data-mgmt-page .acu-panel');
    expect(panels.length).toBe(3);
    panels.forEach(panel => {
      expect(panel.querySelector('.acu-panel__description-region .acu-info-banner')).not.toBeNull();
      expect(panel.querySelector('.acu-panel__header .acu-info-banner')).toBeNull();
    });

    mount.__resetAcuV2MountForTests();
  });

  it('左列放数据隔离和备份恢复，右列放删除清理', async () => {
    const { mount } = await mountDataMgmtPage();

    const columns = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page__panel-stack'));
    expect(columns).toHaveLength(2);

    const leftTitles = Array.from(columns[0].querySelectorAll<HTMLElement>('.acu-panel__title'))
      .map(title => title.textContent?.trim() || '');
    const rightTitles = Array.from(columns[1].querySelectorAll<HTMLElement>('.acu-panel__title'))
      .map(title => title.textContent?.trim() || '');

    expect(leftTitles).toEqual(['数据隔离', '备份与恢复']);
    expect(rightTitles).toEqual(['删除与清理']);

    mount.__resetAcuV2MountForTests();
  });

  it('删除与清理面板分为自动清理和手动删除', async () => {
    const { mount } = await mountDataMgmtPage();

    const cleanupPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('删除与清理'))!;
    const sectionTitles = Array.from(cleanupPanel.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page__section-title'))
      .map(title => title.textContent?.trim() || '');

    expect(sectionTitles).toEqual(['自动清理', '手动删除']);
    expect(cleanupPanel.textContent || '').toContain('保留数据层数');
    expect(cleanupPanel.textContent || '').toContain('删除当前标识本地数据');

    mount.__resetAcuV2MountForTests();
  });

  it('数据隔离面板不再使用统计列表，历史标识收进折叠列表', async () => {
    const { mount } = await mountDataMgmtPage();

    const panels = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'));
    const isolationPanel = panels.find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'));
    const backupPanel = panels.find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('备份与恢复'));
    const cleanupPanel = panels.find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('删除与清理'));

    expect(isolationPanel?.querySelector('.acu-stats')).toBeNull();
    expect(isolationPanel?.querySelector('.acu-v2-data-mgmt-page__history')).not.toBeNull();
    expect(isolationPanel?.textContent || '').toContain('当前正在使用：alpha');
    expect(backupPanel?.querySelector('.acu-stats')).toBeNull();
    expect(cleanupPanel?.querySelector('.acu-stats')).toBeNull();
    expect(backupPanel?.querySelector('.acu-v2-data-mgmt-page__meta')).toBeNull();
    expect(cleanupPanel?.querySelector('.acu-v2-data-mgmt-page__meta')?.textContent).toContain('当前聊天 2 个 AI 楼层');

    mount.__resetAcuV2MountForTests();
  });

  it('全局 header 展示当前页标题，页面内不再渲染重复 header', async () => {
    const { mount } = await mountDataMgmtPage();

    expect(document.querySelector('.acu-v2-data-mgmt-page .acu-page-header')).toBeNull();
    const globalTitle = document.querySelector('.acu-v2-app__page-title');
    expect(globalTitle?.textContent?.trim()).toBe('数据管理');

    mount.__resetAcuV2MountForTests();
  });

  it('历史标识选择后保存并应用会切换隔离 profile', async () => {
    const { mount, switchIsolation } = await mountDataMgmtPage();

    const historyToggle = Array.from(document.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page .acu-disclosure-group__header'))
      .find(button => button.textContent?.includes('历史标识'))!;
    historyToggle.click();
    await new Promise(r => setTimeout(r, 0));
    const beta = Array.from(document.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page__history-fill'))
      .find(item => item.textContent?.includes('beta'));
    expect(beta).not.toBeUndefined();
    beta!.click();
    await new Promise(r => setTimeout(r, 0));

    const applyButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('保存并应用'));
    expect(applyButton).not.toBeUndefined();
    applyButton!.click();
    await new Promise(r => setTimeout(r, 0));

    expect(switchIsolation).toHaveBeenCalledWith('beta');

    mount.__resetAcuV2MountForTests();
  });

  it('输入任意新标识后保存会刷新当前标识和历史列表', async () => {
    const { mount, switchIsolation } = await mountDataMgmtPage();
    const newCode = 'custom-profile';

    const isolationPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'))!;
    const codeInput = isolationPanel.querySelector<HTMLInputElement>('input[type="text"]')!;
    codeInput.value = newCode;
    codeInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    const applyButton = Array.from(isolationPanel.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page__actions button'))
      .find(button => button.textContent?.includes('保存并应用'))!;
    applyButton.click();
    await new Promise(r => setTimeout(r, 0));

    expect(switchIsolation).toHaveBeenCalledWith(newCode);
    expect(document.body.textContent || '').toContain(`已切换到 ${newCode}。`);
    expect(isolationPanel.textContent || '').toContain(`当前正在使用：${newCode}`);

    const historyToggle = isolationPanel.querySelector<HTMLButtonElement>('.acu-disclosure-group__header')!;
    historyToggle.click();
    await new Promise(r => setTimeout(r, 0));
    const options = Array.from(isolationPanel.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page__history-fill'))
      .map(item => item.textContent?.trim() || '');
    expect(options.some(item => item.includes(newCode))).toBe(true);

    mount.__resetAcuV2MountForTests();
  });

  it('历史标识行内可以删除选中的历史记录', async () => {
    const { mount, removeHistory } = await mountDataMgmtPage();

    const isolationPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'))!;
    const historyToggle = isolationPanel.querySelector<HTMLButtonElement>('.acu-disclosure-group__header')!;
    historyToggle.click();
    await new Promise(r => setTimeout(r, 0));

    const removeButton = isolationPanel.querySelector<HTMLButtonElement>('button[aria-label="删除历史标识：beta"]');
    expect(removeButton).not.toBeNull();
    expect(removeButton!.disabled).toBe(false);
    removeButton!.click();
    await new Promise(r => setTimeout(r, 0));

    expect(removeHistory).toHaveBeenCalledWith('beta');
    expect(document.body.textContent || '').toContain('已从历史记录移除标识：beta');

    mount.__resetAcuV2MountForTests();
  });

  it('删除当前正在使用的历史标识会先切回默认再移除历史', async () => {
    const { mount, switchIsolation, removeHistory } = await mountDataMgmtPage();

    const isolationPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'))!;
    const historyToggle = isolationPanel.querySelector<HTMLButtonElement>('.acu-disclosure-group__header')!;
    historyToggle.click();
    await new Promise(r => setTimeout(r, 0));

    const removeButton = isolationPanel.querySelector<HTMLButtonElement>('button[aria-label="删除历史标识：alpha"]')!;
    removeButton.click();
    await new Promise(r => setTimeout(r, 0));

    expect(switchIsolation).toHaveBeenCalledWith('');
    expect(removeHistory).toHaveBeenCalledWith('alpha');
    expect(document.body.textContent || '').toContain('已从历史记录移除标识：alpha；当前已切换到默认数据（未隔离）。');
    expect(isolationPanel.textContent || '').toContain('当前正在使用：默认数据（未隔离）');

    mount.__resetAcuV2MountForTests();
  });

  it('删除当前标识本地数据会保存范围并调用清理链路', async () => {
    const { mount, deleteLocalData, cleanupWorldbook, loadOrCreate, refreshMerged, saveSettings } = await mountDataMgmtPage();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const deleteButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('删除当前标识本地数据'));
    expect(deleteButton).not.toBeUndefined();
    deleteButton!.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(saveSettings).toHaveBeenCalled();
    expect(deleteLocalData).toHaveBeenCalledWith('current', 1, null);
    expect(loadOrCreate).toHaveBeenCalled();
    expect(refreshMerged).toHaveBeenCalled();
    expect(cleanupWorldbook).toHaveBeenCalled();
    expect(document.body.textContent || '').toContain('已删除 2 条消息中的本地数据');

    mount.__resetAcuV2MountForTests();
  });

  it('删除当前标识注入条目会调用世界书注入条目删除链路', async () => {
    const { mount, deleteGenerated } = await mountDataMgmtPage();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const isolationPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('数据隔离'))!;
    const cleanupPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('删除与清理'))!;
    const isolationButtons = Array.from(isolationPanel.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page__actions button'));
    const localDataButtons = Array.from(cleanupPanel.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page__command-grid--cleanup button'));
    expect(localDataButtons.map(button => button.textContent?.trim() || '')).toEqual([
      '删除当前标识本地数据',
      '删除所有本地数据',
    ]);
    const button = isolationButtons
      .find(item => item.textContent?.includes('删除当前标识注入条目'));
    expect(button).not.toBeUndefined();
    button!.click();
    await new Promise(r => setTimeout(r, 0));

    expect(deleteGenerated).toHaveBeenCalled();
    expect(document.body.textContent || '').toContain('已删除当前标识对应的数据库注入条目。');

    mount.__resetAcuV2MountForTests();
  });

  it('删除与清理面板可以保存自动保留本地数据层数', async () => {
    const { mount, settings, saveSettings } = await mountDataMgmtPage();

    const cleanupPanel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('删除与清理'))!;
    const retentionRow = Array.from(cleanupPanel.querySelectorAll<HTMLElement>('.acu-form-row'))
      .find(row => (row.textContent || '').includes('保留数据层数'))!;
    const input = retentionRow.querySelector<HTMLInputElement>('input[type="number"]')!;
    input.value = '30';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 0));

    expect(settings.retainRecentLayers).toBe(30);
    expect(saveSettings).toHaveBeenCalled();
    expect(document.body.textContent || '').not.toContain('自动清理策略已保存：保留最近 30 层本地数据。');

    mount.__resetAcuV2MountForTests();
  });

  it('模板覆盖最新层数据会先同步当前聊天生效模板再执行覆盖链路', async () => {
    const { mount, applyTemplateScope, overrideLatest, loadOrCreate, refreshMerged } = await mountDataMgmtPage();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(item => item.textContent?.includes('模板覆盖最新层数据'));
    expect(button).not.toBeUndefined();
    button!.click();
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(applyTemplateScope).toHaveBeenCalledTimes(1);
    expect(overrideLatest).toHaveBeenCalledTimes(1);
    expect(applyTemplateScope.mock.invocationCallOrder[0]).toBeLessThan(overrideLatest.mock.invocationCallOrder[0]);
    expect(loadOrCreate).toHaveBeenCalled();
    expect(refreshMerged).toHaveBeenCalled();
    expect(document.body.textContent || '').toContain('已使用当前生效模板覆盖最新 AI 楼层的 3 个表格。');

    mount.__resetAcuV2MountForTests();
  });

  it('备份与恢复面板导出合并配置和 JSON 数据使用普通按钮', async () => {
    const { mount } = await mountDataMgmtPage();

    const panel = Array.from(document.querySelectorAll<HTMLElement>('.acu-v2-data-mgmt-page .acu-panel'))
      .find(el => el.querySelector('.acu-panel__title')?.textContent?.includes('备份与恢复'));
    expect(panel).not.toBeUndefined();

    const buttons = Array.from(panel!.querySelectorAll<HTMLButtonElement>('button'));
    expect(panel!.querySelector('.acu-v2-data-mgmt-page__command-grid')).not.toBeNull();
    const labels = buttons.map(button => button.textContent?.trim() || '').filter(Boolean);
    expect(labels).toEqual([
      '合并导入（模板+指令）',
      '合并导出（模板+指令）',
      '特殊导出',
      '模板覆盖最新层数据',
    ]);
    expect(buttons.find(button => button.textContent?.includes('特殊导出'))?.classList.contains('acu-btn--default')).toBe(true);
    expect(buttons.find(button => button.textContent?.includes('模板覆盖最新层数据'))?.classList.contains('acu-btn--default')).toBe(true);

    mount.__resetAcuV2MountForTests();
  });

  it('全页只保留删除所有本地数据为红色危险按钮', async () => {
    const { mount } = await mountDataMgmtPage();

    const dangerButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.acu-v2-data-mgmt-page button.acu-btn--danger'));
    expect(dangerButtons.map(button => button.textContent?.trim())).toEqual(['删除所有本地数据']);

    mount.__resetAcuV2MountForTests();
  });
});
