import type { MarkdownView } from "obsidian";

export function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  const d = ((...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  }) as ((...a: A) => void) & { cancel: () => void };
  d.cancel = () => { if (t) clearTimeout(t); t = null; };
  return d;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

export function fmtStamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 读取 MarkdownView 当前模式（兼容新旧 API）。
 * 注意：新版 API 中实时预览（Live Preview）的 getMode() 也返回 "source"，
 * 且无公开探测接口——用行内渲染元素做启发式判定（纯源码模式只有 cm token span，
 * 不会产生 strong/em/a/code 等真实元素）。
 */
export function mdViewMode(view: MarkdownView): "source" | "livepreview" | "preview" {
  const v = view as unknown as { getMode?: () => string; previewMode?: boolean };
  let m = "";
  if (typeof v.getMode === "function") {
    try { m = v.getMode(); } catch { /* ignore */ }
  }
  if (m === "preview") return "preview";
  if (m === "livepreview") return "livepreview";
  const state = view.getState();
  if (m === "source" && typeof state.source === "boolean") return state.source ? "source" : "livepreview";
  // 模式类（当前 Obsidian 版本按实际模式设置）：最直接的判断依据，
  // 无需从正文格式猜。is-source-mode 优先——显式源码模式不能被正文启发式误判为 LP
  const host = view.contentEl;
  const hasCls = (cls: string) => host.classList.contains(cls) || !!host.querySelector(`.${cls}`);
  if (hasCls("is-source-mode")) return "source";
  if (hasCls("is-live-preview")) return "livepreview";
  if (m === "source") {
    const dom = host.querySelector<HTMLElement>(".cm-content");
    // 无模式类的旧版本回退：任一渲染产物出现在 CM 行里 → 实际是 Live Preview。
    // 覆盖内联格式 / 标题 / 表格 / 图片 / 脚注 / 数学 / 嵌入。
    // 已知局限：正文完全无格式（纯文本行）的文档无法据此判别，仍按源码处理
    if (dom?.querySelector(
      ".cm-line strong, .cm-line em, .cm-line a, .cm-line code, .cm-line .internal-embed, .cm-line iframe, " +
      ".cm-line h1, .cm-line h2, .cm-line h3, .cm-line h4, .cm-line h5, .cm-line h6, " +
      ".cm-line table, .cm-line img, .cm-line sup, .cm-line .math"
    )) {
      return "livepreview";
    }
    return "source";
  }
  return v.previewMode ? "preview" : "source";
}

/**
 * 把源码模式的选中文本近似转换为渲染层纯文本，
 * 用于源码模式建批注时的锚点文本（渲染层匹配依据）。
 */
export function sourceToRenderedApprox(s: string): string {
  return s
    .replace(/^\s*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+|>+\s?)/, "")  // 行首块标记（标题/列表/引用）
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")                    // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")                 // 链接
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")           // wikilink（渲染显示别名）
    .replace(/\[\[([^\]]+)\]\]/g, "$1")                      // wikilink
    .replace(/`([^`]*)`/g, "$1")                             // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1");
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
