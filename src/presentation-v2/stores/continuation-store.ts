/**
 * continuation-store — 智能续写页设置边界
 *
 * 旧 UI 将智能续写挂在剧情推进页内部；v2 拆成独立一级页。
 * 这里仍读写同一份 plotSettings.loopSettings，保证运行时逻辑兼容。
 */
import { defineStore } from 'pinia';
import { DEFAULT_PLOT_SETTINGS_ACU } from '../../shared/defaults-json.js';
import { normalizeExcludeRules_ACU, normalizeExtractRules_ACU } from '../../shared/utils';
import { ensureLoopPromptsArray_ACU } from '../../service/plot/plot-logic';
import { settings_ACU } from '../../service/runtime/state-manager';
import { saveSettings_ACU } from '../../service/settings/settings-service';
import { FEATURE_GATE_CONTENT_REPLACE } from '../router/page-registry';
import { syncContentReplaceAvailability } from './content-replace-gate';
import { useRouterStore } from './router-store';

export interface ContinuationRulePair {
  start: string;
  end: string;
}

interface ContinuationState {
  prompts: string[];
  loopTags: string;
  loopDelay: number;
  loopTotalDuration: number;
  maxRetries: number;
  contextTurnCount: number;
  contextExtractRules: ContinuationRulePair[];
  contextExcludeRules: ContinuationRulePair[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

function toNonNegativeNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function ensureSettingsShape(): Record<string, any> {
  if (!settings_ACU.plotSettings || typeof settings_ACU.plotSettings !== 'object') {
    settings_ACU.plotSettings = clone(DEFAULT_PLOT_SETTINGS_ACU);
  }
  const plot = settings_ACU.plotSettings as Record<string, any>;
  if (!plot.loopSettings || typeof plot.loopSettings !== 'object') {
    plot.loopSettings = clone(DEFAULT_PLOT_SETTINGS_ACU.loopSettings);
  }
  plot.contextTurnCount = toNonNegativeNumber(plot.contextTurnCount, DEFAULT_PLOT_SETTINGS_ACU.contextTurnCount ?? 3);
  plot.contextExtractRules = normalizeExtractRules_ACU(
    plot.contextExtractRules,
    plot.contextExtractTags || '',
  );
  plot.contextExcludeRules = normalizeExcludeRules_ACU(
    plot.contextExcludeRules,
    plot.contextExcludeTags || '',
  );
  ensureLoopPromptsArray_ACU(plot);
  return plot;
}

function readLoopSettings(): Record<string, any> {
  const plot = ensureSettingsShape();
  return plot.loopSettings as Record<string, any>;
}

function saveAndRefresh(store: ReturnType<typeof useContinuationStore>): void {
  saveSettings_ACU();
  store.refreshFromSettings();
}

function syncContentReplaceGate(): void {
  useRouterStore().syncFeatureGate(
    FEATURE_GATE_CONTENT_REPLACE,
    syncContentReplaceAvailability(),
  );
}

export const useContinuationStore = defineStore('acu-v2-continuation', {
  state: (): ContinuationState => ({
    prompts: [],
    loopTags: '',
    loopDelay: 5,
    loopTotalDuration: 0,
    maxRetries: 3,
    contextTurnCount: 3,
    contextExtractRules: [],
    contextExcludeRules: [],
  }),
  getters: {
    hasPrompt(state): boolean {
      return state.prompts.some(p => p.trim().length > 0);
    },
    promptCount(state): number {
      return state.prompts.length;
    },
  },
  actions: {
    refreshFromSettings(): void {
      const plot = ensureSettingsShape();
      const loop = plot.loopSettings as Record<string, any>;
      this.prompts = Array.isArray(loop.quickReplyContent) ? loop.quickReplyContent.map((p: unknown) => String(p ?? '')) : [];
      this.loopTags = String(loop.loopTags || '');
      this.loopDelay = toNonNegativeNumber(loop.loopDelay, DEFAULT_PLOT_SETTINGS_ACU.loopSettings?.loopDelay ?? 5);
      this.loopTotalDuration = toNonNegativeNumber(loop.loopTotalDuration, DEFAULT_PLOT_SETTINGS_ACU.loopSettings?.loopTotalDuration ?? 0);
      this.maxRetries = toNonNegativeNumber(loop.maxRetries, DEFAULT_PLOT_SETTINGS_ACU.loopSettings?.maxRetries ?? 3);
      this.contextTurnCount = toNonNegativeNumber(plot.contextTurnCount, DEFAULT_PLOT_SETTINGS_ACU.contextTurnCount ?? 3);
      this.contextExtractRules = clone(plot.contextExtractRules || []);
      this.contextExcludeRules = clone(plot.contextExcludeRules || []);
    },

    addPrompt(): void {
      const loop = readLoopSettings();
      loop.quickReplyContent.push('');
      saveAndRefresh(this);
    },

    removePrompt(index: number): void {
      const loop = readLoopSettings();
      if (index < 0 || index >= loop.quickReplyContent.length) return;
      loop.quickReplyContent.splice(index, 1);
      loop.currentPromptIndex = 0;
      saveAndRefresh(this);
    },

    setPrompt(index: number, value: string): void {
      const loop = readLoopSettings();
      if (index < 0 || index >= loop.quickReplyContent.length) return;
      loop.quickReplyContent[index] = String(value ?? '');
      loop.currentPromptIndex = 0;
      saveAndRefresh(this);
    },

    setLoopTags(value: string): void {
      const loop = readLoopSettings();
      loop.loopTags = String(value ?? '');
      saveAndRefresh(this);
    },

    setLoopDelay(value: number | string): void {
      const loop = readLoopSettings();
      loop.loopDelay = toNonNegativeNumber(value, DEFAULT_PLOT_SETTINGS_ACU.loopSettings?.loopDelay ?? 5);
      saveAndRefresh(this);
    },

    setLoopTotalDuration(value: number | string): void {
      const loop = readLoopSettings();
      loop.loopTotalDuration = toPositiveNumber(value, 0);
      saveAndRefresh(this);
    },

    setMaxRetries(value: number | string): void {
      const loop = readLoopSettings();
      loop.maxRetries = toNonNegativeNumber(value, DEFAULT_PLOT_SETTINGS_ACU.loopSettings?.maxRetries ?? 3);
      syncContentReplaceGate();
      saveAndRefresh(this);
    },

    setContextTurnCount(value: number | string): void {
      const plot = ensureSettingsShape();
      plot.contextTurnCount = toNonNegativeNumber(value, DEFAULT_PLOT_SETTINGS_ACU.contextTurnCount ?? 3);
      saveAndRefresh(this);
    },

    setContextExtractRules(value: ContinuationRulePair[]): void {
      const plot = ensureSettingsShape();
      plot.contextExtractRules = normalizeExtractRules_ACU(value, '');
      delete plot.contextExtractTags;
      saveAndRefresh(this);
    },

    setContextExcludeRules(value: ContinuationRulePair[]): void {
      const plot = ensureSettingsShape();
      plot.contextExcludeRules = normalizeExcludeRules_ACU(value, '');
      delete plot.contextExcludeTags;
      saveAndRefresh(this);
    },
  },
});
