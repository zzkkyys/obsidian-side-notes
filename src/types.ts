// ---------- 锚点 ----------

/** Markdown 锚点：blockId 可空（空时按文本全文搜索重锚）；start/end 为块内渲染纯文本坐标 */
export interface MdAnchor {
  kind: "md";
  blockId: string;
  start: number;
  end: number;
  text: string;
  /** 创建时的块文本与选区上下文，用于区分重复句子。 */
  blockText?: string;
  prefix?: string;
  suffix?: string;
  /** 编辑器原始文档坐标；与渲染后的块内坐标分开保存。 */
  source?: { from: number; to: number; text: string; prefix?: string; suffix?: string };
}

/** PDF 锚点：page 1-based；bbox 为归一化 0-1 区域 [x0,y0,x1,y1]（相对页面） */
export interface PdfAnchor {
  kind: "pdf";
  page: number;
  text: string;
  bbox?: [number, number, number, number];
}

export type Anchor = MdAnchor | PdfAnchor;

// ---------- 批注 ----------

export interface GlossReply {
  id: string;
  content: string;
  createdAt: number;
}

export type AttachmentKind = "audio" | "image" | "video" | "file";

export interface GlossAttachment {
  id: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
}

export interface GlossAnnotation {
  id: string;
  typeId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  replies: GlossReply[];
  attachments: GlossAttachment[];
}

/** 一条批注 = 锚点 + 批注体（note 字段名避免与 Obsidian TFile 混淆） */
export interface GlossEntry {
  anchor: Anchor;
  note: GlossAnnotation;
}

/** .gloss/annotations/<safePath>.json 的文件结构 */
export interface GlossDocStore {
  version: 1;
  docPath: string;
  kind: "md" | "pdf";
  entries: GlossEntry[];
}

// ---------- 批注类型 ----------

export interface GlossType {
  id: string;
  name: string;
  color: string;
  emoji: string;
  builtin?: boolean;
  order: number;
}

/** 类型被删除后的兜底显示 */
export const GHOST_TYPE: GlossType = {
  id: "__ghost",
  name: "已删除类型",
  color: "#8a8f98",
  emoji: "🗑",
  order: 9999,
};

export function defaultTypes(): GlossType[] {
  return [
    { id: "correction", name: "错误纠正", color: "#e5484d", emoji: "🔧", builtin: true, order: 0 },
    { id: "supplement", name: "内容补充", color: "#3b82f6", emoji: "📝", builtin: true, order: 1 },
    { id: "question", name: "提问质疑", color: "#e8843c", emoji: "❓", builtin: true, order: 2 },
    { id: "idea", name: "灵感记录", color: "#f5a524", emoji: "💡", builtin: true, order: 3 },
    { id: "general", name: "一般批注", color: "#30a46c", emoji: "💬", builtin: true, order: 4 },
  ];
}

/** Resolve historical built-in IDs without rewriting annotation documents. */
export function currentTypeId(id: string): string {
  return id === "key" || id === "review" ? "general" : id === "reference" ? "supplement" : id;
}

export function migrateBuiltinTypes(types: GlossType[]): GlossType[] {
  if (!types.some(t => t.builtin && ["key", "review", "reference"].includes(t.id))) return types;
  const defaults = defaultTypes();
  const builtinIds = new Set(["correction", "idea", "question", "key", "review", "reference"]);
  const remaining = types.filter(t => !t.builtin || !builtinIds.has(t.id));
  const result = defaults.map(t => {
    const existing = types.find(old => old.id === t.id);
    return existing ? { ...existing, name: t.name, order: t.order } : t;
  });
  for (const t of remaining) {
    if (!result.some(r => r.id === t.id)) result.push({ ...t, order: result.length });
  }
  return result;
}

// ---------- 设置 ----------

export interface GlossSettings {
  layoutMode: "auto" | "margin" | "bubble";
  wideBreakpoint: number;
  marginWidth: number;
  highlightStyle: "underline" | "rough";
  cardStyle: "plain" | "glass";
  defaultTypeId: string;
  attachmentsFolder: string;
  pdfEnabled: boolean;
}

export function defaultSettings(): GlossSettings {
  return {
    layoutMode: "auto",
    wideBreakpoint: 1280,
    marginWidth: 240,
    highlightStyle: "underline",
    cardStyle: "plain",
    defaultTypeId: "general",
    attachmentsFolder: "gloss-attachments",
    pdfEnabled: true,
  };
}

// ---------- 存储路径 ----------

export const GLOSS_DIR = ".gloss";
export const ANN_DIR = `${GLOSS_DIR}/annotations`;

/**
 * 路径 → 批注文件名编码（单遍扫描，无损可逆）：`_` → `__`，`/` → `/_`。
 * 编码与解码一一对应、无歧义。
 * 旧版 v0 直接 `/` → `__`（有损，`a__b.md` 与 `a/b.md` 会撞名），
 * 存量文件由 storage.loadDoc 校验 docPath 后自动迁移。
 */
export function safePath(p: string): string {
  let out = "";
  for (const c of p) out += c === "_" ? "__" : c === "/" ? "/_" : c;
  return out;
}

/** safePath 的逆运算：`__` → `_`，`/_` → `/` */
export function unsafePath(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "_" && s[i + 1] === "_") { out += "_"; i++; continue; }
    if (s[i] === "/" && s[i + 1] === "_") { out += "/"; i++; continue; }
    out += s[i];
  }
  return out;
}

/** 旧版编码（有损），仅用于定位待迁移的存量文件 */
export function legacySafePath(p: string): string {
  return p.replace(/\//g, "__");
}

export function isMdPath(p: string): boolean {
  return /\.md$/i.test(p);
}
