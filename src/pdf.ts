import { Notice, type TAbstractFile } from "obsidian";
import type GlossPlugin from "./main";
import { GlossBubble, SelectionPill } from "./popover";
import type { GlossEntry, PdfAnchor } from "./types";

/**
 * PDF 场景（M2，best-effort 挂接 Obsidian 内置 PDF 阅读器）：
 * - 在 canvas 上框选（或点选生成小区域）→ 记录 {page, bbox, text?}
 * - 若能探测到 pdfDocument（PDFDocumentProxy），从文本层抽取覆盖文本
 * - 高亮 = canvas 上层半透明色块，点击弹出气泡卡片
 * 内部结构随 Obsidian 版本可能变化，全部走属性探测，失败不致命。
 */
export class PdfGloss {
  private started = false;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleScan(): void {
    if (!this.plugin.isAlive) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => { this.scanTimer = null; this.scan(); }, 400);
  }
  /** contentEl → 清理函数 + 视图引用（视图关闭 / 插件卸载时释放观察器与事件） */
  private inited = new Map<HTMLElement, { cleanup: () => void; view: PdfViewLike; document: Document }>();

  constructor(private plugin: GlossPlugin) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    const ws = this.plugin.app.workspace;
    ws.onLayoutReady(() => this.scheduleScan());
    this.plugin.registerEvent(ws.on("file-open", () => this.scheduleScan()));
    this.plugin.registerEvent(ws.on("layout-change", () => this.scheduleScan()));
  }

  /** 扫描已打开的 PDF 视图并初始化（幂等） */
  scan(): void {
    if (!this.plugin.settings.pdfEnabled || !this.plugin.isAlive) return;
    // 回收已关闭视图的观察器 / 事件（contentEl 脱离文档）
    for (const [el, rec] of [...this.inited]) {
      if (!el.isConnected || el.ownerDocument !== rec.document) {
        rec.cleanup();
        this.inited.delete(el);
        rec.view.__glossInit = false;
      }
    }
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("pdf")) {
      const view = (leaf as { view?: unknown }).view as PdfViewLike | null;
      if (!view || !view.contentEl) continue;
      if (view.__glossInit) {
        view.__glossRender?.();
        continue;
      }
      this.init(view);
    }
  }

  /** 批注变更后刷新指定文档的 PDF 视图 */
  refresh(docPath: string): void {
    for (const rec of this.inited.values()) {
      if (rec.view.file?.path === docPath) rec.view.__glossRender?.();
    }
  }

  /** 设置开关：关闭时移除所有高亮层并释放监听；打开时重新扫描 */
  setPdfEnabled(on: boolean): void {
    if (!on) {
      this.clearAll();
    } else {
      this.scan();
    }
  }

  /** 插件卸载：释放全部监听并清掉高亮层 */
  dispose(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    this.clearAll();
  }

  private clearAll(): void {
    for (const [el, rec] of [...this.inited]) {
      el.querySelectorAll<HTMLElement>(".gloss-pdf-layer").forEach((n) => n.remove());
      rec.cleanup();
      this.inited.delete(el);
      rec.view.__glossInit = false;
    }
  }

  private init(view: PdfViewLike): void {
    view.__glossInit = true;
    const contentEl = view.contentEl;
    const doc = contentEl.ownerDocument;
    const win = doc.defaultView ?? window;
    const plugin = this.plugin;
    const cleanups: Array<() => void> = [];

    const canvases = () => Array.from(contentEl.querySelectorAll<HTMLCanvasElement>("canvas"));

    const pageOfCanvas = (cv: HTMLCanvasElement): number => {
      const page = Number(cv.closest(".page[data-page-number]")?.getAttribute("data-page-number"));
      // DOM order is not page order when pdf.js only keeps visible canvases.
      return Number.isInteger(page) && page > 0 ? page : 0;
    };

    const ensureLayer = (cv: HTMLCanvasElement): HTMLElement | null => {
      const wrap = cv.parentElement;
      if (!wrap) return null;
      wrap.style.position = "relative";
      let layer = wrap.querySelector<HTMLElement>(":scope > .gloss-pdf-layer");
      if (!layer) {
        layer = wrap.createDiv({ cls: "gloss-pdf-layer" });
      }
      return layer;
    };

    // ---------- 高亮渲染 ----------
    let renderToken = 0;
    let disposed = false; // 视图已回收：异步渲染回来时不得再写 DOM（层会被重建）
    const renderHighlights = () => {
      if (disposed) return;
      const file = view.file;
      if (!file) return;
      const token = ++renderToken;
      void (async () => {
        const store = await plugin.storage.loadDoc(file.path);
        // 等待期间视图可能已被回收（close/setPdfEnabled(false)/插件卸载）：
        // 不核对 disposed 的话，loadDoc 之后仍会把色块写回已清空的 DOM
        if (disposed || token !== renderToken || !plugin.isAlive || !plugin.settings.pdfEnabled
          || !contentEl.isConnected || contentEl.ownerDocument !== doc || view.file?.path !== file.path) return;
        contentEl.querySelectorAll<HTMLElement>(".gloss-pdf-hl").forEach((n) => n.remove());
        for (const e of store.entries) {
          if (e.anchor.kind !== "pdf" || !e.anchor.bbox) continue;
          for (const cv of canvases()) {
            if (pageOfCanvas(cv) !== e.anchor.page) continue;
            const layer = ensureLayer(cv);
            if (!layer) continue;
            const [x0, y0, x1, y1] = e.anchor.bbox;
            const t = plugin.storage.typeOf(e.note.typeId);
            const d = layer.createDiv({ cls: "gloss-pdf-hl" });
            d.dataset.glossId = e.note.id;
            d.style.cssText = `left:${(x0 * 100).toFixed(2)}%;top:${(y0 * 100).toFixed(2)}%;width:${((x1 - x0) * 100).toFixed(2)}%;height:${((y1 - y0) * 100).toFixed(2)}%;--gloss-color:${t.color}`;
            d.onclick = (ev) => {
              ev.stopPropagation();
              ev.preventDefault();
              GlossBubble.show(plugin, e, t, d, store);
            };
          }
        }
      })();
    };
    view.__glossRender = renderHighlights;

    // 翻页 / 缩放 → canvas 重建或尺寸变化 → 重画
    // 注意：我们自己的重画也会改 DOM，必须识别并忽略，否则观察器无限回环
    const isOwnNode = (n: Node): boolean => {
      const el = n.nodeType === Node.ELEMENT_NODE
        ? (n as Element)
        : (n.parentElement as Element | null);
      return !!el?.closest?.(".gloss-pdf-layer, .gloss-pdf-hl, .gloss-pdf-select");
    };
    const mo = new MutationObserver((muts) => {
      const foreign = muts.some((m) => {
        if (!m.addedNodes.length && !m.removedNodes.length) return false;
        const all = Array.from(m.addedNodes).concat(Array.from(m.removedNodes));
        return !all.every(isOwnNode);
      });
      if (!foreign) return;
      for (const cv of canvases()) ensureLayer(cv);
      renderHighlights();
    });
    mo.observe(contentEl, { childList: true, subtree: true });
    cleanups.push(() => mo.disconnect());
    const ro = new ResizeObserver(() => renderHighlights());
    for (const cv of canvases()) ro.observe(cv);
    cleanups.push(() => ro.disconnect());


    // ---------- 框选 / 点选 ----------
    let dragging = false;
    let textStart: { x: number; y: number } | null = null;
    let startPt: { x: number; y: number } | null = null;
    let selBox: HTMLElement | null = null;
    let selLayer: HTMLElement | null = null;
    let selCanvas: HTMLCanvasElement | null = null;

    const onDown = (e: MouseEvent) => {
      if (disposed || !plugin.isAlive || e.button !== 0) return;
      const target = e.target as HTMLElement;
      textStart = null;
      if (!e.altKey) {
        if (target.closest(".textLayer")) textStart = { x: e.clientX, y: e.clientY };
        return;
      }
      if (target.closest(".gloss-pdf-hl")) return;
      const cv = target.closest(".page[data-page-number]")?.querySelector<HTMLCanvasElement>("canvas");
      if (!cv || !pageOfCanvas(cv)) return;
      const layer = ensureLayer(cv);
      if (!layer) return;
      e.preventDefault();
      dragging = true;
      startPt = { x: e.clientX, y: e.clientY };
      selCanvas = cv;
      selLayer = layer;
      selBox = layer.createDiv({ cls: "gloss-pdf-select" });
    };
    const onMove = (e: MouseEvent) => {
      if (!dragging || !selBox || !startPt || !selLayer) return;
      const lr = selLayer.getBoundingClientRect();
      const x0 = Math.min(startPt.x, e.clientX) - lr.left;
      const y0 = Math.min(startPt.y, e.clientY) - lr.top;
      const x1 = Math.max(startPt.x, e.clientX) - lr.left;
      const y1 = Math.max(startPt.y, e.clientY) - lr.top;
      selBox.style.left = `${x0}px`;
      selBox.style.top = `${y0}px`;
      selBox.style.width = `${Math.max(0, x1 - x0)}px`;
      selBox.style.height = `${Math.max(0, y1 - y0)}px`;
    };
    const pill = new SelectionPill(doc);
    const updateSelection = () => {
      pill.hide();
      if (disposed || !plugin.isAlive) return;
        const selection = win.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount || !view.file) return;
        const range = selection.getRangeAt(0);
        const pageFor = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest<HTMLElement>(".page[data-page-number]");
        const pageEl = pageFor(range.startContainer);
        if (!pageEl || !contentEl.contains(pageEl) || pageEl !== pageFor(range.endContainer)) return;
        const cv = pageEl.querySelector<HTMLCanvasElement>("canvas");
        if (!cv) return;
        const page = pageOfCanvas(cv), rect = range.getBoundingClientRect(), bounds = cv.getBoundingClientRect();
        const text = selection.toString().trim();
        if (!page || !text || !bounds.width || !bounds.height || !rect.width || !rect.height) return;
        const unit = (v: number) => Math.max(0, Math.min(1, v));
        const docPath = view.file.path;
        const anchor: PdfAnchor = { kind: "pdf", page, text: text.slice(0, 400), bbox: [
          unit((rect.left - bounds.left) / bounds.width), unit((rect.top - bounds.top) / bounds.height),
          unit((rect.right - bounds.left) / bounds.width), unit((rect.bottom - bounds.top) / bounds.height),
        ] };
        const button = pill.ensureEl();
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => {
          if (disposed || !plugin.isAlive || view.file?.path !== docPath) return;
          pill.hide(); plugin.openPdfCreatePopover(docPath, anchor, rect, doc);
        };
        pill.show(rect);
    };
    doc.addEventListener("selectionchange", updateSelection);
    cleanups.push(() => { doc.removeEventListener("selectionchange", updateSelection); pill.dispose(); });
    const onUp = (e: MouseEvent) => {
      if (!dragging) return; // 原生选区仅显示浮泡，由点击明确创建。
      dragging = false;
      const box = selBox;
      const layer = selLayer;
      const cv = selCanvas;
      const sp = startPt; // 先取再置空：点选时框选 rect 无意义，必须用按下/抬起坐标
      selBox = null; selLayer = null; selCanvas = null;
      startPt = null;
      if (!box || !layer || !cv || !sp) return;
      const lr = layer.getBoundingClientRect();
      box.remove();
      const file = view.file;
      if (!file) return;

      const px0 = Math.min(sp.x, e.clientX);
      const py0 = Math.min(sp.y, e.clientY);
      const px1 = Math.max(sp.x, e.clientX);
      const py1 = Math.max(sp.y, e.clientY);
      let bx = (px0 - lr.left) / lr.width;
      let by = (py0 - lr.top) / lr.height;
      let bw = (px1 - px0) / lr.width;
      let bh = (py1 - py0) / lr.height;
      // 纯点选（未拖动）→ 以点击点为中心生成小区域
      if (bw < 0.008 && bh < 0.008) {
        bw = 0.06; bh = 0.02;
        bx = bx - bw / 2; by = by - bh / 2;
      }
      bx = Math.max(0, bx);
      by = Math.max(0, by);
      bw = Math.min(bw, 1 - bx);
      bh = Math.min(bh, 1 - by);
      const bbox: [number, number, number, number] = [bx, by, bx + bw, by + bh];
      const rect = new DOMRect(px0, py0, Math.max(1, px1 - px0), Math.max(1, py1 - py0));
      const page = pageOfCanvas(cv);
      if (!page) { new Notice("Gloss：无法确认 PDF 页码，未创建批注"); return; }
      const anchor: PdfAnchor = { kind: "pdf", page, text: "", bbox };
      // 尝试抽取覆盖文本（best-effort）
      void (async () => {
        try {
          const pd = view.pdfDocument;
          if (pd) {
            const p = await pd.getPage(page);
            const tc = await p.getTextContent();
            const vp = p.getViewport({ scale: 1 });
            const parts: string[] = [];
            for (const it of tc.items as Array<{ str: string; transform: number[] }>) {
              const x = it.transform[4];
              const y = vp.height - it.transform[5];
              if (x >= bx * vp.width && x <= (bx + bw) * vp.width && y >= by * vp.height && y <= (by + bh) * vp.height) {
                parts.push(it.str);
              }
            }
            anchor.text = parts.join("").trim().slice(0, 400);
          }
        } catch { /* 无文本层则仅区域锚点 */ }
        // 文本抽取是异步的：期间视图可能已切走，不能再用旧视图弹浮层
        if (disposed || !plugin.isAlive || !plugin.settings.pdfEnabled || !contentEl.isConnected || contentEl.ownerDocument !== doc || view.file?.path !== file.path) return;
        plugin.openPdfCreatePopover(file.path, anchor, rect, doc);
      })();
    };

    contentEl.addEventListener("mousedown", onDown, true);
    cleanups.push(() => contentEl.removeEventListener("mousedown", onDown, true));
    // document 级监听不用 registerDomEvent（要随视图提前释放，而它只随卸载释放）
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
    cleanups.push(() => {
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
    });

    this.inited.set(contentEl, {
      view, document: doc,
      cleanup: () => {
        // 先关门闩、作废在途渲染令牌，再拆监听——顺序保证清理后到手的异步渲染直接返回
        disposed = true;
        dragging = false; selBox?.remove(); selBox = null;
        renderToken++;
        view.__glossRender = undefined;
        for (const c of cleanups) { try { c(); } catch { /* ignore */ } }
      },
    });

    renderHighlights();
  }
}

interface PdfViewLike {
  contentEl: HTMLElement;
  file?: TAbstractFile | null;
  /** PDFDocumentProxy（存在则可抽文本） */
  pdfDocument?: {
    getPage: (n: number) => Promise<{
      getViewport: (o: { scale: number }) => { width: number; height: number };
      getTextContent: () => Promise<{ items: unknown[] }>;
    }>;
  } | null;
  /** 单页视图下的当前页码（不同版本属性名可能不同） */
  pdfPage?: number;
  __glossInit?: boolean;
  __glossRender?: () => void;
}

export type { GlossEntry };
