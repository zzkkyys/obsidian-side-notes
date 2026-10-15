const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const notices = [];
class MockTFile { constructor(path) { this.path = path; } }
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Blob, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require: p => p === 'obsidian' ? { Notice: class { constructor(message) { notices.push(message); } }, ItemView: class {}, Component: class {}, TFile: MockTFile } : load(p.slice(2)) });
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
  const parent = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  const adapter = {
    exists: async p => disk.has(p) || dirs.has(p),
    read: async p => { if (!disk.has(p)) throw Error('ENOENT'); return disk.get(p); },
    mkdir: async p => { if (!dirs.has(parent(p))) throw Error('parent missing: ' + p); dirs.add(p); },
    write: async (p, value) => { if (!dirs.has(parent(p))) throw Error('parent missing: ' + p); disk.set(p, value); },
    remove: async p => disk.delete(p),
    list: async p => ({ files: [...disk.keys()].filter(k => parent(k) === p), folders: [...dirs].filter(k => k && parent(k) === p) }),
  };
  const vault = { adapter, getMarkdownFiles: () => [], getAbstractFileByPath: p => disk.has(p) ? new MockTFile(p) : null, trash: async file => { disk.set(".trash/" + file.path.split("/").pop(), disk.get(file.path)); disk.delete(file.path); }, createBinary: async (p, bytes) => { if (disk.has(p)) throw Error('exists'); await adapter.write(p, bytes); } };
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


test('conflict freezes further writes, keeps one backup and can explicitly reload remote', async () => {
  const p = 'conflict.md', f = fixture({ [jsonPath(p)]: raw(p, 'A') });
  const store = await f.storage.loadDoc(p);
  f.disk.set(jsonPath(p), raw(p, 'A', 'remote'));
  store.entries.push(note('local')); f.storage.saveStore(store);
  await assert.rejects(f.storage.flushDoc(p));
  assert.equal(f.storage.saveStore(store), false);
  await f.storage.flushAll(); await f.storage.checkExternalChanges();
  assert.equal([...f.disk.keys()].filter(p => p.startsWith('.gloss/conflicts/')).length, 1);
  await f.storage.recoverDisk(jsonPath(p));
  assert.deepEqual(ids(await f.storage.loadDoc(p)), ['A', 'remote']);
  assert.equal(f.storage.hasProblems, false);
});

test('temporary absence preserves cached annotations and types and never initializes over them', async () => {
  const p = 'missing.md';
  const types = JSON.stringify([{ id: 'custom', name: 'Custom', color: '#123456', order: 0 }]);
  const f = fixture({ [jsonPath(p)]: raw(p, 'A', 'B'), '.gloss/types.json': types });
  const store = await f.storage.loadDoc(p); await f.storage.loadTypes();
  f.disk.delete(jsonPath(p)); f.disk.delete('.gloss/types.json');
  await f.storage.checkExternalChanges();
  assert.equal(await f.storage.loadDoc(p), store);
  assert.deepEqual(ids(store), ['A', 'B']);
  assert.equal(f.storage.types[0].id, 'custom');
  assert.equal(f.disk.has('.gloss/types.json'), false);
  const restarted = fixture({ [jsonPath(p)]: raw(p, 'A') });
  await restarted.storage.loadTypes();
  assert.equal(restarted.storage.canEditTypes, false);
  assert.equal(restarted.disk.has('.gloss/types.json'), false);
});

test('failed creation never becomes visible or gets saved by a later unrelated edit', async () => {
  const p = 'create.md', f = fixture({ [jsonPath(p)]: raw(p, 'A') });
  const store = await f.storage.loadDoc(p), write = f.adapter.write;
  f.adapter.write = async () => { throw Error('EACCES'); };
  await assert.rejects(f.storage.createEntry(p, note('cancelled')));
  assert.deepEqual(ids(store), ['A']);
  assert.equal(f.storage.hasProblems, true);
  f.adapter.write = write;
  const old = store.entries[0], next = note('A'); next.note.content = 'edited';
  await f.storage.commitEntry(store, 'A', next, JSON.stringify(old.note));
  assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath(p)))), ['A']);
});

test('stale store and concurrent editor snapshots cannot overwrite a newer annotation', async () => {
  const p = 'edit.md', f = fixture({ [jsonPath(p)]: raw(p, 'A') });
  const store = await f.storage.loadDoc(p), expected = JSON.stringify(store.entries[0].note);
  const next = note('A'); next.note.content = 'first editor';
  await f.storage.commitEntry(store, 'A', next, expected);
  await assert.rejects(f.storage.commitEntry(store, 'A', note('A'), expected));
  f.disk.set(jsonPath(p), raw(p, 'remote')); await f.storage.checkExternalChanges();
  await assert.rejects(f.storage.commitEntry(store, 'A', next, JSON.stringify(next.note)));
  assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath(p)))), ['remote']);
});

