import { Notice, normalizePath, type TFile } from "obsidian";
import type GlossPlugin from "./main";
import { fmtStamp, fmtTime } from "./util";

/** 文件名清洗（obsidian 1.13 d.ts 未导出 sanitizeFileName） */
function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|#^\[\]~]/g, "").trim().slice(0, 80) || "未命名";
}

/** 导出当前文档的全部批注为 Markdown 笔记 */
export async function exportDocAnnotations(plugin: GlossPlugin, file: TFile): Promise<void> {
  const store = await plugin.storage.loadDoc(file.path);
  if (!store.entries.length) {
    new Notice("该文档还没有批注");
    return;
  }
  const lines: string[] = [];
  lines.push(`# ${file.basename} — Gloss 批注导出`);
  lines.push("");
  lines.push(`> 导出于 ${new Date().toLocaleString()} · 共 ${store.entries.length} 条`);
  for (const e of store.entries) {
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
      // 路径含空格/括号会破坏 Markdown 链接：逐段编码，名称去掉 []
      const label = a.name.replace(/[\[\]]/g, "");
      const href = a.path.split("/").map(encodeURIComponent).join("/");
      lines.push(`- 📎 附件：[${label}](${href})`);
    }
  }
  const name = normalizePath(`Gloss批注导出 - ${sanitizeName(file.basename)} - ${fmtStamp(Date.now())}.md`);
  try {
    await plugin.app.vault.create(name, lines.join("\n"));
    new Notice(`已导出：${name}`);
  } catch (e) {
    new Notice(`导出失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
