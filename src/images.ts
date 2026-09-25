import { Modal, Notice, TFile } from "obsidian";
import type GlossPlugin from "./main";
import type { GlossAttachment } from "./types";
import { uuid } from "./util";
import { imageMarkdown, isInline, moveAttachment, removeInline } from "./image-model";

// Keep only currently open modals; one unload callback per plugin instance.
const modals = new WeakMap<GlossPlugin, Set<Modal>>();
export function openImageModal(plugin: GlossPlugin, modal: Modal): void {
  let active = modals.get(plugin);
  if (!active) {
    active = new Set();
    modals.set(plugin, active);
    const set = active;
    plugin.register(() => { for (const m of Array.from(set)) m.close(); set.clear(); });
  }
  active.add(modal);
  const close = modal.onClose.bind(modal);
  const set = active;
  modal.onClose = () => { set.delete(modal); close(); modal.contentEl.empty(); };
  modal.open();
}

function url(plugin: GlossPlugin, a: GlossAttachment): string {
  const file = plugin.app.vault.getAbstractFileByPath(a.path);
  return file instanceof TFile ? plugin.app.vault.getResourcePath(file) : plugin.app.vault.adapter.getResourcePath(a.path);
}

export function viewImages(plugin: GlossPlugin, images: GlossAttachment[], selected: GlossAttachment): void {
  class Viewer extends Modal {
    index = Math.max(0, images.indexOf(selected));
    onOpen(): void {
      this.modalEl.addClass("gloss-image-viewer");
      this.scope.register([], "ArrowLeft", () => { this.show(-1); return false; });
      this.scope.register([], "ArrowRight", () => { this.show(1); return false; });
      this.show(0);
    }
    show(delta: number): void {
      this.index = (this.index + delta + images.length) % images.length;
      this.contentEl.empty();
      const a = images[this.index];
      this.setTitle(`${a.name} · ${this.index + 1} / ${images.length}`);
      const stage = this.contentEl.createDiv({ cls: "gloss-image-stage" });
      const img = stage.createEl("img", { attr: { src: url(plugin, a), alt: a.name } });
      const row = this.contentEl.createDiv({ cls: "gloss-image-tools" });
      const prev = row.createEl("button", { text: "上一张" });
      prev.disabled = images.length < 2;
      prev.onclick = () => this.show(-1);
      const zoom = row.createEl("button", { text: "原始尺寸" });
      zoom.onclick = () => { const full = img.classList.toggle("gloss-full-size"); zoom.setText(full ? "适合窗口" : "原始尺寸"); };
      const next = row.createEl("button", { text: "下一张" });
      next.disabled = images.length < 2;
      next.onclick = () => this.show(1);
    }
    onClose(): void { this.contentEl.empty(); }
  }
  const viewer = new Viewer(plugin.app);
  openImageModal(plugin, viewer);
}

export function renderGallery(plugin: GlossPlugin, parent: HTMLElement, attachments: GlossAttachment[], content: string): void {
  const images = attachments.filter(a => a.kind === "image");
  const bottom = images.filter(a => !isInline(content, a));
  if (!bottom.length) return;
  const grid = parent.createDiv({ cls: "gloss-image-grid" });
  let expanded = false;
  function draw(): void {
    grid.empty();
    const shown = expanded ? bottom : bottom.slice(0, 4);
    shown.forEach((a, i) => {
      const button = grid.createEl("button", { cls: "gloss-image-tile", attr: { "aria-label": `查看图片：${a.name}` } });
      button.createEl("img", { attr: { src: url(plugin, a), alt: a.name, loading: "lazy" } });
      if (!expanded && bottom.length > 4 && i === 3) {
        button.createSpan({ cls: "gloss-image-more", text: `+${bottom.length - 3}` });
        button.setAttribute("aria-label", `展开全部 ${bottom.length} 张图片`);
        button.onclick = () => { expanded = true; draw(); };
      } else button.onclick = () => viewImages(plugin, images, a);
    });
  }
  draw();
}

