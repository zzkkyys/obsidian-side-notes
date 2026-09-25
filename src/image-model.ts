import type { GlossAttachment } from "./types";

/** Vault-root-relative Markdown URLs, escaped even for parentheses and spaces. */
export function imageMarkdown(a: GlossAttachment): string {
  const path = a.path.split("/").map(p => encodeURIComponent(p).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)).join("/");
  return `![${a.name.replace(/[\\\[\]\r\n]/g, "_")}](<${path}>)`;
}

/** Match by destination, so editing alt text does not duplicate the bottom thumbnail. */
function references(content: string, a: GlossAttachment): string[] {
  const refs: string[] = [];
  const pattern = /!\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))\s*\)|!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    let path = match[1] ?? match[2] ?? match[3];
    if (path === a.path) { refs.push(match[0]); continue; }
    try { path = decodeURIComponent(path); } catch { /* Literal percent in legacy vault paths. */ }
    if (path === a.path) refs.push(match[0]);
  }
  return refs;
}

export function isInline(content: string, a: GlossAttachment): boolean {
  return references(content, a).length > 0;
}

export function removeInline(content: string, a: GlossAttachment): string {
  for (const ref of references(content, a)) content = content.split(ref).join("");
  return content;
}

/** Render registered attachments using Obsidian's resource URL, bypassing its internal-link decoder.
 * Stored Markdown stays portable; old percent-encoded links are repaired at display time too.
 */
export function renderImageReferences(content: string, attachments: GlossAttachment[], resource: (a: GlossAttachment) => string): string {
  for (const a of attachments) {
    if (a.kind !== "image") continue;
    for (const ref of references(content, a)) {
      const label = a.name.replace(/[\\\[\]\r\n]/g, "_");
      content = content.split(ref).join(`![${label}](<${resource(a)}>)`);
    }
  }
  return content;
}

export function moveAttachment(items: GlossAttachment[], id: string, target: string): void {
  const from = items.findIndex(a => a.id === id), to = items.findIndex(a => a.id === target);
  if (from < 0 || to < 0 || from === to) return;
  items.splice(to, 0, items.splice(from, 1)[0]);
}
