import type { GlossAttachment } from "./types";

/** Vault-root-relative Markdown URLs, escaped even for parentheses and spaces. */
export function imageMarkdown(a: GlossAttachment): string {
  const path = a.path.split("/").map(p => encodeURIComponent(p).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)).join("/");
  return `![${a.name.replace(/[\\\[\]\r\n]/g, "_")}](<${path}>)`;
}

/** Match by destination, so editing alt text does not duplicate the bottom thumbnail. */
function references(content: string, a: GlossAttachment): string[] {
  const refs: string[] = [];
  const pattern = /!\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)|!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    let path = match[1] ?? match[2] ?? match[3];
    // Markdown destinations are URLs; Wiki embeds name literal vault paths.
    // Matching both raw and decoded URLs aliases "my%20photo.png" to "my photo.png".
    if (match[3] === undefined) {
      try { path = decodeURIComponent(path); } catch { /* Keep malformed percent escapes literal. */ }
    }
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
    content = rewriteAttachmentDefinitions(content, a, resource(a));
  }
  return content;
}

export function moveAttachment(items: GlossAttachment[], id: string, target: string): void {
  const from = items.findIndex(a => a.id === id), to = items.findIndex(a => a.id === target);
  if (from < 0 || to < 0 || from === to) return;
  items.splice(to, 0, items.splice(from, 1)[0]);
}

/** Alt labels need not be unique; match the resource destination only. */
export function attachmentForSource(images: GlossAttachment[], source: string, resource: (a: GlossAttachment) => string): GlossAttachment | undefined {
  return images.find(a => resource(a) === source);
}

export function moveImageReferences(content: string, attachment: GlossAttachment, newPath: string): string {
  for (const ref of references(content, attachment)) content = content.split(ref).join(imageMarkdown({ ...attachment, path: newPath }));
  return content;
}

/** Move registered attachment destinations in images, ordinary links and Wiki links. */
export function moveAttachmentReferences(content: string, attachment: GlossAttachment, newPath: string): string {
  const encoded = newPath.split("/").map(p => encodeURIComponent(p).replace(/[!'()*]/g,
    c => `%${c.charCodeAt(0).toString(16)}`)).join("/");
  content = content.replace(/(!?)\[([^\]\n]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)|(!?)\[\[([^\]|]+)(\|[^\]]*)?\]\]/g,
    (ref, image, label, anglePath, plainPath, title, wikiImage, wikiPath, alias) => {
      let path = wikiPath ?? anglePath ?? plainPath;
      if (wikiPath === undefined) {
        try { path = decodeURIComponent(path); } catch { /* Match malformed escapes literally. */ }
      }
      if (path !== attachment.path) return ref;
      return wikiPath === undefined ? `${image}[${label}](<${encoded}>${title ?? ""})` : `${wikiImage}[[${newPath}${alias ?? ""}]]`;
    });
  return rewriteAttachmentDefinitions(content, attachment, encoded);
}

/** Reference-style links keep their label and optional title; only the exact URL changes. */
export function rewriteAttachmentDefinitions(content: string, attachment: GlossAttachment, destination: string): string {
  return content.replace(/^([ ]{0,3}\[[^\]\r\n]+\]:[ \t]*)(?:<([^>\r\n]+)>|([^\s]+))/gm,
    (ref, prefix, anglePath, plainPath) => {
      let path = anglePath ?? plainPath;
      try { path = decodeURIComponent(path); } catch { /* Match malformed escapes literally. */ }
      return path === attachment.path ? `${prefix}<${destination}>` : ref;
    });
}
