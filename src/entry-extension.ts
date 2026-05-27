/**
 * src/entry-extension.ts — 酒馆插件入口
 *
 * 与 index.ts（油猴脚本入口）共享所有模块，但启动方式不同：
 * - 不使用 UserScript 头
 * - 不依赖 jQuery ready（插件加载时 DOM 已就绪）
 * - 运行在酒馆主窗口中（不是 iframe）
 * - 仍然依赖酒馆助手（TavernHelper）提供的 API
 */

// ═══════════════════════════════════════════════════════════════
// 运行时环境检测（必须最先导入并设置模式）
// ═══════════════════════════════════════════════════════════════
import { _forceExtensionMode, checkAndMarkInstance } from './shared/runtime-env';

// 强制设置为插件模式（必须在其他模块导入之前）
_forceExtensionMode();

// ═══════════════════════════════════════════════════════════════
// shared 层
// ═══════════════════════════════════════════════════════════════
import './shared/constants';
import './shared/env';
import './shared/utils';
import './shared/json-helpers';
import './shared/html-helpers';
import './shared/text-optimization';

// ═══════════════════════════════════════════════════════════════
// data 层
// ═══════════════════════════════════════════════════════════════
import './shared/data-constants';
import './shared/idb-import-temp';
import './data/storage/tavern-storage';
import './data/storage/chat-history';
import './shared/defaults';
import './shared/defaults-json.js';
import './data/storage/config-storage';
import './data/repositories/profile-repo';
import './data/repositories/isolation-repo';

// ═══════════════════════════════════════════════════════════════
// service 层
// ═══════════════════════════════════════════════════════════════
import './service/settings/settings-service';
import './service/ai/api-call';
import './service/ai/prompt-builder';
import './service/worldbook/pipeline';
import './service/worldbook/injection-engine';
import './service/summary/merge-logic';
import './service/runtime/state-manager';
import './service/runtime/helpers-remaining';
import './service/template/chat-scope';
import './service/optimization/content-optimization';

// ═══════════════════════════════════════════════════════════════
// presentation 层
// ═══════════════════════════════════════════════════════════════
import './presentation/triggers/update-process';
import './presentation/triggers/admin-ui';
import './presentation/triggers/import-process';
import './presentation/bootstrap/init';
import './presentation/bootstrap/api-registry';
import './presentation/window/window-system';
import './presentation/window/window-styles';
import './presentation/theme/toast';
import './presentation/components/table-selector';
import './presentation/components/plot-editors';
import './presentation/components/status-display';
import './presentation/bootstrap/startup';
import './presentation/pages/main-popup';
import './presentation/pages/popup-bindings';
import './presentation/pages/popup-helpers';
import './presentation/pages/visualizer';
import './presentation/pages/visualizer-sidebar';
import './presentation/pages/visualizer-main-render';
import './presentation/pages/visualizer-main-config';
import './presentation/pages/visualizer-main-save';
import './presentation/bootstrap/visualizer-template-assistant-addon';
import './presentation/components/template-preset-ui';
import './presentation/components/optimization-ui';
import './presentation/components/worldbook-selector';
import './presentation/components/update-status-display';
import './presentation/components/import-status-ui';
import './presentation/triggers/update-trigger';
import './presentation/triggers/data-admin-ui';
import './presentation/triggers/settings-ui-sync';

// ═══════════════════════════════════════════════════════════════
// 启动入口（酒馆插件模式）
// ═══════════════════════════════════════════════════════════════
import { mainInitialize_ACU } from './presentation/bootstrap/init';
import { initVisualizerTemplateAssistantAddon_ACU } from './presentation/bootstrap/visualizer-template-assistant-addon';
import { bootstrapAcuV2 } from './presentation-v2/bootstrap';
import { logDebug_ACU, logError_ACU, logWarn_ACU } from './shared/utils';

