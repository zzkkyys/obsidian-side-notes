const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function compile(name, requireModule, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: requireModule, ...globals });
  return module.exports;
}

function harness() {
  const editorInfoField = Symbol('file'), editorLivePreviewField = Symbol('livePreview');
  const obsidian = { editorInfoField, editorLivePreviewField };
  const frames = new Map(), events = new Map(), blocks = new Map([[10, 100], [40, 400]]);
  let nextFrame = 0, path = 'note.md', livePreview = true, visible = [], marks = [];
  let builds = 0, disposedCards = 0, measurements = 0;
  const surfaces = [], stores = new Map();
  const win = { innerWidth: 1500, requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); } };
  const view = {
    dom: { ownerDocument: { defaultView: win }, isConnected: true, clientWidth: 1300 },
    scrollDOM: { scrollTop: 0, addEventListener(name, fn) { events.set(name, fn); },
      removeEventListener(name, fn) { if (events.get(name) === fn) events.delete(name); } },
    contentDOM: { querySelectorAll() { return visible; } },
    state: { doc: { length: 100, toString: () => '0123456789alpha' + ' '.repeat(25) + 'beta' + ' '.repeat(56) },
      field(field) { return field === editorInfoField ? { file: { path } } : field === editorLivePreviewField ? livePreview : undefined; } },
    get documentTop() { return 50 - this.scrollDOM.scrollTop; },
    lineBlockAt(from) { return { top: blocks.get(from) ?? from * 10 }; },
    requestMeasure() { measurements++; },
  };
  const entry = id => ({ note: { id, typeId: 'general' }, anchor: { kind: 'md', text: id === 'a' ? 'alpha' : 'beta' } });
  const store = { docPath: 'note.md', entries: [entry('a'), entry('b')] }; stores.set('note.md', store);
  const plugin = { isAlive: true, marginLayoutMode: 'auto', settings: { wideBreakpoint: 1035, marginWidth: 248, highlightStyle: 'solid' },
    storage: { docCacheFor: p => stores.get(p), typeOf: () => ({ color: '#336699' }), loadDoc: p => Promise.resolve(stores.get(p)) },
    buildMarginCard(e) { builds++; return { id: e.note.id, draft: '', disposed: false }; } };
  let availableWidth = 1300, readingWidth = 700;
  const layoutModule = {
    getSurface(_dom, mode) {
      assert.equal(mode, 'livepreview');
      const surface = { disposed: false, gutter: null,
        availableWidth: () => availableWidth, readingWidth: () => readingWidth,
        docTop: rect => rect.top + view.scrollDOM.scrollTop - 50,
        setGutter(width) { this.gutter = width; }, dispose() { this.disposed = true; } };
      surfaces.push(surface); return surface;
    },
    buildMarginLayout(_plugin, surface, placed, buildCard) {
      const layout = { surface, items: [], disposed: false,
        updateAnchors(anchors, validIds) {
          for (let i = this.items.length - 1; i >= 0; i--) {
            const item = this.items[i];
            if (validIds && !validIds.has(item.entry.note.id)) {
              item.cardEl.disposed = true; disposedCards++; this.items.splice(i, 1);
            }
          }
          for (const anchor of anchors) {
            let item = this.items.find(item => item.entry.note.id === anchor.entry.note.id);
            if (!item) { item = { entry: anchor.entry, cardEl: buildCard(anchor.entry, anchor.type) }; this.items.push(item); }
            item.hlEl = anchor.el;
            item.hlTop = surface.docTop(anchor.el.getBoundingClientRect());
          }
        },
        dispose() { this.disposed = true; for (const item of this.items) { item.cardEl.disposed = true; disposedCards++; } surface.dispose(); },
      };
      layout.updateAnchors(placed); return layout;
    },
  };
  const { EditorMargin } = compile('editor-margin', name => name === 'obsidian' ? obsidian : name === './layout' ? layoutModule : {});
  const decorations = { between(_from, _to, fn) { for (const mark of marks) fn(mark.from, mark.to, { spec: { attributes: { 'data-gloss-id': mark.id } } }); } };
  const margin = new EditorMargin(plugin, view, () => decorations);
  function highlight(id, top, rendered = true) {
    return { dataset: { glossId: id }, getClientRects: () => rendered ? [{}] : [],
      getBoundingClientRect: () => ({ top: 50 + top - view.scrollDOM.scrollTop }) };
  }
  return { EditorMargin, obsidian, frames, events, blocks, view, win, plugin, store, stores, margin, surfaces, highlight,
    get builds() { return builds; }, get disposedCards() { return disposedCards; }, get measurements() { return measurements; },
    get marks() { return marks; }, set marks(value) { marks = value; },
    set visible(value) { visible = value; }, set livePreview(value) { livePreview = value; }, set path(value) { path = value; },
    set availableWidth(value) { availableWidth = value; }, set readingWidth(value) { readingWidth = value; },
    frame() { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(); },
    sync() { margin.schedule(); this.frame(); },
    start() { marks = [{ id: 'a', from: 10, to: 15 }]; visible = [highlight('a', 110)]; this.sync(); this.frame(); },
  };
}

