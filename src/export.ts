import { Notice, normalizePath, type TFile, type TFolder } from "obsidian";
import type GlossPlugin from "./main";
import type { GlossEntry } from "./types";
import { imageMarkdown, moveAttachmentReferences } from "./image-model";
import { fmtStamp, fmtTime, uuid } from "./util";

/** 文件名清洗（obsidian 1.13 d.ts 未导出 sanitizeFileName） */
function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^\[\]~]/g, "").trim().slice(0, 80) || "未命名";
}

/** 导出当前文档的全部批注为 Markdown 笔记。隐藏附件复制到可独立使用的可见目录。 */
export async function exportDocAnnotations(plugin: GlossPlugin, file: TFile): Promise<void> {
  const vault = plugin.app.vault;
  const copied: TFile[] = [];
  let assetFolder: TFolder | undefined;
  try {
    const store = await plugin.storage.loadDoc(file.path);
    if (!store.entries.length) {
      new Notice("该文档还没有批注");
      return;
    }
    // Async copies must not rewrite the live annotation store or mix later edits into this export.
    const entries: GlossEntry[] = JSON.parse(JSON.stringify(store.entries));
    const base = `Gloss批注导出 - ${sanitizeName(file.basename)} - ${fmtStamp(Date.now())} - ${uuid().slice(0, 8)}`;
    let stem = base, suffix = 1;
    while (await vault.adapter.exists(`${stem}.md`) || await vault.adapter.exists(`${stem}.assets`)) {
      stem = `${base}-${suffix++}`;
    }
    const name = normalizePath(`${stem}.md`);
    const moved = new Map<string, string>();
    const checked = new Set<string>();
    for (const e of entries) {
      for (const a of e.note.attachments) {
        if (checked.has(a.path)) continue;
        checked.add(a.path);
        if (!await vault.adapter.exists(a.path)) throw new Error(`附件不存在：${a.path}`);
        if (!a.path.split("/").some(part => part.startsWith("."))) continue;
        const bytes = await vault.adapter.readBinary(a.path);
        assetFolder ??= await vault.createFolder(normalizePath(`${stem}.assets`));
        // A numeric prefix keeps duplicate basenames distinct and dotfiles visible.
        const originalName = a.path.split("/").pop() || a.name;
        const dot = originalName.lastIndexOf(".");
        const filename = dot > 0
          ? sanitizeName(originalName.slice(0, dot)) + sanitizeName(originalName.slice(dot))
          : sanitizeName(originalName);
        const dest = normalizePath(`${assetFolder.path}/${moved.size + 1}-${filename}`);
        copied.push(await vault.createBinary(dest, bytes));
        moved.set(a.path, dest);
      }
    }
    for (const e of entries) {
      for (const a of e.note.attachments) {
        const dest = moved.get(a.path);
        if (!dest) continue;
        e.note.content = moveAttachmentReferences(e.note.content, a, dest);
        for (const r of e.note.replies) r.content = moveAttachmentReferences(r.content, a, dest);
        a.path = dest;
      }
    }
    const lines: string[] = [];
    lines.push(`# ${file.basename} — Gloss 批注导出`);
    lines.push("");
    lines.push(`> 导出于 ${new Date().toLocaleString()} · 共 ${entries.length} 条`);
    for (const e of entries) {
      const t = plugin.storage.typeOf(e.note.typeId);
      const src = e.anchor.kind === "md"
        ? e.anchor.text
        : `PDF p.${e.anchor.page}${e.anchor.text ? " " + e.anchor.text : " [区域]"}`;
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(`## ${t.emoji} ${t.name} · ${fmtTime(e.note.createdAt)}`);
      lines.push("");
      lines.push(`> ${src.replace(/\n/g, " ")}`);
      lines.push("");
      lines.push(e.note.content.trim() ? e.note.content : "（无内容）");
      for (const r of e.note.replies) {
        lines.push("");
        lines.push(`- ↳ 回复 · ${fmtTime(r.createdAt)}：${r.content.replace(/\n/g, " ")}`);
      }
      for (const a of e.note.attachments) {
        // The shared image encoder also safely encodes ordinary attachment destinations.
        lines.push(`- 📎 附件：${imageMarkdown(a).slice(1)}`);
      }
    }
    await vault.create(name, lines.join("\n"));
    new Notice(`已导出：${name}`);
  } catch (e) {
    // Only remove copies created by this attempt, never existing/source attachments.
    for (const file of copied.reverse()) {
      try { await vault.delete(file); } catch { /* Best-effort cleanup; preserve the original failure. */ }
    }
    if (assetFolder) {
      try {
        const remaining = await vault.adapter.list(assetFolder.path);
        if (!remaining.files.length && !remaining.folders.length) await vault.delete(assetFolder);
      } catch { /* An interrupted export may leave an empty folder. */ }
    }
    new Notice(`导出失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
