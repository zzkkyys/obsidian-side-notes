import type { GlossEntry, GlossType } from "./types";
import { unwrapAll } from "./anchor";
import { disposeCompsUnder } from "./card";
import type GlossPlugin from "./main";

/**
 * 页边布局表面：
 * - reading: host = .markdown-preview-sizer（不滚动，层内坐标=相对 sizer 顶边）
 * - livepreview: host = .cm-scroller（滚动容器，层坐标需 + scrollTop）
 */
export interface MarginSurface {
  host: HTMLElement;
  layer: HTMLElement;
  /** 元素视口 rect -> 层内文档坐标 top */
  docTop: (rect: DOMRect) => number;
  /** 层内 x 坐标换算基准（host 视口左边） */
  hostLeft: () => number;
  width: () => number;
  availableWidth: () => number;
  readingWidth: () => number;
  docHeight: () => number;
  /** w=null 时移除预留空间 */
  setGutter: (w: number | null) => void;
  /** Align an external card layer with its text host. */
  syncLayer?: () => void;
  /** 清空阅读高亮与卡片层；编辑器 DOM 仍由 CodeMirror 管理。 */
  reset: () => void;
  /** 移除布局拥有的容器、滚动监听和页边留白。 */
  dispose: () => void;
}

class SurfaceImpl implements MarginSurface {
  layer: HTMLElement;
  private layerParent: HTMLElement;
  private viewport: HTMLElement | null = null;
  private onScroll = () => this.syncLayer();
  private onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    const win = this.host.ownerDocument.defaultView ?? window;
    const css = win.getComputedStyle(this.host);
    const lineHeight = parseFloat(css.lineHeight) || (parseFloat(css.fontSize) || 16) * 1.2;
    const dx = event.deltaX * (event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? this.host.clientWidth : 1);
    const dy = event.deltaY * (event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? this.host.clientHeight : 1);
    const canScroll = (position: number, extent: number, viewport: number, delta: number) =>
      delta < 0 ? position > 0 : delta > 0 && position < extent - viewport;
    // Preserve native scrolling inside long cards, textareas and embedded media.
    // Once an inner scroller reaches its edge, hand the gesture to the document.
    const target = event.target as Node | null;
    let el = target?.nodeType === 1 ? target as HTMLElement : target?.parentElement;
    for (; el && el !== this.viewport; el = el.parentElement) {
      const style = win.getComputedStyle(el);
      if ((/^(auto|scroll|overlay)$/.test(style.overflowY) && canScroll(el.scrollTop, el.scrollHeight, el.clientHeight, dy))
        || (/^(auto|scroll|overlay)$/.test(style.overflowX) && canScroll(el.scrollLeft, el.scrollWidth, el.clientWidth, dx))) return;
    }
    const top = Math.max(0, Math.min(this.host.scrollHeight - this.host.clientHeight, this.host.scrollTop + dy));
    const left = Math.max(0, Math.min(this.host.scrollWidth - this.host.clientWidth, this.host.scrollLeft + dx));
    if (top === this.host.scrollTop && left === this.host.scrollLeft) return;
    event.preventDefault();
    this.host.scrollTop = top;
    this.host.scrollLeft = left;
    this.syncLayer();
  };

  constructor(
    public host: HTMLElement,
    private gutterEl: HTMLElement | null,
    private scrollAdjusted: boolean,
  ) {
    host.classList.add("gloss-margin-host");
    // Both rendering engines virtualize their text container. Keep cards outside
    // those containers; a clipped editor overlay must not affect scrollHeight.
    this.layerParent = host.parentElement ?? host;
    this.layerParent.classList.add("gloss-layer-parent");
    this.layerParent.querySelectorAll(":scope > .gloss-margin-layer, :scope > .gloss-margin-viewport").forEach(el => el.remove());
    host.querySelectorAll(":scope > .gloss-margin-layer").forEach(el => el.remove());
    if (scrollAdjusted) {
      this.viewport = this.layerParent.createDiv({ cls: "gloss-margin-viewport" });
      host.addEventListener("scroll", this.onScroll, { passive: true });
      this.viewport.addEventListener("wheel", this.onWheel, { passive: false });
    }
    this.layer = (this.viewport ?? this.layerParent).createDiv({ cls: "gloss-margin-layer" });
    this.layer.style.position = "absolute";
    this.layer.style.left = "0";
    this.layer.style.top = "0";
    this.layer.style.width = "100%";
    this.layer.style.height = "0";
    this.layer.style.pointerEvents = "none";
    const g = this.gutterEl ?? this.host;
    g.classList.remove("gloss-gutter-padded");
    g.style.removeProperty("--gloss-gutter-pad");
    this.syncLayer();
  }

  syncLayer(): void {
    if (this.layerParent === this.host) return;
    const host = this.host.getBoundingClientRect();
    const parent = this.layerParent.getBoundingClientRect();
    // Obsidian centers the readable text sizer within a wider scroller. The
    // gutters belong to that sizer, so cards should align with its edges too.
    const horizontal = this.scrollAdjusted ? this.gutterEl ?? this.host : this.host;
    const bounds = horizontal.getBoundingClientRect();
    const target = this.viewport ?? this.layer;
    target.style.top = `${host.top - parent.top + this.layerParent.scrollTop - this.layerParent.clientTop}px`;
    target.style.left = `${bounds.left - parent.left + this.layerParent.scrollLeft - this.layerParent.clientLeft}px`;
    target.style.width = `${horizontal.clientWidth}px`;
    if (this.viewport) {
      this.viewport.style.height = `${this.host.clientHeight}px`;
      // Horizontal scrolling moves the sizer and its overlay together, while
      // this additional clip prevents cards from escaping the editor viewport.
      const clipLeft = Math.max(0, host.left - bounds.left);
      const clipRight = Math.max(0, bounds.left + horizontal.clientWidth - host.left - this.host.clientWidth);
      this.viewport.style.clipPath = `inset(0 ${clipRight}px 0 ${clipLeft}px)`;
      this.layer.style.transform = `translateY(${-this.host.scrollTop}px)`;
    }
  }

  docTop(rect: DOMRect): number {
    const h = this.host.getBoundingClientRect();
    return rect.top - h.top + (this.scrollAdjusted ? this.host.scrollTop : 0);
  }

  hostLeft(): number {
    return (this.scrollAdjusted ? this.gutterEl ?? this.host : this.host).getBoundingClientRect().left;
  }

  width(): number {
    return (this.scrollAdjusted ? this.gutterEl ?? this.host : this.host).clientWidth;
  }

  availableWidth(): number {
    const viewport = this.scrollAdjusted ? this.host : this.host.parentElement ?? this.host;
    const css = (viewport.ownerDocument.defaultView ?? window).getComputedStyle(viewport);
    return viewport.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0);
  }

  readingWidth(): number {
    const content = this.scrollAdjusted
      ? this.host.querySelector<HTMLElement>(".cm-content") ?? this.gutterEl ?? this.host
      : this.gutterEl ?? this.host;
    const css = (content.ownerDocument.defaultView ?? window).getComputedStyle(content);
    const textWidth = content.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0);
    return Math.max(480, Math.min(700, textWidth));
  }

  docHeight(): number {
    // In the editor only the text sizer defines document height. The SVG and
    // cards are decorative and must never increase the next measured height.
    const content = this.scrollAdjusted ? this.gutterEl ?? this.host : this.host;
    return Math.max(content.scrollHeight, content.clientHeight, this.host.clientHeight) + 40;
  }

  setGutter(w: number | null): void {
    const el = this.gutterEl ?? this.host;
    if (w === null) {
      el.classList.remove("gloss-gutter-padded");
      el.style.removeProperty("--gloss-gutter-pad");
    } else {
      el.style.setProperty("--gloss-gutter-pad", `${Math.max(248, w) + 24}px`);
      el.classList.add("gloss-gutter-padded");
    }
  }

  reset(): void {
    if (!this.scrollAdjusted) unwrapAll(this.host);
    this.layer.empty();
  }

  dispose(): void {
    this.host.removeEventListener("scroll", this.onScroll);
    this.viewport?.removeEventListener("wheel", this.onWheel);
    this.setGutter(null);
    this.host.classList.remove("gloss-margin-host");
    this.layerParent.classList.remove("gloss-layer-parent");
    this.layer.remove();
    this.viewport?.remove();
  }
}