test('a failing poll does not block another document from observing its remote update', async () => {
  const f = fixture({ [jsonPath('a.md')]: raw('a.md', 'A'), [jsonPath('b.md')]: raw('b.md', 'B') });
  await f.storage.loadDoc('a.md'); await f.storage.loadDoc('b.md');
  const read = f.adapter.read;
  f.adapter.read = p => p === jsonPath('a.md') ? Promise.reject(Error('offline')) : read(p);
  f.disk.set(jsonPath('b.md'), raw('b.md', 'new'));
  await f.storage.checkExternalChanges();
  assert.deepEqual(ids(await f.storage.loadDoc('b.md')), ['new']);
});

test('types editor snapshot rejects replacement of an externally refreshed array', async () => {
  const f = fixture({ '.gloss/types.json': '[]' }); await f.storage.loadTypes();
  const expected = JSON.stringify(f.storage.types);
  f.disk.set('.gloss/types.json', JSON.stringify([{ id: 'r', name: 'remote', color: '#123456' }]));
  await f.storage.checkExternalChanges();
  await assert.rejects(f.storage.saveTypesSnapshot([], expected));
  assert.equal(JSON.parse(f.disk.get('.gloss/types.json'))[0].id, 'r');
});

test('case-only rename on insensitive storage preserves the single physical file', async () => {
  const f = fixture({ [jsonPath('Note.md')]: raw('Note.md', 'A') });
  const resolve = p => [...f.disk.keys()].find(k => k.toLowerCase() === p.toLowerCase()) || p;
  const exists = f.adapter.exists, read = f.adapter.read, write = f.adapter.write, remove = f.adapter.remove;
  f.adapter.exists = p => exists(resolve(p)); f.adapter.read = p => read(resolve(p));
  f.adapter.write = (p, value) => write(resolve(p), value); f.adapter.remove = p => remove(resolve(p));
  await f.storage.loadDoc('Note.md');
  assert.equal(await f.storage.migrateDoc('Note.md', 'note.md'), true);
  assert.deepEqual(ids(await f.storage.loadDoc('note.md')), ['A']);
  assert.equal(JSON.parse(f.disk.get(jsonPath('Note.md'))).docPath, 'note.md');
});

test('case-distinct files on sensitive storage are merged rather than treated as one file', async () => {
  const f = fixture({ [jsonPath('Note.md')]: raw('Note.md', 'A'), [jsonPath('note.md')]: raw('note.md', 'B') });
  assert.equal(await f.storage.migrateDoc('Note.md', 'note.md'), true);
  assert.deepEqual(ids(await f.storage.loadDoc('note.md')), ['A', 'B']);
});

test('deleted document archive isolates a new file with the same path', async () => {
  const p = 'deleted.md', f = fixture({ [jsonPath(p)]: raw(p, 'OLD') });
  const old = await f.storage.loadDoc(p);
  await f.storage.archiveDeleted(p);
  assert.equal(f.disk.has(jsonPath(p)), false);
  assert.equal([...f.disk.keys()].filter(p => p.startsWith('.gloss/trash/')).length, 1);
  assert.equal(f.storage.saveStore(old), false);
  const fresh = await f.storage.loadDoc(p); assert.deepEqual(ids(fresh), []);
  await f.storage.createEntry(p, note('NEW'));
  assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath(p)))), ['NEW']);
});
test('archive failure retains source JSON and cached identity', async () => {
  const p = 'deleted.md', f = fixture({ [jsonPath(p)]: raw(p, 'OLD') });
  const old = await f.storage.loadDoc(p), write = f.adapter.write;
  f.adapter.write = async (p, raw) => { if (p.startsWith('.gloss/trash/')) throw Error('full'); return write(p, raw); };
  await assert.rejects(f.storage.archiveDeleted(p));
  assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath(p)))), ['OLD']);
  assert.equal(await f.storage.loadDoc(p), old);
});
test('an iCloud placeholder is not treated as an unannotated new document', async () => {
  const p = 'cloud.md', json = jsonPath(p), slash = json.lastIndexOf('/');
  const f = fixture({ [json.slice(0, slash + 1) + '.' + json.slice(slash + 1) + '.icloud']: 'placeholder' });
  const store = await f.storage.loadDoc(p);
  assert.equal(f.storage.saveStore(store), false);
  await assert.rejects(f.storage.createEntry(p, note('NEW')));
  assert.equal(f.disk.has(json), false);
});
test('attachment rename updates both metadata and encoded inline references', async () => {
  const p = 'pic.md', entry = note('A');
  entry.note.attachments = [{ id: 'pic', kind: 'image', path: 'old/a.png', name: 'a.png' }];
  entry.note.content = '![[old/a.png]]';
  const f = fixture({ [jsonPath(p)]: JSON.stringify({ version: 1, docPath: p, kind: 'md', entries: [entry] }) });
  await f.storage.moveAttachments('old', 'new', true);
  const saved = JSON.parse(f.disk.get(jsonPath(p))).entries[0].note;
  assert.equal(saved.attachments[0].path, 'new/a.png');
  assert.ok(saved.content.includes('new/a.png'));
});


