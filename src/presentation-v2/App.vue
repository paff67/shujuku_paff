<template>
  <div class="acu-v2-app">
    <div v-show="rootShell.isOpen" class="acu-v2-app__shell">
      <div class="acu-v2-app__body">
        <Sidebar v-if="!visualizer.isActive" class="acu-v2-app__desktop-sidebar" />
        <div class="acu-v2-app__content">
          <header v-if="!visualizer.isActive" class="acu-v2-app__header">
            <div class="acu-v2-app__header-left">
              <AcuIconButton
                v-if="!visualizer.isActive"
                class="acu-v2-app__menu"
                icon="fa-solid fa-bars"
                title="打开导航"
                :aria-expanded="isMobileNavOpen"
                @click="openMobileNav"
              />
              <h1 class="acu-v2-app__page-title">{{ shellTitle }}</h1>
            </div>
            <div class="acu-v2-app__header-right">
              <div class="acu-v2-app__theme-switcher">
                <AcuIconButton
                  class="acu-v2-app__theme-btn"
                  icon="fa-solid fa-palette"
                  :title="'主题：' + themeStore.activeTheme.name"
                  @click="toggleThemeMenu"
                />
                <ul
                  v-if="isThemeMenuRendered"
                  class="acu-v2-app__theme-menu"
                  :class="{ 'is-closing': isThemeMenuClosing }"
                  role="listbox"
                  :aria-label="'选择主题'"
                >
                  <li
                    v-for="t in themeStore.themes"
                    :key="t.id"
                    role="option"
                    :aria-selected="t.id === themeStore.activeId"
                    class="acu-v2-app__theme-option"
                    :class="{ 'is-active': t.id === themeStore.activeId }"
                    @click="selectTheme(t.id)"
                  >
                    <span class="acu-v2-app__theme-option-main">
                      <span
                        class="acu-v2-app__theme-swatch"
                        :style="{
                          '--acu-theme-swatch-bg': t.tokens.bg0,
                          '--acu-theme-swatch-accent': t.tokens.accent,
                        }"
                      ></span>
                      <span class="acu-v2-app__theme-name">{{ t.name }}</span>
                      <span v-if="isCustomThemeId(t.id)" class="acu-v2-app__theme-tag">自定义</span>
                    </span>
                    <span class="acu-v2-app__theme-tools" @click.stop>
                      <AcuIconButton
                        icon="fa-solid fa-download"
                        size="sm"
                        :title="'导出主题：' + t.name"
                        @click="exportTheme(t.id)"
                      />
                      <AcuIconButton
                        icon="fa-solid fa-trash"
                        size="sm"
                        :variant="isCustomThemeId(t.id) ? 'danger' : 'default'"
                        :title="isCustomThemeId(t.id) ? '删除自定义主题：' + t.name : '内置主题不可删除：' + t.name"
                        @click="deleteTheme(t.id)"
                      />
                    </span>
                  </li>
                  <li class="acu-v2-app__theme-menu-footer">
                    <AcuFileButton size="sm" accept="application/json,.json" @file="importThemeFile">
                      <i class="fa-solid fa-file-import"></i>
                      导入主题
                    </AcuFileButton>
                  </li>
                </ul>
              </div>
              <AcuIconButton
                class="acu-v2-app__close"
                icon="fa-solid fa-xmark"
                :title="visualizer.isActive ? '关闭数据库编辑器' : '关闭新 UI'"
                :aria-label="visualizer.isActive ? '关闭数据库编辑器' : '关闭新 UI'"
                @click="closeApp"
              />
            </div>
          </header>
          <VisualizerSurface v-if="visualizer.isActive" @close="closeApp" />
          <MainArea v-else />
        </div>
      </div>

      <div
        v-if="isMobileNavRendered"
        class="acu-v2-app__mobile-nav-layer"
        :class="{ 'is-closing': isMobileNavClosing }"
        @click.self="closeMobileNav"
      >
        <aside
          class="acu-v2-app__mobile-nav"
          role="dialog"
          aria-modal="true"
          aria-label="一级页导航"
          @click.stop
        >
          <Sidebar variant="drawer" @navigate="closeMobileNav" />
        </aside>
      </div>

      <AcuToastViewport />
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AcuFileButton from "./components/_lib/AcuFileButton.vue";
import AcuIconButton from "./components/_lib/AcuIconButton.vue";
import AcuToastViewport from "./components/_lib/AcuToastViewport.vue";
import MainArea from "./components/MainArea.vue";
import Sidebar from "./components/Sidebar.vue";
import { useChatChangedListener } from "./composables/useChatChangedListener";
import { useDevOptions } from "./composables/useDevOptions";
import { canCloseUi } from "./composables/useUiCloseGuard";
import { useRootShellStore } from "./stores/root-shell-store";
import { useRouterStore } from "./stores/router-store";
import { isCustomThemeId, useThemeStore } from "./stores/theme-store";
import { useToastStore } from "./stores/toast-store";
import { useUiModeStore } from "./stores/ui-mode-store";
import { useVisualizerStore } from "./stores/visualizer-store";
import VisualizerSurface from "./surfaces/visualizer/VisualizerSurface.vue";
import type { AcuV2ThemeId } from "./theme/theme-types";
import { getAcuHostDocument } from "./bootstrap/host-document";

