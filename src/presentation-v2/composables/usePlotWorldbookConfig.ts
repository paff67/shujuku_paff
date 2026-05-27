/**
 * usePlotWorldbookConfig — 剧情推进世界书配置（D23.1）
 *
 * settings_ACU.plotSettings.plotWorldbookConfig 形如：
 *   { source: 'character'|'manual', manualSelection: string[], enabledEntries: {...} }
 *
 * 阶段 3 的 v1 引入：仅暴露"目标世界书"切换（character / 单个 manual book）。
 * 详细条目级开关（enabledEntries）暂沿用 v1 的 raw 结构，UI 上只显示当前选中的世界书名。
 * 完整条目级管理留给后续迭代。
 */
import { computed, ref } from 'vue';
import { settings_ACU } from '../../service/runtime/state-manager';
import { saveSettings_ACU } from '../../service/settings/settings-service';
import { getCharLorebooks_ACU } from '../../service/worldbook/worldbook-service';

export type PlotWorldbookSource = 'character' | 'manual';

interface PlotWorldbookConfigShape {
  source: PlotWorldbookSource;
  manualSelection: string[];
  enabledEntries?: Record<string, unknown>;
}

function ensureConfig(): PlotWorldbookConfigShape {
  if (!settings_ACU.plotSettings || typeof settings_ACU.plotSettings !== 'object') {
    settings_ACU.plotSettings = {} as Record<string, unknown>;
  }
  const plot = settings_ACU.plotSettings as Record<string, any>;
  if (!plot.plotWorldbookConfig || typeof plot.plotWorldbookConfig !== 'object') {
    plot.plotWorldbookConfig = { source: 'character', manualSelection: [], enabledEntries: {} };
  }
  const cfg = plot.plotWorldbookConfig as PlotWorldbookConfigShape;
  if (cfg.source !== 'manual') cfg.source = 'character';
  if (!Array.isArray(cfg.manualSelection)) cfg.manualSelection = [];
  if (!cfg.enabledEntries || typeof cfg.enabledEntries !== 'object') cfg.enabledEntries = {};
  return cfg;
}

export function usePlotWorldbookConfig() {
  // 用 ref 复制响应式快照（settings_ACU 不是 Vue reactive）
  const source = ref<PlotWorldbookSource>('character');
  const manualBook = ref<string>('');

  function refreshFromSettings(): void {
    const cfg = ensureConfig();
    source.value = cfg.source;
    manualBook.value = cfg.manualSelection[0] || '';
  }

  function setSource(next: PlotWorldbookSource): void {
    const cfg = ensureConfig();
    cfg.source = next;
    source.value = next;
    if (next === 'character') {
      cfg.manualSelection = [];
      manualBook.value = '';
    }
    saveSettings_ACU();
  }

  function setManualBook(name: string): void {
    const cfg = ensureConfig();
    const trimmed = String(name || '').trim();
    cfg.source = 'manual';
    cfg.manualSelection = trimmed ? [trimmed] : [];
    source.value = 'manual';
    manualBook.value = trimmed;
    saveSettings_ACU();
  }

  /** 给 WorldbookSelector 用的 modelValue：character 模式输出 'character'，manual 模式输出书名。 */
  const selectorValue = computed<string>(() => {
    if (source.value === 'character') return 'character';
    return manualBook.value || '';
  });

  /** WorldbookSelector @update:modelValue 接收。 */
  function onSelectorChange(value: string): void {
    if (value === 'character') setSource('character');
    else setManualBook(value);
  }

  async function resolveBookNames(): Promise<string[]> {
    const cfg = ensureConfig();
    if (cfg.source === 'manual') {
      return [...new Set(cfg.manualSelection.filter(Boolean))];
    }
    const names: string[] = [];
    try {
      const charLorebooks = await getCharLorebooks_ACU({ type: 'all' });
      if (charLorebooks.primary) names.push(charLorebooks.primary);
      if (charLorebooks.additional?.length) names.push(...charLorebooks.additional);
    } catch { /* empty */ }
    return [...new Set(names.filter(Boolean))];
  }

  return {
    source,
    manualBook,
    selectorValue,
    refreshFromSettings,
    onSelectorChange,
    resolveBookNames,
  };
}