test('background write errors show a user notice and preserve dirty data for retry', async () => {
  const p = 'denied.md', f = fixture({ [jsonPath(p)]: raw(p, 'A') });
  const store = await f.storage.loadDoc(p), write = f.adapter.write;
  store.entries.push(note('local')); f.adapter.write = async () => { throw Error('EACCES'); };
  const before = notices.length; f.storage.saveStore(store);
  await new Promise(resolve => setTimeout(resolve, 340));
  assert.ok(notices.length > before);
  assert.ok(f.storage.pendingSave(p));
  f.adapter.write = write; await f.storage.retrySave(jsonPath(p));
  assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath(p)))), ['A', 'local']);
});
test('draft cleanup protects backup references and only trashes this session unreferenced uploads', async () => {
  const f = fixture({
    'gloss-attachments/n/keep.png': 'image', 'gloss-attachments/n/cancel.png': 'image',
    'gloss-attachments/older/other.png': 'image',
    '.gloss/conflicts/backup.json': JSON.stringify({ path: 'gloss-attachments/n/keep.png' }),
  });
  await f.storage.cleanupDraftUploads(['gloss-attachments/n/keep.png', 'gloss-attachments/n/cancel.png']);
  assert.ok(f.disk.has('gloss-attachments/n/keep.png'));
  assert.ok(f.disk.has('gloss-attachments/older/other.png'));
  assert.equal(f.disk.has('gloss-attachments/n/cancel.png'), false);
  assert.ok(f.disk.has('.trash/cancel.png'));
});
test('draft cleanup keeps all uploads if even one reference file cannot be read', async () => {
  const f = fixture({ 'gloss-attachments/n/new.png': 'image', '.gloss/conflicts/backup.json': '{}' });
  f.adapter.read = async () => { throw Error('offline'); };
  await f.storage.cleanupDraftUploads(['gloss-attachments/n/new.png']);
  assert.ok(f.disk.has('gloss-attachments/n/new.png'));
});


test('legacy read, probe and format failures stay read-only until the original data is readable', async t => {
  for (const failure of ['read', 'exists', 'json', 'shape']) await t.test(failure, async () => {
    const p = 'folder/a.md', legacy = '.gloss/annotations/folder__a.md.json', original = raw(p, 'OLD');
    const f = fixture({ [legacy]: original });
    const read = f.adapter.read, exists = f.adapter.exists;
    if (failure === 'read') f.adapter.read = path => path === legacy ? Promise.reject(Error('offline')) : read(path);
    if (failure === 'exists') f.adapter.exists = path => path === legacy ? Promise.reject(Error('offline')) : exists(path);
    if (failure === 'json') f.disk.set(legacy, '{incomplete');
    if (failure === 'shape') f.disk.set(legacy, JSON.stringify({ docPath: p, entries: null }));
    const before = f.disk.get(legacy), store = await f.storage.loadDoc(p);
    assert.equal(f.storage.saveStore(store), false);
    await assert.rejects(f.storage.createEntry(p, note('NEW')));
    await f.storage.flushAll();
    assert.equal(f.disk.get(legacy), before);
    assert.equal(f.disk.has(jsonPath(p)), false);
    f.adapter.read = read; f.adapter.exists = exists; f.disk.set(legacy, original);
    f.storage.invalidate(p);
    assert.deepEqual(ids(await f.storage.loadDoc(p)), ['OLD']);
    await f.storage.createEntry(p, note('NEW'));
    assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath(p)))), ['OLD', 'NEW']);
  });
});

