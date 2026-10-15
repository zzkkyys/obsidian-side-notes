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
  setRangeText(text, start, end, mode) {
    const a = this.selectionStart, b = this.selectionEnd;
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    const map = position => position <= start ? position : position >= end ? position + text.length - (end - start) : start + text.length;
    this.selectionStart = mode === 'preserve' ? map(a) : start + text.length;
    this.selectionEnd = mode === 'preserve' ? map(b) : start + text.length;
  }
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
    imageComposer: () => ({ actions: new LegacyElement(), gallery: new LegacyElement(), ready: async () => {}, freeze() {}, dispose() {} }),
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

test('two attachments with identical labels open by destination rather than first alt match', () => {
  const images = [{ id: 'one', name: 'image.png', path: 'image.png' }, { id: 'two', name: 'image.png', path: 'image (1).png' }];
  assert.equal(moduleImage.exports.attachmentForSource(images, 'app://image (1).png', a => 'app://' + a.path).id, 'two');
});

test('upload completion preserves a caret that the user moved elsewhere', async () => {
  let release, began; const started = new Promise(r => began = r), gate = new Promise(r => release = r);
  const h = composerHarness(async () => { began(); await gate; return 'images/new.png'; });
  h.paste([file('image.png')]); await started;
  h.ta.selectionStart = h.ta.selectionEnd = 2;
  release(); await h.composer.ready();
  assert.equal(h.ta.selectionStart, 2); assert.equal(h.ta.selectionEnd, 2);
  assert.ok(h.ta.value.includes('images/new.png'));
});


test('percent escapes and spaces identify distinct attachments in Markdown and Wiki references', () => {
  const literal = { id: 'literal', kind: 'image', name: 'my%20photo.png', path: 'images/my%20photo.png' };
  const spaced = { id: 'spaced', kind: 'image', name: 'my photo.png', path: 'images/my photo.png' };
  for (const [target, other] of [[literal, spaced], [spaced, literal]]) {
    for (const reference of [imageMarkdown(target), `![[${target.path}]]`]) {
      assert.equal(isInline(reference, target), true);
      assert.equal(isInline(reference, other), false);
      assert.equal(removeInline(reference, other), reference);
      assert.equal(removeInline(reference, target), '');
      assert.equal(moduleImage.exports.moveImageReferences(reference, other, 'moved.png'), reference);
      assert.equal(moduleImage.exports.moveImageReferences(reference, target, 'moved.png'), imageMarkdown({ ...target, path: 'moved.png' }));
      for (const attachments of [[literal, spaced], [spaced, literal]]) {
        assert.equal(moduleImage.exports.renderImageReferences(reference, attachments, a => `app://${a.id}`), `![${target.name}](<app://${target.id}>)`);
      }
    }
  }
});


test('attachment relocation preserves Markdown titles, labels and Wiki aliases', () => {
  const { moveAttachmentReferences } = moduleImage.exports;
  const file = { ...a, path: 'old/pic (1).png' };
  const before = '![my label](<old/pic%20%281%29.png> "title") [file](<old/pic%20%281%29.png>) ![[old/pic (1).png|200]] [[old/pic (1).png|alias]]';
  const after = moveAttachmentReferences(before, file, '.gloss/attachments/new (1).png');
  assert.equal(after, '![my label](<.gloss/attachments/new%20%281%29.png> "title") [file](<.gloss/attachments/new%20%281%29.png>) ![[.gloss/attachments/new (1).png|200]] [[.gloss/attachments/new (1).png|alias]]');
  assert.equal(moveAttachmentReferences('[literal](<old/pic%2520%281%29.png>)', file, 'new.png'), '[literal](<old/pic%2520%281%29.png>)');
});


test('titled hidden images render through adapter resource URLs', () => {
  const { renderImageReferences } = moduleImage.exports;
  const file = { ...a, path: '.gloss/attachments/a.png' };
  assert.ok(renderImageReferences('![label](<.gloss/attachments/a.png> "title")', [file], () => 'app://resource/a.png').includes('app://resource/a.png'));
});


test('reference-style images render and relocate definitions without changing labels or titles', () => {
  const { renderImageReferences, moveAttachmentReferences } = moduleImage.exports;
  const file = { ...a, path: '.gloss/attachments/a photo.png' };
  const text = '![caption][asset]\n\n  [asset]: <.gloss/attachments/a%20photo.png> "image title"';
  assert.equal(renderImageReferences(text, [file], () => 'app://resource/a%20photo.png'),
    '![caption][asset]\n\n  [asset]: <app://resource/a%20photo.png> "image title"');
  assert.equal(moveAttachmentReferences(text, file, 'export.assets/a photo.png'),
    '![caption][asset]\n\n  [asset]: <export.assets/a%20photo.png> "image title"');
});

test('reference definition matching distinguishes literal percent names from spaces and ignores unrelated URLs', () => {
  const { rewriteAttachmentDefinitions } = moduleImage.exports;
  const literal = { ...a, path: 'my%20photo.png' }, spaced = { ...a, path: 'my photo.png' };
  const text = '[percent]: my%2520photo.png\n[space]: my%20photo.png\n[web]: https://example.com/my%20photo.png\n    [code]: my%20photo.png';
  assert.equal(rewriteAttachmentDefinitions(text, literal, 'literal.png'),
    '[percent]: <literal.png>\n[space]: my%20photo.png\n[web]: https://example.com/my%20photo.png\n    [code]: my%20photo.png');
  assert.equal(rewriteAttachmentDefinitions(text, spaced, 'space.png'),
    '[percent]: my%2520photo.png\n[space]: <space.png>\n[web]: https://example.com/my%20photo.png\n    [code]: my%20photo.png');
});