test('only Live Preview creates margin cards; switching to source removes the overlay and gutter', () => {
  const h = harness(); h.livePreview = false; h.start();
  assert.equal(h.margin.layout, null); assert.equal(h.surfaces.length, 0);
  h.livePreview = true; h.sync(); h.frame();
  const layout = h.margin.layout;
  assert.ok(layout); assert.equal(layout.surface.gutter, 248); assert.equal(h.builds, 1);
  h.livePreview = false; h.sync();
  assert.equal(h.margin.layout, null); assert.equal(layout.disposed, true); assert.equal(layout.surface.disposed, true);
  assert.equal(h.frames.size, 0);
});

test('scroll recycling retains cards and unsaved replies, then reattaches the visible anchor', () => {
  const h = harness(); h.start();
  const layout = h.margin.layout, item = layout.items[0], card = item.cardEl;
  card.draft = 'unfinished reply';
  h.visible = []; h.view.scrollDOM.scrollTop = 800;
  h.events.get('scroll')(); h.events.get('scroll')();
  assert.equal(h.frames.size, 1);
  h.frame();
  assert.equal(h.margin.layout, layout); assert.equal(item.hlTop, 110);
  assert.equal(item.cardEl, card); assert.equal(card.draft, 'unfinished reply'); assert.equal(h.disposedCards, 0);
  h.view.scrollDOM.scrollTop = 100;
  const replacement = h.highlight('a', 130); h.visible = [replacement]; h.sync();
  assert.equal(item.hlEl, replacement); assert.equal(item.hlTop, 130);
  assert.equal(item.cardEl, card); assert.equal(h.builds, 1);
});

test('edits above an offscreen annotation move its cached position by the height-map delta', () => {
  const h = harness(); h.start();
  const item = h.margin.layout.items[0], card = item.cardEl;
  h.visible = []; h.view.scrollDOM.scrollTop = 900;
  // The decoration maps from position 10 to 30; the original line now sits 240px lower.
  h.marks = [{ id: 'a', from: 30, to: 35 }]; h.blocks.set(30, 340); h.sync();
  assert.equal(item.hlTop, 350); assert.equal(item.cardEl, card);
  h.sync(); assert.equal(item.hlTop, 350, 'a second refresh must not apply the same delta twice');
  h.visible = [h.highlight('a', 365)]; h.sync();
  assert.equal(item.hlTop, 365, 'the rendered span supersedes the height-map estimate'); assert.equal(h.builds, 1);
});

test('deleted or unresolved anchors remove only their cards, preserving unrelated drafts', () => {
  const h = harness(); h.start();
  h.marks.push({ id: 'b', from: 40, to: 44 }); h.visible = [h.highlight('a', 110), h.highlight('b', 410)]; h.sync();
  const layout = h.margin.layout, b = layout.items.find(item => item.entry.note.id === 'b'); b.cardEl.draft = 'keep';
  h.store.entries = h.store.entries.filter(entry => entry.note.id !== 'a');
  h.sync();
  assert.equal(layout.items.length, 1); assert.equal(layout.items[0], b); assert.equal(b.cardEl.draft, 'keep');
  assert.equal(h.disposedCards, 1);
  // A remaining note whose quote was deleted has no usable decoration.
  h.marks = [{ id: 'b', from: 40, to: 40 }]; h.sync();
  assert.equal(h.margin.layout, null); assert.equal(b.cardEl.disposed, true); assert.equal(h.disposedCards, 2);
});