const emit = defineEmits<{ (event: "close"): void }>();
const rootShell = useRootShellStore();
const router = useRouterStore();
const themeStore = useThemeStore();
const toastStore = useToastStore();
const uiMode = useUiModeStore();
const visualizer = useVisualizerStore();
const isMobileNavOpen = ref(false);
const isMobileNavRendered = ref(false);
const isMobileNavClosing = ref(false);
const isThemeMenuOpen = ref(false);
const isThemeMenuRendered = ref(false);
const isThemeMenuClosing = ref(false);
const THEME_MENU_LEAVE_MS = 120;
const MOBILE_NAV_LEAVE_MS = 150;
let themeMenuCloseTimer: ReturnType<typeof setTimeout> | undefined;
let mobileNavCloseTimer: ReturnType<typeof setTimeout> | undefined;

const shellTitle = computed(() =>
  visualizer.isActive ? "数据库编辑器" : router.activePage?.title || "SP·数据库 IV",
);

function toggleThemeMenu(): void {
  if (isThemeMenuOpen.value) closeThemeMenu();
  else openThemeMenu();
}

function selectTheme(id: AcuV2ThemeId): void {
  themeStore.setTheme(id);
  closeThemeMenu();
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("主题文件读取失败。"));
    reader.readAsText(file, "utf-8");
  });
}

async function importThemeFile(file: File): Promise<void> {
  try {
    const text = await readFileText(file);
    themeStore.importCustomThemeFromJsonText(text);
    closeThemeMenu();
  } catch (error) {
    toastStore.error(error instanceof Error ? error.message : "主题导入失败。");
  }
}

function exportTheme(id: AcuV2ThemeId): void {
  try {
    const theme = themeStore.themes.find(t => t.id === id);
    const file = themeStore.buildThemeFile(id);
    const filename = `acu-v2-theme-${sanitizeFilename(theme?.name || "custom-theme")}.json`;
    downloadJson(filename, file);
  } catch {
    toastStore.error("主题导出失败。");
  }
}

function deleteTheme(id: AcuV2ThemeId): void {
  if (!isCustomThemeId(id)) {
    return;
  }
  const theme = themeStore.themes.find(t => t.id === id);
  const confirmed = window.confirm(
    `删除"${theme?.name || "自定义主题"}"后会从本浏览器移除；如果正在使用它，界面会切回默认深色主题。`,
  );
  if (!confirmed) return;
  themeStore.deleteCustomTheme(id);
  closeThemeMenu();
}

function sanitizeFilename(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 48) || "custom-theme";
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = getAcuHostDocument().createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function onDocPointer(e: Event): void {
  if (!(e.target as HTMLElement)?.closest(".acu-v2-app__theme-switcher")) {
    closeThemeMenu();
  }
}

onMounted(() => {
  const doc = getAcuHostDocument();
  doc.addEventListener("pointerdown", onDocPointer, true);
  doc.addEventListener("touchstart", onDocPointer, true);
  doc.addEventListener("click", onDocPointer, true);
});
onBeforeUnmount(() => {
  const doc = getAcuHostDocument();
  doc.removeEventListener("pointerdown", onDocPointer, true);
  doc.removeEventListener("touchstart", onDocPointer, true);
  doc.removeEventListener("click", onDocPointer, true);
  clearThemeMenuCloseTimer();
  clearMobileNavCloseTimer();
});

onMounted(() => {
  rootShell.markMounted();
});

useChatChangedListener();

// 关掉"启用开发者选项"且当前页是开发者一级页时，回退到默认页（plan §D24）
const devOptions = useDevOptions();
watch(() => devOptions.developerOptionsEnabled.value, () => {
  router.ensureActiveVisible();
});

onMounted(() => router.ensureActiveVisible());
watch(() => uiMode.mode, () => router.ensureActiveVisible());
watch(() => rootShell.isOpen, (isOpen) => {
  if (!isOpen) toastStore.clear();
});

