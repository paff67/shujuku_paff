/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STORAGE_KEY = 'acu_v2_ui_state';

function persistAdvancedMode(activePageId = 'dashboard'): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      uiMode: { mode: 'advanced' },
      router: { activePageId },
    }),
  );
}

async function resetMountedApp(): Promise<void> {
  const mount = await import('../../../src/presentation-v2/bootstrap/mount');
  mount.__resetAcuV2MountForTests();
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  localStorage.clear();
});

describe('openVisualizerSurface_ACU', () => {
  it('外部调用会打开 v2 shell 并进入 visualizer surface，关闭后隐藏 shell', async () => {
    persistAdvancedMode();
    const bridge = await import('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface');

    const result = await bridge.openVisualizerSurface_ACU({ source: 'external-api' });
    await Promise.resolve();

    expect(result).toBe(true);
    expect(document.getElementById('acu-app-v2')?.style.display).toBe('');
    expect(document.querySelector('[data-acu-visualizer-surface]')).not.toBeNull();
    expect(document.querySelector('[data-acu-visualizer-surface]')?.textContent).toContain('数据库编辑器');
    expect(document.querySelector('[data-acu-visualizer-surface]')?.textContent).not.toContain('无法载入数据库');
    expect(document.querySelector('[data-acu-visualizer-surface]')?.textContent).not.toContain('VZ-4');

    (document.querySelector('.acu-visualizer-surface__close') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));

    expect(document.getElementById('acu-app-v2')?.style.display).toBe('none');
    await resetMountedApp();
  });

  it('v2 已打开时进入 visualizer，关闭后恢复进入前页面', async () => {
    persistAdvancedMode('dashboard');
    const mount = await import('../../../src/presentation-v2/bootstrap/mount');
    await mount.openAcuV2App();
    await Promise.resolve();
    expect(document.querySelector('.acu-v2-app__page-title')?.textContent).toBe('仪表盘');

    const bridge = await import('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface');
    await bridge.openVisualizerSurface_ACU({ source: 'external-api' });
    await Promise.resolve();
    expect(document.querySelector('[data-acu-visualizer-surface]')?.textContent).toContain('数据库编辑器');

    (document.querySelector('.acu-visualizer-surface__close') as HTMLButtonElement).click();
    await new Promise(r => setTimeout(r, 0));

    expect(document.getElementById('acu-app-v2')?.style.display).toBe('');
    expect(document.querySelector('.acu-v2-app__page-title')?.textContent).toBe('仪表盘');
    mount.__resetAcuV2MountForTests();
  });

  it('安装独立 v2 全局接口：未打开时忽略，打开后记录刷新请求', async () => {
    persistAdvancedMode();
    const bridge = await import('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface');
    const mount = await import('../../../src/presentation-v2/bootstrap/mount');
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');
    expect(typeof (window as any).AutoCardUpdaterV2API?.openVisualizer).toBe('function');
    expect(typeof (window as any).AutoCardUpdaterV2API?.refreshVisualizer).toBe('function');

    await (window as any).AutoCardUpdaterV2API.refreshVisualizer();
    await bridge.openVisualizerSurface_ACU({ source: 'external-api' });
    await (window as any).AutoCardUpdaterV2API.refreshVisualizer();
    await Promise.resolve();

    const pinia = mount.getAcuV2PiniaForBridge();
    expect(pinia).not.toBeNull();
    expect(useVisualizerStore(pinia!).externalRefreshTick).toBe(1);
    mount.__resetAcuV2MountForTests();
  });

  it('载入当前数据后可编辑卡片并拦截 dirty 关闭', async () => {
    persistAdvancedMode();
    const state = await import('../../../src/service/runtime/state-manager');
    state._set_currentJsonTableData_ACU({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: {
        uid: 'sheet_a',
        name: '角色状态',
        orderNo: 0,
        content: [[null, '姓名', '状态'], [null, 'A', '平静']],
      },
    });
    const bridge = await import('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface');
    const mount = await import('../../../src/presentation-v2/bootstrap/mount');
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');

    await bridge.openVisualizerSurface_ACU({ source: 'external-api' });
    await new Promise(r => setTimeout(r, 0));

    const surface = document.querySelector('[data-acu-visualizer-surface]') as HTMLElement;
    expect(surface.textContent).toContain('角色状态');
    expect(surface.textContent).toContain('1 行 · 2 列');
    const topbarContext = surface.querySelector('.acu-visualizer-surface__topbar-context') as HTMLElement;
    expect(topbarContext.textContent).toContain('当前模板');
    expect(topbarContext.textContent).toContain('当前表');
    expect(topbarContext.textContent).toContain('角色状态');
    expect(topbarContext.textContent).not.toContain('已同步');
    const dataToolbar = surface.querySelector('.acu-visualizer-surface__data-toolbar') as HTMLElement;
    const dataAddButton = dataToolbar.querySelector('button') as HTMLButtonElement;
    const cardGrid = surface.querySelector('.acu-visualizer-surface__card-grid') as HTMLElement;
    expect(dataToolbar.textContent).toContain('新增行');
    expect(dataAddButton.classList.contains('acu-btn--primary')).toBe(true);
    expect(Boolean(cardGrid.compareDocumentPosition(dataToolbar) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(dataToolbar.textContent).not.toContain('角色状态');
    expect(dataToolbar.textContent).not.toContain('卡片视图会直接修改当前编辑草稿');

    const textareas = Array.from(surface.querySelectorAll<HTMLTextAreaElement>('textarea'));
    const statusTextarea = textareas.find(item => item.value === '平静')!;
    statusTextarea.value = '紧张';
    statusTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();

    const pinia = mount.getAcuV2PiniaForBridge();
    const visualizer = useVisualizerStore(pinia!);
    expect(visualizer.dirty).toBe(true);
    expect(visualizer.currentSheet.content[1][2]).toBe('紧张');

    (document.querySelector('.acu-visualizer-surface__close') as HTMLButtonElement).click();
    await Promise.resolve();

    expect(document.body.textContent).toContain('关闭数据库编辑器');
    const cancelButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('取消关闭'));
    expect(cancelButton).not.toBeUndefined();
    cancelButton!.click();
    await Promise.resolve();

    expect(document.getElementById('acu-app-v2')?.style.display).toBe('');
    expect(document.querySelector('[data-acu-visualizer-surface]')).not.toBeNull();
    mount.__resetAcuV2MountForTests();
  });

  it('数据卡片按表格字段顺序布局，仅连续两个短字段双列显示', async () => {
    persistAdvancedMode();
    const state = await import('../../../src/service/runtime/state-manager');
    state._set_currentJsonTableData_ACU({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: {
        uid: 'sheet_a',
        name: '布局验证表',
        orderNo: 0,
        content: [[null, '短A', '短B', '长C', '短D', '短E', '短F'], [
          null,
          'A',
          'B',
          'C',
          'D',
          'E',
          'F',
        ], [
          null,
          'AA',
          'BB',
          '这是一段超过二十四个字符的长内容，用来验证整列会独占整行。',
          'DD',
          'EE',
          'FF',
        ]],
      },
    });
    const bridge = await import('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface');
    const mount = await import('../../../src/presentation-v2/bootstrap/mount');

    await bridge.openVisualizerSurface_ACU({ source: 'external-api' });
    await new Promise(r => setTimeout(r, 0));

    const firstCard = document.querySelector<HTMLElement>('.acu-visualizer-surface__data-card')!;
    const fields = Array.from(firstCard.querySelectorAll<HTMLElement>(
      '.acu-visualizer-surface__field[data-acu-visualizer-field-layout]',
    ));
    expect(fields.map(field => field.querySelector('.acu-visualizer-surface__field-label')?.textContent?.trim()))
      .toEqual(['短A', '短B', '长C', '短D', '短E', '短F']);
    expect(fields.map(field => field.dataset.acuVisualizerFieldLayout))
      .toEqual(['half', 'half', 'wide', 'half', 'half', 'wide']);
    expect(Array.from(firstCard.querySelectorAll<HTMLElement>('[data-acu-visualizer-field-row-layout]'))
      .map(row => row.dataset.acuVisualizerFieldRowLayout))
      .toEqual(['half', 'wide', 'half', 'wide']);
    mount.__resetAcuV2MountForTests();
  });

  it('可进入结构参数和数据库管理面板', async () => {
    persistAdvancedMode();
    const state = await import('../../../src/service/runtime/state-manager');
    state._set_currentJsonTableData_ACU({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: {
        uid: 'sheet_a',
        name: '角色状态',
        orderNo: 0,
        content: [[null, '姓名', '状态'], [null, 'A', '平静']],
        sourceData: { note: '角色状态说明' },
        updateConfig: {},
        exportConfig: {},
      },
    });
    const bridge = await import('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface');
    const mount = await import('../../../src/presentation-v2/bootstrap/mount');

    await bridge.openVisualizerSurface_ACU({ source: 'external-api' });
    await new Promise(r => setTimeout(r, 0));

    const configTab = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('结构/参数'));
    expect(configTab).not.toBeUndefined();
    configTab!.click();
    await Promise.resolve();

    const configPanel = document.querySelector('[data-acu-visualizer-config]') as HTMLElement;
    expect(configPanel?.textContent).toContain('自动化更新参数');
    expect(configPanel?.textContent).toContain('世界书注入配置');
    expect(configPanel?.textContent).toContain('启用独立导出');
    expect(configPanel?.textContent).not.toContain('条目名称');
    expect(configPanel?.textContent).not.toContain('主条目位置');

    const enableCustomExportButton = Array.from(configPanel.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]'))
      .find(button => button.textContent?.includes('启用独立导出'));
    expect(enableCustomExportButton).not.toBeUndefined();
    enableCustomExportButton!.click();
    await Promise.resolve();

    expect(configPanel?.textContent).toContain('条目名称');
    expect(configPanel?.textContent).toContain('条目类型');
    expect(configPanel?.textContent).toContain('主条目位置');

    const addColumnButton = Array.from(configPanel.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('新增列'));
    expect(addColumnButton).not.toBeUndefined();
    expect(addColumnButton!.classList.contains('acu-btn--primary')).toBe(true);

    const databaseManagementButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('数据库管理'));
    expect(databaseManagementButton).not.toBeUndefined();
    databaseManagementButton!.click();
    await Promise.resolve();

    expect(document.querySelector('[data-acu-visualizer-global]')?.textContent).toContain('可读数据条目位置');
    expect(document.querySelector('[data-acu-visualizer-global]')?.textContent)
      .not.toContain('保存到当前聊天会同步这份全局草稿');
    expect(document.querySelector('[data-acu-visualizer-table-management]')?.textContent).toContain('角色状态');
    expect(document.querySelector('[data-acu-visualizer-table-management]')?.textContent).toContain('新增表格');
    const addTableButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-acu-visualizer-table-management] button'))
      .find(button => button.textContent?.includes('新增表格'));
    expect(addTableButton).not.toBeUndefined();
    expect(addTableButton!.classList.contains('acu-btn--primary')).toBe(true);
    expect(document.querySelector('.acu-visualizer-surface__mode-tabs')).toBeNull();
    mount.__resetAcuV2MountForTests();
  });

  it('移动端数据库导航使用侧抽屉选择表并自动收起', async () => {
    persistAdvancedMode();
    const state = await import('../../../src/service/runtime/state-manager');
    state._set_currentJsonTableData_ACU({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: {
        uid: 'sheet_a',
        name: '角色状态',
        orderNo: 0,
        content: [[null, '姓名'], [null, 'A']],
      },
      sheet_b: {
        uid: 'sheet_b',
        name: '事件记录',
        orderNo: 1,
        content: [[null, '事件'], [null, '初遇']],
      },
    });
    const bridge = await import('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface');
    const mount = await import('../../../src/presentation-v2/bootstrap/mount');
    const { useVisualizerStore } = await import('../../../src/presentation-v2/stores/visualizer-store');

    await bridge.openVisualizerSurface_ACU({ source: 'external-api' });
    await new Promise(r => setTimeout(r, 0));

    const menuButton = document.querySelector<HTMLButtonElement>('.acu-visualizer-surface__mobile-menu');
    expect(menuButton).not.toBeNull();
    menuButton!.click();
    await Promise.resolve();

    const layer = document.querySelector<HTMLElement>('.acu-visualizer-surface__mobile-nav-layer');
    expect(layer).not.toBeNull();
    const sheetButton = Array.from(layer!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('事件记录'));
    expect(sheetButton).not.toBeUndefined();
    sheetButton!.click();
    await Promise.resolve();

    const pinia = mount.getAcuV2PiniaForBridge();
    expect(useVisualizerStore(pinia!).currentSheetKey).toBe('sheet_b');
    expect(document.querySelector('.acu-visualizer-surface__mobile-nav-layer')?.classList.contains('is-closing')).toBe(true);
    await new Promise(r => setTimeout(r, 170));
    expect(document.querySelector('.acu-visualizer-surface__mobile-nav-layer')).toBeNull();
    mount.__resetAcuV2MountForTests();
  });

  it('可进入 AI 助手面板且不展示额外常驻提示', async () => {
    persistAdvancedMode();
    const state = await import('../../../src/service/runtime/state-manager');
    state._set_currentJsonTableData_ACU({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: {
        uid: 'sheet_a',
        name: '角色状态',
        orderNo: 0,
        content: [[null, '姓名', '状态'], [null, 'A', '平静']],
        sourceData: { note: '角色状态说明' },
        updateConfig: {},
        exportConfig: {},
      },
    });
    const bridge = await import('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface');
    const mount = await import('../../../src/presentation-v2/bootstrap/mount');

    await bridge.openVisualizerSurface_ACU({ source: 'external-api' });
    await new Promise(r => setTimeout(r, 0));

    const assistantTab = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('AI 助手'));
    expect(assistantTab).not.toBeUndefined();
    assistantTab!.click();
    await Promise.resolve();

    const panel = document.querySelector('[data-acu-visualizer-assistant]');
    expect(panel?.textContent).toContain('AI 改表助手');
    expect(panel?.textContent).not.toContain('当前锚点表：角色状态 (sheet_a)');
    expect(panel?.textContent).not.toContain('确认前不会应用到编辑器草稿');
    mount.__resetAcuV2MountForTests();
  });

  it('编码索引自动编号以可配置开关展示，但不禁用手动输入框', async () => {
    persistAdvancedMode();
    const state = await import('../../../src/service/runtime/state-manager');
    state._set_currentJsonTableData_ACU({
      mate: { type: 'chatSheets', version: 1 },
      sheet_summary: {
        uid: 'sheet_summary',
        name: '总结表',
        orderNo: 0,
        content: [[null, '事件', '编码索引'], [null, '初遇', 'AM0001']],
        sourceData: { note: '总结表说明' },
        updateConfig: {},
        exportConfig: {},
      },
    });
    const bridge = await import('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface');
    const mount = await import('../../../src/presentation-v2/bootstrap/mount');

    await bridge.openVisualizerSurface_ACU({ source: 'external-api' });
    await new Promise(r => setTimeout(r, 0));

    const surface = document.querySelector('[data-acu-visualizer-surface]') as HTMLElement;
    expect(surface.textContent).toContain('自动编号');
    const indexTextarea = Array.from(surface.querySelectorAll<HTMLTextAreaElement>('textarea'))
      .find(item => item.value === 'AM0001');
    expect(indexTextarea?.disabled).toBe(false);

    const configTab = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('结构/参数'));
    configTab!.click();
    await Promise.resolve();

    const autoNumberSwitch = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]'))
      .find(button => button.textContent?.includes('保存和 AI 更新时自动重排编码'));
    expect(autoNumberSwitch?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-acu-visualizer-config]')?.textContent).not.toContain('启用编码索引列特殊锁定');
    mount.__resetAcuV2MountForTests();
  });

  it('切换表格时会把当前导航项滚入可见区域', async () => {
    persistAdvancedMode();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const state = await import('../../../src/service/runtime/state-manager');
    state._set_currentJsonTableData_ACU({
      mate: { type: 'chatSheets', version: 1 },
      sheet_a: {
        uid: 'sheet_a',
        name: '角色状态',
        orderNo: 0,
        content: [[null, '姓名'], [null, 'A']],
      },
      sheet_b: {
        uid: 'sheet_b',
        name: '事件记录',
        orderNo: 1,
        content: [[null, '事项'], [null, '旧值']],
      },
    });
    const bridge = await import('../../../src/presentation-v2/surfaces/visualizer/open-visualizer-surface');
    const mount = await import('../../../src/presentation-v2/bootstrap/mount');

    await bridge.openVisualizerSurface_ACU({ source: 'external-api' });
    await new Promise(r => setTimeout(r, 0));
    scrollIntoView.mockClear();

    const sheetButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('事件记录'));
    expect(sheetButton).not.toBeUndefined();
    sheetButton!.click();
    await new Promise(r => setTimeout(r, 0));

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });
    mount.__resetAcuV2MountForTests();
  });

  it('VZ-5 响应式布局有桌面、平板、手机三档和 AI 非常驻结构', () => {
    const surfaceSource = readFileSync(
      join(process.cwd(), 'src/presentation-v2/surfaces/visualizer/VisualizerSurface.vue'),
      'utf8',
    );
    const assistantSource = readFileSync(
      join(process.cwd(), 'src/presentation-v2/surfaces/visualizer/VisualizerAssistantPanel.vue'),
      'utf8',
    );
    const configSource = readFileSync(
      join(process.cwd(), 'src/presentation-v2/surfaces/visualizer/VisualizerConfigPanels.vue'),
      'utf8',
    );
    const tableManagementSource = readFileSync(
      join(process.cwd(), 'src/presentation-v2/surfaces/visualizer/VisualizerTableManagementPanel.vue'),
      'utf8',
    );

    expect(surfaceSource).toContain('@media (max-width: 1024px)');
    expect(surfaceSource).toContain('@media (max-width: 767px)');
    expect(surfaceSource).toContain('@media (max-width: 480px)');
    expect(surfaceSource).toContain('acu-visualizer-surface__topbar-context');
    expect(surfaceSource).toContain('当前模板');
    expect(surfaceSource).not.toContain('>已同步</AcuBadge>');
    expect(surfaceSource).not.toContain('acu-visualizer-surface__mobile-current-sheet');
    expect(surfaceSource).toMatch(
      /\.acu-visualizer-surface__context-items\s*\{[\s\S]*?justify-content: flex-start;[\s\S]*?gap: 16px;/,
    );
    expect(surfaceSource).toMatch(
      /\.acu-visualizer-surface__context-item:first-child\s*\{[\s\S]*?flex: 0 1 auto;[\s\S]*?max-width: min\(560px, 42vw\);/,
    );
    expect(surfaceSource).toMatch(
      /\.acu-visualizer-surface__context-item:first-child strong\s*\{[\s\S]*?white-space: normal;[\s\S]*?word-break: break-word;/,
    );
    expect(surfaceSource).toContain('acu-visualizer-surface__mobile-nav-layer');
    expect(surfaceSource).toContain('visualizer-mobile-nav-drawer-in');
    expect(surfaceSource).not.toContain('acu-visualizer-surface__mobile-sheet');
    expect(surfaceSource).toContain('grid-template-columns: 1fr');
    expect(surfaceSource).toContain('table-management');
    expect(surfaceSource).toContain('grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr))');
    expect(surfaceSource).toContain('acu-visualizer-surface__footer-actions :deep(.acu-btn)');
    expect(assistantSource).toContain('AcuDisclosureGroup');
    expect(assistantSource).toContain('body-max-height="min(72vh, 680px)"');
    expect(assistantSource).toMatch(
      /@media \(max-width: 767px\)[\s\S]*\.acu-viz-assistant__action-row :deep\(\.acu-btn\)[\s\S]*width: 100%;/,
    );
    expect(assistantSource).toMatch(
      /\.acu-viz-assistant__disclosure\s*\{[\s\S]*?border: 1px solid var\(--acu-border\);[\s\S]*?border-radius: var\(--acu-radius-md\);[\s\S]*?background: var\(--acu-bg-1\);/,
    );
    expect(assistantSource).toContain('@media (max-width: 480px)');
    expect(configSource).toMatch(
      /@media \(max-width: 767px\)[\s\S]*\.acu-viz-config__column-operation :deep\(\.acu-btn\)[\s\S]*width: 100%;/,
    );
    expect(tableManagementSource).toMatch(
      /@media \(max-width: 767px\)[\s\S]*\.acu-viz-table-management__operation :deep\(\.acu-btn\)[\s\S]*width: 100%;/,
    );
  });

  it('结构参数区的 AI 触发提示词和 DDL 输入框启用无最大高度自适应', () => {
    const configSource = readFileSync(
      join(process.cwd(), 'src/presentation-v2/surfaces/visualizer/VisualizerConfigPanels.vue'),
      'utf8',
    );

    const promptPanel = configSource.slice(
      configSource.indexOf('title="AI 触发提示词"'),
      configSource.indexOf('title="DDL 定义"'),
    );
    const ddlPanel = configSource.slice(
      configSource.indexOf('title="DDL 定义"'),
      configSource.indexOf('title="世界书注入配置"'),
    );

    expect((promptPanel.match(/auto-resize/g) || []).length).toBe(5);
    expect((promptPanel.match(/max-rows/g) || []).length).toBe(0);
    expect((ddlPanel.match(/auto-resize/g) || []).length).toBe(1);
    expect((ddlPanel.match(/max-rows/g) || []).length).toBe(0);
  });
});
