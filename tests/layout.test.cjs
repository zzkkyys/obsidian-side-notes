const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
test('virtualized block replacement retains cards and drafts, creating only newly visible cards', () => {
  let builds = 0, disposals = 0;
  const element = () => ({ style: {}, classList: { add() {}, toggle() {} }, offsetHeight: 80, setAttribute() {}, replaceChildren() {}, appendChild() {}, remove() {} });
  const children = [];
  const ownerDocument = { createElementNS() { return { ...element(), svg: true }; } };
  const layer = { ownerDocument, remove() { children.length = 0; }, empty() { children.length = 0; }, appendChild(el) { children.push(el); }, querySelector() { return children.find(e => e.svg) || null; } };
  const surface = { host: { contains: () => true }, layer, width: () => 1300, hostLeft: () => 0, docTop: r => r.top, docHeight: () => 2000 };
  const m = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/layout.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(source, { module: m, exports: m.exports, require: p => p === './card' ? { disposeCompsUnder() { disposals++; } } : {}, document: { createElementNS() { return { ...element(), svg: true }; } } });
  const type = { color: '#3b82f6' }, entry = { note: { id: 'a' } }, second = { note: { id: 'b' } };
  const placed = (entry, top) => ({ entry, type, el: { getClientRects: () => [{}], getBoundingClientRect: () => ({ top, left: 300, right: 400, height: 20 }) } });
  const layout = m.exports.buildMarginLayout({ settings: { marginWidth: 240 } }, surface, [placed(entry, 100)], () => { builds++; return element(); });
  const card = layout.items[0].cardEl;
  card.draft = 'unfinished reply';
  layout.updateAnchors([placed(entry, 250), placed(second, 450)]);
  assert.equal(builds, 2);
  assert.equal(layout.items[0].cardEl, card);
  assert.equal(card.draft, 'unfinished reply');
  assert.equal(card.style.top, '236px');
  layout.updateAnchors([]);
  assert.equal(card.style.visibility, '');
  assert.equal(card.style.top, '236px');
  layout.updateAnchors([placed(entry, 300)]);
  assert.equal(card.style.visibility, '');
  assert.equal(builds, 2);
  assert.equal(disposals, 0);
  layout.updateAnchors([], new Set(['a']));
  assert.equal(layout.items.length, 1);
  assert.equal(layout.items[0].cardEl, card);
  assert.equal(card.draft, 'unfinished reply');
  assert.equal(disposals, 1);
  layout.dispose();
  assert.equal(disposals, 2);
});
test('reading cards live outside the virtualized sizer and align with document coordinates', () => {
  function el(rect) {
    return { style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {} }, children: [],
      clientWidth: 1000, scrollTop: 300, scrollLeft: 0, clientTop: 0, clientLeft: 0,
      getBoundingClientRect: () => rect, querySelectorAll: () => [],
      createDiv() { const child = el({}); child.parentElement = this; this.children.push(child); return child; } };
  }
  const parent = el({ top: 40, left: 10 }), host = el({ top: -240, left: 30 });
  host.parentElement = parent;
  const m = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/layout.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(source, { module: m, exports: m.exports, require: () => ({}) });
  const surface = m.exports.getSurface({ querySelector: () => host }, 'preview');
  assert.equal(surface.layer.parentElement, parent);
  assert.equal(host.children.length, 0);
  surface.syncLayer();
  assert.equal(surface.layer.style.top, '20px');
  assert.equal(surface.layer.style.left, '20px');
  assert.equal(surface.layer.style.width, '1000px');
  host.children.length = 0; // Obsidian recycling text children does not remove the layer.
  assert.equal(parent.children[0], surface.layer);
});