/** Draft-only composer: no note mutation before Save. Uploads serialize to prevent filename collisions. */
export function imageComposer(plugin: GlossPlugin, root: HTMLElement, ta: HTMLTextAreaElement, noteId: string, attachments: GlossAttachment[]) {
  let chain: Promise<void> = Promise.resolve();
  let frozen = false;
  let pending = 0;
  const failures = new Set<string>();
  const actions = root.createDiv({ cls: "gloss-image-tools" });
  const add = actions.createEl("button", { text: "图片 / 附件" });
  const status = root.createDiv({ cls: "gloss-upload-status", attr: { role: "status", "aria-live": "polite" } });
  const gallery = root.createDiv({ cls: "gloss-image-editor-grid" });
  const hint = root.createDiv({ cls: "gloss-image-hint", text: "拖入图片 · 粘贴插图 · ⌘ / Ctrl + Enter 保存" });
  let dragged = "";
  const render = () => {
    gallery.empty();
    for (const a of attachments) {
      const tile = gallery.createDiv({ cls: "gloss-image-edit-tile" });
      tile.draggable = !frozen;
      tile.ondragstart = e => { dragged = a.id; e.dataTransfer?.setData("text/gloss-image", a.id); };
      tile.ondragover = e => e.preventDefault();
      tile.ondrop = e => {
        if (e.dataTransfer?.files.length) return;
        e.preventDefault(); e.stopPropagation();
        if (!frozen && dragged) { moveAttachment(attachments, dragged, a.id); dragged = ""; render(); }
      };
      if (a.kind === "image") {
        const thumb = tile.createEl("button", { cls: "gloss-image-tile", attr: { "aria-label": `查看图片：${a.name}` } });
        thumb.createEl("img", { attr: { src: url(plugin, a), alt: a.name } });
        thumb.onclick = () => viewImages(plugin, attachments.filter(x => x.kind === "image"), a);
      }
      tile.createDiv({ cls: "gloss-image-name", text: a.name });
      const row = tile.createDiv({ cls: "gloss-image-tools" });
      if (a.kind === "image") {
        const inline = isInline(ta.value, a);
        const place = row.createEl("button", { text: inline ? "移到底部" : "插入正文" });
        place.disabled = frozen;
        place.onmousedown = e => e.preventDefault();
        place.onclick = () => {
          if (inline) ta.value = removeInline(ta.value, a);
          else ta.setRangeText(`\n${imageMarkdown(a)}\n`, ta.selectionStart, ta.selectionEnd, "end");
          ta.focus(); render();
        };
      }
      const move = row.createEl("button", { text: "前移" });
      const index = attachments.indexOf(a);
      move.disabled = frozen || index === 0;
      move.onclick = () => { moveAttachment(attachments, a.id, attachments[index - 1].id); render(); };
      const remove = row.createEl("button", { text: "移除" });
      remove.disabled = frozen;
      remove.title = "移除批注中的引用，保留原始文件";
      remove.onclick = () => { ta.value = removeInline(ta.value, a); attachments.splice(attachments.indexOf(a), 1); render(); };
    }
  };
  const upload = (files: File[], inline = false) => {
    if (frozen || !root.isConnected) return;
    // Placeholder captures insertion position before asynchronous file I/O; later typing does not move it.
    for (const f of files) {
      const isImage = f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(f.name);
      const marker = inline && isImage ? `<!--gloss-upload-${uuid()}-->` : "";
      if (marker) ta.setRangeText(marker, ta.selectionStart, ta.selectionEnd, "end");
      pending++;
      status.setText(`正在保存 ${pending} 个附件…`);
      chain = chain.then(async () => {
        try {
          const folder = await plugin.storage.ensureAttachmentsDir();
          const path = await plugin.storage.saveBinary(folder, noteId, f.name.replace(/[\\/:*?"<>|]/g, "_"), f);
          const a: GlossAttachment = { id: uuid(), path, name: f.name, mime: f.type || "application/octet-stream", size: f.size,
            kind: isImage ? "image" : f.type.startsWith("audio/") ? "audio" : f.type.startsWith("video/") ? "video" : "file" };
          attachments.push(a);
          if (marker) ta.value = ta.value.replace(marker, `\n${imageMarkdown(a)}\n`);
        } catch (error) {
          if (marker) ta.value = ta.value.replace(marker, "");
          failures.add(f.name);
          new Notice(`附件 ${f.name} 保存失败：${String(error)}`);
        } finally {
          pending--;
          if (root.isConnected) { updateStatus(); render(); }
        }
      });
    }
  };
  function updateStatus(): void {
    status.empty();
    if (pending) status.setText(`正在保存 ${pending} 个附件…`);
    else if (failures.size) {
      status.createSpan({ text: `未上传：${Array.from(failures).join("、")}。请重新添加，或` });
      const ignore = status.createEl("button", { text: "忽略失败附件" });
      ignore.onclick = () => { failures.clear(); updateStatus(); };
    } else status.setText("");
  }
  add.onclick = () => {
    const input = root.createEl("input", { type: "file", attr: { multiple: "multiple" } });
    input.hidden = true;
    input.oncancel = () => input.remove();
    input.onchange = () => { const files = Array.from(input.files ?? []); files.forEach(f => failures.delete(f.name)); upload(files); input.remove(); };
    input.click();
  };
  ta.addEventListener("input", render);
  ta.addEventListener("paste", e => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); upload(files, true); }
  });
  root.addEventListener("dragover", e => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
  root.addEventListener("drop", e => {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) { e.preventDefault(); e.stopPropagation(); upload(files); }
  });
  render();
  return {
    actions, gallery,
    hasPending: () => pending > 0,
    async ready(): Promise<void> { await chain; if (failures.size) throw new Error("部分附件上传失败，请重试或选择忽略失败附件"); },
    freeze(value: boolean): void { frozen = value; add.disabled = value; ta.disabled = value; hint.hidden = value; render(); },
  };
}
