import { Component, MarkdownRenderer, Modal, Notice, TFile, setIcon } from "obsidian";
import type GlossPlugin from "./main";
import type { GlossAttachment, GlossEntry, GlossType, GlossAnnotation } from "./types";
import { renderGallery, viewImages, openImageModal } from "./images";
import { createMemoEditor } from "./memo-editor";
import { renderImageReferences, attachmentForSource } from "./image-model";
import { applyCardStyle } from "./card-style";
import { fmtTime, uuid } from "./util";

export interface CardHooks {
  /** 内容/类型/回复等变化（已持久化到 store 内存） */
  onChanged: (next: GlossAnnotation, expected: string) => Promise<void>;
  /** 删除整条批注 */
  onDeleted: () => Promise<void>;
}

/** 卡片内 Markdown 渲染的 Component 追踪（层被清空时统一 unload） */
const compMap = new WeakMap<HTMLElement, Component[]>();
// Same annotation object survives normal view refreshes; drafts are not persisted as replies.
const replyDrafts = new WeakMap<GlossPlugin, Map<string, { text: string; open: boolean; revision: number }>>();
const editing = new WeakMap<GlossPlugin, Set<string>>();

export function disposeCompsUnder(root: HTMLElement): void {
  // Component 注册在卡片 body（.gloss-card-body）上，而调用方传入的是卡片根 / 气泡 / 弹层
  // 外层元素——只查根节点会漏掉全部，必须遍历整棵子树
  const disposeOne = (el: HTMLElement) => {
    const comps = compMap.get(el);
    if (!comps) return;
    for (const c of comps) { try { c.unload(); } catch { /* ignore */ } }
    compMap.set(el, []);
  };
  disposeOne(root);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) disposeOne(el);
}

function trackComp(card: HTMLElement, comp: Component): void {
  const arr = compMap.get(card);
  if (arr) arr.push(comp);
  else compMap.set(card, [comp]);
}