// ResizeObserver can fire before the debounced preview re-anchoring pass.
function scrollHarness() {
  let onResize, timer, builds = 0;
  const element = () => ({ style: {}, children: [], attrs: {}, offsetHeight: 80,
    classList: { add() {}, toggle() {} },
    setAttribute(name, value) { this.attrs[name] = value; },
    replaceChildren() { this.children.length = 0; },
    appendChild(el) { this.children.push(el); } });
  const layer = { ...element(), isConnected: true,
    ownerDocument: { createElementNS: () => element() },
    empty() { this.children.length = 0; }, querySelector() { return this.children.find(el => el.attrs.width) ?? null; } };
  const host = { contains: el => el.inHost };
  const surface = { host, layer, width: () => 1300, hostLeft: () => 0,
    docTop: rect => rect.top + 600, docHeight: () => 2000 };
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/layout.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, require: () => ({}),
    ResizeObserver: class { constructor(callback) { onResize = callback; } observe() {} unobserve() {} disconnect() {} },
    setTimeout(callback) { timer = callback; return 1; }, clearTimeout() {} });
  const entry = { note: { id: 'above' } }, type = { color: '#3b82f6' };
  const anchor = { inHost: true, rendered: true, top: -500,
    getClientRects() { return this.rendered ? [this.getBoundingClientRect()] : []; },
    getBoundingClientRect() { return this.inHost && this.rendered
      ? { top: this.top, left: 300, right: 400, height: 20 }
      : { top: 0, left: 0, right: 0, height: 0 }; } };
  const placed = () => [{ entry, type, el: anchor }];
  const layout = module.exports.buildMarginLayout({ settings: { marginWidth: 240 } }, surface, placed(), () => { builds++; return element(); });
  return { layout, anchor, placed, get builds() { return builds; },
    resize() { onResize(); timer(); },
    paths() { return layer.querySelector().children.map(path => path.attrs.d); } };
}
for (const missing of ['detached', 'hidden']) {
  test(`scroll recycling keeps card and connector coordinates when the anchor is ${missing}`, () => {
    const h = scrollHarness(), item = h.layout.items[0], card = item.cardEl;
    card.draft = 'reply in progress';
    const paths = h.paths();
    assert.equal(card.style.top, '86px');
    if (missing === 'detached') h.anchor.inHost = false;
    else h.anchor.rendered = false;
    // A resized card / preview host triggers layout before updateAnchors discovers removal.
    h.resize();
    assert.equal(card.style.top, '86px');
    assert.deepEqual(h.paths(), paths);
    h.layout.updateAnchors([]);
    assert.equal(card.style.top, '86px');
    assert.deepEqual(h.paths(), paths);
    h.anchor.inHost = h.anchor.rendered = true;
    h.anchor.top = -450;
    h.layout.updateAnchors(h.placed());
    assert.equal(card.style.top, '136px');
    assert.equal(item.cardEl, card);
    assert.equal(card.draft, 'reply in progress');
    assert.equal(h.builds, 1);
    assert.match(h.paths()[0], /^M 300.0 160.0 /);
  });
}
test('offscreen anchors keep their connector when re-anchoring runs before resize', () => {
  const h = scrollHarness(), paths = h.paths();
  h.anchor.inHost = false;
  h.layout.updateAnchors([]);
  h.resize();
  assert.equal(h.layout.items[0].cardEl.style.top, '86px');
  assert.deepEqual(h.paths(), paths);
});


function editorSurfaceHarness() {
  let unwraps = 0;
  const ownerDocument = { defaultView: { getComputedStyle: el => ({ paddingLeft: '0', paddingRight: '0', lineHeight: '20px', fontSize: '16px', overflowX: 'visible', overflowY: 'visible', ...el.computedStyle }) },
    createElementNS: () => element() };
  function element(rect = { top: 0, left: 0 }) {
    const classes = new Set(), events = new Map();
    return { nodeType: 1, children: [], attrs: {}, ownerDocument, parentElement: null, events,
      clientWidth: 1300, clientHeight: 600, scrollWidth: 1300, scrollHeight: 600, scrollTop: 0, scrollLeft: 0, clientTop: 0, clientLeft: 0,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: { add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name),
        toggle(name, value) { value ? classes.add(name) : classes.delete(name); } },
      getBoundingClientRect: () => rect, getClientRects: () => [rect],
      querySelectorAll: () => [], querySelector(selector) {
        if (selector === 'svg.gloss-connectors') return this.children.find(el => el.classList.contains('gloss-connectors')) ?? null;
        return null;
      },
      setAttribute(name, value) { this.attrs[name] = value; },
      createDiv({ cls }) { const child = element(); child.classList.add(cls); this.appendChild(child); return child; },
      appendChild(child) { child.parentElement = this; this.children.push(child); },
      empty() { this.children.length = 0; }, replaceChildren() { this.empty(); },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; },
      contains(child) { return this === child || this.children.some(el => el.contains(child)); },
      addEventListener(name, callback) { events.set(name, callback); }, removeEventListener(name) { events.delete(name); },
    };
  }
  const editor = element({ top: 40, left: 10 }), scroller = element({ top: 60, left: 20 });
  const sizer = element({ top: -240, left: 20 }), content = element();
  sizer.scrollHeight = 2400; content.clientWidth = 700; scroller.scrollTop = 300;
  editor.appendChild(scroller); scroller.appendChild(sizer); sizer.appendChild(content);
  scroller.querySelector = selector => selector === '.cm-content' ? content : null;
  const root = { querySelector: selector => ({ '.cm-scroller': scroller, '.cm-sizer': sizer }[selector] ?? null) };
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/layout.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === './anchor'
    ? { unwrapAll() { unwraps++; } } : { disposeCompsUnder() {} } });
  const surface = module.exports.getSurface(root, 'livepreview');
  return { surface, editor, scroller, sizer, content, element, buildMarginLayout: module.exports.buildMarginLayout,
    get unwraps() { return unwraps; } };
}

