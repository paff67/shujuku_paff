import { settings_ACU } from '../../service/runtime/state-manager';
import { CONTENT_REPLACE_UNLOCK_MAX_RETRIES } from '../router/page-registry';

export function isContentReplaceUnlockedBySettings(): boolean {
  return Number(settings_ACU?.plotSettings?.loopSettings?.maxRetries) === CONTENT_REPLACE_UNLOCK_MAX_RETRIES;
}

function ensureContentReplaceSettings(): Record<string, any> {
  if (!settings_ACU.contentOptimizationSettings || typeof settings_ACU.contentOptimizationSettings !== 'object') {
    settings_ACU.contentOptimizationSettings = {};
  }
  return settings_ACU.contentOptimizationSettings as Record<string, any>;
}

function readUserEnabledPreference(cfg: Record<string, any>): boolean {
  if (cfg.enabledSwitchTouched !== true) return false;
  return cfg.enabledPreference === true;
}

export function isContentReplaceEnabledBySettings(): boolean {
  return isContentReplaceUnlockedBySettings() && settings_ACU?.contentOptimizationSettings?.enabled === true;
}

export function setContentReplaceEnabledBySettings(enabled: boolean): boolean {
  const cfg = ensureContentReplaceSettings();
  cfg.enabledSwitchTouched = true;
  cfg.enabledPreference = enabled === true;
  cfg.enabled = isContentReplaceUnlockedBySettings() && cfg.enabledPreference === true;
  return cfg.enabled === true;
}

export function syncContentReplaceAvailability(): boolean {
  const unlocked = isContentReplaceUnlockedBySettings();
  const cfg = ensureContentReplaceSettings();
  if (!unlocked) {
    cfg.enabled = false;
    return false;
  }
  cfg.enabled = readUserEnabledPreference(cfg);
  return cfg.enabled;
}