function openMobileNav(): void {
  clearMobileNavCloseTimer();
  isMobileNavOpen.value = true;
  isMobileNavRendered.value = true;
  isMobileNavClosing.value = false;
}

function closeMobileNav(): void {
  if (!isMobileNavOpen.value && !isMobileNavRendered.value) return;
  isMobileNavOpen.value = false;
  if (!isMobileNavRendered.value) return;
  isMobileNavClosing.value = true;
  clearMobileNavCloseTimer();
  mobileNavCloseTimer = setTimeout(() => {
    isMobileNavRendered.value = false;
    isMobileNavClosing.value = false;
    mobileNavCloseTimer = undefined;
  }, MOBILE_NAV_LEAVE_MS);
}

async function closeApp(): Promise<void> {
  if (!(await canCloseUi())) return;
  closeThemeMenu();
  closeMobileNav();
  if (visualizer.isActive) {
    const result = visualizer.closeSurface();
    if (result.previousPageId) router.setActivePage(result.previousPageId);
    if (result.shouldCloseShell) emit("close");
    return;
  }
  emit("close");
}

function openThemeMenu(): void {
  clearThemeMenuCloseTimer();
  isThemeMenuOpen.value = true;
  isThemeMenuRendered.value = true;
  isThemeMenuClosing.value = false;
}

function closeThemeMenu(): void {
  if (!isThemeMenuOpen.value && !isThemeMenuRendered.value) return;
  isThemeMenuOpen.value = false;
  if (!isThemeMenuRendered.value) return;
  isThemeMenuClosing.value = true;
  clearThemeMenuCloseTimer();
  themeMenuCloseTimer = setTimeout(() => {
    isThemeMenuRendered.value = false;
    isThemeMenuClosing.value = false;
    themeMenuCloseTimer = undefined;
  }, THEME_MENU_LEAVE_MS);
}

function clearThemeMenuCloseTimer(): void {
  if (themeMenuCloseTimer === undefined) return;
  clearTimeout(themeMenuCloseTimer);
  themeMenuCloseTimer = undefined;
}

function clearMobileNavCloseTimer(): void {
  if (mobileNavCloseTimer === undefined) return;
  clearTimeout(mobileNavCloseTimer);
  mobileNavCloseTimer = undefined;
}
</script>

<style scoped>
.acu-v2-app {
  color: var(--acu-text-1);
  font-family: var(--acu-font-ui);
  --acu-font-size-micro: 10px;
  --acu-font-size-caption: 11px;
  --acu-font-size-body: 12px;
  --acu-font-size-body-lg: 13px;
  --acu-font-size-section-title: 12px;
  --acu-font-size-list-title: 13px;
  --acu-font-size-panel-title: 15px;
  --acu-font-size-page-title: 22px;
  --acu-line-height-caption: 1.5;
  --acu-line-height-body: 1.45;
  --acu-line-height-readable: 1.55;
  font-size: var(--acu-font-size-body);
}

.acu-v2-app__shell {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  inset: 0;
  z-index: 9000;
  width: 100%;
  width: 100vw;
  width: 100dvw;
  height: 100%;
  height: 100vh;
  height: 100dvh;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--acu-bg-0);
  color: var(--acu-text-1);
  font-family: var(--acu-font-ui);
  font-size: var(--acu-font-size-body);
}

.acu-v2-app,
.acu-v2-app * {
  box-sizing: border-box;
}

.acu-v2-app :deep(button) {
  appearance: none;
  -webkit-appearance: none;
  -webkit-tap-highlight-color: transparent;
}

.acu-v2-app :deep(button:focus:not(:focus-visible)) {
  outline: none;
  box-shadow: none;
}

:global(.acu-text) {
  margin: 0;
  min-width: 0;
}

:global(.acu-text--caption) {
  font-size: var(--acu-font-size-caption, 11px);
  line-height: var(--acu-line-height-caption, 1.5);
  color: var(--acu-text-3);
}

:global(.acu-text--meta) {
  font-size: var(--acu-font-size-body, 12px);
  line-height: var(--acu-line-height-body, 1.45);
  color: var(--acu-text-3);
}

:global(.acu-text--hint) {
  font-size: var(--acu-font-size-body, 12px);
  line-height: var(--acu-line-height-readable, 1.55);
  color: var(--acu-text-3);
}

:global(.acu-text--status-line) {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 22px;
  font-size: var(--acu-font-size-body, 12px);
  line-height: var(--acu-line-height-body, 1.45);
  color: var(--acu-text-3);
}