test('live preview overlays stay outside CodeMirror and restore gutters without unwrapping editor marks', () => {
  const h = editorSurfaceHarness(), { surface, editor, scroller, sizer, content } = h;
  const viewport = surface.layer.parentElement;
  assert.equal(viewport.parentElement, editor);
  assert.equal(scroller.contains(surface.layer), false);
  assert.equal(viewport.style.top, '20px');
  assert.equal(viewport.style.left, '10px');
  assert.equal(viewport.style.height, '600px');
  assert.equal(surface.layer.style.transform, 'translateY(-300px)');
  assert.equal(surface.docTop({ top: 160 }), 400);
  assert.equal(surface.availableWidth(), 1300);
  assert.equal(surface.readingWidth(), 700);
  surface.setGutter(248);
  assert.equal(sizer.classList.contains('gloss-gutter-padded'), true);
  assert.equal(sizer.style['--gloss-gutter-pad'], '272px');
  assert.equal(content.classList.contains('gloss-gutter-padded'), false);
  // A decorative SVG extent or foreign scroller child must not feed its height
  // back into the next SVG sizing pass.
  scroller.scrollHeight = 50000;
  assert.equal(surface.docHeight(), 2440);
  assert.equal(surface.docHeight(), 2440);
  surface.reset();
  assert.equal(h.unwraps, 0);
  assert.equal(scroller.events.has('scroll'), true);
  surface.dispose();
  assert.equal(scroller.events.has('scroll'), false);
  assert.equal(sizer.style['--gloss-gutter-pad'], undefined);
  assert.equal(sizer.classList.contains('gloss-gutter-padded'), false);
  assert.equal(scroller.classList.contains('gloss-margin-host'), false);
  assert.equal(editor.classList.contains('gloss-layer-parent'), false);
  assert.equal(editor.children.length, 1);
});

test('live preview scrolling moves cards and connectors with text while recycled anchors preserve drafts', () => {
  const h = editorSurfaceHarness(), { surface, scroller, content } = h;
  let builds = 0;
  const type = { color: '#3b82f6' }, entry = { note: { id: 'editor-note' } };
  const anchor = h.element({ top: 160, left: 320, right: 420, height: 20 });
  content.appendChild(anchor);
  const layout = h.buildMarginLayout({ settings: { marginWidth: 248 } }, surface, [{ entry, type, el: anchor }], () => {
    builds++; const card = h.element(); card.offsetHeight = 80; return card;
  });
  const card = layout.items[0].cardEl;
  card.draft = 'preserve this reply';
  assert.equal(card.style.top, '386px');
  const path = surface.layer.querySelector('svg.gloss-connectors').children[0].attrs.d;
  scroller.scrollTop = 900;
  scroller.events.get('scroll')();
  assert.equal(surface.layer.style.transform, 'translateY(-900px)');
  anchor.remove();
  layout.updateAnchors([], new Set(['editor-note']));
  assert.equal(card.style.top, '386px');
  assert.equal(surface.layer.querySelector('svg.gloss-connectors').children[0].attrs.d, path);
  scroller.scrollTop = 300;
  const replacement = h.element({ top: 180, left: 320, right: 420, height: 20 });
  content.appendChild(replacement);
  layout.updateAnchors([{ entry, type, el: replacement }], new Set(['editor-note']));
  assert.equal(surface.layer.style.transform, 'translateY(-300px)');
  assert.equal(card.style.top, '406px');
  assert.equal(layout.items[0].cardEl, card);
  assert.equal(card.draft, 'preserve this reply');
  assert.equal(builds, 1);
  assert.match(surface.layer.querySelector('svg.gloss-connectors').children[0].attrs.d, /^M 300.0 430.0 /);
  layout.dispose();
  assert.equal(scroller.events.size, 0);
});