export function buildCard(plugin: GlossPlugin, entry: GlossEntry, type: GlossType, docPath: string, hooks: CardHooks): HTMLElement {
  const note = entry.note;
  const key = `${docPath}\0${note.id}`;
  const copy = (): GlossAnnotation => JSON.parse(JSON.stringify(note));
  const change = async (next: GlossAnnotation, expected = JSON.stringify(note)) => {
    try { await hooks.onChanged(next, expected); return true; }
    catch (error) { new Notice(errMsg(error)); return false; }
  };
  const card = createEl("div", { cls: "gloss-card" });
  card.dataset.glossId = note.id;
  applyCardStyle(card, plugin.settings, type);
  card.addEventListener("dblclick", e => {
    const target = e.target;
    if (!(target as Element | null)?.closest || (target as Element).closest("button, a, input, textarea, select, summary, audio, video, img, [role=button], [contenteditable], .gloss-type-chip, .gloss-card-replies")) return;
    e.preventDefault();
    e.stopPropagation();
    enterEdit();
  });

  // ---------- 头部 ----------
  const head = card.createDiv({ cls: "gloss-card-head" });
  const chip = head.createDiv({ cls: "gloss-type-chip" });
  chip.setText(`${type.emoji} ${type.name}`);
  chip.title = "点击切换类型";
  chip.onclick = (e) => {
    e.stopPropagation();
    showTypeMenu(plugin, chip, (tid) => {
      const next = copy(); next.typeId = tid; next.updatedAt = Date.now();
      void change(next);
    });
  };
  head.createSpan({ cls: "gloss-spacer" });

  const edit = head.createEl("button", { cls: "gloss-ic gloss-card-control", text: "✎" });
  setIcon(edit, "pencil");
  edit.setAttribute("aria-label", "编辑批注");
  edit.title = "编辑批注";
  edit.onclick = (e) => { e.stopPropagation(); enterEdit(); };

  const del = head.createEl("button", { cls: "gloss-ic gloss-del gloss-card-control", text: "🗑" });
  setIcon(del, "trash-2");
  del.setAttribute("aria-label", "删除批注");
  del.title = "删除批注（再点一次确认）";
  del.onclick = (e) => {
    e.stopPropagation();
    if (del.dataset.arm) {
      void hooks.onDeleted().catch(error => new Notice(errMsg(error)));
    } else {
      del.dataset.arm = "1";
      del.addClass("gloss-armed");
      setTimeout(() => { delete del.dataset.arm; del.removeClass("gloss-armed"); }, 2500);
    }
  };

  if (entry.anchor.text) card.createDiv({ cls: "gloss-card-quote", text: entry.anchor.text });

  // ---------- 正文 ----------
  const body = card.createDiv({ cls: "gloss-card-body" });
  void renderContent();

  async function renderContent(): Promise<void> {
    disposeCompsUnder(body);
    body.empty();
    if (!note.content.trim()) {
      body.createSpan({ cls: "gloss-empty", text: "双击卡片，写下你的想法…" });
      return;
    }
    const comp = new Component();
    trackComp(body, comp);
    comp.load();
    try {
      const markdown = renderImageReferences(note.content, note.attachments, a => resourceUrl(plugin, a.path));
      await MarkdownRenderer.render(plugin.app, markdown, body, docPath, comp);
      if (!body.isConnected) return;
      const images = note.attachments.filter(a => a.kind === "image");
      for (const img of Array.from(body.querySelectorAll("img"))) {
        const a = attachmentForSource(images, img.getAttribute("src") ?? img.src, a => resourceUrl(plugin, a.path));
        if (!a) continue;
        img.onerror = () => { img.replaceWith(createEl("span", { cls: "gloss-missing-file", text: `图片缺失或尚未同步：${a.name}` })); };
        img.tabIndex = 0;
        img.setAttribute("role", "button");
        img.setAttribute("aria-label", `查看大图：${a.name}`);
        img.onclick = e => { e.preventDefault(); e.stopPropagation(); viewImages(plugin, images, a); };
        img.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); viewImages(plugin, images, a); } };
      }
    } catch {
      body.createEl("pre", { text: note.content });
    }
  }

  function enterEdit(): void {
    let active = editing.get(plugin);
    if (!active) { active = new Set(); editing.set(plugin, active); }
    if (active.has(key)) return;
    active.add(key);
    const expected = JSON.stringify(note);
    const modal = new Modal(plugin.app);
    modal.setTitle("编辑批注");
    modal.modalEl.addClass("gloss-editor-modal");
    const draft = note.attachments.map(a => ({ ...a }));
    modal.contentEl.createDiv({ cls: "gloss-memo-context", text: entry.anchor.text || "所选区域" });
    const composer = createMemoEditor(plugin, modal.contentEl, note.content, note.id, draft, docPath);
    const ta = composer.input;
    modal.onClose = () => { active!.delete(key); composer.dispose(); };
    const row = composer.buttons;
    const cancel = row.createEl("button", { text: "取消" });
    const save = row.createEl("button", { text: "保存批注", cls: "mod-cta" });
    cancel.onclick = () => modal.close();
    save.onclick = async () => {
      save.disabled = cancel.disabled = true;
      save.setText("正在保存…");
      composer.freeze(true);
      try {
        await composer.ready();
        if (!modal.contentEl.isConnected || !plugin.isAlive) return;
        const next = copy(); next.content = ta.value; next.attachments = draft; next.updatedAt = Date.now();
        await hooks.onChanged(next, expected);
        modal.close();
      } catch (e) { new Notice(errMsg(e)); }
      finally { save.disabled = cancel.disabled = false; save.setText("保存批注"); composer.freeze(false); }
    };
    ta.onkeydown = e => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save.click(); }
    };
    openImageModal(plugin, modal);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // ---------- 附件 ----------
  const attEl = card.createDiv({ cls: "gloss-card-attach" });
  renderGallery(plugin, attEl, note.attachments, note.content);
  for (const a of note.attachments.filter(a => a.kind !== "image")) renderAttachment(attEl, a);
  attEl.toggleClass("gloss-hidden", note.attachments.length === 0);

  function renderAttachment(parent: HTMLElement, a: GlossAttachment): void {
    const row = parent.createDiv({ cls: "gloss-attach-row" });
    const icon = row.createSpan({ cls: "gloss-attach-icon" });
    const src = resourceUrl(plugin, a.path);
    if (a.kind === "image") {
      row.createEl("img", { cls: "gloss-attach-img", attr: { src, alt: a.name } });
    } else if (a.kind === "audio") {
      row.createEl("audio", { cls: "gloss-attach-audio", attr: { controls: "controls", src } });
      icon.setText("🎧");
    } else if (a.kind === "video") {
      row.createEl("video", { cls: "gloss-attach-video", attr: { controls: "controls", src } });
    } else {
      const link = row.createEl("a", { cls: "gloss-attach-file", text: a.name });
      link.onclick = (e) => {
        e.preventDefault();
        const file = plugin.app.vault.getAbstractFileByPath(a.path);
        if (!(file instanceof TFile)) { new Notice(`附件缺失或尚未同步：${a.name}`); return; }
        void plugin.app.workspace.getLeaf(false).openFile(file);
      };
      icon.setText("📄");
    }
    const rm = row.createEl("button", { cls: "gloss-ic gloss-attach-rm", text: "✕" });
    rm.title = "移除附件";
    rm.onclick = () => {
      if (rm.dataset.arm) {
        const next = copy(); next.attachments = next.attachments.filter(x => x.id !== a.id); next.updatedAt = Date.now();
        void change(next);
      } else {
        rm.dataset.arm = "1";
        rm.addClass("gloss-armed");
        setTimeout(() => { delete rm.dataset.arm; rm.removeClass("gloss-armed"); }, 2500);
      }
    };
  }

  // ---------- 回复 ----------
  const rep = card.createDiv({ cls: "gloss-card-replies" });
  let drafts = replyDrafts.get(plugin);
  if (!drafts) { drafts = new Map(); replyDrafts.set(plugin, drafts); }
  const replyDraft = drafts.get(key) ?? { text: "", open: false, revision: 0 };
  drafts.set(key, replyDraft);
  rep.hidden = !replyDraft.open;
  rep.id = `gloss-replies-${uuid()}`;
  if (note.replies.length) {
    const list = rep.createDiv({ cls: "gloss-reply-list" });
    for (const r of note.replies) {
      const row = list.createDiv({ cls: "gloss-reply" });
      row.createSpan({ cls: "gloss-reply-time", text: fmtTime(r.createdAt) });
      row.createSpan({ cls: "gloss-reply-text", text: r.content });
    }
  }
  const inRow = rep.createDiv({ cls: "gloss-reply-row" });
  const ta = inRow.createEl("textarea", { cls: "gloss-reply-ta", placeholder: "回复讨论…（Enter 发送）" });
  ta.value = replyDraft.text;
  let inputRevision = 0;
  ta.addEventListener("input", () => { inputRevision++; replyDraft.text = ta.value; replyDraft.revision++; });
  const send = inRow.createEl("button", { cls: "gloss-reply-send", text: "回复" });
  const doSend = async () => {
    const submitted = ta.value;
    const v = submitted.trim();
    if (!v || send.disabled) return;
    const submittedInputRevision = inputRevision;
    const submittedDraftRevision = replyDraft.revision;
    send.disabled = true;
    const next = copy();
    next.replies.push({ id: uuid(), content: v, createdAt: Date.now() }); next.updatedAt = Date.now();
    if (await change(next)) {
      // A pending save must not erase later input in this card or another card sharing the draft.
      if (inputRevision === submittedInputRevision && ta.value === submitted) ta.value = "";
      if (replyDraft.revision === submittedDraftRevision && replyDraft.text === submitted) {
        replyDraft.text = ""; replyDraft.revision++;
      }
      replyDraft.open = true;
      const row = rep.createDiv({ cls: "gloss-reply" }); row.setText(v);
      row.scrollIntoView?.({ block: "nearest" });
    }
    send.disabled = false;
  };
  send.onclick = doSend;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
  });

  // ---------- 底部 ----------
  const foot = card.createDiv({ cls: "gloss-card-foot" });
  const reply = foot.createEl("button", { cls: "gloss-ic gloss-reply-toggle", attr: {
    "aria-label": note.replies.length ? `查看或添加回复（${note.replies.length} 条）` : "添加回复",
    "aria-expanded": String(!rep.hidden), "aria-controls": rep.id,
  } });
  setIcon(reply, "message-circle");
  reply.title = note.replies.length ? `${note.replies.length} 条回复` : "添加回复";
  reply.onclick = e => {
    e.stopPropagation();
    rep.hidden = !rep.hidden;
    replyDraft.open = !rep.hidden;
    reply.setAttribute("aria-expanded", String(!rep.hidden));
    if (!rep.hidden) ta.focus();
  };
  foot.createSpan({ cls: "gloss-card-date", text: fmtTime(note.createdAt) });

  // Only the annotation content scrolls; header, source quote and footer stay fixed.
  const scroll = createEl("div", { cls: "gloss-card-scroll" });
  scroll.appendChild(body);
  scroll.appendChild(attEl);
  scroll.appendChild(rep);
  card.insertBefore(scroll, foot);
  return card;
}

