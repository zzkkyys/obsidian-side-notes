import { similarContext } from "./anchor-context";
import { markerBackground } from "./highlight-style";
import { StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type GlossPlugin from "./main";
import type { MdAnchor } from "./types";
import { GlossBubble } from "./popover";

const refresh = StateEffect.define<null>();

/** 源码坐标独立于渲染坐标；重复文本必须由上下文消歧。 */
export function sourceRange(text: string, anchor: MdAnchor, project = true): { from: number; to: number } | null {
  const source = anchor.source;
  const needle = source?.text ?? anchor.text;
  if (!needle) return null;
  const matches: Array<{ from: number; to: number; score: number }> = [];
  for (let from = text.indexOf(needle); from >= 0; from = text.indexOf(needle, from + 1)) {
    const to = from + needle.length;
    const prefix = source?.prefix ?? anchor.prefix;
    const suffix = source?.suffix ?? anchor.suffix;
    const before = !prefix || similarContext(text.slice(Math.max(0, from - prefix.length), from), prefix);
    const after = !suffix || similarContext(text.slice(to, to + suffix.length), suffix);
    const score = (prefix && before ? 4 : 0) + (suffix && after ? 4 : 0) + (source?.from === from && before && after ? 1 : 0);
    matches.push({ from, to, score });
  }
  matches.sort((a, b) => b.score - a.score);
  if (!matches.length && !source && project) {
    // 阅读视图创建的引用不包含 Markdown 包装符；映射回源码字符坐标。
    const hidden = new Set<number>();
    const hide = (start: number, end: number) => { for (let i = start; i < end; i++) hidden.add(i); };
    for (const pattern of [/\*\*|__|~~|`/g, /^ {0,3}(?:#{1,6}|>|[-+*])\s/gm]) {
      for (const match of text.matchAll(pattern)) hide(match.index!, match.index! + match[0].length);
    }
    for (const match of text.matchAll(/\[([^\]]+)\]\([^)]*\)/g)) {
      hide(match.index!, match.index! + 1);
      hide(match.index! + 1 + match[1].length, match.index! + match[0].length);
    }
    const map: number[] = [];
    let plain = "";
    for (let i = 0; i < text.length; i++) if (!hidden.has(i)) { plain += text[i]; map.push(i); }
    const range = sourceRange(plain, anchor, false);
    return range ? { from: map[range.from], to: map[range.to - 1] + 1 } : null;
  }
  if (!matches.length || (matches.length > 1 && matches[0].score === matches[1].score)) return null;
  if (source && (source.prefix || source.suffix) && matches[0].score === 0) return null;
  return matches[0];
}

/** 由 CodeMirror 自己管理 span，编辑、虚拟滚动不会擦除或破坏其 DOM。 */
export class EditorHighlights {
  private views = new Set<EditorView>();
  constructor(private plugin: GlossPlugin) {}

  extension(): Extension {
    const owner = this;
    return ViewPlugin.fromClass(class {
      decorations: DecorationSet = Decoration.none;
      idle: ReturnType<typeof setTimeout> | null = null;
      constructor(readonly view: EditorView) {
        owner.views.add(view);
        this.rebuild();
        this.load();
      }
      load(): void {
        const path = this.view.state.field(editorInfoField, false)?.file?.path;
        if (path) void owner.plugin.storage.loadDoc(path).then(() => {
          if (owner.views.has(this.view) && owner.plugin.isAlive) owner.refresh(path);
        });
      }
      update(update: ViewUpdate): void {
        const oldPath = update.startState.field(editorInfoField, false)?.file?.path;
        const path = update.state.field(editorInfoField, false)?.file?.path;
        if (oldPath !== path) this.load();
        if (oldPath !== path || update.transactions.some(t => t.effects.some(e => e.is(refresh)))) {
          if (this.idle) clearTimeout(this.idle);
          this.idle = null;
          this.rebuild();
        } else if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
          if (this.idle) clearTimeout(this.idle);
          this.idle = setTimeout(() => {
            this.idle = null;
            if (owner.views.has(this.view) && owner.plugin.isAlive) this.view.dispatch({ effects: refresh.of(null) });
          }, 400);
        }
      }
      rebuild(): void {
        const path = this.view.state.field(editorInfoField, false)?.file?.path;
        const store = path ? owner.plugin.storage.docCacheFor(path) : undefined;
        const text = this.view.state.doc.toString();
        const marks = [];
        for (const entry of store?.entries ?? []) {
          if (entry.anchor.kind !== "md") continue;
          const range = sourceRange(text, entry.anchor);
          if (!range) continue;
          const color = owner.plugin.storage.typeOf(entry.note.typeId).color;
          const marker = owner.plugin.settings.highlightStyle === "rough" ? `; --gloss-marker-image: ${markerBackground(color)}` : "";
          marks.push(Decoration.mark({
            class: `gloss-hl gloss-hl-${owner.plugin.settings.highlightStyle}`,
            attributes: { "data-gloss-id": entry.note.id, style: `--gloss-color: ${color}${marker}` },
          }).range(range.from, range.to));
        }
        this.decorations = Decoration.set(marks, true);
      }
      destroy(): void { if (this.idle) clearTimeout(this.idle); owner.views.delete(this.view); }
    }, {
      decorations: instance => instance.decorations,
      eventHandlers: {
        click(event, view) {
          // Plain click places the caret; Mod-click explicitly opens the annotation.
          if (!event.metaKey && !event.ctrlKey) return false;
          const mark = (event.target as HTMLElement).closest<HTMLElement>(".gloss-hl");
          const path = view.state.field(editorInfoField, false)?.file?.path;
          const store = path ? owner.plugin.storage.docCacheFor(path) : undefined;
          const entry = store?.entries.find(e => e.note.id === mark?.dataset.glossId);
          if (!mark || !store || !entry) return false;
          GlossBubble.show(owner.plugin, entry, owner.plugin.storage.typeOf(entry.note.typeId), mark, store);
          return true;
        },
      },
    });
  }

  refresh(path?: string): void {
    for (const view of this.views) {
      if (!path || view.state.field(editorInfoField, false)?.file?.path === path) view.dispatch({ effects: refresh.of(null) });
    }
  }
}
