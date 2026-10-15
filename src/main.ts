import { MarkdownView, Menu, Modal, Notice, Plugin, TFile, TFolder, type EventRef } from "obsidian";
import { applyCardStyle } from "./card-style";
import { EditorHighlights, sourceRange } from "./editor";
import { buildCard, closeTypeMenu, disposeCompsUnder, type CardHooks } from "./card";
import { exportDocAnnotations } from "./export";
import { buildMarginLayout, getSurface, type MarginLayout } from "./layout";
import { GENERIC_BLOCK_EDITOR, GENERIC_BLOCK_PREVIEW, unwrapAll, blockPlainText, locateAnchor, selectionToMdAnchor, wrapRangeInBlock } from "./anchor";
import { GlossBubble, SelectionPill, openCreatePopover, dismissCreatePopover } from "./popover";
import { PdfGloss } from "./pdf";
import { GlossSettingTab } from "./settings";
import { GlossStorage } from "./storage";
import { TypeManagerModal } from "./typemanager";
import {
  defaultSettings,
  currentTypeId,
  type Anchor,
  type GlossAttachment,
  type GlossDocStore,
  type GlossEntry,
  type GlossSettings,
  type GlossType,
  type MdAnchor,
} from "./types";
import { debounce, mdViewMode, sourceToRenderedApprox, uuid } from "./util";

const shutdownKey = Symbol.for("gloss.shutdowns");
const runtime = globalThis as unknown as Record<symbol, WeakMap<object, Promise<void>>>;
const shutdowns = runtime[shutdownKey] ?? (runtime[shutdownKey] = new WeakMap());

export default class GlossPlugin extends Plugin {
  settings: GlossSettings = defaultSettings();
  storage = new GlossStorage(this);

  private editorHighlights = new EditorHighlights(this);
  private pills = new Map<Document, SelectionPill>();
  private windowCleanups = new Map<Window, () => void>();
  private layoutOverride: "margin" | "bubble" | null = null;
  private renderTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private renderState = new WeakMap<HTMLElement, { sig: string; at: number }>();
  private sizeObservers = new Map<HTMLElement, ResizeObserver>();
  private readingObservers = new Map<HTMLElement, MutationObserver>();
  private layoutMap = new Map<HTMLElement, MarginLayout>();
  private versionCounter = new Map<string, number>();
  private popoverOpen = false;
  /** 打开中的新建批注浮层（文档重命名时要关掉：它闭包持有旧路径） */
  private createPop: { el: HTMLElement; docPath: string } | null = null;
  private pdf: PdfGloss | null = null;
  private statusEl: HTMLElement | null = null;
  private fileStats = new Map<string, { visible: number; orphan: number; fail?: string }>();
  private lastErrAt = 0;
  /** 渲染竞态令牌：同一 contentEl 上最新的渲染生效，旧的在 await 后作废 */
  private renderSeq = new WeakMap<HTMLElement, number>();
  /** 插件存活标志：卸载后一切异步回调立即退出 */
  private alive = true;

  get isAlive(): boolean { return this.alive; }

  // ================= 生命周期 =================

