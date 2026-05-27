/**
 * AdvancedToolsPage 日志面板集成 — 运行日志布局、筛选与实时订阅
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'acu_v2_ui_state';

async function waitForUi(ms = 0) {
  await new Promise(r => setTimeout(r, ms));
}

async function mountAdvancedToolsLogPanel(seedLogs = true) {
  vi.resetModules();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ router: { activePageId: 'advanced-tools' } }));

  const logBuffer = await import('../../../src/shared/log-buffer');
  logBuffer._resetForTesting();
  if (seedLogs) {
    logBuffer.setDebugLogEnabled(true);
    logBuffer.pushLog('debug', ['[ACU]', '[调试] Debug 初始化日志']);
    logBuffer.pushLog('warn', ['[ACU]', '[SQL] 警告日志']);
    logBuffer.pushLog('error', ['[ACU]', '[导入] 错误日志']);
    logBuffer.setDebugLogEnabled(false);
  }

  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:acu-log-test'),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

  const mount = await import('../../../src/presentation-v2/bootstrap/mount');
  await mount.openAcuV2App();
  await waitForUi();

  return {
    mount,
    logBuffer,
  };
}

function getPage(): HTMLElement {
  const page = document.querySelector<HTMLElement>('.acu-v2-advanced-tools-page');
  expect(page).not.toBeNull();
  return page!;
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.acu-v2-advanced-tools-page__log-panel button'))
    .find(el => el.textContent?.includes(label));
  expect(button).not.toBeUndefined();
  return button!;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AdvancedToolsPage log panel', () => {
  it('渲染高级工具页内运行日志面板，状态徽章留在面板标题区', async () => {
    const { mount } = await mountAdvancedToolsLogPanel();

    const page = getPage();
    const text = page.textContent || '';
    expect(text).toContain('运行日志');
    expect(text).toContain('全部级别');
    expect(text).toContain('全部模块');
    expect(text).toContain('SQL 控制台');
    expect(page.querySelector<HTMLInputElement>('.acu-v2-advanced-tools-page input')?.placeholder).toBe('搜索日志内容');
    expect(text).toContain('自动滚动');
    expect(text).toContain('错误日志');
    expect(text).toContain('警告日志');
    expect(text).not.toContain('缓冲区状态');

    const panels = document.querySelectorAll('.acu-v2-advanced-tools-page .acu-panel');
    expect(panels.length).toBe(2);
    panels.forEach(panel => {
      expect(panel.querySelector('.acu-panel__description-region .acu-info-banner')).not.toBeNull();
      expect(panel.querySelector('.acu-panel__header .acu-info-banner')).toBeNull();
    });

    const mobileNavItems = Array.from(page.querySelectorAll('.acu-mobile-panel-nav__item'))
      .map(item => item.textContent?.trim());
    expect(mobileNavItems).toEqual(['SQL 控制台', '运行日志']);
    expect(document.querySelector('.acu-v2-app__page-title')?.textContent?.trim()).toBe('高级工具');
    expect(page.querySelector('.acu-page-header')).toBeNull();
    expect(page.querySelector('.acu-v2-advanced-tools-page__log-panel .acu-panel__header')?.textContent || '').toContain('实时更新中');

    mount.__resetAcuV2MountForTests();
  });

  it('按级别和关键词筛选日志列表', async () => {
    const { mount } = await mountAdvancedToolsLogPanel();

    const levelSelect = document.querySelector<HTMLElement>('.acu-v2-advanced-tools-page .acu-select');
    expect(levelSelect).not.toBeNull();
    levelSelect!.querySelector<HTMLButtonElement>('.acu-select__trigger')!.click();
    await waitForUi();
    const errorItem = Array.from(levelSelect!.querySelectorAll<HTMLElement>('.acu-select__item'))
      .find(item => item.textContent?.trim() === 'Error');
    expect(errorItem).not.toBeUndefined();
    errorItem!.click();
    await waitForUi();

    let text = document.querySelector('.acu-v2-advanced-tools-page__log-list')?.textContent || '';
    expect(text).toContain('错误日志');
    expect(text).not.toContain('警告日志');

    const search = document.querySelector<HTMLInputElement>('.acu-v2-advanced-tools-page input');
    expect(search).not.toBeNull();
    search!.value = '不存在的关键词';
    search!.dispatchEvent(new Event('input', { bubbles: true }));
    await waitForUi();

    text = document.querySelector('.acu-v2-advanced-tools-page__log-list')?.textContent || '';
    expect(text).toContain('暂无匹配日志');

    mount.__resetAcuV2MountForTests();
  });

  it('暂停时新日志进入积压，恢复后刷新显示', async () => {
    const { mount, logBuffer } = await mountAdvancedToolsLogPanel(false);

    findButton('暂停').click();
    await waitForUi();
    logBuffer.pushLog('warn', ['[ACU]', '[暂停测试] 暂停期间新增']);
    await waitForUi(30);

    let pageText = getPage().textContent || '';
    expect(pageText).toContain('1 条暂停期间新增日志等待显示');
    expect(document.querySelector('.acu-v2-advanced-tools-page__log-list')?.textContent || '').not.toContain('暂停期间新增');

    findButton('暂停').click();
    await waitForUi();

    pageText = getPage().textContent || '';
    expect(pageText).toContain('暂停期间新增');
    expect(pageText).toContain('实时更新中');

    mount.__resetAcuV2MountForTests();
  });

  it('Debug 采集开关会控制 debug 日志进入缓冲区', async () => {
    const { mount, logBuffer } = await mountAdvancedToolsLogPanel(false);

    logBuffer.pushLog('debug', ['[ACU]', '[调试] 不应出现']);
    await waitForUi(30);
    expect(getPage().textContent || '').not.toContain('不应出现');

    const debugToggle = Array.from(document.querySelectorAll<HTMLButtonElement>('.acu-v2-advanced-tools-page .acu-toggle'))
      .find(button => button.textContent?.includes('Debug'));
    expect(debugToggle).not.toBeUndefined();
    debugToggle!.click();
    await waitForUi();

    logBuffer.pushLog('debug', ['[ACU]', '[调试] Debug 已采集']);
    await waitForUi(30);

    const text = getPage().textContent || '';
    expect(text).toContain('Debug 已采集');
    expect(text).toContain('Debug 采集中');

    mount.__resetAcuV2MountForTests();
  });

  it('清空与导出使用当前筛选后的日志数据', async () => {
    const { mount, logBuffer } = await mountAdvancedToolsLogPanel(false);
    logBuffer.clearLogs();
    logBuffer.setDebugLogEnabled(true);
    logBuffer.pushLog('debug', ['[ACU]', '[调试] Debug 导出日志']);
    logBuffer.pushLog('warn', ['[ACU]', '[SQL] 警告导出日志']);
    logBuffer.pushLog('error', ['[ACU]', '[导入] 错误导出日志']);
    logBuffer.setDebugLogEnabled(false);
    await waitForUi(30);

    findButton('导出').click();
    await waitForUi();
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(getPage().textContent || '').not.toContain('已导出 3 条日志');

    findButton('清空').click();
    await waitForUi();
    const text = getPage().textContent || '';
    expect(text).not.toContain('日志缓冲区已清空');
    expect(text).toContain('暂无匹配日志');

    mount.__resetAcuV2MountForTests();
  });
});
