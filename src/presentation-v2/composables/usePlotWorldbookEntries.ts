/**
 * usePlotWorldbookEntries — 剧情推进世界书条目级启用/禁用
 *
 * 从 service 层加载条目列表，过滤掉数据库生成条目和屏蔽词条目，
 * 暴露 reactive 分组列表 + selectAll / deselectAll / toggleEntry，
 * 持久化到 plotWorldbookConfig.enabledEntries。
 */
import { ref, shallowRef } from 'vue';
import { getLorebookEntriesByNames_ACU } from '../../service/worldbook/pipeline';
import { settings_ACU } from '../../service/runtime/state-manager';
import { saveSettings_ACU } from '../../service/settings/settings-service';
import { logError_ACU } from '../../shared/utils';

export interface WorldbookEntryItem {
  uid: number;
  bookName: string;
  label: string;
  checked: boolean;
  disabled: boolean;
}

export interface WorldbookEntryGroup {
  bookName: string;
  entries: WorldbookEntryItem[];
  expanded: boolean;
}

export type EntryLoadStatus = 'idle' | 'loading' | 'success' | 'error';

const BLOCKED_KEYWORDS = [
  '规则', '思维链', 'cot', 'MVU', 'mvu', '变量', '状态',
  'Status', 'Rule', 'rule', '检定', '判断', '叙事', '文风',
  'InitVar', '格式',
];

function isDbGenerated(comment: string): boolean {
  const normalized = comment
    .replace(/^ACU-\[[^\]]+\]-/, '')
    .replace(/^外部导入-(?:[^-]+-)?/, '');
  if (normalized.startsWith('TavernDB-ACU-OutlineTable')) return true;
  if (normalized.startsWith('TavernDB-ACU-')) return true;
  if (normalized.startsWith('重要人物条目')) return true;
  if (normalized.startsWith('总结条目')) return true;
  if (normalized.startsWith('小总结条目')) return true;
  return false;
}

function isBlocked(comment: string): boolean {
  return BLOCKED_KEYWORDS.some(kw => comment.includes(kw));
}

function isEntryVisibleForUI(entry: any): boolean {
  const comment = String(entry?.comment || entry?.name || '');
  if (isDbGenerated(comment)) return false;
  if (isBlocked(comment)) return false;
  return true;
}

function ensurePlotWorldbookConfig(): Record<string, any> {
  if (!settings_ACU.plotSettings || typeof settings_ACU.plotSettings !== 'object') {
    settings_ACU.plotSettings = {} as Record<string, any>;
  }
  const plot = settings_ACU.plotSettings as Record<string, any>;
  if (!plot.plotWorldbookConfig || typeof plot.plotWorldbookConfig !== 'object') {
    plot.plotWorldbookConfig = { source: 'character', manualSelection: [], enabledEntries: {} };
  }
  const cfg = plot.plotWorldbookConfig;
  if (!cfg.enabledEntries || typeof cfg.enabledEntries !== 'object') {
    cfg.enabledEntries = {};
  }
  return cfg;
}

export function usePlotWorldbookEntries() {
  const groups = shallowRef<WorldbookEntryGroup[]>([]);
  const status = ref<EntryLoadStatus>('idle');
  const error = ref('');

  async function loadEntries(bookNames: string[]): Promise<void> {
    const unique = [...new Set(bookNames.filter(Boolean))];
    if (unique.length === 0) {
      groups.value = [];
      status.value = 'success';
      return;
    }

    status.value = 'loading';
    error.value = '';

    try {
      const cfg = ensurePlotWorldbookConfig();
      const entriesMap = await getLorebookEntriesByNames_ACU(unique) as Record<string, any[]>;
      let settingsChanged = false;
      const result: WorldbookEntryGroup[] = [];

      for (const bookName of unique) {
        const bookEntries = Array.isArray(entriesMap[bookName]) ? entriesMap[bookName] : [];

        if (typeof cfg.enabledEntries[bookName] === 'undefined') {
          cfg.enabledEntries[bookName] = bookEntries
            .filter(isEntryVisibleForUI)
            .map((e: any) => e.uid);
          settingsChanged = true;
        }

        const enabledList: number[] = Array.isArray(cfg.enabledEntries[bookName])
          ? cfg.enabledEntries[bookName]
          : [];

        const visible: WorldbookEntryItem[] = [];
        for (const entry of bookEntries) {
          if (!isEntryVisibleForUI(entry)) continue;
          visible.push({
            uid: entry.uid,
            bookName,
            label: entry.comment || `条目 ${entry.uid}`,
            checked: enabledList.includes(entry.uid),
            disabled: entry.enabled === false,
          });
        }

        if (visible.length > 0) {
          result.push({ bookName, entries: visible, expanded: false });
        }
      }

      if (settingsChanged) saveSettings_ACU();
      groups.value = result;
      status.value = 'success';
    } catch (e: any) {
      logError_ACU('[ACU-V2] usePlotWorldbookEntries loadEntries failed', e);
      error.value = e?.message ?? '加载条目失败';
      status.value = 'error';
    }
  }

  function toggleEntry(bookName: string, uid: number, checked: boolean): void {
    const cfg = ensurePlotWorldbookConfig();
    if (!Array.isArray(cfg.enabledEntries[bookName])) {
      cfg.enabledEntries[bookName] = [];
    }
    const list: number[] = cfg.enabledEntries[bookName];
    const idx = list.indexOf(uid);
    if (checked && idx === -1) list.push(uid);
    else if (!checked && idx !== -1) list.splice(idx, 1);
    saveSettings_ACU();

    groups.value = groups.value.map(g => {
      if (g.bookName !== bookName) return g;
      return {
        ...g,
        entries: g.entries.map(e =>
          e.uid === uid ? { ...e, checked } : e,
        ),
      };
    });
  }

  function selectAll(): void {
    const cfg = ensurePlotWorldbookConfig();
    for (const group of groups.value) {
      cfg.enabledEntries[group.bookName] = group.entries
        .filter(e => !e.disabled)
        .map(e => e.uid);
    }
    saveSettings_ACU();

    groups.value = groups.value.map(g => ({
      ...g,
      entries: g.entries.map(e => ({ ...e, checked: !e.disabled })),
    }));
  }

  function deselectAll(): void {
    const cfg = ensurePlotWorldbookConfig();
    for (const group of groups.value) {
      cfg.enabledEntries[group.bookName] = [];
    }
    saveSettings_ACU();

    groups.value = groups.value.map(g => ({
      ...g,
      entries: g.entries.map(e => ({ ...e, checked: false })),
    }));
  }

  function toggleGroupExpanded(bookName: string): void {
    groups.value = groups.value.map(g => {
      if (g.bookName !== bookName) return g;
      return { ...g, expanded: !g.expanded };
    });
  }

  return {
    groups,
    status,
    error,
    loadEntries,
    toggleEntry,
    selectAll,
    deselectAll,
    toggleGroupExpanded,
  };
}