:global(.acu-text--empty) {
  font-size: var(--acu-font-size-body-lg, 13px);
  line-height: var(--acu-line-height-readable, 1.55);
  color: var(--acu-text-3);
  text-align: center;
}

:global(.acu-text--error) {
  font-size: var(--acu-font-size-body, 12px);
  line-height: var(--acu-line-height-body, 1.45);
  color: var(--acu-danger);
}

:global(.acu-text--section-label) {
  font-size: var(--acu-font-size-section-title, 12px);
  line-height: var(--acu-line-height-body, 1.45);
  font-weight: 600;
  color: var(--acu-text-2);
}

:global(.acu-text--list-title) {
  font-size: var(--acu-font-size-list-title, 13px);
  line-height: var(--acu-line-height-body, 1.45);
  font-weight: 500;
  color: var(--acu-text-1);
}

:global(.acu-text__value) {
  color: var(--acu-text-1);
  font-weight: 500;
}

.acu-v2-app__header {
  position: relative;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 50px;
  padding: 8px 12px 8px 20px;
  background: var(--acu-bg-0);
  border-bottom: 1px solid var(--acu-border-2);
  flex: 0 0 auto;
}

.acu-v2-app__header-left {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
  flex: 1 1 auto;
}

.acu-v2-app__menu {
  display: none;
  flex: 0 0 auto;
  font-size: 14px;
  background: transparent;
  color: var(--acu-text-2);
  box-shadow: none;
}

.acu-v2-app__menu:hover:not(:disabled) {
  background: transparent;
  color: var(--acu-text-1);
}

.acu-v2-app__page-title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--acu-text-1);
  font-size: var(--acu-font-size-page-title, 22px);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acu-v2-app__close {
  width: 30px;
  height: 30px;
  border: 0;
  background: transparent;
  color: var(--acu-text-2);
  font-size: var(--acu-font-size-page-title, 22px);
  line-height: 1;
  cursor: pointer;
  border-radius: var(--acu-radius-sm);
}

.acu-v2-app__close:hover {
  background: var(--acu-hover-overlay);
  color: var(--acu-text-1);
}

.acu-v2-app__body {
  flex: 1 1 auto;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.acu-v2-app__content {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.acu-v2-app__mobile-nav-layer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  inset: 0;
  width: 100%;
  width: 100vw;
  width: 100dvw;
  height: 100%;
  height: 100vh;
  height: 100dvh;
  min-height: 100vh;
  min-height: 100dvh;
  z-index: 9300;
  display: none;
  align-items: stretch;
  justify-content: flex-start;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.58);
  pointer-events: auto;
  overscroll-behavior: contain;
  animation: mobile-nav-layer-in 0.18s ease-out both;
}

.acu-v2-app__mobile-nav-layer.is-closing {
  pointer-events: auto;
  animation: mobile-nav-layer-out 0.15s ease-in both;
}

.acu-v2-app__mobile-nav {
  width: 280px;
  max-width: calc(100vw - 72px);
  height: 100%;
  max-height: 100vh;
  min-width: 0;
  min-height: 0;
  align-self: stretch;
  flex: 0 1 280px;
  display: flex;
  flex-direction: column;
  background: var(--acu-sidebar-bg);
  border-right: 0;
  box-shadow: var(--acu-shadow);
  overflow: hidden;
  pointer-events: auto;
  animation: mobile-nav-drawer-in 0.18s ease-out both;
}

.acu-v2-app__mobile-nav-layer.is-closing .acu-v2-app__mobile-nav {
  animation: mobile-nav-drawer-out 0.15s ease-in both;
}

@supports (width: min(280px, calc(100vw - 72px))) {
  .acu-v2-app__mobile-nav {
    width: min(280px, calc(100vw - 72px));
    flex: 0 0 min(280px, calc(100vw - 72px));
  }
}

@supports (width: 100dvw) {
  .acu-v2-app__mobile-nav {
    max-width: calc(100dvw - 72px);
  }
}

@supports (height: 100dvh) {
  .acu-v2-app__mobile-nav {
    height: 100dvh;
    max-height: 100dvh;
  }
}

/* ── Theme switcher ── */
.acu-v2-app__header-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.acu-v2-app__theme-switcher {
  position: relative;
}

.acu-v2-app__theme-btn {
  width: 30px;
  height: 30px;
  border: 0;
  background: transparent;
  color: var(--acu-text-2);
  font-size: 14px;
  cursor: pointer;
  border-radius: var(--acu-radius-sm);
}

.acu-v2-app__theme-btn:hover {
  background: var(--acu-hover-overlay);
  color: var(--acu-text-1);
}

