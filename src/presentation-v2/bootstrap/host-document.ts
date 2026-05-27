/**
 * host-document — 解析"宿主"窗口与文档（D15.1）
 *
 * 酒馆助手前端可能跑在楼层 iframe 内，此时 `document.body` 是 iframe 内部，
 * 用户可见的酒馆主页面其实是 `window.parent.document`。新 UI 的根节点、
 * 主题 <style>、SFC 样式注入都必须挂到同一个 host document，否则会出现
 * "console marker 正常但页面无内容"。
 *
 * 解析规则：
 * 1. window.parent 存在且 !== window，且能访问 parent.document → host
 * 2. 否则（顶层窗口或跨域不可访问）→ 当前 window/document
 * 3. 全程 try/catch；跨域抛错时降级到当前文档并打印可检索 warning
 */
import { logWarn_ACU } from '../../shared/utils';

const PARENT_PROBE_MARKER = '[ACU-V2] host-document parent probe';

export type HostDocumentSource = 'parent-document' | 'current-document';

export interface ResolvedHost {
  window: Window;
  document: Document;
  source: HostDocumentSource;
}

let cachedHost: ResolvedHost | null = null;

function probeParent(): ResolvedHost | null {
  try {
    if (typeof window === 'undefined') return null;
    const parent = window.parent;
    if (!parent || parent === window) return null;
    const parentDoc = parent.document;
    if (!parentDoc || !parentDoc.body) return null;
    return { window: parent as Window, document: parentDoc, source: 'parent-document' };
  } catch (err) {
    logWarn_ACU(`${PARENT_PROBE_MARKER}: parent inaccessible (likely cross-origin), falling back. ${(err as Error)?.message ?? err}`);
    return null;
  }
}

/**
 * 解析并缓存 host window/document。后续重复调用直接返回缓存。
 *
 * 缓存原因：jsdom 测试场景里我们会 defineProperty 修改 window.parent，
 * 但运行时 host 不会变；缓存避免重复 try/catch 噪音。
 * 测试通过 __resetHostDocumentCacheForTests 清缓存。
 */
export function resolveAcuHost(): ResolvedHost {
  if (cachedHost) return cachedHost;
  const fromParent = probeParent();
  if (fromParent) {
    cachedHost = fromParent;
    return cachedHost;
  }
  cachedHost = {
    window,
    document: window.document,
    source: 'current-document',
  };
  return cachedHost;
}

export function getAcuHostWindow(): Window {
  return resolveAcuHost().window;
}

export function getAcuHostDocument(): Document {
  return resolveAcuHost().document;
}

export function getAcuHostSource(): HostDocumentSource {
  return resolveAcuHost().source;
}

/**
 * 仅供测试使用：重置内部缓存，让后续 resolveAcuHost 重新探测。
 */
export function __resetHostDocumentCacheForTests(): void {
  cachedHost = null;
}
