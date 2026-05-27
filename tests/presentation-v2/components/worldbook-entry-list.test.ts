/**
 * WorldbookEntryList — 世界书条目列表空状态
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type App, createApp, defineComponent, h } from 'vue';
import WorldbookEntryList from '../../../src/presentation-v2/components/WorldbookEntryList.vue';

interface Mounted {
  app: App<Element>;
  el: HTMLElement;
}

const mounted: Mounted[] = [];

function mountList(emptyText: string) {
  const wrapper = defineComponent({
    setup() {
      return () => h(WorldbookEntryList, {
        groups: [],
        filter: '',
        loading: false,
        emptyText,
      });
    },
  });

  const el = document.createElement('div');
  document.body.appendChild(el);
  const app = createApp(wrapper);
  app.mount(el);
  mounted.push({ app, el });
  return el;
}

function mountGroups() {
  const groups = [
    {
      bookName: 'CharBook',
      expanded: false,
      entries: [
        { uid: 1, bookName: 'CharBook', label: '人物', checked: true, disabled: false },
        { uid: 2, bookName: 'CharBook', label: '地点', checked: false, disabled: false },
        { uid: 3, bookName: 'CharBook', label: '背景', checked: true, disabled: false },
      ],
    },
  ];
  const wrapper = defineComponent({
    setup() {
      return () => h(WorldbookEntryList, {
        groups,
        filter: '',
        loading: false,
      });
    },
  });

  const el = document.createElement('div');
  document.body.appendChild(el);
  const app = createApp(wrapper);
  app.mount(el);
  mounted.push({ app, el });
  return el;
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    entry.app.unmount();
    entry.el.remove();
  }
  document.body.innerHTML = '';
});

describe('WorldbookEntryList', () => {
  it('空列表提示使用调用方传入的文案', () => {
    const el = mountList('未解析到角色卡世界书。打开聊天后会显示条目；也可手动选择一本。');

    expect(el.textContent).toContain('未解析到角色卡世界书');
    expect(el.textContent).not.toContain('所选世界书中无可显示的条目');
  });

  it('分组头部展示已勾选数量和总条目数量', () => {
    const el = mountGroups();
    const meta = el.querySelector('.acu-disclosure-group__meta');

    expect(el.textContent).toContain('CharBook');
    expect(meta?.textContent).toBe('2/3 条');
  });
});
