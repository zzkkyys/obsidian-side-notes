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
  const surface = { layer, width: () => 1300, hostLeft: () => 0, docTop: r => r.top, docHeight: () => 2000 };
  const m = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/layout.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(source, { module: m, exports: m.exports, require: p => p === './card' ? { disposeCompsUnder() { disposals++; } } : {}, document: { createElementNS() { return { ...element(), svg: true }; } } });
  const type = { color: '#3b82f6' }, entry = { note: { id: 'a' } }, second = { note: { id: 'b' } };
  const placed = (entry, top) => ({ entry, type, el: { getBoundingClientRect: () => ({ top, left: 300, right: 400, height: 20 }) } });
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
