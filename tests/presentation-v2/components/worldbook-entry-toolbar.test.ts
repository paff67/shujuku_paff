/**
 * WorldbookEntryToolbar — 世界书条目批量按钮 + 搜索输入
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type App, createApp, defineComponent, h, ref } from 'vue';
import WorldbookEntryToolbar from '../../../src/presentation-v2/components/WorldbookEntryToolbar.vue';

interface Mounted {
  app: App<Element>;
  el: HTMLElement;
}

const mounted: Mounted[] = [];

function mountToolbar() {
  const selectAll = vi.fn();
  const deselectAll = vi.fn();

  const wrapper = defineComponent({
    setup() {
      const filter = ref('');
      return () => h(WorldbookEntryToolbar, {
        filter: filter.value,
        'onUpdate:filter': (value: string) => { filter.value = value; },
        onSelectAll: selectAll,
        onDeselectAll: deselectAll,
      });
    },
  });

  const el = document.createElement('div');
  document.body.appendChild(el);
  const app = createApp(wrapper);
  app.mount(el);
  mounted.push({ app, el });
  return { el, selectAll, deselectAll };
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    entry.app.unmount();
    entry.el.remove();
  }
  document.body.innerHTML = '';
});

describe('WorldbookEntryToolbar', () => {
  it('批量按钮和搜索输入统一使用 md 高度，并透传操作事件', async () => {
    const { el, selectAll, deselectAll } = mountToolbar();

    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.acu-btn'));
    const input = el.querySelector<HTMLInputElement>('.acu-input');

    expect(buttons).toHaveLength(2);
    expect(buttons.every(button => button.classList.contains('acu-btn--md'))).toBe(true);
    expect(buttons.some(button => button.classList.contains('acu-btn--sm'))).toBe(false);
    expect(input?.classList.contains('acu-input--md')).toBe(true);

    buttons[0].click();
    buttons[1].click();
    await Promise.resolve();

    expect(selectAll).toHaveBeenCalledTimes(1);
    expect(deselectAll).toHaveBeenCalledTimes(1);
  });
});
