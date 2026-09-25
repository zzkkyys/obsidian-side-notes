import { similarContext } from "./anchor-context";
import { markerBackground } from "./highlight-style";
import type { MdAnchor } from "./types";

const UI_SELECTOR = ".gloss-card,.gloss-create,.gloss-bubble,.gloss-pill,.gloss-pdf-layer";

/** 无 data-block-id 的旧版本 Obsidian：渲染回退与创建回退共用的块选择器 */
export const GENERIC_BLOCK_PREVIEW = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th";
export const GENERIC_BLOCK_EDITOR = ".cm-line";

/**
 * 从节点向上找最近的块元素：优先带 data-block-id 的块；
 * 找不到时（旧版本 Obsidian 不给块分配 ID）回退到 fallbackSel 命中的最近祖先块。
 */
export function findBlockEl(from: Node | null, fallbackSel?: string): HTMLElement | null {
  let n: Node | null = from;
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement;
      if (el.closest?.(UI_SELECTOR)) return null; // 落在 Gloss 自己的 UI 上
      if (el.hasAttribute?.("data-block-id")) return el;
      if (fallbackSel && (el as Element).matches?.(fallbackSel)) return el;
    }
    n = n.parentElement;
  }
  return null;
}

/** 块内纯文本（跳过 Gloss 自身 UI 的文本节点） */
export function blockPlainText(el: HTMLElement): string {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let out = "";
  let n: Node | null;
  while ((n = w.nextNode())) {
    if ((n.parentElement as HTMLElement | null)?.closest?.(UI_SELECTOR)) continue;
    out += n.nodeValue ?? "";
  }
  return out;
}

export interface LocatedAnchor {
  block: HTMLElement;
  start: number;
  end: number;
}

/**
 * 渲染时锚点定位：
 * 1) blockId 命中 + 坐标处文本校验
 * 2) 同块内文本搜索（精确 → 空白容错 → 去标点宽松匹配）
 * 3) 全文档块内搜索
 * 4) 通用块回退：Obsidian 未给块分配 data-block-id 时
 *    （块 ID 按需生成），按 genericSelector 扫内容块，取最短文本命中块。
 * 全失败返回 null（orphan）。
 */
