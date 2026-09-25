const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const moduleImage = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/image-model.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
vm.runInNewContext(code, { module: moduleImage, exports: moduleImage.exports });
const { imageMarkdown, isInline, removeInline, moveAttachment } = moduleImage.exports;
const a = { id: 'a', path: '附件/a (1)#图.png', name: 'a [图].png', kind: 'image' };
test('image references safely encode spaces, parentheses, hashes and Unicode', () => {
  const md = imageMarkdown(a);
  assert.equal(md, '![a _图_.png](<%E9%99%84%E4%BB%B6/a%20%281%29%23%E5%9B%BE.png>)');
  assert.equal(decodeURIComponent(md.match(/<([^>]+)>/)[1]), a.path);
});
test('moving inline images back to gallery preserves surrounding prose and original attachment', () => {
  const before = '说明\n' + imageMarkdown(a) + '\n结论';
  assert.equal(isInline(before, a), true);
  const after = removeInline(before, a);
  assert.equal(after, '说明\n\n结论');
  assert.equal(isInline(after, a), false);
  assert.equal(a.path, '附件/a (1)#图.png');
});
test('legacy wiki embeds are recognized and can move to bottom', () => {
  const text = `before ![[${a.path}]] after`;
  assert.equal(isInline(text, a), true);
  assert.equal(removeInline(text, a), 'before  after');
});
test('reordering keeps attachment identity, paths and count intact', () => {
  const b = { id: 'b', path: 'b.png' }, c = { id: 'c', path: 'c.png' };
  const items = [a, b, c];
  moveAttachment(items, 'c', 'a');
  assert.deepEqual(items, [c, a, b]);
  moveAttachment(items, 'missing', 'a');
  assert.deepEqual(items, [c, a, b]);
});