test('replacing one stored annotation refreshes that card without discarding another draft', () => {
  const h = harness(); h.start();
  h.marks.push({ id: 'b', from: 40, to: 44 }); h.visible = [h.highlight('a', 110), h.highlight('b', 410)]; h.sync();
  const layout = h.margin.layout, a = layout.items[0], b = layout.items[1]; b.cardEl.draft = 'keep';
  h.store.entries[0] = { ...h.store.entries[0], note: { ...h.store.entries[0].note, body: 'updated externally' } };
  h.sync();
  assert.equal(a.cardEl.disposed, true);
  assert.equal(layout.items.find(item => item.entry.note.id === 'b'), b); assert.equal(b.cardEl.draft, 'keep');
  assert.equal(layout.items.find(item => item.entry.note.id === 'a').entry, h.store.entries[0]); assert.equal(h.builds, 3);
});

test('duplicate highlights create one card, and hidden or unknown highlights create none', () => {
  const h = harness();
  h.marks = [{ id: 'a', from: 10, to: 15 }, { id: 'a', from: 20, to: 25 }, { id: 'b', from: 40, to: 44 }, { id: 'unknown', from: 50, to: 55 }];
  h.visible = [h.highlight('a', 110), h.highlight('a', 130), h.highlight('b', 410, false), h.highlight('unknown', 500)];
  h.sync(); h.frame();
  assert.equal(h.margin.layout.items.length, 1); assert.equal(h.margin.layout.items[0].entry.note.id, 'a'); assert.equal(h.builds, 1);
});

test('narrow windows and narrow split panes fall back without leaving an overlay or gutter', () => {
  const h = harness(); h.win.innerWidth = 900; h.start();
  assert.equal(h.margin.layout, null); assert.equal(h.surfaces.length, 0);
  h.win.innerWidth = 1500; h.availableWidth = 1000; h.sync();
  assert.equal(h.margin.layout, null); assert.equal(h.surfaces.at(-1).disposed, true);
  assert.equal(h.surfaces.at(-1).gutter, null);
  h.availableWidth = 1300; h.sync(); h.frame(); const layout = h.margin.layout;
  assert.ok(layout);
  h.availableWidth = 1000; h.sync();
  assert.equal(h.margin.layout, null); assert.equal(layout.disposed, true);
  h.availableWidth = 1300; h.plugin.marginLayoutMode = 'popover'; h.sync();
  assert.equal(h.margin.layout, null);
  h.plugin.marginLayoutMode = 'margin'; h.win.innerWidth = 900; h.sync();
  assert.ok(h.margin.layout, 'explicit margin mode may use a sufficiently wide pane');
});

test('view destruction cancels its pending frame, removes scroll hooks, and releases cards', () => {
  const h = harness(); h.start(); const layout = h.margin.layout;
  h.margin.schedule(); assert.equal(h.frames.size, 1);
  h.margin.destroy();
  assert.equal(h.frames.size, 0); assert.equal(h.events.size, 0); assert.equal(layout.disposed, true);
  assert.equal(h.margin.layout, null);
  h.margin.schedule(); h.frame(); assert.equal(h.builds, 1); assert.equal(h.frames.size, 0);
});

test('unloaded plugins and disconnected editors cannot create an overlay from a queued frame', () => {
  const h = harness(); h.marks = [{ id: 'a', from: 10, to: 15 }]; h.visible = [h.highlight('a', 110)];
  h.margin.schedule(); h.plugin.isAlive = false; h.frame(); assert.equal(h.margin.layout, null);
  h.plugin.isAlive = true; h.view.dom.isConnected = false; h.sync(); assert.equal(h.margin.layout, null);
  h.view.dom.isConnected = true; h.view.dom.clientWidth = 0; h.sync(); assert.equal(h.margin.layout, null);
  assert.equal(h.surfaces.length, 0);
});