/**
 * 等待 TavernHelper 就绪。
 * 酒馆插件的加载顺序不确定，TavernHelper 可能还没挂载到 window 上。
 *
 * 关键事实：酒馆主窗口的 window.SillyTavern 只有 {libs, getContext}。
 * 所有真正的 API 都必须通过 SillyTavern.getContext() 拿到。
 * 所以就绪检查的正确方式是调用 getContext() 并验证关键字段存在。
 */
async function waitForTavernHelper(maxWaitMs = 15000): Promise<boolean> {
    const start = Date.now();
    let pollCount = 0;
    let lastStatus = '';

    const probe = () => {
        const hasTH = !!(window as any).TavernHelper;
        const hasST = !!(window as any).SillyTavern;
        const hasGetContext = typeof (window as any).SillyTavern?.getContext === 'function';
        let hasExtSettings = false;
        let hasEventSource = false;
        let hasSaveFn = false;
        if (hasGetContext) {
            try {
                const ctx = (window as any).SillyTavern.getContext();
                hasExtSettings = !!ctx?.extensionSettings;
                hasEventSource = !!(ctx?.eventSource && ctx?.eventTypes);
                hasSaveFn = typeof ctx?.saveSettingsDebounced === 'function';
            } catch (e) {
                // getContext 抛异常说明酒馆还没完全初始化
            }
        }
        return { hasTH, hasST, hasGetContext, hasExtSettings, hasEventSource, hasSaveFn };
    };

    while (Date.now() - start < maxWaitMs) {
        const p = probe();
        const status = `TH=${p.hasTH},ST=${p.hasST},GC=${p.hasGetContext},Ext=${p.hasExtSettings},Evt=${p.hasEventSource},Save=${p.hasSaveFn}`;
        if (status !== lastStatus) {
            logDebug_ACU(`[插件启动] 等待就绪... ${status} (${Date.now() - start}ms)`);
            lastStatus = status;
        }

        // 全部就绪：TavernHelper + SillyTavern.getContext() + 核心 API 字段
        if (p.hasTH && p.hasST && p.hasGetContext && p.hasExtSettings && p.hasEventSource && p.hasSaveFn) {
            logDebug_ACU(`[插件启动] 酒馆 API 全部就绪，等待了 ${Date.now() - start}ms（轮询 ${pollCount} 次）`);
            return true;
        }
        pollCount++;
        await new Promise(r => setTimeout(r, 100));
    }

    // 超时降级：如果 TavernHelper + SillyTavern + getContext 都有，即使某些字段暂缺也允许启动
    // （后续 Proxy 每次读取都会重新调 getContext()，可能某些字段稍后会就绪）
    const p = probe();
    if (p.hasTH && p.hasST && p.hasGetContext) {
        logWarn_ACU(`[插件启动] 部分 API 未就绪（${maxWaitMs}ms），但 getContext 可用，降级启动。Ext=${p.hasExtSettings},Evt=${p.hasEventSource},Save=${p.hasSaveFn}`);
        return true;
    }

    logError_ACU(`[插件启动] 等待 TavernHelper 超时（${maxWaitMs}ms），TH=${p.hasTH},ST=${p.hasST},GC=${p.hasGetContext}`);
    return false;
}

/**
 * 插件启动流程
 */
async function extensionMain() {
    // 互斥检测：如果已有实例（油猴脚本或另一个插件）在运行，跳过初始化
    if (checkAndMarkInstance()) {
        logWarn_ACU('[插件启动] 检测到已有实例运行，跳过初始化。请勿同时安装油猴脚本和酒馆插件。');
        return;
    }

    logDebug_ACU('[插件启动] 酒馆插件模式启动，等待 TavernHelper 就绪...');

    const ready = await waitForTavernHelper();
    if (!ready) {
        logError_ACU('[插件启动] 等待 TavernHelper 超时。请确保已安装酒馆助手（JS-Slash-Runner）。');
        return;
    }

    logDebug_ACU('[插件启动] TavernHelper 已就绪，开始初始化...');
    mainInitialize_ACU();
    initVisualizerTemplateAssistantAddon_ACU();
    bootstrapAcuV2();
}

// 插件加载时 DOM 已就绪，直接启动
extensionMain();
