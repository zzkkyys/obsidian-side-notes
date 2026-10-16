import { parseFrontMatterAliases, Scope, type App, type TFile } from "obsidian";
import { completeWikiLink, findWikiLinkContext, type WikiLinkContext } from "./note-link-model";

const imageExtensions = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const videoExtensions = new Set(["mkv", "mov", "mp4", "ogv", "webm"]);

function candidateKind(file: TFile): string | null {
  const extension = file.extension.toLowerCase();
  if (extension === "md") return "笔记";
  if (imageExtensions.has(extension)) return "图片";
  if (extension === "pdf") return "PDF";
  if (videoExtensions.has(extension)) return "视频";
  return null;
}

/** Search indexed vault files without reading media bytes or scanning hidden folders. */
export function findNoteCandidates(app: App, query: string, limit = 12): TFile[] {
  const q = query.trim().toLocaleLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  return app.vault.getFiles().filter(file => candidateKind(file) !== null).map(file => {
    const name = file.basename.toLocaleLowerCase(), filename = file.name.toLocaleLowerCase(), path = file.path.toLocaleLowerCase();
    const aliases = file.extension.toLowerCase() === "md"
      ? (parseFrontMatterAliases(app.metadataCache.getFileCache(file)?.frontmatter) ?? []).map(a => a.toLocaleLowerCase()) : [];
    const haystack = [name, path, ...aliases].join(" ");
    const score = !q ? 0 : (name === q || filename === q) ? 0 : (name.startsWith(q) || filename.startsWith(q)) ? 1 : aliases.includes(q) ? 2 : path.startsWith(q) ? 3 : 4;
    return { file, score, matches: words.every(word => haystack.includes(word)) };
  }).filter(item => item.matches).sort((a, b) => a.score - b.score
    || (!q ? b.file.stat.mtime - a.file.stat.mtime : 0) || a.file.path.localeCompare(b.file.path))
    .slice(0, limit).map(item => item.file);
}

/** Inline list stays inside the draft, including narrow popovers and detached windows. */
export function attachNoteSuggest(app: App, input: HTMLTextAreaElement, host: HTMLElement, sourcePath: string, parentScope = app.scope) {
  const doc = input.ownerDocument, win = doc.defaultView!;
  const panel = doc.createElement("div");
  panel.className = "gloss-note-suggest";
  panel.hidden = true;
  const list = doc.createElement("div");
  list.className = "gloss-note-suggest-list";
  list.id = `gloss-note-suggest-${Math.random().toString(36).slice(2)}`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "链接到笔记或附件");
  const status = doc.createElement("div");
  status.className = "gloss-note-suggest-hint";
  status.setAttribute("role", "status");
  panel.append(list, status); host.appendChild(panel);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  const scope = new Scope(parentScope);
  let pushed = false, disposed = false, frozen = false, composing = false;
  let context: WikiLinkContext | null = null, snapshot = "", dismissed = "";
  let candidates: TFile[] = [], selected = 0;
  const cleanups: Array<() => void> = [];
  const listen = (target: EventTarget, name: string, handler: EventListener) => {
    target.addEventListener(name, handler);
    cleanups.push(() => target.removeEventListener(name, handler));
  };
  const key = () => `${input.selectionStart}:${input.selectionEnd}:${input.value}`;
  function close(): void {
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (pushed) { app.keymap.popScope(scope); pushed = false; }
  }
  function highlight(index: number): void {
    selected = (index + candidates.length) % candidates.length;
    const rows = Array.from(list.children) as HTMLElement[];
    rows.forEach((row, i) => row.setAttribute("aria-selected", String(i === selected)));
    const row = rows[selected];
    if (!row) return;
    input.setAttribute("aria-activedescendant", row.id);
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }
  function choose(file: TFile): void {
    if (disposed || frozen || composing || !input.isConnected || snapshot !== input.value) { close(); return; }
    const current = findWikiLinkContext(input.value, input.selectionStart, input.selectionEnd);
    if (!current || !context || current.start !== context.start || current.end !== context.end || current.query !== context.query) { close(); return; }
    const live = app.vault.getFiles().find(f => f.path === file.path && candidateKind(f) !== null);
    if (!live) { update(); return; }
    const linktext = app.metadataCache.fileToLinktext(live, sourcePath, true);
    const completed = completeWikiLink(input.value, current, linktext);
    close();
    input.focus();
    input.setRangeText(completed.value.slice(current.start, completed.caret), current.start, current.end, "end");
    input.setSelectionRange(completed.caret, completed.caret);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  }
  function update(): void {
    if (disposed || frozen || composing || input.hidden || !input.isConnected || doc.activeElement !== input || key() === dismissed) { close(); return; }
    const next = findWikiLinkContext(input.value, input.selectionStart, input.selectionEnd);
    if (!next) { close(); return; }
    context = next; snapshot = input.value;
    candidates = findNoteCandidates(app, next.query);
    list.replaceChildren();
    candidates.forEach((file, i) => {
      const row = doc.createElement("div");
      row.className = "gloss-note-suggest-option";
      row.id = `${list.id}-${i}`;
      row.setAttribute("role", "option");
      const name = doc.createElement("div"), path = doc.createElement("div");
      name.className = "gloss-note-suggest-name"; name.textContent = file.extension.toLowerCase() === "md" ? file.basename : file.name;
      path.className = "gloss-note-suggest-path"; path.textContent = `${candidateKind(file)} · ${file.path}`;
      row.append(name, path);
      row.addEventListener("mousedown", event => event.preventDefault());
      row.addEventListener("mouseenter", () => highlight(i));
      row.addEventListener("click", event => { event.preventDefault(); choose(file); });
      list.appendChild(row);
    });
    status.textContent = candidates.length ? `${candidates.length} 个候选 · ↑↓ 选择 · Enter / Tab 插入 · Esc 关闭` : "没有匹配的文件，可继续输入或按 Esc 关闭";
    list.hidden = candidates.length === 0;
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
    if (candidates.length) highlight(0);
    if (!pushed) { app.keymap.pushScope(scope); pushed = true; }
  }
  function handleKeydown(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.target !== input || disposed || frozen || composing || event.isComposing || event.keyCode === 229
      || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || panel.hidden) return false;
    if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return false;
    if (event.key !== "Escape" && !candidates.length) { close(); return false; }
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === "Escape") { dismissed = key(); close(); }
    else if (event.key === "Enter" || event.key === "Tab") choose(candidates[selected]);
    else highlight(selected + (event.key === "ArrowDown" ? 1 : -1));
    return true;
  }
  for (const name of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) scope.register([], name, event => handleKeydown(event) ? false : undefined);
  listen(input, "keydown", event => { handleKeydown(event as KeyboardEvent); });
  listen(input, "input", () => { dismissed = ""; update(); });
  listen(input, "click", update);
  listen(input, "focus", update);
  listen(input, "keyup", event => {
    const key = (event as KeyboardEvent).key;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) { dismissed = ""; update(); }
  });
  listen(input, "select", () => { if (!panel.hidden) update(); });
  listen(input, "blur", close);
  listen(input, "compositionstart", () => { composing = true; close(); });
  listen(input, "compositionend", () => { composing = false; dismissed = ""; update(); });
  return {
    close, handleKeydown,
    freeze(value: boolean): void { frozen = value; if (value) close(); },
    dispose(): void {
      if (disposed) return;
      disposed = true; close();
      cleanups.forEach(cleanup => cleanup()); panel.remove();
      for (const attr of ["role", "aria-autocomplete", "aria-controls", "aria-expanded", "aria-activedescendant"]) input.removeAttribute(attr);
    },
  };
}