  async onload(): Promise<void> {
    await shutdowns.get(this.app.vault);
    await this.loadSettings();
    this.storage.plugin = this;
    await this.storage.loadTypes();
    this.storage.onStatusChange = () => this.updateStatus();
    this.addCommand({ id: "resolve-save-problems", name: "处理保存问题", callback: () => this.openSaveProblems() });

    this.registerEditorExtension(this.editorHighlights.extension());
    this.addSettingTab(new GlossSettingTab(this.app, this));
    this.addRibbonIcon("message-square", "Gloss：新建批注", () => void this.cmdCreate());

    // 状态栏诊断：右下角显示当前打开文档的高亮/失效锚点数量
    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText("Gloss 0");
    this.statusEl.title = "Gloss：当前文档批注渲染状态";

    this.addCommand({
      id: "new-annotation",
      name: "新建批注（当前选区）",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }],
      callback: () => void this.cmdCreate(),
    });
    this.addCommand({
      id: "open-annotation-at-cursor",
      name: "打开光标处批注",
      editorCallback: (editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        const path = view.file?.path;
        if (!path) return;
        const store = this.storage.docCacheFor(path);
        if (!store) { new Notice("Gloss：批注仍在加载，请稍后重试"); return; }
        const text = editor.getValue();
        const offset = editor.posToOffset(editor.getCursor());
        const entry = store?.entries.find(e => {
          if (e.anchor.kind !== "md") return false;
          const range = sourceRange(text, e.anchor);
          return range && offset >= range.from && offset < range.to;
        });
        if (!store || !entry) { new Notice("Gloss：请先把光标放到批注高亮内"); return; }
        const mark = Array.from(view.contentEl.querySelectorAll<HTMLElement>(".gloss-hl"))
          .find(el => el.dataset.glossId === entry.note.id);
        GlossBubble.show(this, entry, this.storage.typeOf(entry.note.typeId), mark ?? view.contentEl, store);
      },
    });
    this.addCommand({
      id: "toggle-layout",
      name: "切换布局（页边 ⇄ 气泡）",
      callback: () => {
        this.layoutOverride = this.layoutOverride === null ? "bubble" : this.layoutOverride === "bubble" ? "margin" : null;
        new Notice(
          this.layoutOverride === null ? "Gloss 布局：自动" :
          this.layoutOverride === "margin" ? "Gloss 布局：页边双栏" : "Gloss 布局：气泡",
        );
        this.refreshAll();
      },
    });
    this.addCommand({
      id: "manage-types",
      name: "管理批注类型",
      callback: () => new TypeManagerModal(this.app, this).open(),
    });
    this.addCommand({
      id: "export-annotations",
      name: "导出批注（当前文档）",
      callback: () => void this.cmdExport(),
    });

    // ---- 渲染触发 ----
    this.registerMarkdownPostProcessor((_el, ctx) => {
      if (ctx.sourcePath) this.schedule(ctx.sourcePath);
    });
    // 阅读视图由 postprocessor 驱动；编辑器高亮由 CodeMirror ViewPlugin 管理。
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.scheduleAll();
      this.pdf?.scan();
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleAll()));

    // ---- 文件变动 ----
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
      if (!oldPath.startsWith(".gloss/")) void this.storage.moveAttachments(oldPath, f.path, f instanceof TFolder)
        .then(() => { if (this.alive) this.refreshAll(); }).catch(error => new Notice(`Gloss：附件路径更新失败，原引用已保留：${String(error)}`));
      if (f instanceof TFolder) {
        const prefix = f.path + "/";
        for (const file of this.app.vault.getFiles()) if (file.path.startsWith(prefix) && /\.(md|pdf)$/i.test(file.path)) {
          const old = oldPath + file.path.slice(f.path.length);
          if (this.createPop?.docPath === old) this.closeCreatePopover();
          if (GlossBubble.docPath === old) GlossBubble.close();
          void this.renameDocData(old, file.path);
        }
        return;
      }
      if (!(f instanceof TFile) || !oldPath || !/\.(md|pdf)$/i.test(oldPath)) return;
      if (oldPath.startsWith(".gloss/")) { this.storage.invalidate(); return; }
      // 关掉持有旧路径的浮层：迁移提交后旧路径是全新身份，
      // 新建浮层从旧路径保存会写到旧路径的幽灵文件，气泡里的内存改动会静默丢失；
      // 关掉后用户在重命名后的文档上重新打开
      if (this.createPop?.docPath === oldPath) this.closeCreatePopover();
      if (GlossBubble.docPath === oldPath) GlossBubble.close();
      void this.renameDocData(oldPath, f.path);
      this.scheduleAll();
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      if (this.createPop?.docPath === f.path) this.closeCreatePopover();
      if (GlossBubble.docPath === f.path) GlossBubble.close();
      if (f instanceof TFile && /\.(md|pdf)$/i.test(f.path)) void this.storage.archiveDeleted(f.path).catch(error => new Notice(String(error)));
      else if (f instanceof TFolder) void this.storage.listAll().then(docs => Promise.all(docs.filter(d => d.path.startsWith(f.path + "/")).map(d => this.storage.archiveDeleted(d.path)))).catch(error => new Notice(String(error)));
      this.scheduleAll();
    }));
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f.path.startsWith(".gloss/")) this.storage.invalidate();
    }));

    // Hidden annotation files require adapter reads; polling does not depend on undocumented events.
    this.registerInterval(window.setInterval(() => this.checkExternal(), 5000));

    // Each Obsidian window owns its selection, viewport, and popup DOM.
    this.watchWindow(window);
    this.registerEvent(this.app.workspace.on("window-open", (_container, win) => this.watchWindow(win)));
    this.registerEvent(this.app.workspace.on("window-close", (_container, win) => {
      this.windowCleanups.get(win)?.();
      GlossBubble.closeForDocument(win.document);
      closeTypeMenu(win.document);
      if (this.createPop?.el.ownerDocument === win.document) this.closeCreatePopover();
    }));
    this.registerEvent(this.app.workspace.on("css-change", () => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (!(leaf.view instanceof MarkdownView)) continue;
        const state = this.renderState.get(leaf.view.contentEl); if (state) state.at = 0;
      }
      this.scheduleAll();
    }));

    // ---- 右键菜单（编辑器：源码/实时预览；阅读视图走选区浮泡） ----
    this.registerEvent(this.app.workspace.on("editor-menu", (menu: Menu, editor) => {
      try {
        if (editor.getSelection().trim()) {
          menu.addItem((i) => {
            i.setTitle("新建批注").setIcon("message-square")
              .onClick(() => void this.cmdCreate());
          });
        }
      } catch { /* ignore */ }
    }));

    // ---- 粗糙边缘高亮的全局 SVG 滤镜（只作用于高亮背景层） ----
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("aria-hidden", "true");
    svg.style.position = "absolute";
    svg.innerHTML =
      '<filter id="gloss-rough" x="-5%" y="-25%" width="110%" height="150%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.02 0.08" numOctaves="3" seed="7" result="noise"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="noise" scale="7" xChannelSelector="R" yChannelSelector="G"/>' +
      "</filter>";
    document.body.appendChild(svg);
    this.register(() => svg.remove());

    // ---- PDF 场景 ----
    this.pdf = new PdfGloss(this);
    this.pdf.start();

    this.app.workspace.onLayoutReady(() => {
      if (!this.alive) return;
      for (const leaf of this.app.workspace.getLeavesOfType("markdown").concat(this.app.workspace.getLeavesOfType("pdf"))) {
        const win = leaf.view.containerEl.ownerDocument.defaultView;
        if (win) this.watchWindow(win);
      }
      this.scheduleAll();
    });
  }

  async onunload(): Promise<void> {
    this.alive = false;
    this.closeCreatePopover();
    closeTypeMenu();
    this.storage.onStatusChange = () => {};
    const flushed = this.storage.flushAll();
    shutdowns.set(this.app.vault, flushed);
    for (const t of this.renderTimers.values()) clearTimeout(t);
    this.renderTimers.clear();
    this.pdf?.dispose();
    for (const observer of this.sizeObservers.values()) observer.disconnect();
    this.sizeObservers.clear();
    for (const observer of this.readingObservers.values()) observer.disconnect();
    this.readingObservers.clear();

    // 页边布局：卸载卡片 Component → 移除卡片层/解包高亮/清预留 padding，
    // 并断开 host 上的气泡点击委托（handler 持有 this，不摘除会形成 host→插件的引用链）
    for (const layout of this.layoutMap.values()) {
      try {
        layout.dispose();
        layout.surface.reset();
        layout.surface.setGutter(null);
      } catch { /* ignore */ }
    }
    this.layoutMap.clear();
    // WeakMap 不可枚举：对仍打开的 Markdown 视图按已知 host 选择器摘除委托。
    // handler 闭包持有 this，不摘除会形成 host→插件引用链（视图 DOM 活得比插件久时）
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const v = leaf.view;
      if (!(v instanceof MarkdownView)) continue;
      const ce = v.contentEl;
      unwrapAll(ce);
      ce.querySelectorAll(".gloss-margin-layer").forEach(el => el.remove());
      // getSurface 的 host 候选（含回退到 contentEl 本身）
      for (const h of [
        ce.querySelector<HTMLElement>(".cm-scroller"),
        ce.querySelector<HTMLElement>(".markdown-preview-sizer"),
        ce,
      ]) {
        if (!h) continue;
        const handler = this.bubbleHandlers.get(h);
        if (handler) {
          h.removeEventListener("click", handler);
          this.bubbleHandlers.delete(h);
          this.bubbleDoc.delete(h);
        }
      }
    }
    for (const cleanup of [...this.windowCleanups.values()]) cleanup();
    GlossBubble.close();
    await flushed;
  }

  private checkExternal(): void {
    if (!this.alive) return;
    this.storage.setActivePaths(this.app.workspace.getLeavesOfType("markdown").concat(this.app.workspace.getLeavesOfType("pdf"))
      .map(leaf => (leaf.view as { file?: TFile }).file?.path).filter((path): path is string => !!path));
    void this.storage.checkExternalChanges().then(changed => { if (changed && this.alive) this.refreshAll(); });
  }

  private watchWindow(win: Window): void {
    if (!this.alive || this.windowCleanups.has(win)) return;
    const doc = win.document;
    const pill = new SelectionPill(doc);
    this.pills.set(doc, pill);
    const button = pill.ensureEl();
    const resize = debounce(() => this.scheduleAll(), 200);
    const selection = () => this.updatePill(doc);
    const scroll = () => pill.hide();
    const focus = () => this.checkExternal();
    const down = (event: MouseEvent) => event.preventDefault();
    const click = () => void this.cmdCreate();
    win.addEventListener("resize", resize);
    win.addEventListener("focus", focus);
    win.addEventListener("scroll", scroll, true);
    doc.addEventListener("selectionchange", selection);
    button.addEventListener("mousedown", down);
    button.addEventListener("click", click);
    this.windowCleanups.set(win, () => {
      resize.cancel();
      win.removeEventListener("resize", resize);
      win.removeEventListener("focus", focus);
      win.removeEventListener("scroll", scroll, true);
      doc.removeEventListener("selectionchange", selection);
      button.removeEventListener("mousedown", down);
      button.removeEventListener("click", click);
      pill.dispose();
      this.pills.delete(doc);
      this.windowCleanups.delete(win);
    });
  }

  /** 注册 d.ts 中缺少类型重载的 workspace 事件（运行时均存在） */
  private wsEvent(name: string, cb: (...data: unknown[]) => void): EventRef {
    const ws = this.app.workspace as unknown as {
      on: (n: string, cb: (...data: unknown[]) => unknown) => EventRef;
    };
    return ws.on(name, cb);
  }

  // ================= 设置 =================

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(defaultSettings(), await this.loadData());
    this.settings.defaultTypeId = currentTypeId(this.settings.defaultTypeId);
    this.settings.marginWidth = Math.max(248, this.settings.marginWidth);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Style changes do not rebuild cards or disturb drafts/focus. */
  updateCardStyles(): void {
    for (const doc of this.pills.keys()) for (const el of Array.from(doc.querySelectorAll<HTMLElement>(".gloss-card[data-gloss-type], .gloss-bubble[data-gloss-type]"))) {
      applyCardStyle(el, this.settings, this.storage.typeOf(el.dataset.glossType!));
    }
  }


  // ================= 渲染管线 =================

  private schedule(path: string): void {
    if (this.renderTimers.has(path)) clearTimeout(this.renderTimers.get(path)!);
    this.renderTimers.set(path, setTimeout(() => {
      this.renderTimers.delete(path);
      if (!this.alive) return;
      for (const view of this.mdViewsFor(path)) void this.renderView(view, false);
    }, 150));
  }

  private scheduleAll(): void {
    for (const [host, observer] of this.sizeObservers) {
      if (!host.isConnected) { observer.disconnect(); this.sizeObservers.delete(host); }
    }
    for (const [host, observer] of this.readingObservers) {
      if (!host.isConnected) { observer.disconnect(); this.readingObservers.delete(host); }
    }
    // 回收已脱离文档的布局（卡片 Component / ResizeObserver）
    for (const [host, layout] of [...this.layoutMap]) {
      if (!host.isConnected) {
        layout.dispose();
        this.layoutMap.delete(host);
      }
    }
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) this.schedule(view.file.path);
    }
  }

  refreshDoc(docPath: string): void {
    for (const view of this.mdViewsFor(docPath)) void this.renderView(view, true);
    this.pdf?.refresh(docPath);
  }

  refreshAll(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) void this.renderView(view, true);
    }
    this.pdf?.scan();
  }

  private mdViewsFor(path: string): MarkdownView[] {
    const out: MarkdownView[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) out.push(view);
    }
    return out;
  }

  private mdViewFor(path: string): MarkdownView | null {
    return this.mdViewsFor(path)[0] ?? null;
  }

  private contentSig(view: MarkdownView): string {
    const f = view.file;
    const mode = mdViewMode(view);
    // 布局相关参数也进签名：防自激回环只拦"内容没变"的重复渲染，
    // 改布局/宽度/高亮样式必须能穿透 1.5s 窗口。
    // 两个宽度都要：window 宽度决定断点（设置项按视口定义）；
    // 视图实际宽度决定 canMargin——拖分屏分隔线/开侧栏时窗口宽度不变，
    // 只有纳入视图宽度，后续任何一次渲染才会重估页边可用性
    return [
      f?.path,
      f?.stat?.mtime ?? 0,
      f?.stat?.size ?? 0,
      this.versionCounter.get(f?.path ?? "") ?? 0,
      mode,
      (view.contentEl.ownerDocument.defaultView ?? window).innerWidth,
      view.contentEl.clientWidth,
      this.layoutOverride ?? this.settings.layoutMode,
      this.settings.highlightStyle,
      this.settings.marginWidth,
    ].join(":");
  }

  /** 核心：把一个 MarkdownView 渲染成 Gloss 高亮 + 页边/气泡 */
  async renderView(view: MarkdownView, force: boolean): Promise<void> {
    if (!this.alive) return;
    const file = view.file;
    if (!file || !view.contentEl.isConnected || view.contentEl.clientWidth === 0) return;
    this.watchWindow(view.contentEl.ownerDocument.defaultView ?? window);
    // 每次渲染都先作废旧渲染（令牌）
    const seq = (this.renderSeq.get(view.contentEl) ?? 0) + 1;
    this.renderSeq.set(view.contentEl, seq);

    if (!this.sizeObservers.has(view.contentEl) && typeof ResizeObserver !== "undefined") {
      let width = -1;
      const observer = new ResizeObserver(() => {
        if (!this.alive || !view.file || width === view.contentEl.clientWidth) return;
        width = view.contentEl.clientWidth;
        const state = this.renderState.get(view.contentEl); if (state) state.at = 0;
        this.schedule(view.file.path);
      });
      observer.observe(view.contentEl); this.sizeObservers.set(view.contentEl, observer);
    }
    const mode = mdViewMode(view);
    if (mode !== "preview") {
      const previous = this.layoutMap.get(view.contentEl);
      previous?.dispose();
      previous?.surface.reset();
      previous?.surface.setGutter(null);
      this.layoutMap.delete(view.contentEl);
      view.contentEl.querySelectorAll<HTMLElement>(".gloss-gutter-padded").forEach((el) => {
        el.classList.remove("gloss-gutter-padded");
        el.style.removeProperty("--gloss-gutter-pad");
      });
      const store = await this.storage.loadDoc(file.path);
      if (!this.alive || view.file?.path !== file.path || this.renderSeq.get(view.contentEl) !== seq) return;
      this.editorHighlights.refresh(file.path);
      const entries = store.entries.filter(e => e.anchor.kind === "md");
      const visible = entries.filter(e => e.anchor.kind === "md" && sourceRange(view.editor.getValue(), e.anchor)).length;
      this.fileStats.set(file.path, { visible, orphan: entries.length - visible });
      this.updateStatus();
      return;
    }

    // 防自激回环：内容未变 + 无批注变更 + 1.5s 内 → 跳过
    if (!force) {
      const sig = this.contentSig(view);
      const st = this.renderState.get(view.contentEl);
      if (st && st.sig === sig && Date.now() - st.at < 1500) return;
    }

    const store = await this.storage.loadDoc(file.path);
    if (this.renderSeq.get(view.contentEl) !== seq) return; // 期间已有更新渲染，丢弃本次
    // 身份校验：await 期间视图可能已切走/卸载，旧视图的 contentEl 已被 Obsidian 复用
    if (!this.alive || view.file?.path !== file.path || !view.contentEl.isConnected) return;
    // 先卸载旧布局中的 Component，再构造新的 Surface。
    const prev = this.layoutMap.get(view.contentEl);
    const reuse = !force && prev?.surface.layer.isConnected && view.contentEl.contains(prev.surface.host)
      && this.renderState.get(view.contentEl)?.sig === this.contentSig(view)
      && prev.items.every(it => store.entries.includes(it.entry));
    if (prev && !reuse) {
      try { prev.dispose(); } catch { /* ignore */ }
      this.layoutMap.delete(view.contentEl);
    }
    const surface = reuse && prev ? prev.surface : getSurface(view.contentEl, mode);
    if (!surface) {
      this.fileStats.set(file.path, { visible: 0, orphan: 0, fail: "surface not found" });
      this.updateStatus();
      return;
    }

    if (!this.readingObservers.has(surface.host)) {
      const observer = new MutationObserver(records => {
        const changed = records.some(record => [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node =>
          node.nodeType === 1 && !(node as Element).classList.contains("gloss-margin-layer") && !(node as Element).classList.contains("gloss-connectors")));
        const path = view.file?.path;
        if (changed && this.alive && path) {
          // Virtualized blocks changed, not annotation data: permit reanchoring but retain card DOM.
          const state = this.renderState.get(view.contentEl);
          if (state) state.at = 0;
          this.schedule(path);
        }
      });
      observer.observe(surface.host, { childList: true });
      this.readingObservers.set(surface.host, observer);
    }

    try {
      if (reuse) unwrapAll(surface.host);
      else surface.reset();

      // 通用块选择器：本 Obsidian 未分配 data-block-id 时的回退搜索范围
      const genericSel = mode === "preview" ? GENERIC_BLOCK_PREVIEW : GENERIC_BLOCK_EDITOR;

      // 定位 + 包高亮
      const placed: Array<{ entry: GlossEntry; el: HTMLElement; type: GlossType }> = [];
      for (const e of store.entries) {
        if (e.anchor.kind !== "md") continue;
        const loc = locateAnchor(surface.host, e.anchor, genericSel);
        if (!loc) continue; // orphan：不渲染，数据保留
        const t = this.storage.typeOf(e.note.typeId);
        const n = wrapRangeInBlock(loc.block, loc.start, loc.end, `gloss-hl gloss-hl-${this.settings.highlightStyle}`, e.note.id, t.color);
        if (n > 0) {
          const el = Array.from(surface.host.querySelectorAll<HTMLElement>(".gloss-hl")).find(el => el.dataset.glossId === e.note.id);
          if (el) placed.push({ entry: e, el, type: t });
        }
      }

      // 布局判定：手动命令覆盖 > 设置项（auto 时按断点宽度）
      const forced: "margin" | "bubble" | null = this.layoutOverride
        ?? (this.settings.layoutMode === "auto" ? null : this.settings.layoutMode);
      const want: "margin" | "bubble" = forced ?? ((view.contentEl.ownerDocument.defaultView ?? window).innerWidth >= this.settings.wideBreakpoint ? "margin" : "bubble");
      const gutter = Math.max(248, this.settings.marginWidth) + 24;
      const canMargin = surface.availableWidth() >= surface.readingWidth() + 2 * gutter;

      // 无卡片不留白；即使偏好页边，也不能挤压正文，放不下时回退气泡。
      if ((placed.length > 0 || reuse) && want === "margin" && canMargin) {
        surface.setGutter(this.settings.marginWidth);
        const hooks = (e: GlossEntry): CardHooks => ({
          // 按 store 对象落盘：重命名后路径变了，但卡片修改的就是这个 store，
          // 状态对象随之改挂新路径——旧路径的 saveDoc 会漏掉这批修改
          onChanged: async (next, expected) => {
            await this.storage.commitEntry(store, e.note.id, { ...e, note: next }, expected);
            // 保存成功后只更新本卡，其他卡片的焦点、草稿和滚动位置保持不变。
            this.refreshCard(e, store);
          },
          onDeleted: () => this.deleteAnnotation(store, e.note.id),
        });
        if (reuse && prev) prev.updateAnchors(placed);
        else {
          const layout = buildMarginLayout(this, surface, placed, (e, t) =>
            buildCard(this, e, t, file.path, hooks(e)));
          this.layoutMap.set(view.contentEl, layout);
        }
      } else {
        if (reuse && prev) { prev.dispose(); this.layoutMap.delete(view.contentEl); }
        surface.setGutter(null);
        this.ensureBubbleClick(surface.host, file.path);
      }

      const mdEntries = store.entries.filter((e) => e.anchor.kind === "md");
      // Offscreen blocks are absent from the preview DOM, not evidence of broken anchors.
      // Validate against the full source before labelling a note orphaned.
      const source = await this.app.vault.cachedRead(file);
      if (!this.alive || view.file?.path !== file.path || this.renderSeq.get(view.contentEl) !== seq) return;
      const unresolved = mdEntries.filter(e => e.anchor.kind === "md" && !sourceRange(source, e.anchor));
      this.fileStats.set(file.path, { visible: placed.length, orphan: unresolved.length });

    } catch (err) {
      surface.setGutter(null);
      const msg = err instanceof Error ? err.message : String(err);
      this.fileStats.set(file.path, { visible: 0, orphan: 0, fail: msg });
      if (Date.now() - this.lastErrAt > 5000) {
        this.lastErrAt = Date.now();
        new Notice(`Gloss 渲染错误：${msg}`);
      }
    }

    this.renderState.set(view.contentEl, { sig: this.contentSig(view), at: Date.now() });
    this.updateStatus();
  }

  /** 状态栏：显示当前文档的高亮 / 锚点失效 / 失败原因 */
  private updateStatus(): void {
    if (!this.statusEl) return;
    const view = this.activeMarkdownView();
    const path = view?.file?.path;
    if (this.storage.hasProblems) { this.statusEl.setText("Gloss ⚠ 保存未完成"); this.statusEl.title = "运行 Gloss：处理保存问题，查看重试和冲突恢复选项"; return; }
    let text = "Gloss 0";
    let title = "Gloss：当前文档批注渲染状态";
    if (path) {
      const s = this.fileStats.get(path);
      if (s) {
        if (s.fail) {
          text = "Gloss ⚠";
          title = `Gloss 渲染失败：${s.fail}`;
        } else {
          text = s.orphan > 0 ? `Gloss ${s.visible}✓ ${s.orphan}⚠` : `Gloss ${s.visible}`;
          title = `Gloss：${path}\n已渲染 ${s.visible} 条高亮，${s.orphan} 条锚点失效（原文可能被编辑/删除）`;
        }
      } else {
        text = "Gloss · 无";
        title = `Gloss：当前文档尚无批注数据（${path}）`;
      }
    }
    this.statusEl.setText(text);
    this.statusEl.title = title;
  }

  /** 气泡模式：高亮点击 → 弹出气泡卡片（每个 host 只委托一次）。
   *  WeakMap：host 随视图销毁可被 GC（含整个内容 DOM）；
   *  onunload 时枚举"仍打开的视图"摘除委托，已关视图的 host 交给 GC */
  private bubbleHandlers = new WeakMap<HTMLElement, (ev: MouseEvent) => void>();
  /** host → 当前文档路径。host（如 .cm-scroller）会跨文档复用，
   *  路径必须随每次渲染更新，不能缓存在闭包里 */
  private bubbleDoc = new WeakMap<HTMLElement, string>();

  private ensureBubbleClick(host: HTMLElement, docPath: string): void {
    this.bubbleDoc.set(host, docPath);
    if (this.bubbleHandlers.has(host)) return;
    const handler = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement;
      const hl = target.closest(".gloss-hl") as HTMLElement | null;
      if (!hl || !host.contains(hl)) return;
      const id = hl.dataset.glossId;
      const doc = this.bubbleDoc.get(host);
      if (!id || !doc) return;
      const store = this.storage.docCacheFor(doc);
      const entry = store?.entries.find((e) => e.note.id === id);
      if (!store || !entry) return;
      GlossBubble.show(this, entry, this.storage.typeOf(entry.note.typeId), hl, store);
    };
    host.addEventListener("click", handler);
    this.bubbleHandlers.set(host, handler);
  }

  private touchVersion(docPath: string): void {
    this.versionCounter.set(docPath, (this.versionCounter.get(docPath) ?? 0) + 1);
  }

  // ================= 选区浮泡 =================

  private activeMarkdownView(): MarkdownView | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view = leaf?.view;
    return view instanceof MarkdownView ? view : null;
  }

  private updatePill(doc: Document): void {
    const pill = this.pills.get(doc);
    if (!pill) return;
    const selection = doc.getSelection();
    if (this.popoverOpen || !selection || selection.isCollapsed) { pill.hide(); return; }
    const view = this.activeMarkdownView();
    if (!view?.file || view.contentEl.ownerDocument !== doc) { pill.hide(); return; }
    const sel = this.currentSelection();
    if (sel && view.contentEl.contains(selection.anchorNode)) pill.show(sel.rect);
    else pill.hide();
  }

  private currentSelection(): { anchor: Anchor; rect: DOMRect } | null {
    const view = this.activeMarkdownView();
    if (!view || !view.file) return null;
    if (!this.sizeObservers.has(view.contentEl) && typeof ResizeObserver !== "undefined") {
      let width = -1;
      const observer = new ResizeObserver(() => {
        if (!this.alive || !view.file || width === view.contentEl.clientWidth) return;
        width = view.contentEl.clientWidth;
        const state = this.renderState.get(view.contentEl); if (state) state.at = 0;
        this.schedule(view.file.path);
      });
      observer.observe(view.contentEl); this.sizeObservers.set(view.contentEl, observer);
    }
    const mode = mdViewMode(view);
    if (mode !== "preview") return this.editorSelectionAnchor(view);
    return selectionToMdAnchor(GENERIC_BLOCK_PREVIEW, view.contentEl.ownerDocument);
  }

  // ================= 建 / 删批注 =================

  async createAnnotation(
    docPath: string,
    anchor: Anchor,
    typeId: string,
    content: string,
    attachments: GlossAttachment[],
    noteId?: string,
  ): Promise<void> {
    if (!this.alive) throw new Error("Gloss 已卸载，无法保存批注");
    const now = Date.now();
    const entry: GlossEntry = {
      anchor,
      note: {
        id: noteId ?? uuid(),
        typeId,
        content,
        createdAt: now,
        updatedAt: now,
        replies: [],
        attachments,
      },
    };
    await this.storage.createEntry(docPath, entry);
    this.touchVersion(docPath);
    try {
      await Promise.all(this.mdViewsFor(docPath).map(view => this.renderView(view, true)));
      this.pdf?.refresh(docPath);
    } catch (error) { new Notice(`Gloss：批注已保存，但刷新失败：${String(error)}`); }
    if (!this.settings.defaultTypeId) this.settings.defaultTypeId = typeId;
  }

  async deleteAnnotation(store: GlossDocStore, noteId: string): Promise<void> {
    const entry = store.entries.find(e => e.note.id === noteId);
    if (!entry) throw new Error("批注已更新，请重新打开后重试");
    await this.storage.commitEntry(store, noteId, null, JSON.stringify(entry.note));
    const path = this.storage.currentPath(store) ?? store.docPath;
    this.touchVersion(path); this.refreshDoc(path);
  }

  refreshCard(entry: GlossEntry, store: GlossDocStore): void {
    const path = this.storage.currentPath(store) ?? store.docPath;
    this.editorHighlights.refresh(path); this.pdf?.refresh(path);
    for (const layout of this.layoutMap.values()) for (const item of layout.items) {
      if (item.entry !== entry || !item.cardEl) continue;
      const old = item.cardEl;
      const win = old.ownerDocument.defaultView;
      win?.requestAnimationFrame(() => {
        if (!this.alive || !old.isConnected || item.cardEl !== old) return;
        const active = old.contains(old.ownerDocument.activeElement) ? old.ownerDocument.activeElement as HTMLTextAreaElement : null;
        const scrollTop = old.querySelector<HTMLElement>(".gloss-card-scroll")?.scrollTop ?? 0;
        const card = buildCard(this, entry, this.storage.typeOf(entry.note.typeId), path, {
          onChanged: async (next, expected) => { await this.storage.commitEntry(store, entry.note.id, { ...entry, note: next }, expected); this.refreshCard(entry, store); },
          onDeleted: () => this.deleteAnnotation(store, entry.note.id),
        });
        card.style.cssText = old.style.cssText;
        applyCardStyle(card, this.settings, this.storage.typeOf(entry.note.typeId));
        disposeCompsUnder(old); old.replaceWith(card); item.cardEl = card; layout.observeCard(card, old); item.type = this.storage.typeOf(entry.note.typeId);
        const scroll = card.querySelector<HTMLElement>(".gloss-card-scroll"); if (scroll) scroll.scrollTop = scrollTop;
        if (active?.classList.contains("gloss-reply-ta")) card.querySelector<HTMLTextAreaElement>(".gloss-reply-ta")?.focus({ preventScroll: true });
      });
    }
  }

  /** 程序化关闭新建批注浮层（文档重命名时调用） */
  private closeCreatePopover(): void {
    const pop = this.createPop;
    this.createPop = null;
    if (!pop) return;

    dismissCreatePopover(pop.el);

    this.popoverOpen = false;
  }

  /** 命令 / 浮泡 / 右键共用入口 */
  async cmdCreate(): Promise<void> {
    if (!this.alive) return;
    if (this.createPop?.el.isConnected) { this.createPop.el.querySelector("textarea")?.focus(); return; }
    const view = this.activeMarkdownView();
    if (!view || !view.file) {
      new Notice("请先打开一篇 Markdown 文档");
      return;
    }
    const sel = this.currentSelection();
    if (!sel) {
      new Notice("请选择同一段内的文字；阅读视图暂不支持跨段落批注");
      return;
    }
    this.popoverOpen = true;
    for (const pill of this.pills.values()) pill.hide();
    const el = openCreatePopover(this, {
      docPath: view.file.path,
      document: view.contentEl.ownerDocument,
      anchor: sel.anchor,
      rect: sel.rect,
      onClosed: () => {
        this.popoverOpen = false;
        if (this.createPop?.el === el) this.createPop = null;
      },
    });
    this.createPop = { el, docPath: view.file.path };
  }

  /** 设置入口：PDF 场景开关 */
  setPdfEnabled(on: boolean): void {
    this.pdf?.setPdfEnabled(on);
  }

  /** PDF 场景的创建入口（pdf.ts 调用） */
  openPdfCreatePopover(docPath: string, anchor: Anchor, rect: DOMRect, doc: Document = document): void {
    if (!this.alive) return;
    if (this.createPop?.el.isConnected) { this.createPop.el.querySelector("textarea")?.focus(); return; }
    this.popoverOpen = true;
    const el = openCreatePopover(this, {
      docPath,
      document: doc,
      anchor,
      rect,
      onClosed: () => {
        this.popoverOpen = false;
        if (this.createPop?.el === el) this.createPop = null;
      },
    });
    this.createPop = { el, docPath };
  }

  // ================= 源码模式选区 → 锚点 =================

  private editorSelectionAnchor(view: MarkdownView): { anchor: Anchor; rect: DOMRect } | null {
    const ed = view.editor;
    const raw = ed.getValue();
    let from = ed.posToOffset(ed.getCursor("from"));
    let to = ed.posToOffset(ed.getCursor("to"));
    if (from === to) {
      const cursor = ed.getCursor();
      from = ed.posToOffset({ line: cursor.line, ch: 0 });
      to = from + ed.getLine(cursor.line).length;
    }
    const selected = raw.slice(from, to);
    if (!selected.trim()) return null;
    const lineStart = raw.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
    const endLine = raw.indexOf("\n", to);
    const lineEnd = endLine < 0 ? raw.length : endLine;
    const prefix = sourceToRenderedApprox(raw.slice(lineStart, from));
    const text = sourceToRenderedApprox(selected) || selected;
    const dom = selectionToMdAnchor(GENERIC_BLOCK_EDITOR, view.contentEl.ownerDocument);
    const anchor: MdAnchor = {
      kind: "md", blockId: "", start: prefix.length, end: prefix.length + text.length, text,
      blockText: sourceToRenderedApprox(raw.slice(lineStart, lineEnd)),
      prefix: prefix.slice(-48), suffix: sourceToRenderedApprox(raw.slice(to, lineEnd)).slice(0, 48),
    };
    anchor.source = { from, to, text: selected, prefix: raw.slice(Math.max(0, from - 48), from), suffix: raw.slice(to, to + 48) };
    const win = view.contentEl.ownerDocument.defaultView ?? window;
    return { anchor, rect: dom?.rect ?? new DOMRect(win.innerWidth / 2 - 100, win.innerHeight / 2 - 16, 200, 20) };
  }

  /** 保存后显示刚创建的条目，即使当前没有足够页边空间。 */
  revealAnnotation(path: string, id: string, rect: DOMRect, doc: Document = document): void {
    if (!this.alive) return;
    const view = this.mdViewsFor(path).find(view => view.contentEl.ownerDocument === doc);
    const store = this.storage.docCacheFor(path);
    const entry = store?.entries.find(e => e.note.id === id);
    if (!store || !entry) return;
    const card = Array.from(view?.contentEl.querySelectorAll<HTMLElement>(".gloss-card") ?? []).find(el => el.dataset.glossId === id);
    if (card) { card.scrollIntoView({ block: "nearest" }); return; }
    const hl = Array.from(view?.contentEl.querySelectorAll<HTMLElement>(".gloss-hl") ?? []).find(el => el.dataset.glossId === id);
    GlossBubble.show(this, entry, this.storage.typeOf(entry.note.typeId), hl ?? rect, store, doc);
  }

  // ================= 其它命令 =================

  private openSaveProblems(): void {
    const modal = new Modal(this.app); modal.setTitle("Gloss 保存问题");
    modal.contentEl.createEl("p", { text: "冲突不会自动覆盖。载入磁盘版本前会备份当前内存内容到 .gloss/conflicts；尚未保存的编辑窗口会继续保留草稿。" });
    if (!this.storage.hasProblems) modal.contentEl.createEl("p", { text: "当前没有记录的保存问题。" });
    for (const path of this.storage.problems) {
      const row = modal.contentEl.createDiv(); row.createEl("p", { text: path });
      const retry = row.createEl("button", { text: "重试写盘" });
      const recover = row.createEl("button", { text: "备份本地并载入磁盘版本" });
      const run = async (action: () => Promise<void>) => {
        retry.disabled = recover.disabled = true;
        try { await action(); row.remove(); this.refreshAll(); new Notice("Gloss：操作完成；未提交的草稿请重新核对后保存"); }
        catch (error) { new Notice(String(error)); }
        finally { retry.disabled = recover.disabled = false; }
      };
      retry.onclick = () => void run(() => this.storage.retrySave(path));
      recover.onclick = () => void run(() => this.storage.recoverDisk(path));
    }
    modal.open();
  }

  private async cmdExport(): Promise<void> {
    const view = this.activeMarkdownView();
    if (!view || !view.file) {
      new Notice("请先打开要导出的文档");
      return;
    }
    await exportDocAnnotations(this, view.file);
  }

  async openDoc(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.openLinkText(path, "");
  }

  // ================= 文件重命名：迁移批注数据 =================

  private async renameDocData(oldPath: string, newPath: string): Promise<void> {
    // 重命名事务（storage 内 commit/abort）：窗口内旧/新路径的 loadDoc 一律阻塞到
    // 迁移完成。成功 commit 后文档状态对象整体改挂新路径（缓存/定时器/脏版本/写队列
    // 随对象迁移，无永久路径别名）；失败 abort 保留原文件的可恢复状态
    const ok = await this.storage.migrateDoc(oldPath, newPath);
    if (!ok) new Notice("Gloss：批注数据迁移失败，原文件已保留（可稍后重新命名重试）");
  }

}
