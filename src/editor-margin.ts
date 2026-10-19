import type { DecorationSet, EditorView } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { buildMarginLayout, getSurface, type MarginLayout } from "./layout";
import type GlossPlugin from "./main";
import type { GlossDocStore } from "./types";

/** One overlay per CodeMirror view; never insert cards into its virtualized content. */
export class EditorMargin {
  layout: MarginLayout | null = null;
  private store: GlossDocStore | null = null;
  private marginWidth = 0;
  private path: string | undefined;
  private frame: number | null = null;
  private dead = false;
  private blockTops = new Map<string, number>();
  private typeSignatures = new Map<string, string>();
  private win: Window;

  constructor(private plugin: GlossPlugin, private view: EditorView, private decorations: () => DecorationSet) {
    this.win = view.dom.ownerDocument.defaultView!;
    view.scrollDOM.addEventListener("scroll", this.schedule, { passive: true });
  }

  schedule = (): void => {
    if (this.dead || this.frame !== null) return;
    this.frame = this.win.requestAnimationFrame(() => {
      this.frame = null;
      if (!this.dead && this.plugin.isAlive) this.sync();
    });
  };

  private sync(): void {
    const view = this.view;
    const path = view.state.field(editorInfoField, false)?.file?.path;
    const store = path ? this.plugin.storage.docCacheFor(path) : undefined;
    const mode = this.plugin.marginLayoutMode;
    const wantMargin = mode === "margin" || (mode === "auto" && this.win.innerWidth >= this.plugin.settings.wideBreakpoint);
    if (!view.state.field(editorLivePreviewField, false) || !view.dom.isConnected || !view.dom.clientWidth || !store || !wantMargin) {
      this.clear(); return;
    }

    const positions = new Map<string, number>();
    this.decorations().between(0, view.state.doc.length, (from, to, mark) => {
      const id: string | undefined = mark.spec.attributes?.["data-gloss-id"];
      if (id && to > from && !positions.has(id)) positions.set(id, from);
    });
    const entries = new Map(store.entries.map(entry => [entry.note.id, entry]));
    const validIds = new Set([...positions.keys()].filter(id => entries.has(id)));
    if (!validIds.size) { this.clear(); return; }
    if (path !== this.path || store !== this.store || this.marginWidth !== this.plugin.settings.marginWidth) this.clear();

    const placed = [];
    const seen = new Set<string>();
    for (const el of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".gloss-hl"))) {
      const id = el.dataset.glossId;
      if (!id || seen.has(id) || !validIds.has(id) || !el.getClientRects().length) continue;
      const entry = entries.get(id)!;
      placed.push({ entry, el, type: this.plugin.storage.typeOf(entry.note.typeId) });
      seen.add(id);
    }
    if (!this.layout && !placed.length) return;

    const surface = this.layout?.surface ?? getSurface(view.dom, "livepreview");
    if (!surface) return;
    const gutter = Math.max(248, this.plugin.settings.marginWidth) + 24;
    if (surface.availableWidth() < surface.readingWidth() + 2 * gutter) {
      if (this.layout) this.clear(); else surface.dispose();
      return;
    }

    // Map cached offscreen positions through CodeMirror's height map after edits.
    // When the span re-enters the viewport, its real rect replaces this estimate.
    const nextTops = new Map<string, number>();
    const nextTypes = new Map<string, string>();
    for (const id of validIds) {
      const type = this.plugin.storage.typeOf(entries.get(id)!.note.typeId);
      nextTypes.set(id, JSON.stringify([type.id, type.name, type.emoji, type.color]));
      const block = view.lineBlockAt(positions.get(id)!);
      nextTops.set(id, surface.docTop({ top: view.documentTop + block.top } as DOMRect));
    }
    if (this.layout) {
      const retained = new Set(validIds);
      for (const item of this.layout.items) {
        if (entries.get(item.entry.note.id) !== item.entry
          || this.typeSignatures.get(item.entry.note.id) !== nextTypes.get(item.entry.note.id)) retained.delete(item.entry.note.id);
        const previous = this.blockTops.get(item.entry.note.id), next = nextTops.get(item.entry.note.id);
        if (!seen.has(item.entry.note.id) && previous !== undefined && next !== undefined) item.hlTop += next - previous;
      }
      // External replacement removes only stale cards, preserving unrelated drafts.
      this.layout.updateAnchors(placed, retained);
    } else {
      surface.setGutter(this.plugin.settings.marginWidth);
      this.layout = buildMarginLayout(this.plugin, surface, placed, (entry, type) => this.plugin.buildMarginCard(entry, type, store));
      this.store = store;
      this.path = path;
      this.marginWidth = this.plugin.settings.marginWidth;
      view.requestMeasure();
      this.schedule(); // Gutter changes line wrapping; measure the settled editor again.
    }
    this.blockTops = nextTops;
    this.typeSignatures = nextTypes;
  }

  clear(): void {
    if (!this.layout) return;
    this.layout.dispose();
    this.layout = null;
    this.store = null;
    this.blockTops.clear();
    this.typeSignatures.clear();
    if (!this.dead) this.view.requestMeasure();
  }

  destroy(): void {
    this.dead = true;
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.view.scrollDOM.removeEventListener("scroll", this.schedule);
    this.clear();
  }
}
