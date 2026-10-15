import type { App, DataAdapter } from "obsidian";
import { moveAttachmentReferences } from "./image-model";
import { ATTACHMENTS_DIR, LEGACY_ATTACHMENTS_DIR, type GlossAttachment, type GlossDocStore } from "./types";

const LEGACY = LEGACY_ATTACHMENTS_DIR;
const TARGET = ATTACHMENTS_DIR;
const ANNOTATIONS = ".gloss/annotations/";

type Metadata = { path: string; raw: string; data: unknown; store?: GlossDocStore };
type Move = { source: string; target: string };
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const parent = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

async function ensureDir(adapter: DataAdapter, path: string): Promise<void> {
  if (!path) return;
  if (await placeholder(adapter, path)) throw new Error(`附件迁移等待同步完成：${path}`);
  if (await adapter.exists(path)) return;
  await ensureDir(adapter, parent(path));
  await adapter.mkdir(path);
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  return x.length === y.length && x.every((value, index) => value === y[index]);
}

/** Do not create over an undownloaded iCloud file, even when exists() is false. */
async function placeholder(adapter: DataAdapter, path: string): Promise<boolean> {
  const dir = parent(path);
  return await adapter.exists(`${path}.icloud`) || await adapter.exists(`${dir ? dir + "/" : ""}.${basename(path)}.icloud`);
}

async function filesBelow(adapter: DataAdapter, root: string, skip?: string): Promise<string[]> {
  if (await placeholder(adapter, root)) throw new Error(`附件迁移等待同步完成：${root}`);
  if (!(await adapter.exists(root))) return [];
  const result: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const listing = await adapter.list(dir);
    for (const file of listing.files) {
      const path = `${dir}/${basename(file)}`;
      if (path.endsWith(".icloud")) throw new Error(`附件迁移等待同步完成：${path}`);
      result.push(path);
    }
    for (const folder of listing.folders) {
      const path = `${dir}/${basename(folder)}`;
      if (path !== skip) await visit(path);
    }
  };
  await visit(root);
  return result.sort();
}

/** Read directly from disk: a partial index or swallowed read error is unsafe for migration. */
async function metadata(adapter: DataAdapter): Promise<Metadata[]> {
  const records: Metadata[] = [];
  for (const path of await filesBelow(adapter, ".gloss", TARGET)) {
    if (!path.endsWith(".json")) continue;
    const raw = await adapter.read(path);
    const data = JSON.parse(raw);
    const record: Metadata = { path, raw, data };
    if (path.startsWith(ANNOTATIONS)) {
      if (!data || data.version !== 1 || typeof data.docPath !== "string" || !Array.isArray(data.entries)
        || data.entries.some((entry: any) => !entry?.note || typeof entry.note.content !== "string"
          || !Array.isArray(entry.note.attachments) || entry.note.attachments.some((a: any) => !a || typeof a.path !== "string")
          || !Array.isArray(entry.note.replies) || entry.note.replies.some((r: any) => !r || typeof r.content !== "string"))) {
        throw new Error(`附件迁移无法核实批注文件：${path}`);
      }
      record.store = data;
    }
    records.push(record);
  }
  return records;
}

/** The vault index may still be warming up during startup; scan notes from disk. */
async function userNotes(adapter: DataAdapter): Promise<Array<{ path: string; text: string }>> {
  const result: Array<{ path: string; text: string }> = [];
  const visit = async (dir: string): Promise<void> => {
    const listing = await adapter.list(dir);
    for (const item of listing.files) {
      const name = basename(item), path = dir ? `${dir}/${name}` : name;
      if (name.endsWith(".icloud")) throw new Error(`附件迁移等待笔记同步完成：${path}`);
      if (/\.(md|canvas)$/i.test(name)) result.push({ path, text: await adapter.read(path) });
    }
    for (const folder of listing.folders) {
      const name = basename(folder);
      if (!name.startsWith(".")) await visit(dir ? `${dir}/${name}` : name);
    }
  };
  await visit("");
  return result;
}

function attachment(path: string): GlossAttachment {
  return { id: "", name: basename(path), path, kind: "image", size: 0, mime: "" };
}

function rewrite(store: GlossDocStore, moves: Move[]): void {
  for (const { note } of store.entries) {
    for (const move of moves) {
      const original = note.attachments.find(a => a.path === move.source) ?? attachment(move.source);
      note.content = moveAttachmentReferences(note.content, original, move.target);
      for (const reply of note.replies) reply.content = moveAttachmentReferences(reply.content, original, move.target);
      for (const item of note.attachments) if (item.path === move.source) item.path = move.target;
    }
  }
}

function pathMention(text: string, path: string, broad: boolean): boolean {
  const names = [path, encodeURI(path), path.split("/").map(encodeURIComponent).join("/")];
  if (broad) names.push(basename(path), encodeURIComponent(basename(path)));
  // Raw HTML and other unsupported syntax may not be rewritten by the Markdown parser.
  // Recognize percent-escaped paths too so unsupported syntax keeps its original.
  const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, value => {
    try { return decodeURIComponent(value); } catch { return value; }
  });
  return names.some(name => text.includes(name) || decoded.includes(name));
}

function storeRefers(store: GlossDocStore, path: string): boolean {
  // Include unknown fields/legacy metadata, but do not mistake an attachment's display name
  // for an old reference after its path has been migrated.
  if (pathMention(JSON.stringify(store), path, false)) return true;
  const file = attachment(path), short = { ...file, path: file.name };
  for (const { note } of store.entries) {
    for (const content of [note.content, ...note.replies.map(reply => reply.content)]) {
      if (moveAttachmentReferences(content, file, "__gloss_reference_probe__") !== content
        || moveAttachmentReferences(content, short, "__gloss_reference_probe__") !== content) return true;
    }
  }
  return false;
}

