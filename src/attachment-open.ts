import { FileSystemAdapter, Notice, Platform, TFile, type Component } from "obsidian";
import type GlossPlugin from "./main";
import type { GlossAttachment } from "./types";
import { rewriteAttachmentDefinitions } from "./image-model";

/** Hidden attachments are absent from Vault's TFile index. Use the adapter for them. */
export async function openAttachment(plugin: GlossPlugin, a: GlossAttachment, doc: Document): Promise<void> {
  if (!a.path || /^[\\/]|^[a-z]:/i.test(a.path) || a.path.includes("\\") || a.path.split("/").some(p => p === "." || p === "..")) {
    throw new Error(`附件路径无效：${a.name}`);
  }
  const { vault, workspace } = plugin.app;
  const file = vault.getAbstractFileByPath(a.path);
  if (file instanceof TFile) {
    await workspace.getLeaf(false).openFile(file);
    return;
  }
  const adapter = vault.adapter;
  if ((await adapter.stat(a.path))?.type !== "file") throw new Error(`附件缺失或尚未同步：${a.name}`);
  if (Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
    // getFullPath accepts a vault path, not a URL: do not decode literal '%' characters.
    const { shell } = require("electron") as { shell: { openPath(path: string): Promise<string> } };
    const error = await shell.openPath(adapter.getFullPath(a.path));
    if (error) throw new Error(`无法打开附件：${error}`);
    return;
  }

  // Mobile does not expose Electron. Offer the actual bytes to the system share
  // sheet where supported; otherwise use a browser download in the owning window.
  const win = doc.defaultView;
  if (!win) throw new Error("附件窗口已关闭");
  const binary = await adapter.readBinary(a.path);
  const blob = new win.Blob([binary], { type: a.mime || "application/octet-stream" });
  const shared = new win.File([blob], a.name, { type: blob.type });
  if (win.navigator.canShare?.({ files: [shared] })) {
    try {
      await win.navigator.share({ files: [shared] });
      return;
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      // Some embedded browsers expose sharing but disallow it after an async read.
    }
  }
  const url = win.URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = a.name;
  link.style.display = "none";
  doc.body.appendChild(link);
  try { link.click(); }
  finally {
    link.remove();
    // Let the browser consume the download before releasing its backing bytes.
    win.setTimeout(() => win.URL.revokeObjectURL(url), 60_000);
  }
}


/** Resolve registered link destinations before Obsidian's internal-link decoder sees them. */
export function renderAttachmentLinks(content: string, attachments: GlossAttachment[], resource: (a: GlossAttachment) => string): string {
  content = content.replace(/(!?)\[([^\]\n]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)|(!?)\[\[([^\]|]+)(\|[^\]]*)?\]\]/g,
    (ref, image, label, anglePath, plainPath, title, wikiImage, wikiPath, alias) => {
      if (image || wikiImage) return ref;
      let path = wikiPath ?? anglePath ?? plainPath;
      // Markdown links are URLs; Wiki links contain literal vault paths. Never try both.
      if (wikiPath === undefined) {
        try { path = decodeURIComponent(path); } catch { /* Match malformed escapes literally. */ }
      }
      const a = attachments.find(a => a.path === path);
      if (!a) return ref;
      const text = wikiPath === undefined ? label : (alias?.slice(1) ?? wikiPath).replace(/[\\[\]]/g, "\\$&");
      return `[${text}](<${resource(a)}>${title ?? ""})`;
    });
  for (const a of attachments) content = rewriteAttachmentDefinitions(content, a, resource(a));
  return content;
}

/** Capture handled links before Obsidian tries to resolve hidden files as TFiles. */
export function bindAttachmentLinks(plugin: GlossPlugin, root: HTMLElement, attachments: GlossAttachment[], component: Component,
  resource: (a: GlossAttachment) => string = a => plugin.app.vault.adapter.getResourcePath(a.path)): void {
  const resources = new Map(attachments.map(a => [resource(a), a]));
  component.registerDomEvent(root, "click", event => {
    const link = (event.target as Element | null)?.closest?.("a");
    if (!link || !root.contains(link)) return;
    const a = resources.get(link.getAttribute("href") ?? "");
    if (!a) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void openAttachment(plugin, a, root.ownerDocument).catch(error => {
      new Notice(error instanceof Error ? error.message : String(error));
    });
  }, true);
}
