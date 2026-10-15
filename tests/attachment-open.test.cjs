const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/attachment-open.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;
const imageModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/image-model.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText, { module: imageModule, exports: imageModule.exports });
const attachment = { id: 'a', path: '.gloss/attachments/n/a%20b file.pdf', name: 'a%20b file.pdf', mime: 'application/pdf', kind: 'file' };

function harness(options = {}) {
  const calls = [], timers = [];
  class TFile {}
  class FileSystemAdapter {
    async stat(p) { calls.push(['stat', p]); return options.stat === undefined ? { type: 'file' } : options.stat; }
    getFullPath(p) { return `/vault/${p}`; }
    getResourcePath(p) { return `app://resource/${encodeURIComponent(p)}`; }
    async readBinary(p) { calls.push(['read', p]); return new Uint8Array([1, 2, 3]).buffer; }
  }
  const adapter = new FileSystemAdapter();
  const indexed = options.indexed ? new TFile() : null;
  const plugin = { app: { vault: { adapter, getAbstractFileByPath: () => indexed }, workspace: { getLeaf(reuse) {
    calls.push(['leaf', reuse]); return { async openFile(file) { calls.push(['openFile', file]); } };
  } } } };
  const doc = { body: { appendChild(link) { calls.push(['append', link]); } }, createElement() {
    return { style: {}, click() { calls.push(['download', this.href, this.download]); }, remove() { calls.push(['remove']); } };
  }, defaultView: { Blob, File: require('node:buffer').File, navigator: options.navigator || {},
    URL: { createObjectURL(blob) { calls.push(['blob', blob]); return 'blob:attachment'; }, revokeObjectURL(url) { calls.push(['revoke', url]); } },
    setTimeout(callback) { timers.push(callback); },
  } };
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require(name) {
    if (name === './image-model') return imageModule.exports;
    if (name === 'obsidian') return { TFile, FileSystemAdapter, Notice: class { constructor(text) { calls.push(['notice', text]); } }, Platform: { isDesktopApp: options.desktop !== false } };
    if (name === 'electron') {
      assert.notEqual(options.desktop, false, 'mobile must never import Electron');
      return { shell: { async openPath(p) { calls.push(['native', p]); return options.nativeError || ''; } } };
    }
    throw new Error(`Unexpected module: ${name}`);
  } });
  return { calls, timers, indexed, plugin, doc, api: module.exports, open: (a = attachment) => module.exports.openAttachment(plugin, a, doc) };
}

test('indexed files continue to open in an Obsidian leaf', async () => {
  const h = harness({ indexed: true });
  await h.open();
  assert.deepEqual(h.calls, [['leaf', false], ['openFile', h.indexed]]);
});

test('hidden desktop files open their exact filesystem path without URI decoding', async () => {
  const h = harness();
  await h.open();
  assert.deepEqual(h.calls, [['stat', attachment.path], ['native', `/vault/${attachment.path}`]]);
});

test('missing files and directories fail instead of silently doing nothing', async () => {
  for (const stat of [null, { type: 'folder' }]) {
    const h = harness({ stat });
    await assert.rejects(h.open(), /附件缺失或尚未同步/);
    assert.equal(h.calls.length, 1);
  }
});

test('native open failures are propagated for a user-visible notice', async () => {
  await assert.rejects(harness({ nativeError: 'no application' }).open(), /无法打开附件.*no application/);
});

test('untrusted absolute and traversal paths never reach the adapter or shell', async () => {
  for (const p of ['/etc/passwd', '../secret', '.gloss/../secret', 'C:/secret', '.gloss\\secret', '']) {
    const h = harness();
    await assert.rejects(h.open({ ...attachment, path: p }), /附件路径无效/);
    assert.deepEqual(h.calls, []);
  }
});

test('mobile shares exact file bytes without loading Electron', async () => {
  let shared;
  const h = harness({ desktop: false, navigator: { canShare: () => true, share: async data => { shared = data.files[0]; } } });
  await h.open();
  assert.equal(shared.name, attachment.name);
  assert.equal(shared.type, attachment.mime);
  assert.deepEqual([...new Uint8Array(await shared.arrayBuffer())], [1, 2, 3]);
  assert.equal(h.calls.some(c => c[0] === 'download'), false);
});

test('mobile downloads bytes in the owning document when file sharing is unavailable', async () => {
  const h = harness({ desktop: false });
  await h.open();
  assert.deepEqual(h.calls.find(c => c[0] === 'download'), ['download', 'blob:attachment', attachment.name]);
  assert.equal(h.calls.some(c => c[0] === 'remove'), true);
  assert.equal(h.calls.some(c => c[0] === 'revoke'), false);
  h.timers[0]();
  assert.deepEqual(h.calls.at(-1), ['revoke', 'blob:attachment']);
});

test('canceling system share does not trigger an unwanted download', async () => {
  const h = harness({ desktop: false, navigator: { canShare: () => true, async share() { throw Object.assign(new Error('cancel'), { name: 'AbortError' }); } } });
  await h.open();
  assert.equal(h.calls.some(c => c[0] === 'download'), false);
});

