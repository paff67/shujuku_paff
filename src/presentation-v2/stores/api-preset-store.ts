/**
 * api-preset-store — API 页状态边界（阶段 1 / D17）
 *
 * Vue 组件只读写本 store；旧 settings_ACU 与 service 调用集中在这里。
 */
import { defineStore } from 'pinia';
import { currentChatFileIdentifier_ACU, settings_ACU } from '../../service/runtime/state-manager';
import { saveSettings_ACU } from '../../service/settings/settings-service';
import { fetchAvailableModels_ACU, getConnectionManagerProfiles_ACU } from '../../service/ai/ai-service';

export type AcuV2ApiMode = 'custom' | 'tavern';

export interface AcuV2ApiConfig {
  url: string;
  apiKey: string;
  model: string;
  useMainApi: boolean;
  max_tokens: number;
  temperature: number;
}

export interface AcuV2ApiPreset {
  name: string;
  apiMode: AcuV2ApiMode;
  apiConfig: AcuV2ApiConfig;
  tavernProfile: string;
}

export interface AcuV2ApiPresetBinding {
  presetName: string;
  updatedAt: number;
}

interface ApiPresetState {
  presets: AcuV2ApiPreset[];
  defaultApiPresetName: string;
  activePresetName: string;
  currentConfigReady: boolean;
  currentConfigLabel: string;
  currentChatKey: string;
  streamingEnabled: boolean;
  tavernProfiles: Array<{ id: string; name: string }>;
  modelOptions: string[];
  modelLoadStatus: 'idle' | 'loading' | 'success' | 'error';
  modelLoadError: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

function normalizeApiMode(value: unknown): AcuV2ApiMode {
  return value === 'tavern' ? 'tavern' : 'custom';
}

function normalizeApiConfig(value: any): AcuV2ApiConfig {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const maxTokens = Number(source.max_tokens ?? source.maxTokens ?? 60000);
  const temperature = Number(source.temperature ?? 1);
  return {
    url: typeof source.url === 'string' ? source.url : '',
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : '',
    model: typeof source.model === 'string' ? source.model : '',
    useMainApi: source.useMainApi !== false,
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 60000,
    temperature: Number.isFinite(temperature) ? temperature : 1,
  };
}

function normalizePreset(value: any): AcuV2ApiPreset | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name) return null;
  return {
    name,
    apiMode: normalizeApiMode(value.apiMode),
    apiConfig: normalizeApiConfig(value.apiConfig),
    tavernProfile: typeof value.tavernProfile === 'string' ? value.tavernProfile : '',
  };
}

function normalizePresetList(value: unknown): AcuV2ApiPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const presets: AcuV2ApiPreset[] = [];
  for (const raw of value) {
    const preset = normalizePreset(raw);
    if (!preset || seen.has(preset.name)) continue;
    seen.add(preset.name);
    presets.push(preset);
  }
  return presets;
}

function getCurrentChatKey(): string {
  const raw = String(currentChatFileIdentifier_ACU || '').trim();
  return raw || 'unknown_chat';
}

function ensureSettingsShape(): void {
  if (!Array.isArray(settings_ACU.apiPresets)) settings_ACU.apiPresets = [];
  settings_ACU.apiPresets = normalizePresetList(settings_ACU.apiPresets);
  if (typeof settings_ACU.defaultApiPresetName !== 'string') settings_ACU.defaultApiPresetName = '';
  if (
    !settings_ACU.apiPresetBindingsByChat ||
    typeof settings_ACU.apiPresetBindingsByChat !== 'object' ||
    Array.isArray(settings_ACU.apiPresetBindingsByChat)
  ) {
    settings_ACU.apiPresetBindingsByChat = {};
  }
  settings_ACU.apiMode = normalizeApiMode(settings_ACU.apiMode);
  settings_ACU.apiConfig = normalizeApiConfig(settings_ACU.apiConfig);
  if (typeof settings_ACU.tavernProfile !== 'string') settings_ACU.tavernProfile = '';
  settings_ACU.streamingEnabled = settings_ACU.streamingEnabled === true;
}

function findPresetByName(presets: AcuV2ApiPreset[], name: string): AcuV2ApiPreset | null {
  const normalized = String(name || '').trim();
  return presets.find(p => p.name === normalized) ?? null;
}

function getCurrentConfigAsPreset(name: string): AcuV2ApiPreset {
  return {
    name,
    apiMode: normalizeApiMode(settings_ACU.apiMode),
    apiConfig: normalizeApiConfig(settings_ACU.apiConfig),
    tavernProfile: typeof settings_ACU.tavernProfile === 'string' ? settings_ACU.tavernProfile : '',
  };
}