function editorHarness() {
  const h = harness(), timers = new Map(); let timerId = 0;
  // EditorHighlights creates its own controller; remove the direct-controller listener.
  h.margin.destroy();
  const cm = require('@codemirror/view');
  const { EditorHighlights } = compile('editor', name => {
    if (name === './editor-margin') return { EditorMargin: h.EditorMargin };
    if (name === 'obsidian') return h.obsidian;
    if (name === '@codemirror/state') return require(name);
    if (name === '@codemirror/view') return { ...cm, ViewPlugin: { fromClass: (Plugin, spec) => ({ Plugin, spec }) } };
    if (name === './anchor-context') return { similarContext: (a, b) => a === b };
    if (name === './highlight-style') return { markerBackground: () => '' };
    return {};
  }, { setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } });
  h.visible = [h.highlight('a', 110)];
  const owner = new EditorHighlights(h.plugin), extension = owner.extension(), instance = new extension.Plugin(h.view);
  const dispatched = [];
  h.view.dispatch = spec => { dispatched.push(spec); instance.update({ startState: h.view.state, state: h.view.state,
    transactions: [{ effects: spec.effects ? [spec.effects] : [] }], docChanged: false }); };
  return { ...h, h, owner, instance, timers, dispatched,
    update(changes = {}) { instance.update({ startState: h.view.state, state: h.view.state, transactions: [], docChanged: false, ...changes }); },
  };
}

test('selection-only editor transactions preserve cards without scheduling unnecessary layout work', async () => {
  const { h, owner, instance, update } = editorHarness();
  await Promise.resolve(); h.frame(); h.frame();
  const layout = owner.layouts[0], card = layout.items[0].cardEl; card.draft = 'selection-safe reply';
  update(); assert.equal(h.frames.size, 0); h.frame();
  assert.equal(owner.layouts[0], layout); assert.equal(layout.items[0].cardEl, card); assert.equal(card.draft, 'selection-safe reply');
  const previewState = { field: field => field === h.obsidian.editorLivePreviewField ? true : h.view.state.field(field) };
  h.livePreview = false; update({ startState: previewState }); h.frame();
  assert.equal(owner.layouts.length, 0); assert.equal(layout.disposed, true);
  instance.destroy();
});

test('destroying the editor cancels delayed document revalidation and pending margin work', async () => {
  const { h, owner, instance, timers, dispatched, update } = editorHarness();
  await Promise.resolve(); h.frame(); h.frame();
  const { ChangeSet } = require('@codemirror/state');
  update({ docChanged: true, changes: ChangeSet.of({ from: 0, insert: 'prefix ' }, h.view.state.doc.length) });
  assert.equal(timers.size, 1); assert.equal(h.frames.size, 1);
  const before = dispatched.length;
  instance.destroy();
  assert.equal(timers.size, 0); assert.equal(h.frames.size, 0); assert.equal(h.events.size, 0); assert.equal(owner.layouts.length, 0);
  h.frame(); owner.refresh(); assert.equal(dispatched.length, before);
});

test('plugin disposal tears down every editor margin while queued document loading finishes harmlessly', async () => {
  const { h, owner, instance, dispatched } = editorHarness();
  h.frame(); h.frame(); const layout = owner.layouts[0];
  h.plugin.isAlive = false; owner.dispose();
  assert.equal(layout.disposed, true); assert.equal(h.events.size, 0); assert.equal(h.frames.size, 0); assert.equal(owner.layouts.length, 0);
  await Promise.resolve(); assert.equal(dispatched.length, 0);
  instance.destroy();
});

test('switching documents removes old cards before asynchronously loading the new document', async () => {
  const { h, owner, instance, update } = editorHarness();
  await Promise.resolve(); h.frame(); h.frame();
  const oldLayout = owner.layouts[0], oldCard = oldLayout.items[0].cardEl;
  let completeLoad;
  h.plugin.storage.loadDoc = () => new Promise(resolve => { completeLoad = resolve; });
  const oldState = { field: field => field === h.obsidian.editorInfoField ? { file: { path: 'note.md' } } : true };
  h.path = 'other.md'; h.visible = [];
  update({ startState: oldState }); h.frame();
  assert.equal(oldCard.disposed, true); assert.equal(owner.layouts.length, 0);
  h.stores.set('other.md', { docPath: 'other.md', entries: [h.store.entries[1]] });
  h.visible = [h.highlight('b', 410)]; completeLoad(); await Promise.resolve(); h.frame(); h.frame();
  const newLayout = owner.layouts[0];
  assert.ok(newLayout); assert.notEqual(newLayout, oldLayout);
  assert.equal(newLayout.items.length, 1); assert.equal(newLayout.items[0].entry.note.id, 'b');
  instance.destroy();
});


