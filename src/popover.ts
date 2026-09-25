import type GlossPlugin from "./main";
import { buildCard, disposeCompsUnder, errMsg } from "./card";
import { createMemoEditor } from "./memo-editor";
import { applyCardStyle } from "./card-style";
import { Notice } from "obsidian";
import type { Anchor, GlossAttachment, GlossDocStore, GlossEntry, GlossType } from "./types";
import { clamp, uuid } from "./util";

// ---------- 选区上方的小浮泡 ----------

export class SelectionPill {
  private el: HTMLElement | null = null;

  show(rect: DOMRect): void {
    this.ensure();
    const el = this.el!;
    const x = clamp(rect.left + rect.width / 2, 80, window.innerWidth - 80);
    const y = Math.max(10, rect.top - 40);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.classList.add("gloss-show"); // 显示走类切换，CSS 负责入场动画
  }

  hide(): void {
    if (this.el) this.el.classList.remove("gloss-show");
  }

  dispose(): void {
    this.el?.remove();
    this.el = null;
  }

  /** 确保 DOM 存在（供外部绑定事件） */
  ensureEl(): HTMLElement {
    this.ensure();
    return this.el!;
  }

  private ensure(): void {
    if (this.el) return;
    const el = document.body.createDiv({ cls: "gloss-pill" });
    el.setText("💬 批注");
    this.el = el;
  }
}

// ---------- 新建批注浮层 ----------

export interface CreatePopoverOptions {
  docPath: string;
  anchor: Anchor;
  rect: DOMRect;
  onClosed: () => void;
}

const createClosers = new WeakMap<HTMLElement, () => void>();
export function dismissCreatePopover(el: HTMLElement): void {
  const close = createClosers.get(el);
  if (close) close();
  else el.remove();
}

/** 返回浮层根元素（调用方持有，文档重命名等场景可程序化关闭） */
export function openCreatePopover(plugin: GlossPlugin, opts: CreatePopoverOptions): HTMLElement {
  GlossBubble.close();
  const pop = document.body.createDiv({ cls: "gloss-create" });

  const head = pop.createDiv({ cls: "gloss-create-head" });
  head.createSpan({ cls: "gloss-create-title", text: "新建批注" });
  const close = head.createEl("button", { cls: "gloss-ic", text: "✕" });
  let disposeEditor = () => {};
  let cleanupEvents = () => {};
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true; cleanupEvents();
    createClosers.delete(pop);
    disposeEditor(); pop.remove(); opts.onClosed();
  };
  createClosers.set(pop, dismiss);
  close.onclick = dismiss;

  pop.createDiv({ cls: "gloss-card-quote", text: opts.anchor.text || "所选区域" });

  // 类型选择
  const typeRow = pop.createDiv({ cls: "gloss-create-types" });
  let typeId = plugin.settings.defaultTypeId;
  for (const t of plugin.storage.sortedTypes()) {
    const chip = typeRow.createDiv({ cls: "gloss-type-chip" });
    chip.style.setProperty("--gloss-color", t.color);
    chip.setText(`${t.emoji} ${t.name}`);
    if (t.id === typeId) chip.addClass("gloss-active");
    chip.onclick = () => {
      typeId = t.id;
      for (const c of Array.from(typeRow.children)) c.classList.remove("gloss-active");
      chip.addClass("gloss-active");
    };
  }


  // 图片与附件
  // noteId 预生成：附件落盘时就用它做子目录，保存时复用同一 id（避免附件挂在临时目录 "new" 下）
  const noteId = uuid();
  const attachments: GlossAttachment[] = [];
  const composer = createMemoEditor(plugin, pop, "", noteId, attachments, opts.docPath);
  const ta = composer.input;
  disposeEditor = () => composer.dispose();

  const btnRow = composer.buttons;
  const cancel = btnRow.createEl("button", { text: "取消" });
  const save = btnRow.createEl("button", { cls: "gloss-primary", text: "保存批注" });
  cancel.onclick = dismiss;
  save.onclick = () => {
    save.disabled = true;
    save.setText("正在保存…");
    composer.freeze(true);

    void (async () => {
      try {
        await composer.ready();
        if (!pop.isConnected) return; // 等待期间弹窗已被关掉
        await plugin.createAnnotation(opts.docPath, opts.anchor, typeId, ta.value.trim(), attachments, noteId);
        dismiss();
        plugin.revealAnnotation(opts.docPath, noteId, opts.rect);
      } catch (error) {
        new Notice(`批注保存失败：${errMsg(error)}。内容仍保留在窗口中，请重试。`);
      } finally {
        save.disabled = false;
        save.setText("保存批注");
        composer.freeze(false);

      }
    })();
  };

  ta.onkeydown = e => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
  };
  positionPopover(pop, opts.rect);
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || document.querySelector(".gloss-image-viewer")) return;
    event.preventDefault(); event.stopPropagation();
    if (!ta.value.trim() && attachments.length === 0 && !composer.hasPending() && !save.disabled) dismiss();
  };
  const onOutside = (event: MouseEvent) => {
    if (pop.contains(event.target as Node) || (event.target as Element).closest?.(".modal-container")) return;
    // Outside clicks only dismiss an empty draft; never silently throw away text or uploaded images.
    if (!ta.value.trim() && attachments.length === 0 && !composer.hasPending() && !save.disabled) dismiss();
  };
  const timer = setTimeout(() => {
    if (!pop.isConnected) return;
    ta.focus();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onOutside, true);
  }, 0);
  cleanupEvents = () => {
    clearTimeout(timer);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
  };
  return pop;
}