function findPresetMatchingCurrentConfig(presets: AcuV2ApiPreset[]): AcuV2ApiPreset | null {
  const current = getCurrentConfigAsPreset('');
  return presets.find(preset => {
    if (preset.apiMode !== current.apiMode) return false;
    if (preset.tavernProfile !== current.tavernProfile) return false;
    return (
      preset.apiConfig.useMainApi === current.apiConfig.useMainApi &&
      preset.apiConfig.url === current.apiConfig.url &&
      preset.apiConfig.apiKey === current.apiConfig.apiKey &&
      preset.apiConfig.model === current.apiConfig.model &&
      preset.apiConfig.max_tokens === current.apiConfig.max_tokens &&
      preset.apiConfig.temperature === current.apiConfig.temperature
    );
  }) ?? null;
}

function resolveCurrentConfigStatus(): { ready: boolean; label: string } {
  const mode = normalizeApiMode(settings_ACU.apiMode);
  const config = normalizeApiConfig(settings_ACU.apiConfig);
  const tavernProfile = typeof settings_ACU.tavernProfile === 'string'
    ? settings_ACU.tavernProfile.trim()
    : '';

  if (mode === 'tavern') {
    return tavernProfile
      ? { ready: true, label: `酒馆连接预设 ${tavernProfile}` }
      : { ready: false, label: '未选择酒馆连接预设' };
  }

  if (config.useMainApi) {
    return { ready: true, label: '酒馆主 API' };
  }

  if (config.url.trim() && config.model.trim()) {
    return { ready: true, label: config.model.trim() };
  }

  return { ready: false, label: '当前 API 配置不完整' };
}