test('scrolling before any annotated span is rendered does not create temporary overlay DOM', () => {
  const h = harness(); h.marks = [{ id: 'a', from: 10, to: 15 }]; h.visible = [];
  h.sync(); h.events.get('scroll')(); h.frame();
  assert.equal(h.margin.layout, null); assert.equal(h.surfaces.length, 0);
  h.visible = [h.highlight('a', 110)]; h.sync(); h.frame();
  assert.ok(h.margin.layout); assert.equal(h.surfaces.length, 1); assert.equal(h.builds, 1);
});

test('in-place file and store renames rebuild cards with the new source path', () => {
  const h = harness(), file = { path: 'note.md' }, info = { file };
  const field = h.view.state.field;
  h.view.state.field = key => key === h.obsidian.editorInfoField ? info : field(key);
  const buildCard = h.plugin.buildMarginCard;
  h.plugin.buildMarginCard = (entry, type, store) => ({ ...buildCard(entry, type, store), sourcePath: store.docPath });
  h.start();
  const oldLayout = h.margin.layout, oldCard = oldLayout.items[0].cardEl;
  assert.equal(oldCard.sourcePath, 'note.md');
  // Obsidian mutates TFile.path, and storage preserves the existing store object.
  file.path = 'renamed/note.md'; h.store.docPath = file.path;
  h.stores.delete('note.md'); h.stores.set(file.path, h.store);
  h.sync(); h.frame();
  assert.equal(h.view.state.field(h.obsidian.editorInfoField).file, file);
  assert.equal(h.plugin.storage.docCacheFor(file.path), h.store);
  assert.notEqual(h.margin.layout, oldLayout); assert.equal(oldLayout.disposed, true); assert.equal(oldCard.disposed, true);
  const card = h.margin.layout.items[0].cardEl;
  assert.equal(card.sourcePath, 'renamed/note.md'); assert.equal(h.builds, 2);
  h.sync(); assert.equal(h.margin.layout.items[0].cardEl, card); assert.equal(h.builds, 2);
});

test('in-place type changes rebuild only affected cards without replacing annotation entries', () => {
  const h = harness(), types = {
    general: { id: 'general', name: 'General', emoji: '💬', color: '#336699' },
    other: { id: 'other', name: 'Other', emoji: '📌', color: '#996633' },
  };
  h.store.entries[1].note.typeId = 'other';
  h.plugin.storage.typeOf = id => types[id];
  const buildCard = h.plugin.buildMarginCard;
  h.plugin.buildMarginCard = (entry, type, store) => ({ ...buildCard(entry, type, store), renderedType: { ...type } });
  h.start(); h.marks.push({ id: 'b', from: 40, to: 44 });
  h.visible = [h.highlight('a', 110), h.highlight('b', 410)]; h.sync();
  const layout = h.margin.layout, entries = [...h.store.entries], unaffected = layout.items.find(item => item.entry.note.id === 'b').cardEl;
  unaffected.draft = 'keep this reply';
  for (const [key, value] of Object.entries({ name: 'Question', emoji: '❓', color: '#cc2244', id: 'question' })) {
    const previous = layout.items.find(item => item.entry.note.id === 'a').cardEl;
    types.general[key] = value; h.sync();
    const affected = layout.items.find(item => item.entry.note.id === 'a');
    assert.equal(affected.entry, entries[0]); assert.equal(h.store.entries[1], entries[1]);
    assert.equal(previous.disposed, true); assert.notEqual(affected.cardEl, previous);
    assert.deepEqual(affected.cardEl.renderedType, types.general);
    assert.equal(layout.items.find(item => item.entry.note.id === 'b').cardEl, unaffected);
    assert.equal(unaffected.draft, 'keep this reply'); assert.equal(unaffected.disposed, false);
  }
  assert.equal(h.builds, 6); h.sync(); assert.equal(h.builds, 6);
});

test('Live Preview DOM redraw schedules one measurement even without document or geometry changes', async () => {
  const { h, owner, instance, update } = editorHarness();
  await Promise.resolve(); h.frame(); h.frame();
  const item = owner.layouts[0].items[0], card = item.cardEl;
  update({ docChanged: false, viewportChanged: false, geometryChanged: false });
  assert.equal(h.frames.size, 0);
  const replacement = h.highlight('a', 145); h.visible = [replacement];
  instance.docViewUpdate(); instance.docViewUpdate();
  assert.equal(h.frames.size, 1); h.frame();
  assert.equal(item.hlEl, replacement); assert.equal(item.hlTop, 145); assert.equal(item.cardEl, card);
  assert.equal(h.frames.size, 0); instance.destroy();
});
