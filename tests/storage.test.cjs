const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Blob, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require: p => p === 'obsidian' ? { Notice: class {}, ItemView: class {}, Component: class {}, TFile: class {} } : load(p.slice(2)) });
  modules.set(name, module.exports);
  return module.exports;
}
const { GlossStorage } = load('storage');
const { safePath, unsafePath } = load('types');
const jsonPath = p => `.gloss/annotations/${safePath(p)}.json`;
const note = id => ({ anchor: { kind: 'md', blockId: '', start: 0, end: 4, text: 'text' }, note: { id, content: id, attachments: [], replies: [] } });
const raw = (p, ...ids) => JSON.stringify({ version: 1, docPath: p, kind: 'md', entries: ids.map(note) });
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
function fixture(initial = {}) {
  const disk = new Map(Object.entries(initial));
  const dirs = new Set(['']);
  for (const file of disk.keys()) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const parent = p => p.slice(0, p.lastIndexOf('/'));
  const adapter = {
    exists: async p => disk.has(p) || dirs.has(p),
    read: async p => { if (!disk.has(p)) throw Error('ENOENT'); return disk.get(p); },
    mkdir: async p => { if (!dirs.has(parent(p))) throw Error('parent missing: ' + p); dirs.add(p); },
    write: async (p, value) => { if (!dirs.has(parent(p))) throw Error('parent missing: ' + p); disk.set(p, value); },
    remove: async p => disk.delete(p),
    list: async p => ({ files: [...disk.keys()].filter(k => parent(k) === p), folders: [...dirs].filter(k => k && parent(k) === p) }),
  };
  const vault = { adapter, createBinary: async (p, bytes) => { if (disk.has(p)) throw Error('exists'); await adapter.write(p, bytes); } };
  return { storage: new GlossStorage({ app: { vault } }), adapter, disk };
}
const ids = store => Array.from(store.entries, e => e.note.id);

