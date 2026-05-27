/**
 * mount — 把 Vue + Pinia 应用挂载到 host document 的 #acu-app-v2 容器（D15 / D15.1 / D16）
 *
 * 设计要点：
 * - 容器物理隔离于旧 popup（id=acu-app-v2，不复用 #popup）
 * - 容器、所有 SFC <style>、未来主题节点都注入同一个 host document
 * - 应用生命周期：首次打开惰性创建 + mount，后续打开/关闭只切换 display；
 *   根 Vue app 与 Pinia 保留，当前页面组件在重开时由 MainArea key remount。
 */
import { createApp, type App as VueApp } from 'vue';
import { createPinia, type Pinia } from 'pinia';
import { logDebug_ACU } from '../../shared/utils';
import { setSfcStyleHost } from '../build/sfc-style-runtime';
import App from '../App.vue';
import { useRootShellStore } from '../stores/root-shell-store';
import { useThemeStore } from '../stores/theme-store';
import { applyTheme } from '../theme/theme-injector';
import { __resetUiCloseGuardsForTests } from '../composables/useUiCloseGuard';
import {
  __resetHostDocumentCacheForTests,
  getAcuHostDocument,
  getAcuHostSource,
} from './host-document';

const ROOT_ID = 'acu-app-v2';

interface MountedState {
  vueApp: VueApp;
  pinia: Pinia;
  root: HTMLElement;
}

let state: MountedState | null = null;

function ensureMounted(): MountedState {
  if (state) return state;
  const doc = getAcuHostDocument();
  const source = getAcuHostSource();

  setSfcStyleHost({ document: doc });

  let root = doc.getElementById(ROOT_ID) as HTMLElement | null;
  if (!root) {
    root = doc.createElement('div');
    root.id = ROOT_ID;
    root.style.display = 'none';
    doc.body.appendChild(root);
  }

  const pinia = createPinia();
  const vueApp = createApp(App, {
    onClose: () => closeAcuV2App(),
  });
  vueApp.use(pinia);
  vueApp.mount(root);

  // 主题：先应用一次 + 订阅后续变更，确保切主题立刻刷新 <style>
  const themeStore = useThemeStore(pinia);
  applyTheme(themeStore.activeTheme);
  themeStore.$subscribe(() => applyTheme(themeStore.activeTheme));

  state = { vueApp, pinia, root };
  logDebug_ACU(`[ACU-V2] app mounted into ${source} (id=#${ROOT_ID})`);
  return state;
}

/** 打开新 UI：首次调用执行 mount，后续只切 display + 标记 isOpen。 */
export async function openAcuV2App(): Promise<void> {
  const wasMounted = state !== null;
  const s = ensureMounted();
  s.root.style.display = '';
  const store = useRootShellStore(s.pinia);
  const wasOpen = store.isOpen;
  store.setOpen(true);
  if (wasMounted && !wasOpen) store.requestOpenRefresh();
}

/** Bridge 层在 Vue 组件外访问现有 Pinia；不会主动创建应用。 */
export function getAcuV2PiniaForBridge(): Pinia | null {
  return state?.pinia ?? null;
}

/**
 * 关闭新 UI：保留根 DOM 与 Pinia 状态，仅隐藏容器并请求滚动重置（P0-6 修订）。
 * - 路由：activePageId 留在 store + localStorage，重开后回到原页
 * - 页面：重开后当前页面 remount；用户明确编辑过且需要保留的草稿必须进入 store / settings
 * - 滚动：通过 scrollResetTick 通知 MainArea / 各页 scroll 容器
 */
export function closeAcuV2App(): void {
  if (!state) return;
  state.root.style.display = 'none';
  const store = useRootShellStore(state.pinia);
  store.setOpen(false);
  store.requestScrollReset();
}

/** 仅供测试使用：销毁应用并重置内部状态。 */
export function __resetAcuV2MountForTests(): void {
  if (state) {
    try {
      state.vueApp.unmount();
    } catch {
      /* swallow */
    }
    state.root.parentNode?.removeChild(state.root);
    state = null;
  }
  __resetUiCloseGuardsForTests();
  __resetHostDocumentCacheForTests();
}
