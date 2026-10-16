const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function compile(name, context) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, { module, exports: module.exports, setTimeout, clearTimeout, ...context });
  return module.exports;
}
class Target {
  listeners = [];
  addEventListener(type, fn, capture = false) { this.listeners.push({ type, fn, capture }); }
  removeEventListener(type, fn, capture = false) { this.listeners = this.listeners.filter(x => x.type !== type || x.fn !== fn || x.capture !== capture); }
}
class El extends Target {
  constructor(doc, tag = 'div', opts = {}) {
    super(); this.ownerDocument = doc; this.tag = tag; this.cls = opts.cls || ''; this.children = []; this.dataset = {};
    this.style = { setProperty() {} }; this.offsetHeight = 100; this.value = ''; this.disabled = false;
    this.classList = { add() {}, remove() {} }; this.isConnected = true;
  }
  createEl(tag, opts) { const el = new El(this.ownerDocument, tag, opts); this.appendChild(el); return el; }
  createDiv(opts) { return this.createEl('div', opts); } createSpan(opts) { return this.createEl('span', opts); }
  appendChild(el) { this.children.push(el); el.parent = this; }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
  empty() { for (const el of this.children) el.isConnected = false; this.children = []; }
  setText(text) { this.text = text; } addClass() {} focus() { this.focused = true; }
  contains(el) { return this === el || this.children.some(child => child.contains(el)); }
  querySelector() { return null; } querySelectorAll() { return []; }
}
function doc(width = 900) {
  const doc = new Target(); const win = new Target();
  doc.defaultView = win; win.document = doc; win.innerWidth = width; win.innerHeight = 800; win.requestAnimationFrame = fn => fn();
  doc.body = new El(doc); doc.querySelector = () => null; doc.getSelection = () => null;
  return doc;
}
function popHarness() {
  const main = doc(1600), secondary = doc(600), callbacks = [];
  let composer, creates = 0, ready = Promise.resolve();
  const plugin = { isAlive: true, settings: { defaultTypeId: 'general' }, register: fn => callbacks.push(fn),
    storage: { sortedTypes: () => [], typeOf: () => ({}), currentPath: s => s.docPath },
    async createAnnotation() { creates++; }, revealAnnotation() {} };
  const exports = compile('popover', { document: main, window: main.defaultView,
    require: name => name === './util' ? { clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)), uuid: () => 'note' } :
      name === './card' ? { buildCard: () => new El(secondary), disposeCompsUnder() {}, errMsg: String } :
      name === './card-style' ? { applyCardStyle() {} } : name === 'obsidian' ? { Notice: class {} } :
      name === './memo-editor' ? { createMemoEditor(_plugin, parent) {
        const input = parent.createEl('textarea'), buttons = parent.createDiv();
        return composer = { input, buttons, handleSuggestionKeydown: () => false, ready: () => ready, hasPending: () => false, freeze() {}, dispose() { this.disposed = true; } };
      } } : {} });
  const opts = { docPath: 'note.md', anchor: { kind: 'md', text: 'quote' }, rect: { left: 300, width: 100, top: 200, bottom: 220 }, document: secondary, onClosed() {} };
  return { ...exports, main, secondary, callbacks, plugin, opts, get composer() { return composer; }, get creates() { return creates; }, set ready(promise) { ready = promise; } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
test('create popup uses its owning window and unload removes DOM, listeners, and pending saves', async () => {
  const h = popHarness(); let finish; h.ready = new Promise(resolve => { finish = resolve; });
  const pop = h.openCreatePopover(h.plugin, h.opts); await tick();
  assert.equal(h.main.body.children.length, 0); assert.equal(pop.ownerDocument, h.secondary);
  assert.equal(pop.style.width, '480px'); assert.equal(h.main.listeners.length, 0); assert.equal(h.secondary.listeners.length, 2);
  const composer = h.composer, save = composer.buttons.children.find(el => el.cls === 'gloss-primary');
  composer.input.value = 'pending draft'; save.onclick();
  h.plugin.isAlive = false; for (const callback of h.callbacks) callback();
  finish(); await tick();
  assert.equal(h.creates, 0); assert.equal(pop.isConnected, false); assert.equal(composer.disposed, true);
  assert.equal(h.secondary.listeners.length, 0);
  save.onclick(); await tick(); assert.equal(h.creates, 0);
});
test('closing and reopening create popups registers only one plugin cleanup', () => {
  const h = popHarness();
  for (let i = 0; i < 3; i++) { const pop = h.openCreatePopover(h.plugin, h.opts); h.dismissCreatePopover(pop); }
  assert.equal(h.callbacks.length, 1); assert.equal(h.secondary.body.children.length, 0);
});
test('bubble and selection pill use a foreign element document and viewport', async () => {
  const h = popHarness();
  const anchor = new El(h.secondary); anchor.getBoundingClientRect = () => ({ left: 550, width: 20, top: 200, bottom: 220 });
  h.GlossBubble.show(h.plugin, { note: { id: 'a' } }, {}, anchor, { docPath: 'a.md' });
  await tick();
  const bubble = h.secondary.body.children[0]; assert.equal(bubble.style.left, '252px');
  assert.equal(h.main.body.children.length, 0); assert.equal(h.main.listeners.length, 0); assert.equal(h.secondary.listeners.length, 2);
  h.GlossBubble.close(); assert.equal(h.secondary.listeners.length, 0);
  const pill = new h.SelectionPill(h.secondary); pill.show({ left: 550, width: 20, top: 200 });
  assert.equal(pill.ensureEl().ownerDocument, h.secondary); assert.equal(pill.ensureEl().style.left, '520px'); pill.dispose();
});
function mainHarness() {
  const main = doc(), secondary = doc(); let surfaces = 0, dismissed = 0;
  const { default: Plugin } = compile('main', { document: main, window: main.defaultView,
    require: name => name === 'obsidian' ? { Plugin: class {}, MarkdownView: class {} } : name === './util' ? { mdViewMode: () => 'preview' } :
      name === './layout' ? { getSurface() { surfaces++; return null; } } : name === './card' ? { closeTypeMenu() {} } :
      name === './popover' ? { GlossBubble: { close() {} }, dismissCreatePopover(el) { dismissed++; el.remove(); } } : {} });
  const plugin = Object.create(Plugin.prototype);
  return { plugin, main, secondary, get surfaces() { return surfaces; }, get dismissed() { return dismissed; } };
}
test('connected Markdown view in another document reaches rendering', async () => {
  const h = mainHarness(), contentEl = new El(h.secondary); contentEl.clientWidth = 1200;
  Object.assign(h.plugin, { alive: true, watchWindow() {}, renderSeq: new WeakMap(), sizeObservers: new Map([[contentEl, {}]]),
    layoutMap: new Map(), fileStats: new Map(), updateStatus() {}, storage: { loadDoc: async () => ({ entries: [] }) } });
  assert.equal(h.main.body.contains(contentEl), false);
  await h.plugin.renderView({ contentEl, file: { path: 'secondary.md' } }, true);
  assert.equal(h.surfaces, 1);
});
test('plugin unload closes its popup, waits for attachment migration, then flushes storage', async () => {
  const h = mainHarness(), pop = new El(h.secondary); let flushed = false, finishMigration;
  const attachmentMigration = new Promise(resolve => { finishMigration = resolve; });
  Object.assign(h.plugin, { attachmentMigration, alive: true, createPop: { el: pop, docPath: 'note.md' }, popoverOpen: true,
    storage: { onStatusChange() {}, async flushAll() { assert.equal(pop.isConnected, false); flushed = true; } },
    app: { vault: {}, workspace: { getLeavesOfType: () => [] } }, pdf: null, renderTimers: new Map(), sizeObservers: new Map(), readingObservers: new Map(), layoutMap: new Map(), windowCleanups: new Map() });
  const unloaded = h.plugin.onunload(); await Promise.resolve();
  assert.equal(flushed, false); assert.equal(pop.isConnected, false);
  finishMigration(); await unloaded; assert.equal(h.dismissed, 1); assert.equal(h.plugin.popoverOpen, false); assert.equal(flushed, true);
});

test('save completion after unload does not reopen a bubble', async () => {
  const h = popHarness(); let complete, started; const entered = new Promise(resolve => { started = resolve; });
  h.plugin.createAnnotation = () => { started(); return new Promise(resolve => { complete = resolve; }); };
  let revealed = false; h.plugin.revealAnnotation = () => { revealed = true; };
  h.openCreatePopover(h.plugin, h.opts);
  h.composer.buttons.children.find(el => el.cls === 'gloss-primary').onclick(); await entered;
  h.plugin.isAlive = false; for (const callback of h.callbacks) callback();
  complete(); await tick();
  assert.equal(revealed, false); assert.equal(h.secondary.body.children.length, 0);
});

test('margin card refresh is scheduled in its own window even if the main window is suspended', () => {
  const h = mainHarness(), entry = { note: { id: 'a' } }, card = new El(h.secondary);
  let mainFrames = 0, secondaryFrames = 0;
  h.main.defaultView.requestAnimationFrame = () => { mainFrames++; };
  h.secondary.defaultView.requestAnimationFrame = () => { secondaryFrames++; };
  Object.assign(h.plugin, { storage: { currentPath: () => 'a.md' }, editorHighlights: { refresh() {} }, pdf: null,
    layoutMap: new Map([['secondary', { items: [{ entry, cardEl: card }] }]]) });
  h.plugin.refreshCard(entry, { docPath: 'a.md' });
  assert.equal(mainFrames, 0); assert.equal(secondaryFrames, 1);
});