test('a valid legacy collision remains owned by its declared document', async () => {
  const legacy = '.gloss/annotations/folder__a.md.json', original = raw('folder__a.md', 'FOREIGN');
  const f = fixture({ [legacy]: original });
  await f.storage.createEntry('folder/a.md', note('NEW'));
  assert.equal(f.disk.get(legacy), original);
  assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath('folder/a.md')))), ['NEW']);
});

test('type cloud placeholders block saves and downloaded types become editable after polling', async t => {
  for (const placeholder of ['.gloss/.types.json.icloud', '.gloss/types.json.icloud']) await t.test(placeholder, async () => {
    const f = fixture({ [placeholder]: 'placeholder' });
    await f.storage.loadTypes();
    assert.equal(f.storage.canEditTypes, false);
    await assert.rejects(f.storage.saveTypesSnapshot([], JSON.stringify(f.storage.types)));
    f.storage.saveTypes(); await f.storage.flushAll();
    assert.equal(f.disk.has('.gloss/types.json'), false);
    const remote = [{ id: 'remote', name: 'Remote', color: '#123456', order: 0 }];
    f.disk.set('.gloss/types.json', JSON.stringify(remote)); f.disk.delete(placeholder);
    assert.equal(await f.storage.checkExternalChanges(), true);
    assert.equal(f.storage.canEditTypes, true);
    assert.equal(f.storage.types[0].id, 'remote');
    await f.storage.saveTypesSnapshot([], JSON.stringify(f.storage.types));
    assert.equal(f.disk.get('.gloss/types.json'), '[]');
  });
});

function attachmentDoc(p, id) {
  const entry = note(id);
  entry.note.attachments = [{ id: 'pic', kind: 'image', path: 'old/a.png', name: 'a.png' }];
  entry.note.content = '![[old/a.png]]';
  return JSON.stringify({ version: 1, docPath: p, kind: 'md', entries: [entry] });
}

test('polling does not evict closed documents held by a batch attachment rename', async () => {
  const f = fixture({ [jsonPath('a.md')]: attachmentDoc('a.md', 'A'), [jsonPath('b.md')]: attachmentDoc('b.md', 'B') });
  f.storage.setActivePaths([]);
  const gate = deferred(), started = deferred(), write = f.adapter.write;
  f.adapter.write = async (p, value) => { if (p === jsonPath('a.md')) { started.resolve(); await gate.promise; } return write(p, value); };
  const move = f.storage.moveAttachments('old/a.png', 'new/a.png');
  await started.promise; await f.storage.checkExternalChanges(); gate.resolve(); await move;
  for (const p of ['a.md', 'b.md']) {
    const saved = JSON.parse(f.disk.get(jsonPath(p))).entries[0].note;
    assert.equal(saved.attachments[0].path, 'new/a.png');
    assert.ok(saved.content.includes('new/a.png'));
  }
  await f.storage.checkExternalChanges();
  assert.equal(f.storage.docCacheFor('a.md'), undefined);
  assert.equal(f.storage.docCacheFor('b.md'), undefined);
});

test('consecutive attachment renames serialize and survive polling between writes', async () => {
  const f = fixture({ [jsonPath('a.md')]: attachmentDoc('a.md', 'A'), [jsonPath('b.md')]: attachmentDoc('b.md', 'B') });
  f.storage.setActivePaths([]);
  const gate = deferred(), started = deferred(), write = f.adapter.write; let first = true;
  f.adapter.write = async (p, value) => {
    if (p === jsonPath('a.md') && first) { first = false; started.resolve(); await gate.promise; }
    return write(p, value);
  };
  const one = f.storage.moveAttachments('old/a.png', 'new/a.png'); await started.promise;
  const two = f.storage.moveAttachments('new/a.png', 'final/a.png');
  await f.storage.checkExternalChanges(); gate.resolve(); await Promise.all([one, two]);
  for (const p of ['a.md', 'b.md']) assert.equal(JSON.parse(f.disk.get(jsonPath(p))).entries[0].note.attachments[0].path, 'final/a.png');
});

test('a failed batch attachment rename releases retained stores and does not block the next rename', async () => {
  const f = fixture({ [jsonPath('a.md')]: attachmentDoc('a.md', 'A') });
  f.storage.setActivePaths([]);
  const write = f.adapter.write;
  f.adapter.write = async () => { throw Error('disk full'); };
  await assert.rejects(f.storage.moveAttachments('old/a.png', 'new/a.png'));
  f.adapter.write = write;
  await f.storage.moveAttachments('old/a.png', 'final/a.png');
  assert.equal(JSON.parse(f.disk.get(jsonPath('a.md'))).entries[0].note.attachments[0].path, 'final/a.png');
  await f.storage.checkExternalChanges();
  assert.equal(f.storage.docCacheFor('a.md'), undefined);
});


