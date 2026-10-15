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
  const w = (el.ownerDocument ?? document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
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

interface TextMatch { start: number; end: number; score: number }

/** Score every candidate with its context; callers decide whether the best hit is unique. */
function exactTextMatches(text: string, a: MdAnchor, baseScore: number): TextMatch[] {
  const found: TextMatch[] = [];
  if (!a.text) return found;
  for (let i = text.indexOf(a.text); i >= 0; i = text.indexOf(a.text, i + 1)) {
    let score = baseScore;
    if (a.blockText === text) score += 100;
    if (a.prefix && text.slice(Math.max(0, i - a.prefix.length), i) === a.prefix) score += 40;
    if (a.suffix && text.slice(i + a.text.length, i + a.text.length + a.suffix.length) === a.suffix) score += 40;
    if (a.prefix && similarContext(text.slice(Math.max(0, i - a.prefix.length), i), a.prefix)) score += 10;
    if (a.suffix && similarContext(text.slice(i + a.text.length, i + a.text.length + a.suffix.length), a.suffix)) score += 10;
    if ((a.blockText === text || a.blockId) && i === a.start) score += 20;
    if (a.blockText && (a.prefix || a.suffix) && score === baseScore) continue;
    found.push({ start: i, end: i + a.text.length, score });
  }
  return found;
}

const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ");

/** 精确和空白容错候选都必须用创建时的上下文消歧。 */
export function textMatches(text: string, a: MdAnchor): TextMatch[] {
  if (!a.text) return [];
  const found = exactTextMatches(text, a, 10);
  const collapsedText = normalizeWhitespace(text);
  const normalizedText = collapsedText.trim();
  const leading = a.text.match(/^\s*/)?.[0] ?? "";
  const trailing = a.text.match(/\s*$/)?.[0] ?? "";
  const normalizedAnchor: MdAnchor = {
    ...a,
    text: normalizeWhitespace(a.text).trim(),
    blockText: a.blockText === undefined ? undefined : normalizeWhitespace(a.blockText).trim(),
    prefix: a.prefix === undefined ? undefined : normalizeWhitespace(a.prefix + leading).trimStart(),
    suffix: a.suffix === undefined ? undefined : normalizeWhitespace(trailing + a.suffix).trimEnd(),
    // Stored offsets refer to the original block, not the newly normalized one.
    start: a.blockText === undefined ? -1 : normalizeWhitespace(a.blockText.slice(0, a.start) + leading).trimStart().length,
  };
  const changed = normalizedText !== text || normalizedAnchor.text !== a.text
    || normalizedAnchor.blockText !== a.blockText || normalizedAnchor.prefix !== a.prefix || normalizedAnchor.suffix !== a.suffix;
  if (changed && normalizedAnchor.text.length >= 2) {
    const starts: number[] = [], ends: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const start = i;
      if (/\s/.test(text[i])) while (i + 1 < text.length && /\s/.test(text[i + 1])) i++;
      starts.push(start); ends.push(i + 1);
    }
    const trimOffset = collapsedText.length - collapsedText.trimStart().length;
    const byRange = new Map(found.map(match => [`${match.start}:${match.end}`, match]));
    for (const match of exactTextMatches(normalizedText, normalizedAnchor, 0)) {
      const start = starts[match.start + trimOffset], end = ends[match.end - 1 + trimOffset];
      const key = `${start}:${end}`;
      const existing = byRange.get(key);
      if (existing) existing.score = Math.max(existing.score, match.score);
      else {
        const candidate = { start, end, score: match.score };
        found.push(candidate); byRange.set(key, candidate);
      }
    }
  }
  if (found.length) return found;
  // A quote with rejected context must not reappear through punctuation stripping.
  if (text.includes(a.text) || normalizedText.includes(normalizedAnchor.text)) return [];
  const fallback = !a.blockText ? looseRange(text, a.text) : null;
  return fallback ? [{ ...fallback, score: 0 }] : [];
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
  const doc = block.ownerDocument;
  const w = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
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
    const r = doc.createRange();
    r.setStart(node, s);
    r.setEnd(node, e);
    const span = doc.createElement("span");
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
    const frag = host.ownerDocument.createDocumentFragment();
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
export function selectionToMdAnchor(fallbackSel?: string, doc: Document = document): { anchor: MdAnchor; rect: DOMRect } | null {
  const sel = (doc.defaultView ?? window).getSelection();
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
