const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
class El {
  constructor(tag, o = {}) { this.tag = tag; this.cls = o.cls || ''; this.children = []; this.listeners = {}; this.attrs = {}; this.style = { setProperty() {} }; this.dataset = {}; this.classList = { contains: c => this.cls.split(' ').includes(c), toggle() {} }; }
  createEl(tag, o) { const el = new El(tag, o); this.appendChild(el); return el; }
  createDiv(o) { return this.createEl('div', o); }
  createSpan(o) { return this.createEl('span', o); }
  appendChild(el) { if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el); this.children.push(el); el.parent = this; }
  insertBefore(el, before) { if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el); this.children.splice(this.children.indexOf(before), 0, el); el.parent = this; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  setAttribute(k, v) { this.attrs[k] = v; }
  setText() {} empty() { this.children = []; } querySelectorAll() { return []; } toggleClass() {} focus() {}
}
function find(el, cls) { if (el.cls.split(' ').includes(cls)) return el; for (const child of el.children) { const hit = find(child, cls); if (hit) return hit; } }
const m = { exports: {} }; let uuid = 0;
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/card.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText, {
  module: m, exports: m.exports, createEl: (tag, o) => new El(tag, o),
  require: name => name === 'obsidian' ? { setIcon() {} } : name === './util' ? { uuid: () => String(++uuid), fmtTime: () => 'now' } : name === './card-style' ? { applyCardStyle() {} } : name === './images' ? { renderGallery() {} } : {},
});
test('ordinary card rebuild preserves the reply draft and expanded state; send clears only that draft', () => {
  const entry = { anchor: { text: 'quote' }, note: { id: 'n', content: '', attachments: [], replies: [], createdAt: 1 } };
  const hooks = { onChanged() {}, onDeleted() {} };
  const build = () => m.exports.buildCard({}, entry, { emoji: '', name: 'test' }, 'doc.md', hooks);
  let card = build();
  find(card, 'gloss-reply-toggle').onclick({ stopPropagation() {} });
  const ta = find(card, 'gloss-reply-ta'); ta.value = 'unfinished reply'; ta.listeners.input();
  card = build();
  assert.equal(find(card, 'gloss-reply-ta').value, 'unfinished reply');
  assert.equal(find(card, 'gloss-card-replies').hidden, false);
  find(card, 'gloss-reply-send').onclick();
  card = build();
  assert.equal(find(card, 'gloss-reply-ta').value, '');
  assert.equal(entry.note.replies[0].content, 'unfinished reply');
  assert.equal(find(card, 'gloss-card-replies').hidden, false);
});