test('editor card wheel scrolling hands off to the document only when inner scrolling is exhausted', () => {
  const { surface, scroller, element } = editorSurfaceHarness();
  scroller.scrollHeight = 2400;
  const viewport = surface.layer.parentElement, card = element(), input = element();
  surface.layer.appendChild(card); card.appendChild(input);
  card.computedStyle = { overflowY: 'auto' };
  card.clientHeight = 200; card.scrollHeight = 500; card.scrollTop = 80;
  input.computedStyle = { overflowY: 'auto' };
  input.clientHeight = 50; input.scrollHeight = 150; input.scrollTop = 40;
  const wheel = (dy, extra = {}) => {
    let prevented = false;
    viewport.events.get('wheel')({ target: input, deltaX: 0, deltaY: dy, deltaMode: 0,
      preventDefault() { prevented = true; }, ...extra });
    return prevented;
  };
  assert.equal(wheel(50), false); // Textarea can still scroll.
  assert.equal(scroller.scrollTop, 300);
  input.scrollTop = 100;
  assert.equal(wheel(50), false); // Parent card can still scroll.
  card.scrollTop = 300;
  assert.equal(wheel(50), true); // Both are at the bottom: scroll the note.
  assert.equal(scroller.scrollTop, 350);
  assert.equal(surface.layer.style.transform, 'translateY(-350px)');
  assert.equal(wheel(-50), false); // Upward gesture stays within the textarea.
  input.scrollTop = card.scrollTop = 0;
  assert.equal(wheel(-50), true);
  assert.equal(scroller.scrollTop, 300);
  assert.equal(wheel(50, { ctrlKey: true }), false);
  assert.equal(wheel(50, { metaKey: true }), false);
  assert.equal(wheel(50, { defaultPrevented: true }), false);
  assert.equal(scroller.scrollTop, 300);
  surface.dispose();
  assert.equal(viewport.events.has('wheel'), false);
});

test('editor overlay normalizes wheel line and page units and clamps document edges', () => {
  const { surface, scroller, element } = editorSurfaceHarness();
  const viewport = surface.layer.parentElement, card = element();
  surface.layer.appendChild(card);
  scroller.scrollHeight = 2400; scroller.scrollWidth = 1800;
  const wheel = (deltaX, deltaY, deltaMode) => {
    let prevented = false;
    viewport.events.get('wheel')({ target: card, deltaX, deltaY, deltaMode,
      preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(wheel(2, 3, 1), true);
  assert.equal(scroller.scrollTop, 360);
  assert.equal(scroller.scrollLeft, 40);
  assert.equal(wheel(0, 1, 2), true);
  assert.equal(scroller.scrollTop, 960);
  assert.equal(wheel(0, 10, 2), true);
  assert.equal(scroller.scrollTop, 1800);
  assert.equal(wheel(0, 1, 2), false);
  assert.equal(wheel(-10, -10, 2), true);
  assert.equal(scroller.scrollTop, 0);
  assert.equal(scroller.scrollLeft, 0);
  assert.equal(wheel(0, -1, 0), false);
  surface.dispose();
});


test('live preview cards align with the centered text sizer and follow horizontal scrolling', () => {
  const { surface, scroller, sizer } = editorSurfaceHarness();
  sizer.clientWidth = 1000;
  sizer.getBoundingClientRect = () => ({ top: -240, left: 250 - scroller.scrollLeft });
  surface.syncLayer();
  const viewport = surface.layer.parentElement;
  assert.equal(viewport.style.left, '240px');
  assert.equal(viewport.style.width, '1000px');
  assert.equal(surface.hostLeft(), 250);
  assert.equal(surface.width(), 1000);
  assert.equal(surface.availableWidth(), 1300); // Capacity uses the entire editor.
  assert.equal(viewport.style.top, '20px'); // Vertical origin remains the scroller.
  assert.equal(surface.docTop({ top: 160 }), 400);
  assert.equal(viewport.style.clipPath, 'inset(0 0px 0 0px)');
  scroller.scrollLeft = 350;
  scroller.events.get('scroll')();
  assert.equal(viewport.style.left, '-110px');
  assert.equal(surface.hostLeft(), -100);
  assert.equal(viewport.style.clipPath, 'inset(0 0px 0 120px)');
  assert.equal(surface.layer.style.transform, 'translateY(-300px)');
  surface.dispose();
});
