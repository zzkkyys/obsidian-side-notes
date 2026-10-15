const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

class Element {
  constructor(tag, options = {}) {
    this.tag = tag; this.cls = options.cls || ''; this.children = []; this.dataset = {};
    this.style = { setProperty() {} };
  }
  createEl(tag, options) { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  empty() { this.children = []; }
  addEventListener() {} addClass() {} removeClass() {}
  querySelectorAll() { return []; }
}
function find(el, cls) {
  if (el.cls.split(' ').includes(cls)) return el;
  for (const child of el.children) { const found = find(child, cls); if (found) return found; }
}
function harness(types) {
  const m = { exports: {} };
  class Modal {
    constructor() { this.contentEl = new Element('div'); }
    close() { this.onClose(); }
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/typemanager.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, {
    module: m, exports: m.exports, setTimeout() {},
    require: name => name === 'obsidian' ? { Modal, Notice: class {} } : { uuid: () => 'new-type' },
  });
  let saved;
  const plugin = {
    storage: { canEditTypes: true, types, async saveTypesSnapshot(draft) { saved = JSON.parse(JSON.stringify(draft)); } },
    settings: { defaultTypeId: 'A' }, refreshAll() {},
  };
  const modal = new m.exports.TypeManagerModal({}, plugin); modal.onOpen();
  const list = find(modal.contentEl, 'gloss-tm-list');
  return {
    order: () => list.children.map(row => find(row, 'gloss-tm-name').value),
    up(index) { find(list.children[index], 'gloss-tm-nav').children[0].onclick(); },
    remove(index) { const button = find(list.children[index], 'gloss-tm-del'); button.onclick(); button.onclick(); },
    async save() { await find(modal.contentEl, 'gloss-primary').onclick(); return saved.sort((a, b) => a.order - b.order).map(t => t.id); },
  };
}
const type = (id, order) => ({ id, name: id, order, color: '#3b82f6', emoji: '' });

test('deleting a type preserves the order edited in the same manager session', async () => {
  const types = [type('A', 0), type('B', 1), type('C', 2)];
  const h = harness(types);
  h.up(2); h.up(1);
  assert.deepEqual(h.order(), ['C', 'A', 'B']);
  h.remove(2);
  assert.deepEqual(h.order(), ['C', 'A']);
  assert.deepEqual(types.map(t => t.order), [0, 1, 2]);
  assert.deepEqual(await h.save(), ['C', 'A']);
});

test('deleting a type preserves persisted order when the source array is unsorted', async () => {
  const h = harness([type('A', 1), type('B', 2), type('C', 0)]);
  assert.deepEqual(h.order(), ['C', 'A', 'B']);
  h.remove(2);
  assert.deepEqual(h.order(), ['C', 'A']);
  assert.deepEqual(await h.save(), ['C', 'A']);
});