class Element {
  constructor(tag = 'div', opts = {}) { this.tag = tag; this.children = []; this.listeners = {}; this.value = opts.value || ''; this.text = opts.text || ''; this.isConnected = true; this.selectionStart = this.selectionEnd = this.value.length; }
  createEl(tag, opts) { const e = new Element(tag, opts); this.children.push(e); return e; }
  createDiv(opts) { return this.createEl('div', opts); }
  createSpan(opts) { return this.createEl('span', opts); }
  empty() { this.children = []; }
  setText(text) { this.text = text; }
  setAttribute() {}
  addEventListener(name, cb) { this.listeners[name] = cb; }
  setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; }
  focus() {}
  remove() { this.isConnected = false; }
}
function composerHarness(saveBinary) {
  let id = 0;
  const m = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/images.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(source, { module: m, exports: m.exports, require: name => name === './image-model' ? moduleImage.exports : name === './util' ? { uuid: () => String(++id) } : { Modal: class {}, TFile: class {}, Notice: class {} } });
  const plugin = { storage: { ensureAttachmentsDir: async () => 'images', saveBinary }, app: { vault: { getAbstractFileByPath: () => null, adapter: { getResourcePath: p => p } } } };
  const root = new Element(), ta = new Element('textarea', { value: 'before after' }), attachments = [];
  ta.selectionStart = ta.selectionEnd = 7;
  const composer = m.exports.imageComposer(plugin, root, ta, 'note', attachments);
  const drop = files => root.listeners.drop({ dataTransfer: { files }, preventDefault() {}, stopPropagation() {} });
  const paste = files => ta.listeners.paste({ clipboardData: { files }, preventDefault() {} });
  return { root, ta, attachments, composer, drop, paste };
}
const file = name => ({ name, type: 'image/png', size: 10 });
test('saving waits for all uploads; same-name files serialize and frozen composer refuses additions', async () => {
  let release, began, started = 0;
  const firstStarted = new Promise(r => began = r);
  const gate = new Promise(r => release = r);
  const h = composerHarness(async () => { const n = ++started; if (n === 1) { began(); await gate; } return `images/${n}.png`; });
  h.drop([file('same.png'), file('same.png')]);
  await firstStarted;
  assert.equal(started, 1);
  h.composer.freeze(true);
  h.drop([file('extra.png')]);
  let done = false;
  const ready = h.composer.ready().then(() => done = true);
  await Promise.resolve(); assert.equal(done, false);
  release(); await ready;
  assert.equal(h.attachments.length, 2);
  assert.deepEqual(Array.from(h.attachments, a => a.path), ['images/1.png', 'images/2.png']);
});
test('pasting inserts at the original cursor even if more text is typed while uploading', async () => {
  let release;
  const gate = new Promise(r => release = r);
  const h = composerHarness(async () => { await gate; return 'images/pasted.png'; });
  h.paste([file('pasted.png')]);
  h.ta.value += ' typed later';
  release(); await h.composer.ready();
  assert.equal(h.ta.value, `before \n${imageMarkdown(h.attachments[0])}\nafter typed later`);
  assert.equal(isInline(h.ta.value, h.attachments[0]), true);
});
test('failed uploads block save and remove temporary inline marker', async () => {
  const h = composerHarness(async () => { throw new Error('disk full'); });
  h.paste([file('failed.png')]);
  await assert.rejects(h.composer.ready(), /部分附件/);
  assert.equal(h.ta.value, 'before after');
  assert.equal(h.attachments.length, 0);
});
test('changing image alt text does not show a duplicate gallery thumbnail', () => {
  const changed = imageMarkdown(a).replace('a _图_.png', 'new caption');
  assert.equal(isInline(changed, a), true);
  assert.equal(removeInline(changed, a), '');
});
test('CleanShot @2x legacy reference renders via the exact stored attachment path', () => {
  const a = { id: 'screenshot', kind: 'image', name: 'CleanShot 2026-09-23 at 22.26.05@2x.png', path: 'gloss-attachments/n/CleanShot 2026-09-23 at 22.26.05@2x.png' };
  const stored = imageMarkdown(a);
  assert.match(stored, /%402x/);
  let resolved;
  const rendered = moduleImage.exports.renderImageReferences(stored, [a], attachment => { resolved = attachment.path; return 'app://resource/image.png'; });
  assert.equal(resolved, a.path);
  assert.equal(rendered, `![${a.name}](<app://resource/image.png>)`);
  assert.equal(isInline(stored, a), true);
});
test('render conversion preserves text, unrelated images and literal percent filenames', () => {
  const a = { kind: 'image', name: 'literal%20.png', path: 'attachments/literal%20.png' };
  const text = `before ![[${a.path}]] after ![external](https://example.com/x.png)`;
  assert.equal(moduleImage.exports.renderImageReferences(text, [a], () => 'app://local/image.png'), 'before ![literal%20.png](<app://local/image.png>) after ![external](https://example.com/x.png)');
});
test('memo editor restores existing multiline content on Obsidian versions ignoring textarea value options', () => {
  class LegacyElement extends Element {
    createEl(tag, opts = {}) { const e = new LegacyElement(tag, { ...opts, value: '' }); this.children.push(e); return e; }
    appendChild(el) { this.children.push(el); return el; }
  }
  const m = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/memo-editor.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(source, { module: m, exports: m.exports, require: name => name === './image-model' ? moduleImage.exports : name === './images' ? {
    imageComposer: () => ({ actions: new LegacyElement(), gallery: new LegacyElement(), ready: async () => {}, freeze() {} }),
    renderGallery() {},
  } : {} });
  const original = '原有批注 **重点**\n第二段\n' + imageMarkdown(a);
  const root = new LegacyElement();
  const editor = m.exports.createMemoEditor({}, root, original, 'note', [a], 'doc.md');
  assert.equal(editor.input.value, original);
  editor.input.value += '\n新增想法';
  assert.equal(editor.input.value, original + '\n新增想法');
  editor.dispose();
});
