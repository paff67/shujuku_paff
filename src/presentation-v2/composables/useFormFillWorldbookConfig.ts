/**
 * useFormFillWorldbookConfig — 填表"附加世界书条目"来源（Component B，§4.2）
 *
 * 操作 worldbookConfig.source / worldbookConfig.manualSelection。
 * 决定填表 AI 提示词附带的条目从哪本书来。
 *   - source='character'：跟随角色卡的所有世界书（primary + additional）
 *   - source='manual'：手动指定一本世界书（manualSelection[0]）
 *
 * 与 useFormFillInjectionTarget（写入侧）相互独立。
 */
import { computed, ref } from 'vue';
import { getCurrentWorldbookConfig_ACU } from '../../service/settings/settings-readers';
import { saveSettings_ACU } from '../../service/settings/settings-service';
import { getCharLorebooks_ACU } from '../../service/worldbook/worldbook-service';

export type FormFillWorldbookSource = 'character' | 'manual';

export function useFormFillWorldbookConfig() {
  const source = ref<FormFillWorldbookSource>('character');
  const manualBook = ref<string>('');

  function refreshFromSettings(): void {
    const cfg = getCurrentWorldbookConfig_ACU();
    source.value = cfg.source === 'manual' ? 'manual' : 'character';
    const list: string[] = Array.isArray(cfg.manualSelection) ? cfg.manualSelection : [];
    manualBook.value = list[0] || '';
  }

  function setSource(next: FormFillWorldbookSource): void {
    const cfg = getCurrentWorldbookConfig_ACU();
    cfg.source = next;
    source.value = next;
    if (next === 'character') {
      cfg.manualSelection = [];
      manualBook.value = '';
    }
    saveSettings_ACU();
  }

  function setManualBook(name: string): void {
    const cfg = getCurrentWorldbookConfig_ACU();
    const trimmed = String(name || '').trim();
    cfg.source = 'manual';
    cfg.manualSelection = trimmed ? [trimmed] : [];
    source.value = 'manual';
    manualBook.value = trimmed;
    saveSettings_ACU();
  }

  const selectorValue = computed<string>(() => {
    if (source.value === 'character') return 'character';
    return manualBook.value || '';
  });

  function onSelectorChange(value: string): void {
    if (value === 'character') setSource('character');
    else setManualBook(value);
  }

  async function resolveBookNames(): Promise<string[]> {
    const cfg = getCurrentWorldbookConfig_ACU();
    if (cfg.source === 'manual') {
      const list: string[] = Array.isArray(cfg.manualSelection) ? cfg.manualSelection : [];
      return [...new Set(list.filter(Boolean))];
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
