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
let lastModal, lastComposer;
class Modal {
  constructor() { lastModal = this; this.contentEl = new El('div'); this.contentEl.isConnected = true; this.modalEl = { addClass() {} }; }
  setTitle() {} open() {} close() { this.closed = true; this.onClose?.(); }
}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/card.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText, {
  module: m, exports: m.exports, createEl: (tag, o) => new El(tag, o),
  require: name => name === 'obsidian' ? { setIcon() {}, Notice: class {}, Modal } : name === './util' ? { uuid: () => String(++uuid), fmtTime: () => 'now' } : name === './card-style' ? { applyCardStyle() {} } : name === './images' ? { renderGallery() {}, openImageModal(_plugin, modal) { modal.open(); } } : name === './memo-editor' ? { createMemoEditor() { const input = { value: '', focus() {}, setSelectionRange() {} }; return lastComposer = { input, buttons: new El('div'), ready: async () => {}, freeze() {}, dispose() {} }; } } : {},
});
test('ordinary card rebuild preserves the reply draft and expanded state; send clears only that draft', async () => {
  const entry = { anchor: { text: 'quote' }, note: { id: 'n', content: '', attachments: [], replies: [], createdAt: 1 } };
  const plugin = {};
  const hooks = { async onChanged(next) { Object.assign(entry.note, next); }, async onDeleted() {} };
  const build = () => m.exports.buildCard(plugin, entry, { emoji: '', name: 'test' }, 'doc.md', hooks);
  let card = build();
  find(card, 'gloss-reply-toggle').onclick({ stopPropagation() {} });
  const ta = find(card, 'gloss-reply-ta'); ta.value = 'unfinished reply'; ta.listeners.input();
  card = build();
  assert.equal(find(card, 'gloss-reply-ta').value, 'unfinished reply');
  assert.equal(find(card, 'gloss-card-replies').hidden, false);
  await find(card, 'gloss-reply-send').onclick();
  card = build();
  assert.equal(find(card, 'gloss-reply-ta').value, '');
  assert.equal(entry.note.replies[0].content, 'unfinished reply');
  assert.equal(find(card, 'gloss-card-replies').hidden, false);
});


test('rejected reply retains text even after store identity changes', async () => {
  const plugin = {};
  const entry = { anchor: { text: 'quote' }, note: { id: 'stale', content: '', attachments: [], replies: [], createdAt: 1 } };
  const hooks = { async onChanged() { throw Error('stale store'); }, async onDeleted() {} };
  let card = m.exports.buildCard(plugin, entry, {}, 'doc.md', hooks);
  const ta = find(card, 'gloss-reply-ta'); ta.value = 'do not lose this'; ta.listeners.input();
  await find(card, 'gloss-reply-send').onclick();
  assert.equal(ta.value, 'do not lose this');
  assert.equal(entry.note.replies.length, 0);
  card = m.exports.buildCard(plugin, JSON.parse(JSON.stringify(entry)), {}, 'doc.md', hooks);
  assert.equal(find(card, 'gloss-reply-ta').value, 'do not lose this');
});


test('a rejected editor save keeps the modal and its text, leaving the published note untouched', async () => {
  const plugin = { isAlive: true }, entry = { anchor: { text: 'quote' }, note: { id: 'editor-test', content: '', attachments: [], replies: [], createdAt: 1 } };
  const card = m.exports.buildCard(plugin, entry, {}, 'doc.md', { async onChanged() { throw Error('version changed'); }, async onDeleted() {} });
  find(card, 'gloss-card-control').onclick({ stopPropagation() {} });
  lastComposer.input.value = 'several minutes of writing';
  await find(lastComposer.buttons, 'mod-cta').onclick();
  assert.notEqual(lastModal.closed, true);
  assert.equal(lastComposer.input.value, 'several minutes of writing');
  assert.equal(entry.note.content, '');
});


for (const scenario of [
  { name: 'new input in the sending card', otherCard: false, next: 'next reply' },
  { name: 'a newly typed identical reply', otherCard: false, next: 'first reply' },
  { name: 'new input in another card', otherCard: true, next: 'next reply from another card' },
]) test(`successful reply save preserves ${scenario.name}`, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const plugin = {};
  const entry = { anchor: { text: 'quote' }, note: { id: 'pending-reply', content: '', attachments: [], replies: [], createdAt: 1 } };
  const hooks = { async onChanged(next) { await gate; Object.assign(entry.note, next); }, async onDeleted() {} };
  const build = () => m.exports.buildCard(plugin, entry, {}, 'doc.md', hooks);
  const card = build(), ta = find(card, 'gloss-reply-ta');
  ta.value = 'first reply'; ta.listeners.input();
  const sending = find(card, 'gloss-reply-send').onclick();
  const nextInput = scenario.otherCard ? find(build(), 'gloss-reply-ta') : ta;
  nextInput.value = scenario.next; nextInput.listeners.input();
  release(); await sending;
  assert.equal(entry.note.replies.length, 1);
  assert.equal(entry.note.replies[0].content, 'first reply');
  assert.equal(nextInput.value, scenario.next);
  assert.equal(find(build(), 'gloss-reply-ta').value, scenario.next);
});

test('sending an older card does not clear a newer shared draft that already exists', async () => {
  const plugin = {};
  const entry = { anchor: { text: 'quote' }, note: { id: 'older-card', content: '', attachments: [], replies: [], createdAt: 1 } };
  const hooks = { async onChanged(next) { Object.assign(entry.note, next); }, async onDeleted() {} };
  const build = () => m.exports.buildCard(plugin, entry, {}, 'doc.md', hooks);
  const first = build(), ta = find(first, 'gloss-reply-ta');
  ta.value = 'older reply'; ta.listeners.input();
  const secondInput = find(build(), 'gloss-reply-ta');
  secondInput.value = 'newer unsent draft'; secondInput.listeners.input();
  await find(first, 'gloss-reply-send').onclick();
  assert.equal(entry.note.replies[0].content, 'older reply');
  assert.equal(find(build(), 'gloss-reply-ta').value, 'newer unsent draft');
});
