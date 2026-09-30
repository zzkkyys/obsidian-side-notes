const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
class Target {
  handlers = [];
  addEventListener(type, cb, capture = false) { this.handlers.push({ type, cb, capture: !!capture }); }
  removeEventListener(type, cb, capture = false) { this.handlers = this.handlers.filter(h => h.type !== type || h.cb !== cb || h.capture !== !!capture); }
  querySelectorAll() { return []; }
  contains() { return true; }
}
function harness() {
  const content = new Target(), doc = new Target(); doc.body = { contains: () => true };
  const view = { contentEl: content, file: { path: 'test.pdf' } };
  const pills = []; let opens = 0, selection = null;
  const m = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/pdf.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const plugin = { isAlive: true, settings: { pdfEnabled: true }, storage: { loadDoc: async () => ({ entries: [] }) },
    app: { workspace: { getLeavesOfType: () => [{ view }] } }, openPdfCreatePopover() { opens++; } };
  vm.runInNewContext(code, { module: m, exports: m.exports, document: doc, window: { getSelection: () => selection },
    setTimeout, clearTimeout, Node: class {}, Element: class {},
    MutationObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    require: p => p === './popover' ? { SelectionPill: class { constructor() { pills.push(this); this.button = {}; } show() { this.visible = true; } hide() { this.visible = false; } ensureEl() { return this.button; } dispose() { this.dead = true; } } } : {} });
  const pdf = new m.exports.PdfGloss(plugin);
  return { pdf, content, doc, pills, view, get opens() { return opens; }, set selection(v) { selection = v; } };
}
test('PDF repeated toggle removes capturing handlers, document handlers and selection pills', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) {
    h.pdf.scan(); await Promise.resolve();
    assert.equal(h.content.handlers.filter(e => e.type === 'mousedown' && e.capture).length, 1);
    h.pdf.setPdfEnabled(false);
    assert.equal(h.content.handlers.length, 0);
    assert.equal(h.doc.handlers.length, 0);
  }
  h.pdf.scan(); h.pdf.dispose();
  assert.equal(h.content.handlers.length, 0);
  assert.equal(h.doc.handlers.length, 0);
  assert.ok(h.pills.every(p => p.dead));
});
test('PDF text selection offers a button without opening or focusing an editor', async () => {
  const h = harness(); h.pdf.scan(); await Promise.resolve();
  const rect = { left: 10, right: 50, top: 20, bottom: 40, width: 40, height: 20 };
  const canvas = { closest: () => ({ getAttribute: () => '3' }), getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 200 }) };
  const page = { querySelector: () => canvas }, textNode = { parentElement: { closest: () => page } };
  h.selection = { isCollapsed: false, rangeCount: 1, toString: () => 'selected text', getRangeAt: () => ({ startContainer: textNode, endContainer: textNode, getBoundingClientRect: () => rect }) };
  h.doc.handlers.find(h => h.type === 'selectionchange').cb();
  assert.equal(h.opens, 0);
  assert.equal(h.pills[0].visible, true);
  h.pills[0].button.onclick();
  assert.equal(h.opens, 1);
  h.pdf.dispose();
});
