/**
 * AcuToastViewport - v2 toast rendering and interactions.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

const apps: Array<{ app: App<Element>; el: HTMLElement }> = [];

async function mountViewport() {
  vi.resetModules();
  vi.doMock("../../../src/service/runtime/state-manager", () => ({
    settings_ACU: { toastMuteEnabled: false },
  }));
  const [{ createPinia }, { default: AcuToastViewport }, { useToastStore }] =
    await Promise.all([
      import("pinia"),
      import("../../../src/presentation-v2/components/_lib/AcuToastViewport.vue"),
      import("../../../src/presentation-v2/stores/toast-store"),
    ]);
  const wrapper = defineComponent({
    setup() {
      return () => h(AcuToastViewport);
    },
  });
  const el = document.createElement("div");
  document.body.appendChild(el);
  const pinia = createPinia();
  const app = createApp(wrapper);
  app.use(pinia);
  app.mount(el);
  apps.push({ app, el });
  return { store: useToastStore(), el };
}

afterEach(() => {
  while (apps.length > 0) {
    const entry = apps.pop()!;
    entry.app.unmount();
    entry.el.remove();
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("AcuToastViewport", () => {
  it("renders stacked semantic toasts", async () => {
    const { store, el } = await mountViewport();

    store.success("提示词已保存", { durationMs: 0 });
    store.error("操作失败，详情见运行日志", { durationMs: 0 });
    await nextTick();

    const toasts = Array.from(el.querySelectorAll<HTMLElement>(".acu-v2-toast"));
    const viewport = el.querySelector<HTMLElement>(".acu-toast-viewport");
    expect(viewport).not.toBeNull();
    expect(viewport!.getAttribute("role")).toBe("status");
    expect(getComputedStyle(viewport!).zIndex).toBe("9410");
    expect(Number(getComputedStyle(viewport!).zIndex)).toBeGreaterThan(9300);
    expect(toasts).toHaveLength(2);
    expect(toasts[0].classList.contains("acu-v2-toast--success")).toBe(true);
    expect(toasts[0].classList.contains("acu-toast--success")).toBe(false);
    expect(toasts[0].getAttribute("role")).toBe("status");
    expect(toasts[1].classList.contains("acu-v2-toast--error")).toBe(true);
    expect(toasts[1].classList.contains("acu-toast--error")).toBe(false);
    expect(toasts[1].getAttribute("role")).toBe("alert");
    expect(el.textContent || "").toContain("提示词已保存");
    expect(el.textContent || "").toContain("操作失败，详情见运行日志");
  });

  it("dismiss button removes the toast item", async () => {
    const { store, el } = await mountViewport();

    store.info("已开始导出", { durationMs: 0 });
    await nextTick();

    const dismiss = el.querySelector<HTMLButtonElement>(".acu-v2-toast__dismiss");
    expect(dismiss).not.toBeNull();
    dismiss!.click();
    await nextTick();

    expect(store.items).toHaveLength(0);
    expect(el.querySelector(".acu-v2-toast")).toBeNull();
  });

  it("runs toast action and follows dismissOnClick", async () => {
    const { store, el } = await mountViewport();
    const action = vi.fn();

    store.info("可查看日志", {
      durationMs: 0,
      action: {
        label: "查看",
        onClick: action,
        dismissOnClick: false,
      },
    });
    await nextTick();

    const actionButton = Array.from(el.querySelectorAll<HTMLButtonElement>(".acu-v2-toast__action"))
      .find((button) => button.textContent?.includes("查看"));
    expect(actionButton).not.toBeUndefined();
    actionButton!.click();
    await nextTick();

    expect(action).toHaveBeenCalled();
    expect(store.items).toHaveLength(1);
  });
});