export const useApiPresetStore = defineStore('acu-v2-api-presets', {
  state: (): ApiPresetState => ({
    presets: [],
    defaultApiPresetName: '',
    activePresetName: '',
    currentConfigReady: false,
    currentConfigLabel: '当前 API 配置不完整',
    currentChatKey: getCurrentChatKey(),
    streamingEnabled: false,
    tavernProfiles: [],
    modelOptions: [],
    modelLoadStatus: 'idle',
    modelLoadError: '',
  }),
  getters: {
    defaultPreset(state): AcuV2ApiPreset | null {
      return findPresetByName(state.presets, state.defaultApiPresetName);
    },
    activePreset(state): AcuV2ApiPreset | null {
      return findPresetByName(state.presets, state.activePresetName);
    },
    hasPresets(state): boolean {
      return state.presets.length > 0;
    },
  },
  actions: {
    /**
     * 仅刷新展示用状态（presets / activePresetName / streaming）。
     *
     * 实际把 chat 绑定的预设写回 apiMode/apiConfig/tavernProfile 的副作用由 service 层
     * 的 applyCurrentChatApiPresetSelection_ACU() 负责（见 injection-engine-state.ts
     * loadSettings_ACU()）。store 不重复调用，避免与 chat-changed 监听器形成竞争或循环写入。
     */
    refreshFromSettings(): void {
      ensureSettingsShape();
      this.currentChatKey = getCurrentChatKey();
      this.presets = clone(settings_ACU.apiPresets);
      const defaultName = findPresetByName(this.presets, settings_ACU.defaultApiPresetName)
        ? settings_ACU.defaultApiPresetName
        : '';
      settings_ACU.defaultApiPresetName = defaultName;
      this.defaultApiPresetName = defaultName;

      const binding = settings_ACU.apiPresetBindingsByChat[this.currentChatKey] as AcuV2ApiPresetBinding | undefined;
      const boundName = binding && findPresetByName(this.presets, binding.presetName)
        ? binding.presetName
        : '';
      const matchedCurrentName = findPresetMatchingCurrentConfig(this.presets)?.name ?? '';
      this.activePresetName = boundName || defaultName || matchedCurrentName;
      const currentConfig = resolveCurrentConfigStatus();
      this.currentConfigReady = currentConfig.ready;
      this.currentConfigLabel = currentConfig.label;
      this.streamingEnabled = settings_ACU.streamingEnabled === true;
    },
    persist(): void {
      settings_ACU.apiPresets = clone(this.presets);
      settings_ACU.defaultApiPresetName = this.defaultApiPresetName;
      settings_ACU.streamingEnabled = this.streamingEnabled;
      saveSettings_ACU();
    },
    setStreamingEnabled(enabled: boolean): void {
      this.streamingEnabled = !!enabled;
      settings_ACU.streamingEnabled = this.streamingEnabled;
      saveSettings_ACU();
    },
    setDefaultPreset(name: string): boolean {
      const preset = findPresetByName(this.presets, name);
      if (!preset) return false;
      this.defaultApiPresetName = preset.name;
      settings_ACU.defaultApiPresetName = preset.name;
      saveSettings_ACU();
      return true;
    },
    setActivePresetForCurrentChat(name: string): boolean {
      const preset = findPresetByName(this.presets, name);
      if (!preset) return false;
      this.currentChatKey = getCurrentChatKey();
      this.activePresetName = preset.name;
      settings_ACU.apiPresetBindingsByChat[this.currentChatKey] = {
        presetName: preset.name,
        updatedAt: Date.now(),
      };
      settings_ACU.apiMode = preset.apiMode;
      settings_ACU.apiConfig = clone(preset.apiConfig);
      settings_ACU.tavernProfile = preset.tavernProfile;
      saveSettings_ACU();
      return true;
    },
    savePreset(presetInput: AcuV2ApiPreset, originalName = ''): boolean {
      const preset = normalizePreset(presetInput);
      if (!preset) return false;
      const hadPresets = this.presets.length > 0;
      const oldName = String(originalName || '').trim();
      const existingByNewName = this.presets.findIndex(p => p.name === preset.name);
      if (existingByNewName >= 0 && this.presets[existingByNewName].name !== oldName) {
        this.presets[existingByNewName] = preset;
      } else {
        const existingByOldName = oldName
          ? this.presets.findIndex(p => p.name === oldName)
          : -1;
        if (existingByOldName >= 0) this.presets[existingByOldName] = preset;
        else this.presets.push(preset);
      }

      if (!this.defaultApiPresetName) this.defaultApiPresetName = preset.name;
      if (oldName && this.defaultApiPresetName === oldName) this.defaultApiPresetName = preset.name;
      if (oldName && this.activePresetName === oldName) this.activePresetName = preset.name;

      for (const binding of Object.values(settings_ACU.apiPresetBindingsByChat) as AcuV2ApiPresetBinding[]) {
        if (oldName && binding?.presetName === oldName) {
          binding.presetName = preset.name;
          binding.updatedAt = Date.now();
        }
      }

      this.persist();
      if (!hadPresets || !this.activePresetName || this.activePresetName === preset.name) {
        this.setActivePresetForCurrentChat(preset.name);
      }
      return true;
    },
    saveCurrentConfigAsPreset(name: string): boolean {
      return this.savePreset(getCurrentConfigAsPreset(name));
    },
    deletePreset(name: string): boolean {
      const target = findPresetByName(this.presets, name);
      if (!target) return false;
      this.presets = this.presets.filter(p => p.name !== target.name);
      if (this.defaultApiPresetName === target.name) {
        this.defaultApiPresetName = this.presets[0]?.name ?? '';
      }
      if (this.activePresetName === target.name) {
        this.activePresetName = this.defaultApiPresetName;
      }
      if (settings_ACU.tableApiPreset === target.name) settings_ACU.tableApiPreset = '';
      if (settings_ACU.plotApiPreset === target.name) settings_ACU.plotApiPreset = '';
      if (settings_ACU.contentOptimizationSettings?.apiPreset === target.name) {
        settings_ACU.contentOptimizationSettings.apiPreset = '';
      }
      if (settings_ACU.tableApiPresetOverridesByName && typeof settings_ACU.tableApiPresetOverridesByName === 'object') {
        for (const key of Object.keys(settings_ACU.tableApiPresetOverridesByName)) {
          if (settings_ACU.tableApiPresetOverridesByName[key] === target.name) {
            delete settings_ACU.tableApiPresetOverridesByName[key];
          }
        }
      }
      for (const [chatKey, binding] of Object.entries(settings_ACU.apiPresetBindingsByChat) as Array<[string, AcuV2ApiPresetBinding]>) {
        if (binding?.presetName === target.name) delete settings_ACU.apiPresetBindingsByChat[chatKey];
      }
      this.persist();
      if (this.activePresetName) this.setActivePresetForCurrentChat(this.activePresetName);
      return true;
    },
    refreshTavernProfiles(): void {
      try {
        const profiles = getConnectionManagerProfiles_ACU() || [];
        this.tavernProfiles = profiles
          .filter((profile: any) => profile?.id)
          .map((profile: any) => ({ id: String(profile.id), name: String(profile.name || profile.id) }));
      } catch {
        this.tavernProfiles = [];
      }
    },
    async loadModelsForConfig(apiConfig: Partial<AcuV2ApiConfig>): Promise<boolean> {
      this.modelLoadStatus = 'loading';
      this.modelLoadError = '';
      const result = await fetchAvailableModels_ACU(String(apiConfig.url || ''), String(apiConfig.apiKey || ''));
      if (!result.success) {
        this.modelOptions = [];
        this.modelLoadStatus = 'error';
        this.modelLoadError = result.error || '模型列表加载失败';
        return false;
      }
      this.modelOptions = result.models || [];
      this.modelLoadStatus = 'success';
      return true;
    },
  },
});