test('batch attachment updates preserve an external edit made before its document is committed', async () => {
  const f = fixture({ [jsonPath('a.md')]: attachmentDoc('a.md', 'A'), [jsonPath('b.md')]: attachmentDoc('b.md', 'B') });
  f.storage.setActivePaths([]);
  const gate = deferred(), started = deferred(), write = f.adapter.write;
  f.adapter.write = async (p, value) => { if (p === jsonPath('a.md')) { started.resolve(); await gate.promise; } return write(p, value); };
  const move = f.storage.moveAttachments('old/a.png', 'new/a.png');
  await started.promise;
  const remote = raw('b.md', 'REMOTE'); f.disk.set(jsonPath('b.md'), remote);
  await f.storage.checkExternalChanges(); gate.resolve();
  await assert.rejects(move);
  assert.equal(f.disk.get(jsonPath('b.md')), remote);
});

test('flushAll waits for an attachment batch that has not finished enumerating documents', async () => {
  const f = fixture({ [jsonPath('a.md')]: attachmentDoc('a.md', 'A'), [jsonPath('b.md')]: attachmentDoc('b.md', 'B') });
  const gate = deferred(), started = deferred(), list = f.adapter.list;
  f.adapter.list = async p => { if (p === '.gloss/annotations') { started.resolve(); await gate.promise; } return list(p); };
  const move = f.storage.moveAttachments('old/a.png', 'new/a.png'); await started.promise;
  let flushed = false;
  const flushing = f.storage.flushAll().then(() => { flushed = true; });
  await new Promise(setImmediate);
  assert.equal(flushed, false);
  gate.resolve(); await Promise.all([move, flushing]);
  for (const p of ['a.md', 'b.md']) assert.equal(JSON.parse(f.disk.get(jsonPath(p))).entries[0].note.attachments[0].path, 'new/a.png');
});


test('attachment batches re-enumerate documents migrated while their paths are being collected', { timeout: 2000 }, async () => {
  const oldPath = 'old/n.md', newPath = 'new/n.md';
  const f = fixture({ [jsonPath(oldPath)]: attachmentDoc(oldPath, 'A') });
  await f.storage.loadDoc(oldPath);
  const gate = deferred(), started = deferred(), read = f.adapter.read;
  let first = true;
  f.adapter.read = async p => {
    const value = await read(p);
    if (p === jsonPath(oldPath) && first) { first = false; started.resolve(); await gate.promise; }
    return value;
  };
  const move = f.storage.moveAttachments('old', 'new', true);
  await started.promise;
  gate.resolve();
  const migration = f.storage.migrateDoc(oldPath, newPath);
  const flushing = f.storage.flushAll();
  const [, migrated] = await Promise.all([move, migration, flushing]);
  assert.equal(migrated, true);
  const saved = JSON.parse(f.disk.get(jsonPath(newPath))).entries[0].note;
  assert.equal(saved.attachments[0].path, 'new/a.png');
  assert.ok(saved.content.includes('new/a.png'));
  assert.equal(f.disk.has(jsonPath(oldPath)), false);
});


test('legacy cloud placeholders prevent a new annotation file from shadowing undownloaded data', async t => {
  const p = 'folder/a.md', legacy = '.gloss/annotations/folder__a.md.json';
  for (const placeholder of ['.gloss/annotations/.folder__a.md.json.icloud', legacy + '.icloud']) await t.test(placeholder, async () => {
    const f = fixture({ [placeholder]: 'placeholder' });
    const store = await f.storage.loadDoc(p);
    assert.equal(f.storage.saveStore(store), false);
    await assert.rejects(f.storage.createEntry(p, note('NEW')));
    await f.storage.flushAll();
    assert.equal(f.disk.has(jsonPath(p)), false);
    assert.equal(f.disk.get(placeholder), 'placeholder');
    f.disk.set(legacy, raw(p, 'OLD')); f.disk.delete(placeholder);
    f.storage.invalidate(p);
    assert.deepEqual(ids(await f.storage.loadDoc(p)), ['OLD']);
    await f.storage.createEntry(p, note('NEW'));
    assert.deepEqual(ids(JSON.parse(f.disk.get(jsonPath(p)))), ['OLD', 'NEW']);
  });
});
