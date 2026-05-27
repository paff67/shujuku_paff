/**
 * useFormFillInjectionTarget — 填表"注入目标世界书"（Component A，§4.2）
 *
 * 管理 worldbookConfig.injectionTarget。值为：
 *   - 'character'（写入角色卡主世界书；默认）
 *   - 一个具体的世界书名（写入指定世界书）
 *
 * 这个 target 是写入侧（填好的表内容会写到这本书的条目里），
 * 与 Component B 的 source/enabledEntries（提示词附带条目）相互独立。
 */
import { computed, ref } from 'vue';
import { getCurrentWorldbookConfig_ACU } from '../../service/settings/settings-readers';
import { saveSettings_ACU } from '../../service/settings/settings-service';
import { getCharLorebooks_ACU } from '../../service/worldbook/worldbook-service';

export function useFormFillInjectionTarget() {
  const target = ref<string>('character');

  function refreshFromSettings(): void {
    const cfg = getCurrentWorldbookConfig_ACU();
    const next = String(cfg?.injectionTarget || 'character');
    target.value = next || 'character';
  }

  function setTarget(value: string): void {
    const cfg = getCurrentWorldbookConfig_ACU();
    const trimmed = String(value || '').trim();
    cfg.injectionTarget = trimmed || 'character';
    target.value = cfg.injectionTarget;
    saveSettings_ACU();
  }

  /** WorldbookSelector 用的 modelValue：'character' 或 bookName。 */
  const selectorValue = computed<string>(() => target.value || 'character');

  function onSelectorChange(value: string): void {
    setTarget(value);
  }

  /** 文案：当前注入目标的人类可读名。 */
  async function describeTarget(): Promise<string> {
    if (target.value === 'character') {
      try {
        const charLorebooks = await getCharLorebooks_ACU({ type: 'all' });
        return charLorebooks.primary
          ? `角色卡绑定世界书 · ${charLorebooks.primary}`
          : '角色卡绑定世界书（当前未解析到角色卡）';
      } catch {
        return '角色卡绑定世界书';
      }
    }
    return target.value || '（未选择）';
  }

  return {
    target,
    selectorValue,
    refreshFromSettings,
    setTarget,
    onSelectorChange,
    describeTarget,
  };
}
