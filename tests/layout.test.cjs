const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
test('virtualized block replacement retains cards and drafts, creating only newly visible cards', () => {
  let builds = 0, disposals = 0;
  const element = () => ({ style: {}, classList: { add() {}, toggle() {} }, offsetHeight: 80, setAttribute() {}, replaceChildren() {}, appendChild() {} });
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