export function getSurface(viewContentEl: HTMLElement, mode: "preview" | "livepreview"): MarginSurface | null {
  if (mode === "preview") {
    const sizer = viewContentEl.querySelector<HTMLElement>(":scope > .markdown-preview-sizer")
      ?? viewContentEl.querySelector<HTMLElement>(".markdown-preview-sizer")
      ?? viewContentEl;
    return new SurfaceImpl(sizer, sizer, false);
  }
  const scroller = viewContentEl.querySelector<HTMLElement>(".cm-scroller") ?? viewContentEl;
  const cmSizer = viewContentEl.querySelector<HTMLElement>(".cm-sizer") ?? null;
  // Without the editor sizer there is no safe place to reserve card gutters.
  if (!cmSizer || !scroller.parentElement) return null;
  return new SurfaceImpl(scroller, cmSizer, true);
}

// ---------- 布局项与算法 ----------

export interface LayoutItem {
  entry: GlossEntry;
  type: GlossType;
  hlEl: HTMLElement;
  side: "left" | "right";
  /** 高亮在层内坐标 */
  hlTop: number;
  hlH: number;
  hlLeft: number;
  hlRight: number;
  cardEl: HTMLElement | null;
  cardTop: number;
  cardH: number;
  active: boolean;
}

export interface MarginLayout {
  items: LayoutItem[];
  surface: MarginSurface;
  updateAnchors: (placed: Array<{ entry: GlossEntry; el: HTMLElement; type: GlossType }>, validIds?: ReadonlySet<string>) => void;
  observeCard: (card: HTMLElement, previous?: HTMLElement) => void;
  refresh: () => void;
  dispose: () => void;
}