async function copyVerified(adapter: DataAdapter, source: string): Promise<Move> {
  const bytes = await adapter.readBinary(source);
  const preferred = `${TARGET}/${source.slice(LEGACY.length + 1)}`;
  await ensureDir(adapter, parent(preferred));
  const name = basename(preferred), dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let serial = 0; ; serial++) {
    const target = serial ? `${parent(preferred)}/${stem} (${serial})${ext}` : preferred;
    if (await placeholder(adapter, target)) throw new Error(`附件迁移等待同步完成：${target}`);
    if (await adapter.exists(target)) {
      if (sameBytes(bytes, await adapter.readBinary(target))) return { source, target };
      continue;
    }
    await adapter.writeBinary(target, bytes);
    if (!sameBytes(bytes, await adapter.readBinary(target))) throw new Error(`附件复制校验失败：${source}`);
    return { source, target };
  }
}

/** Preserve the entire annotation document before any possibly partial adapter write. */
async function backupMetadata(adapter: DataAdapter, record: Metadata): Promise<string> {
  const base = `.trash/gloss-attachment-migration/${record.path}`;
  await ensureDir(adapter, parent(base));
  for (let serial = 0; ; serial++) {
    const path = serial ? `${base}.${serial}` : base;
    if (await placeholder(adapter, path)) throw new Error(`附件迁移等待备份同步完成：${path}`);
    if (await adapter.exists(path)) {
      if (await adapter.read(path) === record.raw) return path;
      continue;
    }
    await adapter.write(path, record.raw);
    if (await adapter.read(path) !== record.raw) throw new Error(`附件迁移备份校验失败：${path}`);
    return path;
  }
}

/** FileSystemAdapter.rmdir(path, false) is not supported by every desktop runtime.
 * Only trash a freshly checked empty directory; trashLocal keeps removal recoverable.
 */
async function removeEmptyDirs(adapter: DataAdapter, dir: string): Promise<void> {
  if (!(await adapter.exists(dir))) return;
  for (const folder of (await adapter.list(dir)).folders) await removeEmptyDirs(adapter, `${dir}/${basename(folder)}`);
  const listing = await adapter.list(dir);
  if (!listing.files.length && !listing.folders.length) await adapter.trashLocal(dir);
}

/** Startup-only migration, before storage caches, renderers or file listeners are installed.
 * Copies survive interrupted runs; deterministic collision names make retries idempotent.
 * Originals are retained until every changed JSON is verified and surviving references checked.
 */
export async function migrateLegacyAttachments(app: App): Promise<{ moved: number; retained: number }> {
  const adapter = app.vault.adapter;
  const sources = await filesBelow(adapter, LEGACY);
  if (!sources.length) {
    // Resume after an interrupted directory cleanup, even when all files were moved.
    await removeEmptyDirs(adapter, LEGACY);
    return { moved: 0, retained: 0 };
  }
  const records = await metadata(adapter);
  const moves: Move[] = [];
  for (const source of sources) moves.push(await copyVerified(adapter, source));
  for (const record of records) {
    if (!record.store) continue;
    const next = JSON.parse(record.raw) as GlossDocStore;
    rewrite(next, moves);
    if (JSON.stringify(next) === JSON.stringify(record.data)) continue;
    if (await adapter.read(record.path) !== record.raw) throw new Error(`附件迁移期间批注已变更：${record.path}`);
    const backup = await backupMetadata(adapter, record);
    if (await adapter.read(record.path) !== record.raw) throw new Error(`附件迁移期间批注已变更：${record.path}`);
    const raw = JSON.stringify(next, null, 2);
    try {
      await adapter.write(record.path, raw);
      if (await adapter.read(record.path) !== raw) throw new Error(`写入校验失败：${record.path}`);
    } catch (error) {
      // Do not restore blindly: a sync writer could own the current bytes. The intact
      // original stays available for recovery, alongside all original attachments.
      throw new Error(`附件迁移写入失败；原始批注备份：${backup}；${String(error)}`);
    }
  }

  // Any unreadable metadata/note aborts this stage before a single original is removed.
  const current = await metadata(adapter);
  const notes = await userNotes(adapter);
  const retained = new Set<string>();
  for (const move of moves) {
    if (notes.some(note => note.path === move.source || pathMention(note.text, move.source, true))
      || current.some(record => record.store ? storeRefers(record.store, move.source) : pathMention(JSON.stringify(record.data), move.source, true))) {
      retained.add(move.source);
    }
  }
  // A sync change after the first scan must not be silently overwritten or lose its source.
  for (const record of current) if (await adapter.read(record.path) !== record.raw) throw new Error(`附件迁移期间元数据已变更：${record.path}`);
  for (const note of notes) if (await adapter.read(note.path) !== note.text) throw new Error(`附件迁移期间笔记已变更：${note.path}`);
  let moved = 0;
  for (const move of moves) {
    if (retained.has(move.source)) continue;
    if (!sameBytes(await adapter.readBinary(move.source), await adapter.readBinary(move.target))) {
      throw new Error(`附件迁移期间文件已变更：${move.source}`);
    }
    // Keep a recoverable original in Obsidian's hidden local trash.
    await adapter.trashLocal(move.source);
    moved++;
  }
  await removeEmptyDirs(adapter, LEGACY);
  return { moved, retained: retained.size };
}