test('rejected system share falls back to a download', async () => {
  const h = harness({ desktop: false, navigator: { canShare: () => true, async share() { throw Object.assign(new Error('activation'), { name: 'NotAllowedError' }); } } });
  await h.open();
  assert.equal(h.calls.some(c => c[0] === 'download'), true);
});


const encode = p => p.split('/').map(encodeURIComponent).join('/');
test('rendered Markdown and Wiki links preserve exact percent filenames and quoted titles', () => {
  const h = harness(), percent = { ...attachment, path: '.gloss/attachments/my%20file.pdf' };
  const space = { ...attachment, path: '.gloss/attachments/my file.pdf' };
  const resource = a => h.plugin.app.vault.adapter.getResourcePath(a.path);
  const text = `[percent](<${encode(percent.path)}> "PDF") [space](<${encode(space.path)}>) [[${percent.path}|literal]] [[${space.path}|space]]`;
  assert.equal(h.api.renderAttachmentLinks(text, [space, percent], resource),
    `[percent](<${resource(percent)}> "PDF") [space](<${resource(space)}>) [literal](<${resource(percent)}>) [space](<${resource(space)}>)`);
  // Decoding the Markdown destination once names the space file, never the percent file.
  assert.equal(h.api.renderAttachmentLinks(`[encoded](<${percent.path}>)`, [percent], resource), `[encoded](<${percent.path}>)`);
});

test('ordinary-link conversion leaves images, unrelated links and external URLs intact', () => {
  const h = harness(), resource = a => h.plugin.app.vault.adapter.getResourcePath(a.path);
  const text = `![image](<${encode(attachment.path)}>) ![[${attachment.path}]] [web](https://example.com/${encode(attachment.path)}) [[unrelated.pdf]]`;
  assert.equal(h.api.renderAttachmentLinks(text, [attachment], resource), text);
});

function boundHarness(options = {}) {
  const h = harness(options), listeners = [];
  const component = { registerDomEvent(root, name, callback, capture) { listeners.push({ root, name, callback, capture }); } };
  const root = { ownerDocument: h.doc, contains: el => el.inside !== false };
  h.api.bindAttachmentLinks(h.plugin, root, [attachment], component, options.resource);
  const click = (href, inside = true) => {
    const state = { prevented: false, stopped: false };
    const link = { inside, getAttribute: name => name === 'href' ? href : null };
    listeners[0].callback({ target: { closest: () => link }, preventDefault() { state.prevented = true; }, stopImmediatePropagation() { state.stopped = true; } });
    return state;
  };
  return { ...h, listeners, click, resource: h.plugin.app.vault.adapter.getResourcePath(attachment.path) };
}

test('capture-phase links open registered resources in their owning window and stop Obsidian dispatch', async () => {
  const h = boundHarness({ desktop: false });
  assert.equal(h.listeners[0].name, 'click');
  assert.equal(h.listeners[0].capture, true);
  assert.deepEqual(h.click(h.resource), { prevented: true, stopped: true });
  await new Promise(setImmediate);
  assert.equal(h.calls.some(c => c[0] === 'download' && c[2] === attachment.name), true);
});

test('unrelated URLs and links outside this renderer are never intercepted', async () => {
  const h = boundHarness();
  for (const [url, inside] of [['https://example.com/file.pdf', true], [attachment.path, true], [h.resource, false]]) {
    assert.deepEqual(h.click(url, inside), { prevented: false, stopped: false });
  }
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, []);
});

test('rendered link open failures surface as Notice instead of unhandled rejections', async () => {
  const h = boundHarness({ stat: null });
  h.click(h.resource);
  await new Promise(setImmediate);
  assert.match(h.calls.find(c => c[0] === 'notice')[1], /附件缺失或尚未同步/);
});


test('binding uses the same resource resolver as rendering, including indexed-file cache suffixes', async () => {
  const resource = a => `app://indexed/${encodeURIComponent(a.path)}?mtime=123`;
  const h = boundHarness({ indexed: true, resource });
  assert.deepEqual(h.click(h.resource), { prevented: false, stopped: false });
  assert.deepEqual(h.click(resource(attachment)), { prevented: true, stopped: true });
  await new Promise(setImmediate);
  assert.equal(h.calls.some(c => c[0] === 'openFile' && c[1] === h.indexed), true);
});


test('reference-style attachment links resolve their definitions to exact resources', () => {
  const h = harness(), resource = a => h.plugin.app.vault.adapter.getResourcePath(a.path);
  const percent = { ...attachment, path: '.gloss/attachments/my%20file.pdf' };
  const space = { ...attachment, path: '.gloss/attachments/my file.pdf' };
  const text = `[percent][one] [space][two] [web][three]\n[one]: <${encode(percent.path)}> "title"\n[two]: ${encode(space.path)}\n[three]: https://example.com/file.pdf`;
  assert.equal(h.api.renderAttachmentLinks(text, [percent, space], resource),
    `[percent][one] [space][two] [web][three]\n[one]: <${resource(percent)}> "title"\n[two]: <${resource(space)}>\n[three]: https://example.com/file.pdf`);
});