export function locateAnchor(host: HTMLElement, a: MdAnchor, genericSelector?: string): LocatedAnchor | null {
  if (!a.text) return null;
  const selectors = ["[data-block-id]", genericSelector].filter(Boolean).join(",");
  const hits: Array<LocatedAnchor & { score: number }> = [];
  for (const el of Array.from(host.querySelectorAll<HTMLElement>(selectors))) {
    if (el.closest(UI_SELECTOR + ",.gloss-margin-layer,.mod-header,.metadata-container,.inline-title")) continue;
    const text = blockPlainText(el);
    const sameBlock = !!a.blockId && el.getAttribute("data-block-id") === a.blockId;
    for (const match of textMatches(text, a)) {
      hits.push({ block: el, ...match, score: match.score + (sameBlock ? 1000 : 0) });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  if (!hits.length) return null;
  const tied = hits.filter(h => h.score === hits[0].score);
  // 同一选区可能同时属于 p 与外层 section；只保留最内层命中。
  const leaves = tied.filter(h => !tied.some(other => other !== h && h.block !== other.block && h.block.contains(other.block)));
  return leaves.length === 1 ? leaves[0] : null; // 歧义不猜：不要高亮另一处同文

}

/** 返回所有精确命中，并用创建时的上下文消除重复文字歧义。 */
export function textMatches(text: string, a: MdAnchor): Array<{ start: number; end: number; score: number }> {
  const found: Array<{ start: number; end: number; score: number }> = [];
  if (!a.text) return found;
  for (let i = text.indexOf(a.text); i >= 0; i = text.indexOf(a.text, i + 1)) {
    let score = 10;
    if (a.blockText === text) score += 100;
    if (a.prefix && text.slice(Math.max(0, i - a.prefix.length), i) === a.prefix) score += 40;
    if (a.suffix && text.slice(i + a.text.length, i + a.text.length + a.suffix.length) === a.suffix) score += 40;
    if (a.prefix && similarContext(text.slice(Math.max(0, i - a.prefix.length), i), a.prefix)) score += 10;
    if (a.suffix && similarContext(text.slice(i + a.text.length, i + a.text.length + a.suffix.length), a.suffix)) score += 10;
    if ((a.blockText === text || a.blockId) && i === a.start) score += 20;
    if (a.blockText && (a.prefix || a.suffix) && score === 10) continue;
    found.push({ start: i, end: i + a.text.length, score });
  }
  if (found.length) return found;
  if (text.includes(a.text)) return []; // 有同文但上下文已不符，不再用宽松匹配绕过校验
  const normalized = normalizedRange(text, a.text);
  // 带上下文的新锚点不使用删标点的猜测匹配。
  const fallback = normalized ?? (!a.blockText ? looseRange(text, a.text) : null);
  return fallback ? [{ ...fallback, score: 0 }] : [];
}

/**
 * 空白/换行容错匹配：把两侧空白序列都折叠成单个空格后查找，
 * 再把命中位置映射回原文坐标。解决源码模式锚点（join 成空格）
 * 与渲染层（保留 \n）不一致导致的 orphan 问题。
 */
function normalizedRange(haystack: string, needle: string): { start: number; end: number } | null {
  const needleN = needle.replace(/\s+/g, " ").trim();
  if (needleN.length < 2) return null;
  let hN = "";
  const map: number[] = []; // hN 下标 -> haystack 下标
  for (let i = 0; i < haystack.length; i++) {
    const ch = haystack[i];
    if (/\s/.test(ch)) {
      if (hN.length === 0 || hN[hN.length - 1] !== " ") {
        hN += " ";
        map.push(i);
      }
    } else {
      hN += ch;
      map.push(i);
    }
  }
  const i = hN.indexOf(needleN);
  if (i < 0) return null;
  const last = i + needleN.length - 1;
  return { start: map[i], end: map[last] + 1 };
}

/**
 * 宽松匹配（最后一级兜底）：把两侧的标点 / Markdown 符号全部剔除，
 * 只留字母、数字、汉字再查找。可吸收列表/标题/引用标记、
 * 直引号 vs 弯引号、加粗残留等差异；命中后映射回原文坐标
 * （高亮范围仍覆盖原始标点）。
 */
function looseRange(haystack: string, needle: string): { start: number; end: number } | null {
  const keep = (c: string) => /\p{L}|\p{N}/u.test(c);
  let hL = "";
  const map: number[] = [];
  for (let i = 0; i < haystack.length; i++) {
    if (keep(haystack[i])) { hL += haystack[i]; map.push(i); }
  }
  let nL = "";
  for (const c of needle) if (keep(c)) nL += c;
  if (nL.length < 4) return null;
  const i = hL.indexOf(nL);
  if (i < 0) return null;
  const last = i + nL.length - 1;
  return { start: map[i], end: map[last] + 1 };
}

/** 把块内 [start,end) 纯文本坐标范围包上高亮 span（跨行内元素时逐文本节点分段包） */
export function wrapRangeInBlock(block: HTMLElement, start: number, end: number, cls: string, annId: string, color?: string): number {
  const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let n: Node | null;
  const targets: Array<[Text, number, number]> = [];
  while ((n = w.nextNode())) {
    if (n.parentElement?.closest(UI_SELECTOR)) continue;
    const text = n.nodeValue ?? "";
    const len = text.length;
    if (end > pos && start < pos + len && !(n.parentElement as HTMLElement | null)?.closest?.(UI_SELECTOR)) {
      targets.push([n as Text, Math.max(0, start - pos), Math.min(len, end - pos)]);
    }
    pos += len;
  }
  let count = 0;
  for (const [node, s, e] of targets) {
    if (s >= e) continue;
    const r = document.createRange();
    r.setStart(node, s);
    r.setEnd(node, e);
    const span = document.createElement("span");
    span.className = cls;
    span.dataset.glossId = annId;
    if (color) {
      span.style.setProperty("--gloss-color", color);
      if (cls.includes("gloss-hl-rough")) span.style.setProperty("--gloss-marker-image", markerBackground(color));
    }
    try {
      r.surroundContents(span);
      count++;
    } catch { /* 跨结构失败则放弃该段 */ }
  }
  return count;
}

/** 解除 host 下所有 Gloss 高亮（幂等渲染的前置） */
export function unwrapAll(host: HTMLElement): void {
  const spans = Array.from(host.querySelectorAll<HTMLElement>(".gloss-hl"));
  for (const s of spans) {
    const parent = s.parentNode;
    if (!parent) continue;
    const frag = document.createDocumentFragment();
    while (s.firstChild) frag.appendChild(s.firstChild);
    parent.replaceChild(frag, s);
  }
  if (spans.length) {
    try { host.normalize(); } catch { /* ignore */ }
  }
}

/**
 * 从当前 DOM 选区构造 Markdown 锚点（预览/实时预览用）。
 * 返回锚点 + 选区 rect（用于浮泡定位）；不在有效块内返回 null。
 */
export function selectionToMdAnchor(fallbackSel?: string): { anchor: MdAnchor; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const first = findBlockEl(range.startContainer, fallbackSel);
  const last = findBlockEl(range.endContainer, fallbackSel);
  if (!first || first !== last) return null;
  const block = first;
  if (!block) return null;

  const pre = range.cloneRange();
  pre.selectNodeContents(block);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const text = range.toString();
  if (!text.trim()) return null;
  return {
    anchor: {
      kind: "md",
      blockId: block.getAttribute("data-block-id") ?? "",
      start,
      end: start + text.length,
      text,
      blockText: blockPlainText(block),
      prefix: blockPlainText(block).slice(Math.max(0, start - 48), start),
      suffix: blockPlainText(block).slice(start + text.length, start + text.length + 48),
    },
    rect,
  };
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\\[\]]/g, "\\$&");
}
