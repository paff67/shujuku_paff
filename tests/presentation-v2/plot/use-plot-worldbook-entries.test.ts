/**
 * usePlotWorldbookEntries 单元测试
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeEntry(uid: number, comment: string, enabled = true) {
  return { uid, comment, name: comment, enabled };
}

function createSettings() {
  return {
    plotSettings: {
      plotWorldbookConfig: {
        source: 'character',
        manualSelection: [],
        enabledEntries: {},
      },
    },
  } as any;
}

let settings: ReturnType<typeof createSettings>;
const mockSaveSettings = vi.fn();
const mockGetEntries = vi.fn();

async function getComposable() {
  vi.resetModules();
  settings = createSettings();

  vi.doMock('../../../src/service/runtime/state-manager', () => ({
    settings_ACU: settings,
  }));
  vi.doMock('../../../src/service/settings/settings-service', () => ({
    saveSettings_ACU: mockSaveSettings,
  }));
  vi.doMock('../../../src/service/worldbook/pipeline', () => ({
    getLorebookEntriesByNames_ACU: mockGetEntries,
  }));

  const mod = await import('../../../src/presentation-v2/composables/usePlotWorldbookEntries');
  return mod.usePlotWorldbookEntries();
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockSaveSettings.mockClear();
  mockGetEntries.mockClear();
});

describe('usePlotWorldbookEntries', () => {
  it('loadEntries 加载并过滤掉数据库生成条目', async () => {
    mockGetEntries.mockResolvedValue({
      'MyBook': [
        makeEntry(1, '角色设定'),
        makeEntry(2, 'TavernDB-ACU-OutlineTable'),
        makeEntry(3, 'TavernDB-ACU-CharTable'),
        makeEntry(4, '重要人物条目-xx'),
        makeEntry(5, '总结条目-xx'),
        makeEntry(6, '世界观'),
      ],
    });

    const c = await getComposable();
    await c.loadEntries(['MyBook']);

    expect(c.groups.value).toHaveLength(1);
    expect(c.groups.value[0].bookName).toBe('MyBook');
    const uids = c.groups.value[0].entries.map(e => e.uid);
    expect(uids).toContain(1);
    expect(uids).toContain(6);
    expect(uids).not.toContain(2);
    expect(uids).not.toContain(3);
    expect(uids).not.toContain(4);
    expect(uids).not.toContain(5);
  });

  it('loadEntries 过滤屏蔽词条目', async () => {
    mockGetEntries.mockResolvedValue({
      'B': [
        makeEntry(10, '角色规则'),
        makeEntry(11, '思维链说明'),
        makeEntry(12, '正常条目'),
      ],
    });

    const c = await getComposable();
    await c.loadEntries(['B']);

    const uids = c.groups.value[0].entries.map(e => e.uid);
    expect(uids).toEqual([12]);
  });

  it('首次加载默认启用所有可见条目', async () => {
    mockGetEntries.mockResolvedValue({
      'X': [makeEntry(1, '好条目'), makeEntry(2, '也好')],
    });

    const c = await getComposable();
    await c.loadEntries(['X']);

    expect(c.groups.value[0].entries.every(e => e.checked)).toBe(true);
    expect(settings.plotSettings.plotWorldbookConfig.enabledEntries['X']).toEqual([1, 2]);
    expect(mockSaveSettings).toHaveBeenCalled();
  });

  it('已有 enabledEntries 时按已有值设置 checked', async () => {
    settings = createSettings();
    settings.plotSettings.plotWorldbookConfig.enabledEntries = { Y: [2] };

    mockGetEntries.mockResolvedValue({
      'Y': [makeEntry(1, '甲'), makeEntry(2, '乙'), makeEntry(3, '丙')],
    });

    vi.resetModules();
    vi.doMock('../../../src/service/runtime/state-manager', () => ({
      settings_ACU: settings,
    }));
    vi.doMock('../../../src/service/settings/settings-service', () => ({
      saveSettings_ACU: mockSaveSettings,
    }));
    vi.doMock('../../../src/service/worldbook/pipeline', () => ({
      getLorebookEntriesByNames_ACU: mockGetEntries,
    }));
    const mod = await import('../../../src/presentation-v2/composables/usePlotWorldbookEntries');
    const c = mod.usePlotWorldbookEntries();
    await c.loadEntries(['Y']);

    const checks = c.groups.value[0].entries.map(e => ({ uid: e.uid, checked: e.checked }));
    expect(checks).toEqual([
      { uid: 1, checked: false },
      { uid: 2, checked: true },
      { uid: 3, checked: false },
    ]);
  });

  it('toggleEntry 更新 checked 和 enabledEntries', async () => {
    mockGetEntries.mockResolvedValue({
      'Z': [makeEntry(1, 'a'), makeEntry(2, 'b')],
    });

    const c = await getComposable();
    await c.loadEntries(['Z']);
    mockSaveSettings.mockClear();

    c.toggleEntry('Z', 2, false);
    expect(settings.plotSettings.plotWorldbookConfig.enabledEntries['Z']).toEqual([1]);
    expect(c.groups.value[0].entries.find(e => e.uid === 2)?.checked).toBe(false);
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);

    c.toggleEntry('Z', 2, true);
    expect(settings.plotSettings.plotWorldbookConfig.enabledEntries['Z']).toContain(2);
    expect(c.groups.value[0].entries.find(e => e.uid === 2)?.checked).toBe(true);
  });

  it('selectAll 启用所有非 disabled 条目', async () => {
    mockGetEntries.mockResolvedValue({
      'W': [makeEntry(1, 'ok'), makeEntry(2, 'disabled', false), makeEntry(3, 'ok2')],
    });

    const c = await getComposable();
    settings.plotSettings.plotWorldbookConfig.enabledEntries = { W: [] };
    await c.loadEntries(['W']);
    mockSaveSettings.mockClear();

    c.selectAll();
    expect(settings.plotSettings.plotWorldbookConfig.enabledEntries['W']).toEqual([1, 3]);
    expect(c.groups.value[0].entries.find(e => e.uid === 2)?.checked).toBe(false);
    expect(mockSaveSettings).toHaveBeenCalled();
  });

  it('deselectAll 清空所有条目', async () => {
    mockGetEntries.mockResolvedValue({
      'V': [makeEntry(1, 'a'), makeEntry(2, 'b')],
    });

    const c = await getComposable();
    await c.loadEntries(['V']);
    mockSaveSettings.mockClear();

    c.deselectAll();
    expect(settings.plotSettings.plotWorldbookConfig.enabledEntries['V']).toEqual([]);
    expect(c.groups.value[0].entries.every(e => !e.checked)).toBe(true);
    expect(mockSaveSettings).toHaveBeenCalled();
  });

  it('空书名列表返回空 groups', async () => {
    const c = await getComposable();
    await c.loadEntries([]);
    expect(c.groups.value).toEqual([]);
    expect(c.status.value).toBe('success');
  });

  it('toggleGroupExpanded 切换展开状态', async () => {
    mockGetEntries.mockResolvedValue({
      'G': [makeEntry(1, 'x')],
    });

    const c = await getComposable();
    await c.loadEntries(['G']);
    expect(c.groups.value[0].expanded).toBe(false);

    c.toggleGroupExpanded('G');
    expect(c.groups.value[0].expanded).toBe(true);

    c.toggleGroupExpanded('G');
    expect(c.groups.value[0].expanded).toBe(false);
  });
});
