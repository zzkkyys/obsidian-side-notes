const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(entries, initial = {}) {
  const disk = new Map(Object.entries(initial)), dirs = new Set(['']), notices = [], reads = [], created = [];
  const parent = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  for (const p of disk.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const adapter = {
    exists: async p => disk.has(p) || dirs.has(p),
    readBinary: async p => { reads.push(p); if (!disk.has(p)) throw Error('missing source'); return disk.get(p); },
    list: async p => ({ files: [...disk.keys()].filter(k => parent(k) === p), folders: [...dirs].filter(k => k && parent(k) === p) }),
  };
  const put = async (p, data) => {
    if (disk.has(p) || dirs.has(p)) throw Error('already exists');
    if (!dirs.has(parent(p))) throw Error('missing parent');
    disk.set(p, data); created.push(p); return { path: p };
  };
  const vault = {
    adapter,
    getAbstractFileByPath: p => p.startsWith('.') ? null : disk.has(p) ? { path: p } : null,
    create: put, createBinary: put,
    createFolder: async p => { if (await adapter.exists(p)) throw Error('already exists'); dirs.add(p); return { path: p }; },
    delete: async file => {
      if (dirs.has(file.path)) {
        const children = await adapter.list(file.path);
        if (children.files.length || children.folders.length) throw Error('non-empty');
        dirs.delete(file.path);
      } else disk.delete(file.path);
    },
  };
  const store = { entries }, modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const mod = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
    vm.runInNewContext(code, {
      module: mod, exports: mod.exports, Error,
      require: p => p === 'obsidian' ? { Notice: class { constructor(text) { notices.push(text); } }, normalizePath: p => p }
        : p === './util' ? { fmtStamp: () => 'STAMP', fmtTime: () => 'TIME', uuid: () => '12345678-unique' }
        : load(p.slice(2)),
    });
    modules.set(name, mod.exports); return mod.exports;
  }
  const plugin = { app: { vault }, storage: { loadDoc: async () => store, typeOf: () => ({ emoji: '💬', name: '一般批注' }) } };
  return { disk, dirs, reads, notices, created, vault, plugin, store,
    run: () => load('export').exportDocAnnotations(plugin, { path: 'note.md', basename: 'note' }),
    markdown: () => [...disk].find(([p]) => p.endsWith('.md')),
  };
}
const attachment = (path, kind = 'image') => ({ id: path, path, name: path.split('/').pop(), kind, mime: 'image/png', size: 3 });
const entry = (attachments, content = '', reply = '') => ({
  anchor: { kind: 'md', text: 'source text' },
  note: { id: 'note', typeId: 'general', createdAt: 1, content, attachments, replies: reply ? [{ id: 'reply', content: reply, createdAt: 2 }] : [] },
});
const encoded = p => p.split('/').map(s => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)).join('/');
const markdownPaths = text => [...text.matchAll(/\]\(<([^>]+)>\)|\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(m => m[2] ?? decodeURIComponent(m[1]));

test('hidden attachments export as visible copies, including note/reply refs, without changing the store', async () => {
  const p = '.gloss/attachments/n/photo.png', a = attachment(p);
  const entries = [entry([a], `before ![[${p}]] after`, `[查看](<${encoded(p)}>)`), entry([{ ...a }], `![duplicate](<${encoded(p)}>)`)];
  const before = JSON.stringify(entries), f = fixture(entries, { [p]: Buffer.from('png') });
  await f.run();
  const [name, text] = f.markdown(), copies = f.created.filter(p => !p.endsWith('.md'));
  assert.equal(copies.length, 1);
  assert.ok(copies[0].startsWith(name.slice(0, -3) + '.assets/'));
  assert.equal(copies[0].split('/').some(s => s.startsWith('.')), false);
  assert.deepEqual(f.disk.get(copies[0]), Buffer.from('png'));
  assert.equal(markdownPaths(text).filter(p => p === copies[0]).length, 5);
  assert.equal(text.includes('.gloss/'), false);
  assert.equal(JSON.stringify(entries), before);
  assert.equal(f.disk.has(p), true);
  assert.deepEqual(f.reads, [p]);
  assert.match(f.notices.at(-1), /已导出/);
});

test('visible attachment paths remain usable without making copies or folders', async () => {
  const p = 'images/my photo (1).png', a = attachment(p), f = fixture([entry([a], `![photo](<${encoded(p)}>)`)], { [p]: 'bytes' });
  await f.run();
  const [, text] = f.markdown();
  assert.deepEqual(markdownPaths(text), [p, p]);
  assert.equal([...f.dirs].some(p => p.endsWith('.assets')), false);
  assert.deepEqual(f.reads, []);
});

test('literal percent and space filenames remain distinct in all exported references', async () => {
  const a = attachment('.gloss/attachments/n/my%20photo.png'), b = attachment('.gloss/attachments/n/my photo.png');
  const f = fixture([entry([a, b], `![percent](<${encoded(a.path)}>) ![[${b.path}]]`, `[[${a.path}|literal]] [space](<${encoded(b.path)}>)`)], { [a.path]: 'percent', [b.path]: 'space' });
  await f.run();
  const [, text] = f.markdown(), paths = markdownPaths(text);
  assert.equal(new Set(paths).size, 2);
  assert.equal(paths.length, 6);
  assert.equal(f.disk.get(paths[0]), 'percent');
  assert.equal(f.disk.get(paths[1]), 'space');
  assert.equal(f.disk.get(paths[2]), 'percent');
  assert.equal(f.disk.get(paths[3]), 'space');
  assert.ok(text.includes('my%2520photo.png'));
  assert.ok(text.includes('my%20photo.png'));
});

test('missing hidden or visible assets fail the export instead of publishing broken links', async t => {
  for (const p of ['.gloss/attachments/missing.png', 'images/missing.png']) await t.test(p, async () => {
    const f = fixture([entry([attachment(p)])]);
    await f.run();
    assert.equal(f.markdown(), undefined);
    assert.equal(f.created.length, 0);
    assert.match(f.notices.at(-1), /导出失败：附件不存在/);
  });
});

test('copy failure removes earlier copies and leaves original attachments intact', async () => {
  const a = attachment('.gloss/attachments/a.png'), b = attachment('.gloss/attachments/b.png');
  const f = fixture([entry([a, b])], { [a.path]: 'a', [b.path]: 'b' });
  const create = f.vault.createBinary;
  f.vault.createBinary = async (p, bytes) => { if (p.endsWith('b.png')) throw Error('disk full'); return create(p, bytes); };
  await f.run();
  assert.equal(f.markdown(), undefined);
  assert.deepEqual([...f.disk.keys()], [a.path, b.path]);
  assert.equal([...f.dirs].some(p => p.endsWith('.assets')), false);
  assert.match(f.notices.at(-1), /disk full/);
});

test('Markdown write failure cleans owned copies but preserves unrelated files in the new folder', async () => {
  const a = attachment('.gloss/attachments/a.png'), f = fixture([entry([a])], { [a.path]: 'a' });
  let unrelated;
  f.vault.create = async p => {
    unrelated = p.slice(0, -3) + '.assets/added-by-user.txt';
    f.disk.set(unrelated, 'keep');
    throw Error('Markdown denied');
  };
  await f.run();
  assert.equal(f.markdown(), undefined);
  assert.deepEqual([...f.disk.keys()], [a.path, unrelated]);
  assert.match(f.notices.at(-1), /Markdown denied/);
});

test('repeated exports use distinct names and never replace an existing Markdown or asset copy', async () => {
  const a = attachment('.gloss/attachments/a.png'), f = fixture([entry([a])], { [a.path]: 'a' });
  await f.run();
  const first = new Map(f.disk);
  f.store.entries[0].note.content = 'second export';
  await f.run();
  for (const [p, content] of first) assert.equal(f.disk.get(p), content);
  assert.equal([...f.disk.keys()].filter(p => p.endsWith('.md')).length, 2);
  assert.equal([...f.disk.keys()].filter(p => p.includes('.assets/')).length, 2);
});

test('annotation load errors produce an export failure notice', async () => {
  const f = fixture([]);
  f.plugin.storage.loadDoc = async () => { throw Error('annotations offline'); };
  await f.run();
  assert.equal(f.created.length, 0);
  assert.match(f.notices.at(-1), /导出失败：annotations offline/);
});


test('long attachment names keep their media extension after export', async () => {
  const a = attachment('.gloss/attachments/' + 'very-long-name-'.repeat(10) + '.png');
  const f = fixture([entry([a], `![[${a.path}]]`)], { [a.path]: 'png' });
  await f.run();
  const [, text] = f.markdown(), [destination] = markdownPaths(text);
  assert.ok(destination.endsWith('.png'));
  assert.equal(f.disk.get(destination), 'png');
});