// ---------- 类型切换菜单 ----------

let currentMenu: HTMLElement | null = null;
let menuCleanup: (() => void) | null = null;

export function closeTypeMenu(doc?: Document): void {
  if (doc && currentMenu?.ownerDocument !== doc) return;
  menuCleanup?.(); menuCleanup = null;
  currentMenu?.remove();
  currentMenu = null;
}

export function showTypeMenu(plugin: GlossPlugin, anchorEl: HTMLElement, onPick: (id: string) => void): void {
  closeTypeMenu();
  const doc = anchorEl.ownerDocument;
  const win = doc.defaultView ?? window;
  const menu = doc.body.createDiv({ cls: "gloss-type-menu" });
  for (const t of plugin.storage.sortedTypes()) {
    const row = menu.createDiv({ cls: "gloss-type-row" });
    row.style.setProperty("--gloss-color", t.color);
    row.setText(`${t.emoji} ${t.name}`);
    row.onclick = () => {
      closeTypeMenu();
      onPick(t.id);
    };
  }
  const r = anchorEl.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, win.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(r.bottom + 6, win.innerHeight - 40 * Math.max(1, plugin.storage.types.length))}px`;
  currentMenu = menu;
  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      closeTypeMenu();
      doc.removeEventListener("mousedown", onDown, true);
    }
  };
  const timer = setTimeout(() => { if (currentMenu === menu) doc.addEventListener("mousedown", onDown, true); }, 0);
  menuCleanup = () => { clearTimeout(timer); doc.removeEventListener("mousedown", onDown, true); };
}

/** 取库内文件的可访问 URL（getResourcePath 需要 TFile） */
export function resourceUrl(plugin: GlossPlugin, path: string): string {
  const f = plugin.app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) {
    try {
      return plugin.app.vault.getResourcePath(f);
    } catch { /* fallthrough */ }
  }
  return plugin.app.vault.adapter.getResourcePath(path);
}

// ---------- 文件选择 ----------

export function pickFile(onFile: (f: File) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.style.display = "none";
  document.body.appendChild(input);
  const done = () => {
    input.removeEventListener("cancel", done);
    input.remove();
  };
  input.addEventListener("cancel", done); // 取消对话框也要移除，否则 input 一直挂在 body
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) onFile(f);
    done();
  });
  input.click();
}

export function kindOf(mime: string, name = ""): GlossAttachment["kind"] {
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(name)) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
