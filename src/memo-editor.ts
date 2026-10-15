import { Component, MarkdownRenderer, Notice } from "obsidian";
import type GlossPlugin from "./main";
import type { GlossAttachment } from "./types";
import { imageComposer, renderGallery } from "./images";
import { renderImageReferences } from "./image-model";

/** One draft surface for creation and editing; textarea values must be assigned as properties on older Obsidian. */
export function createMemoEditor(plugin: GlossPlugin, parent: HTMLElement, initial: string, noteId: string, attachments: GlossAttachment[], docPath: string) {
  const shell = parent.createDiv({ cls: "gloss-memo-editor" });
  const tabs = shell.createDiv({ cls: "gloss-memo-tabs" });
  const edit = tabs.createEl("button", { text: "编辑", attr: { "aria-pressed": "true" } });
  const previewButton = tabs.createEl("button", { text: "预览", attr: { "aria-pressed": "false" } });
  const input = shell.createEl("textarea", { cls: "gloss-memo-input", attr: { "aria-label": "批注正文（支持 Markdown）" } });
  input.value = initial;
  input.placeholder = "写下你的想法…";
  const preview = shell.createDiv({ cls: "gloss-memo-preview gloss-card-body" });
  preview.hidden = true;
  const composer = imageComposer(plugin, shell, input, noteId, attachments);
  const footer = shell.createDiv({ cls: "gloss-memo-footer" });
  footer.appendChild(composer.actions);
  const buttons = footer.createDiv({ cls: "gloss-memo-buttons" });
  let token = 0;
  let disposed = false;
  let component: Component | null = null;
  function clearPreview(): void { token++; component?.unload(); component = null; preview.empty(); }
  edit.onclick = () => {
    clearPreview();
    input.hidden = false; preview.hidden = true; composer.gallery.hidden = false;
    edit.setAttribute("aria-pressed", "true"); previewButton.setAttribute("aria-pressed", "false");
    input.focus();
  };
  previewButton.onclick = async () => {
    clearPreview();
    const seq = token;
    input.hidden = true; preview.hidden = false; composer.gallery.hidden = true;
    edit.setAttribute("aria-pressed", "false"); previewButton.setAttribute("aria-pressed", "true");
    preview.setText("正在准备预览…");
    const comp = new Component();
    component = comp;
    comp.load();
    const body = parent.ownerDocument.createElement("div");
    try {
      await composer.ready();
      if (disposed || seq !== token || !shell.isConnected) return;
      const markdown = renderImageReferences(input.value, attachments, a => plugin.app.vault.adapter.getResourcePath(a.path));
      await MarkdownRenderer.render(plugin.app, markdown, body, docPath, comp);
      if (disposed || seq !== token || !shell.isConnected) return;
      if (!input.value.trim()) body.createSpan({ cls: "gloss-empty", text: "还没有正文" });
      renderGallery(plugin, body, attachments, input.value);
      for (const a of attachments.filter(a => a.kind !== "image")) body.createDiv({ cls: "gloss-image-name", text: a.name });
      preview.empty(); preview.appendChild(body);
    } catch (error) {
      if (!disposed && seq === token) { preview.setText("预览失败，请返回编辑后重试。"); new Notice(String(error)); }
    } finally {
      if (disposed || seq !== token || !shell.isConnected) comp.unload();
    }
  };
  return {
    input, buttons,
    ready: composer.ready,
    hasPending: composer.hasPending,
    freeze(value: boolean): void { composer.freeze(value); previewButton.disabled = value; edit.disabled = value; },
    dispose(): void { disposed = true; clearPreview(); composer.dispose(); },
  };
}