/**
 * 宽屏页边布局：
 * - side 按高亮中点相对 host 中轴判定
 * - 每侧按锚点 top 排序后正向 sweep：cardTop = max(锚点中点-24, 上一张底边+10)，保证不重叠
 * - 单条 SVG 覆盖层画同色贝塞尔连线
 */
export function buildMarginLayout(plugin: GlossPlugin, surface: MarginSurface, placed: Array<{ entry: GlossEntry; el: HTMLElement; type: GlossType }>, buildCard: (e: GlossEntry, t: GlossType) => HTMLElement): MarginLayout {
  const marginW = plugin.settings.marginWidth;
  const cardW = Math.max(240, marginW - 8);
  const hostLeft = surface.hostLeft();
  const W = surface.width();

  const items: LayoutItem[] = [];
  for (const p of placed) {
    const r = p.el.getBoundingClientRect();
    const top = surface.docTop(r);
    const left = r.left - hostLeft;
    const right = r.right - hostLeft;
    const side: "left" | "right" = (left + right) / 2 < W / 2 ? "left" : "right";
    items.push({
      entry: p.entry,
      type: p.type,
      hlEl: p.el,
      side,
      hlTop: top,
      hlH: r.height,
      hlLeft: left,
      hlRight: right,
      cardEl: null,
      cardTop: 0,
      cardH: 0,
      active: true,
    });
  }

  const layer = surface.layer;
  layer.empty();

  // 先建卡片（高度异步渲染，RO 会再触发 apply）
  for (const it of items) {
    const card = buildCard(it.entry, it.type);
    card.style.width = `${cardW}px`;
    card.style.pointerEvents = "auto";
    card.style.position = "absolute";
    layer.appendChild(card);
    it.cardEl = card;
  }

  const apply = () => {
    surface.syncLayer?.();
    const W2 = surface.width();
    for (const it of items) {
      // Preview virtualization can detach or hide an anchor before updateAnchors runs.
      // Its empty rect is not a document position; retain the last valid geometry.
      if (!it.active || !surface.host.contains(it.hlEl) || !it.hlEl.getClientRects().length) continue;
      const rect = it.hlEl.getBoundingClientRect();
      it.hlTop = surface.docTop(rect); it.hlH = rect.height;
      it.hlLeft = rect.left - surface.hostLeft(); it.hlRight = rect.right - surface.hostLeft();
    }
    for (const side of ["left", "right"] as const) {
      const list = items.filter((i) => i.side === side).sort((a, b) => a.hlTop - b.hlTop);
      let prevBottom = -16;
      for (const it of list) {
        const h = it.cardEl?.offsetHeight ?? 80;
        it.cardH = h;
        const top = Math.max(it.hlTop + it.hlH / 2 - 24, prevBottom + 10, 4);
        it.cardTop = top;
        if (it.cardEl) {
          it.cardEl.style.top = `${top}px`;
          it.cardEl.style.left = side === "left" ? "4px" : `calc(100% - ${cardW + 4}px)`;
          it.cardEl.classList.toggle("gloss-card-left", side === "left");
          it.cardEl.classList.toggle("gloss-card-right", side === "right");
        }
        prevBottom = top + h;
      }
    }
    drawConnectors(surface, items, W2);
  };

  function drawConnectors(s: MarginSurface, list: LayoutItem[], W2: number) {
    let svg = s.layer.querySelector<SVGSVGElement>("svg.gloss-connectors");
    if (!svg) {
      svg = s.layer.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("gloss-connectors");
      s.layer.appendChild(svg);
    }
    svg.setAttribute("width", String(W2));
    svg.setAttribute("height", String(s.docHeight()));
    svg.style.position = "absolute";
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.pointerEvents = "none";
    svg.replaceChildren();
    for (const it of list) {
      // Offscreen cards keep their cached document position, so keep their connector too.
      if (!it.cardEl) continue;
      const y1 = it.hlTop + it.hlH / 2;
      const x1 = it.side === "left" ? it.hlLeft : it.hlRight;
      const y2 = it.cardTop + it.cardH / 2;
      const x2 = it.side === "left" ? cardW + 4 : W2 - cardW - 4;
      const c = Math.max(24, Math.abs(x2 - x1) * 0.45);
      const cx1 = it.side === "left" ? x1 + c : x1 - c;
      const cx2 = it.side === "left" ? x2 - c : x2 + c;
      const path = s.layer.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${y1.toFixed(1)}, ${cx2.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`);
      path.setAttribute("stroke", /^#[\da-f]{3}([\da-f]{3})?$/i.test(it.type.color) ? it.type.color : "#8a8f98");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("fill", "none");
      path.setAttribute("opacity", "0.5");
      svg.appendChild(path);
    }
  }

  apply();

  // 卡片内容异步渲染 / 高度变化 → 重排（仅重算位置，不重建）
  let ro: ResizeObserver | null = null;
  let roTimer: ReturnType<typeof setTimeout> | null = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => {
      if (roTimer) return;
      roTimer = setTimeout(() => {
        roTimer = null;
        if (!layer.isConnected) return;
        apply();
      }, 80);
    });
    for (const it of items) if (it.cardEl) ro.observe(it.cardEl);
    ro.observe(surface.host);
    if (surface.host.parentElement) ro.observe(surface.host.parentElement);
  }

  const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(entries => {
    for (const entry of entries) entry.target.classList.toggle("gloss-flow-paused", !entry.isIntersecting);
  }, { root: surface.host?.parentElement ?? null, rootMargin: "80px" }) : null;
  const observeCard = (card: HTMLElement, previous?: HTMLElement) => { if (previous) { ro?.unobserve(previous); io?.unobserve(previous); } ro?.observe(card); io?.observe(card); };
  for (const item of items) if (item.cardEl) observeCard(item.cardEl);

  return {
    observeCard,
    refresh: apply,
    items,
    surface,
    updateAnchors: (placed, validIds) => {
      // A virtualized anchor remains valid while offscreen. Only an explicit
      // full-document ID set can distinguish it from a deleted/unresolved note.
      if (validIds) {
        for (let index = items.length - 1; index >= 0; index--) {
          const item = items[index];
          if (validIds.has(item.entry.note.id)) continue;
          if (item.cardEl) {
            ro?.unobserve(item.cardEl);
            io?.unobserve(item.cardEl);
            disposeCompsUnder(item.cardEl);
            item.cardEl.remove();
          }
          items.splice(index, 1);
        }
      }
      const visible = new Map(placed.map(p => [p.entry.note.id, p]));
      for (const it of items) {
        const p = visible.get(it.entry.note.id);
        it.active = !!p;
        // Obsidian may remove a virtual block one frame before inserting its replacement.
        // Keep the card at its last known document coordinates rather than flashing it off.
        if (it.cardEl) it.cardEl.style.visibility = "";
        if (p) { it.hlEl = p.el; visible.delete(it.entry.note.id); }
      }
      for (const p of visible.values()) {
        const rect = p.el.getBoundingClientRect();
        const card = buildCard(p.entry, p.type);
        card.style.width = `${cardW}px`;
        card.style.pointerEvents = "auto";
        card.style.position = "absolute";
        layer.appendChild(card);
        items.push({ entry: p.entry, type: p.type, hlEl: p.el,
          side: (rect.left + rect.right) / 2 - surface.hostLeft() < surface.width() / 2 ? "left" : "right",
          hlTop: 0, hlH: 0, hlLeft: 0, hlRight: 0, cardEl: card, cardTop: 0, cardH: 0, active: true });
        observeCard(card);
      }
      apply();
    },
    dispose: () => {
      io?.disconnect();
      if (ro) ro.disconnect();
      if (roTimer) clearTimeout(roTimer);
      for (const it of items) if (it.cardEl) disposeCompsUnder(it.cardEl);
      layer.remove();
      surface.dispose?.();
    },
  };
}