function positionPopover(pop: HTMLElement, rect: DOMRect): void {
  const W = Math.min(480, window.innerWidth - 16);
  pop.style.width = `${W}px`;
  pop.style.left = `${clamp(rect.left + rect.width / 2 - W / 2, 8, window.innerWidth - W - 8)}px`;
  pop.style.top = "0px";
  const h = pop.offsetHeight;
  let y = rect.bottom + 10;
  if (y + h > window.innerHeight - 8) y = Math.max(8, rect.top - h - 10);
  pop.style.top = `${y}px`;
}

// ---------- 气泡模式（窄屏点高亮弹出） ----------

export class GlossBubble {
  private static el: HTMLElement | null = null;
  private static cleanup: (() => void) | null = null;
  /** 气泡当前展示的文档路径（文档重命名时据此判断是否要关掉气泡） */
  static docPath: string | null = null;

  static close(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.docPath = null;
    if (this.el) {

      disposeCompsUnder(this.el); // 卡片里 Markdown 渲染的 Component 随气泡卸载
      this.el.remove();
    }
    this.el = null;

  }

  static show(plugin: GlossPlugin, entry: GlossEntry, type: GlossType, anchorEl: HTMLElement | DOMRect, store: GlossDocStore): void {
    this.close();
    const docPath = store.docPath;
    this.docPath = docPath;
    const b = document.body.createDiv({ cls: "gloss-bubble" });
    b.dataset.glossId = entry.note.id;
    applyCardStyle(b, plugin.settings, type);
    const head = b.createDiv({ cls: "gloss-bubble-head" });
    head.createSpan({ cls: "gloss-bubble-title", text: "批注" });
    const x = head.createEl("button", { cls: "gloss-ic", text: "✕" });
    x.onclick = () => this.close();
    const bodyWrap = b.createDiv({ cls: "gloss-bubble-body" });
    const renderCard = () => {
      disposeCompsUnder(bodyWrap);
      bodyWrap.empty();
      const currentType = plugin.storage.typeOf(entry.note.typeId);
      applyCardStyle(b, plugin.settings, currentType);
      bodyWrap.appendChild(buildCard(plugin, entry, currentType, plugin.storage.currentPath(store) ?? docPath, {
        onChanged: () => {
          if (!plugin.storage.saveStore(store)) return;
          const path = plugin.storage.currentPath(store) ?? docPath;
          if (this.el === b && b.isConnected) renderCard();
          plugin.refreshDoc(path);
        },
        onDeleted: () => {
          this.close();
          void plugin.deleteAnnotation(store, entry.note.id);
        },
      }));
    };
    renderCard();

    // 定位：优先锚点下方，空间不足上翻，水平 clamp
    const r = anchorEl instanceof HTMLElement ? anchorEl.getBoundingClientRect() : anchorEl;
    const W = Math.min(340, window.innerWidth - 16);
    b.style.width = `${W}px`;
    b.style.left = `${clamp(r.left + r.width / 2 - W / 2, 8, window.innerWidth - W - 8)}px`;
    b.style.top = "0px";
    const h = b.offsetHeight;
    let y = r.bottom + 8;
    if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 8);
    b.style.top = `${y}px`;

    this.el = b;
    setTimeout(() => {
      if (this.el !== b || !b.isConnected) return;
      const onDown = (e: Event) => {
        const t = e.target as Node;
        if (b.contains(t)) return;
        if ((t as Element).closest?.(".gloss-hl, .gloss-type-menu, .gloss-editor-modal, .gloss-image-viewer")) return; // 点另一个高亮 → 先关再开
        this.close();
      };
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("touchstart", onDown, true);
      this.cleanup = () => {
        document.removeEventListener("mousedown", onDown, true);
        document.removeEventListener("touchstart", onDown, true);
      };
    }, 0);
  }
}

export { disposeCompsUnder };