.acu-v2-app__theme-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 10;
  list-style: none;
  margin: 0;
  padding: 4px;
  width: min(280px, calc(100vw - 24px));
  min-width: 240px;
  background: var(--acu-bg-1);
  border: 1px solid var(--acu-border);
  border-radius: var(--acu-radius-md);
  box-shadow: var(--acu-shadow);
  animation: theme-menu-in 0.12s ease-out both;
}

.acu-v2-app__theme-menu.is-closing {
  pointer-events: none;
  animation: theme-menu-out 0.12s ease-in both;
}

.acu-v2-app__theme-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  font-size: var(--acu-font-size-body-lg, 13px);
  color: var(--acu-text-2);
  border-radius: var(--acu-radius-sm);
  cursor: pointer;
  user-select: none;
}

.acu-v2-app__theme-option:hover {
  background: var(--acu-hover-overlay);
  color: var(--acu-text-1);
}

.acu-v2-app__theme-option.is-active {
  color: var(--acu-on-accent);
  background: var(--acu-accent);
  font-weight: 600;
}

.acu-v2-app__theme-option-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.acu-v2-app__theme-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acu-v2-app__theme-tag {
  flex: 0 0 auto;
  padding: 1px 5px;
  border-radius: var(--acu-radius-sm);
  background: color-mix(in srgb, var(--acu-accent) 12%, transparent);
  color: var(--acu-accent);
  font-size: var(--acu-font-size-micro, 10px);
  font-weight: 600;
}

.acu-v2-app__theme-option.is-active .acu-v2-app__theme-tag {
  background: color-mix(in srgb, var(--acu-on-accent) 18%, transparent);
  color: var(--acu-on-accent);
}

.acu-v2-app__theme-tools {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  opacity: 0.72;
}

.acu-v2-app__theme-tools :deep(.acu-icon-btn) {
  background: transparent;
  color: inherit;
}

.acu-v2-app__theme-tools :deep(.acu-icon-btn:hover:not(:disabled)) {
  background: var(--acu-hover-overlay);
  color: var(--acu-text-1);
}

.acu-v2-app__theme-option.is-active .acu-v2-app__theme-tools :deep(.acu-icon-btn:hover:not(:disabled)) {
  background: color-mix(in srgb, var(--acu-on-accent) 18%, transparent);
  color: var(--acu-on-accent);
}

.acu-v2-app__theme-tools :deep(.acu-icon-btn--danger:hover:not(:disabled)) {
  background: color-mix(in srgb, var(--acu-danger) 12%, transparent);
  color: var(--acu-danger);
}

.acu-v2-app__theme-option:hover .acu-v2-app__theme-tools,
.acu-v2-app__theme-option.is-active .acu-v2-app__theme-tools {
  opacity: 1;
}

.acu-v2-app__theme-swatch {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  flex: 0 0 18px;
  background: linear-gradient(
    135deg,
    var(--acu-theme-swatch-bg) 0 56%,
    var(--acu-theme-swatch-accent) 56% 100%
  );
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--acu-border-2) 72%, transparent);
}

.acu-v2-app__theme-option.is-active .acu-v2-app__theme-swatch {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--acu-on-accent) 62%, transparent);
}

.acu-v2-app__theme-menu-footer {
  display: flex;
  justify-content: stretch;
  margin-top: 4px;
  padding: 7px 6px 4px;
  border-top: 1px solid var(--acu-border);
}

.acu-v2-app__theme-menu-footer :deep(.acu-file-button),
.acu-v2-app__theme-menu-footer :deep(.acu-btn) {
  width: 100%;
}

@keyframes theme-menu-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes theme-menu-out {
  from {
    opacity: 1;
    transform: translateY(0);
  }
  to {
    opacity: 0;
    transform: translateY(-4px);
  }
}

@keyframes mobile-nav-layer-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes mobile-nav-drawer-in {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}

@keyframes mobile-nav-layer-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

@keyframes mobile-nav-drawer-out {
  from { transform: translateX(0); }
  to { transform: translateX(-100%); }
}

@media (max-width: 720px) {
  .acu-v2-app__header {
    min-height: 48px;
    padding: 8px 10px;
  }

  .acu-v2-app__header-left {
    gap: 6px;
  }

  .acu-v2-app__menu {
    display: inline-flex;
  }

  .acu-v2-app__page-title {
    font-size: 18px;
  }

  .acu-v2-app__desktop-sidebar {
    display: none;
  }

  .acu-v2-app__mobile-nav-layer {
    display: flex;
  }
}
</style>