test('nested legacy annotations migrate only after parent directories exist', async () => {
  const p = 'gloss/插件介绍.md';
  const f = fixture({ '.gloss/annotations/gloss__插件介绍.md.json': raw(p, 'A', 'B', 'C') });
  assert.deepEqual(ids(await f.storage.loadDoc(p)), ['A', 'B', 'C']);
  assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath(p)))), ['A', 'B', 'C']);
});
test('readable legacy annotations remain visible when migration cannot write', async () => {
  const p = 'd/a.md'; const legacy = '.gloss/annotations/d__a.md.json';
  const f = fixture({ [legacy]: raw(p, 'A') });
  f.adapter.write = async () => { throw Error('read only'); };
  assert.deepEqual(ids(await f.storage.loadDoc(p)), ['A']);
  assert.ok(f.disk.has(legacy));
});
test('encoding roundtrips separators and underscores', () => {
  for (const p of ['a/b.md', 'a_b.md', 'a_/__b/c_d.md']) assert.equal(unsafePath(safePath(p)), p);
});
test('invalidated in-flight load remains a shared store', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'A') });
  const gate = deferred(), started = deferred(), read = f.adapter.read;
  let first = true;
  f.adapter.read = async p => { if (first) { first = false; started.resolve(); await gate.promise; } return read(p); };
  const a = f.storage.loadDoc('a.md'); await started.promise;
  f.storage.invalidate(); const b = f.storage.loadDoc('a.md'); gate.resolve();
  const [x, y] = await Promise.all([a, b]); assert.equal(x, y);
  x.entries.push(note('B')); f.storage.saveStore(x); await f.storage.flushDoc('a.md');
  assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath('a.md')))), ['A', 'B']);
});
test('failed target read aborts migration and preserves both files', async () => {
  const a = raw('a.md', 'A'), b = raw('b.md', 'B');
  const f = fixture({ [jsonPath('a.md')]: a, [jsonPath('b.md')]: b });
  const read = f.adapter.read; f.adapter.read = async p => { if (p === jsonPath('b.md')) throw Error('I/O'); return read(p); };
  assert.equal(await f.storage.migrateDoc('a.md', 'b.md'), false);
  assert.equal(f.disk.get(jsonPath('a.md')), a); assert.equal(f.disk.get(jsonPath('b.md')), b);
});
test('old filename reuse and rename roundtrip keep distinct identities', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'A') });
  assert.equal(await f.storage.migrateDoc('a.md', 'b.md'), true);
  assert.deepEqual(ids(await f.storage.loadDoc('a.md')), []);
  assert.equal(await f.storage.migrateDoc('b.md', 'a.md'), true);
  assert.deepEqual(ids(await f.storage.loadDoc('a.md')), ['A']);
});
test('rapid a -> b -> c migrations serialize', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'A') });
  const gate = deferred(), started = deferred(), read = f.adapter.read;
  f.adapter.read = async p => { if (p === jsonPath('a.md')) { started.resolve(); await gate.promise; } return read(p); };
  const one = f.storage.migrateDoc('a.md', 'b.md'); await started.promise;
  const two = f.storage.migrateDoc('b.md', 'c.md'); const waiting = f.storage.loadDoc('c.md');
  gate.resolve(); assert.equal(await one, true); assert.equal(await two, true);
  assert.deepEqual(ids(await waiting), ['A']); assert.ok(!f.disk.has(jsonPath('b.md')));
});
test('late attachment saves through original store after rename', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'A') }); const held = await f.storage.loadDoc('a.md');
  await f.storage.migrateDoc('a.md', 'b.md');
  assert.equal(await f.storage.loadDoc('b.md'), held);
  held.entries[0].note.attachments.push({ id: 'voice' }); assert.equal(f.storage.saveStore(held), true);
  await f.storage.flushDoc('b.md');
  assert.equal(JSON.parse(f.disk.get(jsonPath('b.md'))).entries[0].note.attachments[0].id, 'voice');
});
test('deletion while destination write waits is not resurrected', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'A', 'delete-me') }); const held = await f.storage.loadDoc('a.md');
  const gate = deferred(), started = deferred(), write = f.adapter.write; let first = true;
  f.adapter.write = async (p, value) => { if (p === jsonPath('b.md') && first && JSON.parse(value).entries.length) { first = false; started.resolve(); await gate.promise; } return write(p, value); };
  const move = f.storage.migrateDoc('a.md', 'b.md'); await started.promise;
  assert.equal(await f.storage.removeEntry(held, 'delete-me'), 1);
  gate.resolve(); await move; await f.storage.flushDoc('b.md');
  assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath('b.md')))), ['A']);
});
test('source and destination annotation IDs merge without duplicates', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'A'), [jsonPath('b.md')]: raw('b.md', 'A', 'B') });
  assert.equal(await f.storage.migrateDoc('a.md', 'b.md'), true);
  assert.deepEqual(ids(await f.storage.loadDoc('b.md')), ['A', 'B']);
});
test('failed newer write retains dirty state despite earlier write success', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'A') }); const store = await f.storage.loadDoc('a.md');
  const gate = deferred(), started = deferred(), write = f.adapter.write; let count = 0;
  f.adapter.write = async (p, value) => { if (++count === 1) { started.resolve(); await gate.promise; return write(p, value); } throw Error('disk full'); };
  store.entries.push(note('V1')); f.storage.saveStore(store); const one = f.storage.flushDoc('a.md'); await started.promise;
  store.entries.push(note('V2')); f.storage.saveStore(store); const two = f.storage.flushDoc('a.md'); gate.resolve();
  await one; await assert.rejects(two); f.storage.invalidate('a.md');
  assert.equal(await f.storage.loadDoc('a.md'), store); assert.equal(f.storage.pendingSave('a.md'), true);
});
test('enumeration uses legacy declared path and includes unsaved new documents', async () => {
  const f = fixture({ '.gloss/annotations/d__a.md.json': raw('d/a.md', 'A') });
  await f.storage.addEntry('new.md', note('B'));
  const all = await f.storage.listAll(); assert.deepEqual(Array.from(all, x => x.path).sort(), ['d/a.md', 'new.md']);
  await f.storage.flushAll();
});
test('legacy note flags and attachments survive ordinary edits after feature removal', async () => {
  const old = JSON.parse(raw('legacy.md', 'A'));
  old.entries[0].note.flashcard = true;
  old.entries[0].note.attachments = [{ id: 'old-file', path: 'gloss-attachments/a/voice.webm', kind: 'audio' }];
  const f = fixture({ [jsonPath('legacy.md')]: JSON.stringify(old) });
  const store = await f.storage.loadDoc('legacy.md');
  store.entries[0].note.content = 'updated'; f.storage.saveStore(store); await f.storage.flushDoc('legacy.md');
  const saved = JSON.parse(f.disk.get(jsonPath('legacy.md')));
  assert.equal(saved.entries[0].note.content, 'updated');
  assert.deepEqual(saved.entries[0].note.attachments, old.entries[0].note.attachments);
});
test('image detection accepts missing MIME from a file picker', () => {
  const { kindOf } = load('card');
  assert.equal(kindOf('', 'photo.PNG'), 'image');
  assert.equal(kindOf('image/webp', 'photo'), 'image');
  assert.equal(kindOf('', 'document.pdf'), 'file');
});
test('legacy built-ins migrate to five requested types while custom types and old note IDs remain usable', async () => {
  const legacy = [
    { id: 'correction', name: '错误纠正', color: '#e5484d', builtin: true, order: 0 },
    { id: 'idea', name: '灵感记录', color: '#f5a524', builtin: true, order: 1 },
    { id: 'question', name: '疑问', color: '#abcdef', builtin: true, order: 2 },
    ...['key', 'review', 'reference'].map((id, i) => ({ id, name: id, color: "#8a8f98", builtin: true, order: i + 3 })),
    { id: 'custom', name: '我的类型', color: '#112233', order: 6 },
  ];
  const f = fixture({ '.gloss/types.json': JSON.stringify(legacy) });
  const types = await f.storage.loadTypes();
  assert.deepEqual(Array.from(types, t => t.name), ['错误纠正', '内容补充', '提问质疑', '灵感记录', '一般批注', '我的类型']);
  assert.equal(f.storage.typeOf('key').id, 'general');
  assert.equal(f.storage.typeOf('review').id, 'general');
  assert.equal(f.storage.typeOf('reference').id, 'supplement');
  assert.equal(f.storage.typeOf('question').color, '#abcdef');
  const { migrateBuiltinTypes } = load('types');
  assert.equal(migrateBuiltinTypes(types), types);
});
test('renaming an unannotated document writes no JSON files', async () => {
  const f = fixture();
  assert.equal(await f.storage.migrateDoc('empty.md', 'renamed.md'), true);
  assert.equal(f.disk.size, 0);
});
test('external hidden-file edits invalidate clean cached documents', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'old') });
  await f.storage.loadDoc('a.md');
  f.disk.set(jsonPath('a.md'), raw('a.md', 'remote'));
  assert.equal(await f.storage.checkExternalChanges(), true);
  assert.deepEqual(ids(await f.storage.loadDoc('a.md')), ['remote']);
});
test('external edits cannot be overwritten by a dirty local document; local copy survives in conflicts', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'old') });
  const store = await f.storage.loadDoc('a.md');
  store.entries.push(note('local')); f.storage.saveStore(store);
  const remote = raw('a.md', 'old', 'remote');
  f.disk.set(jsonPath('a.md'), remote);
  await assert.rejects(f.storage.flushDoc('a.md'), /External change conflict/);
  assert.equal(f.disk.get(jsonPath('a.md')), remote);
  const backup = [...f.disk].find(([p]) => p.startsWith('.gloss/conflicts/'));
  assert.ok(backup); assert.deepEqual(ids(JSON.parse(backup[1])), ['old', 'local']);
});
test('unload does not rewrite clean cached documents over an external change', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'old') });
  await f.storage.loadDoc('a.md');
  const remote = raw('a.md', 'remote'); f.disk.set(jsonPath('a.md'), remote);
  await f.storage.flushAll();
  assert.equal(f.disk.get(jsonPath('a.md')), remote);
});
test('empty types list remains valid, malicious color is not accepted or overwritten', async () => {
  const empty = fixture({ '.gloss/types.json': '[]' });
  assert.equal((await empty.storage.loadTypes()).length, 0);
  await empty.storage.flushAll(); assert.equal(empty.disk.get('.gloss/types.json'), '[]');
  const malicious = JSON.stringify([{ id: 'x', name: 'bad', color: '\"/><script>alert(1)</script>' }]);
  const bad = fixture({ '.gloss/types.json': malicious });
  await bad.storage.loadTypes(); await bad.storage.flushAll();
  assert.equal(bad.disk.get('.gloss/types.json'), malicious);
  assert.equal(bad.storage.types.some(t => t.id === 'x'), false);
});


test('corrupt type data disables editing and attempted saves preserve disk', async () => {
  const f = fixture({ '.gloss/types.json': '{broken' });
  await f.storage.loadTypes();
  assert.equal(f.storage.canEditTypes, false);
  f.storage.types[0].name = 'unsaved edit';
  f.storage.saveTypes();
  await f.storage.flushAll();
  assert.equal(f.disk.get('.gloss/types.json'), '{broken');
});
