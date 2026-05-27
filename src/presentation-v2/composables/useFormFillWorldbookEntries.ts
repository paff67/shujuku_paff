/**
 * useFormFillWorldbookEntries — 填表"附加世界书条目"启用/禁用（Component B，§4.2）
 *
 * 操作 worldbookConfig.enabledEntries（每张书 → uid[] 列表）。
 * 与 usePlotWorldbookEntries 形态一致，仅作用域不同：
 *   - usePlot…：plotSettings.plotWorldbookConfig.enabledEntries（剧情推进）
 *   - 本文件：worldbookConfig.enabledEntries（填表 / 提示词附带）
 *
 * 同样过滤掉数据库生成条目和包含屏蔽关键词的条目，避免误开关。
 */
import { ref, shallowRef } from 'vue';
import { getLorebookEntriesByNames_ACU } from '../../service/worldbook/pipeline';
import { getCurrentWorldbookConfig_ACU } from '../../service/settings/settings-readers';
import { saveSettings_ACU } from '../../service/settings/settings-service';
import { logError_ACU } from '../../shared/utils';

export interface FormFillWorldbookEntryItem {
  uid: number;
  bookName: string;
  label: string;
  checked: boolean;
  disabled: boolean;
}

export interface FormFillWorldbookEntryGroup {
  bookName: string;
  entries: FormFillWorldbookEntryItem[];
  expanded: boolean;
}

export type FormFillEntryLoadStatus = 'idle' | 'loading' | 'success' | 'error';

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

function ensureEnabledEntries(): Record<string, number[]> {
  const cfg = getCurrentWorldbookConfig_ACU() as any;
  if (!cfg.enabledEntries || typeof cfg.enabledEntries !== 'object') {
    cfg.enabledEntries = {};
  }
  return cfg.enabledEntries;
}

export function useFormFillWorldbookEntries() {
  const groups = shallowRef<FormFillWorldbookEntryGroup[]>([]);
  const status = ref<FormFillEntryLoadStatus>('idle');
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
      const enabledEntries = ensureEnabledEntries();
      const entriesMap = await getLorebookEntriesByNames_ACU(unique) as Record<string, any[]>;
      let settingsChanged = false;
      const result: FormFillWorldbookEntryGroup[] = [];

      for (const bookName of unique) {
        const bookEntries = Array.isArray(entriesMap[bookName]) ? entriesMap[bookName] : [];

        if (typeof enabledEntries[bookName] === 'undefined') {
          enabledEntries[bookName] = bookEntries
            .filter(isEntryVisibleForUI)
            .map((e: any) => e.uid);
          settingsChanged = true;
        }

        const enabledList: number[] = Array.isArray(enabledEntries[bookName])
          ? enabledEntries[bookName]
          : [];

        const visible: FormFillWorldbookEntryItem[] = [];
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
      logError_ACU('[ACU-V2] useFormFillWorldbookEntries loadEntries failed', e);
      error.value = e?.message ?? '加载条目失败';
      status.value = 'error';
    }
  }

  function toggleEntry(bookName: string, uid: number, checked: boolean): void {
    const enabledEntries = ensureEnabledEntries();
    if (!Array.isArray(enabledEntries[bookName])) {
      enabledEntries[bookName] = [];
    }
    const list: number[] = enabledEntries[bookName];
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
    const enabledEntries = ensureEnabledEntries();
    for (const group of groups.value) {
      enabledEntries[group.bookName] = group.entries
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
    const enabledEntries = ensureEnabledEntries();
    for (const group of groups.value) {
      enabledEntries[group.bookName] = [];
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
