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
  vm.runInNewContext(code, { module, exports: module.exports, Uint8Array, console, require: p => load(p.slice(2)) });
  modules.set(name, module.exports);
  return module.exports;
}
const { migrateLegacyAttachments } = load('attachment-migration');
const OLD = 'gloss-attachments/note/photo 1.png';
const NEW = '.gloss/attachments/note/photo 1.png';
const JSON_PATH = '.gloss/annotations/a.md.json';
const binary = Buffer.from([0, 1, 2, 255, 128]);
function raw(doc = 'a.md', p = OLD) {
  return JSON.stringify({ version: 1, docPath: doc, kind: 'md', entries: [{ anchor: { kind: 'md', text: 'original text' }, note: {
    id: 'note', content: `![edited label](<${encodeURI(p)}>)\n[file](<${encodeURI(p)}>)`,
    replies: [{ id: 'reply', content: `![[${p}]] and [[${p}|download]]` }],
    attachments: [{ id: 'image', path: p, kind: 'image', name: 'photo 1.png' }],
  } }] });
}
function fixture(initial = {}) {
  const disk = new Map(Object.entries(initial)), dirs = new Set(['']), trash = new Map();
  const parent = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  for (const file of disk.keys()) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const adapter = {
    exists: async p => disk.has(p) || dirs.has(p),
    read: async p => { if (!disk.has(p)) throw Error('ENOENT ' + p); return String(disk.get(p)); },
    readBinary: async p => {
      if (!disk.has(p)) throw Error('ENOENT ' + p);
      const b = Buffer.from(disk.get(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    write: async (p, value) => { if (!dirs.has(parent(p))) throw Error('parent missing ' + p); disk.set(p, value); },
    writeBinary: async (p, bytes) => { if (!dirs.has(parent(p))) throw Error('parent missing ' + p); disk.set(p, Buffer.from(bytes)); },
    mkdir: async p => { if (!dirs.has(parent(p))) throw Error('parent missing ' + p); dirs.add(p); },
    list: async p => {
      if (!dirs.has(p)) throw Error('ENOENT ' + p);
      return { files: [...disk.keys()].filter(k => parent(k) === p), folders: [...dirs].filter(k => k && parent(k) === p) };
    },
    trashLocal: async p => {
      if (disk.has(p)) { trash.set(p, disk.get(p)); disk.delete(p); return; }
      if (!dirs.has(p)) throw Error('ENOENT ' + p);
      if ([...disk.keys(), ...dirs].some(k => k !== p && k.startsWith(p + '/'))) throw Error('directory not empty');
      trash.set(p, { directory: true }); dirs.delete(p);
    },
    rmdir: async p => {
      if ([...disk.keys(), ...dirs].some(k => k !== p && k.startsWith(p + '/'))) throw Error('not empty');
      dirs.delete(p);
    },
  };
  return { disk, dirs, trash, adapter, app: { vault: { adapter, getMarkdownFiles: () => [] } } };
}
const saved = f => JSON.parse(f.disk.get(JSON_PATH)).entries[0].note;

test('migration copies nested binaries and orphans, rewrites note/reply links, and removes only verified originals', async () => {
  const f = fixture({ [OLD]: binary, 'gloss-attachments/old/unregistered.png': Buffer.from('orphan'), [JSON_PATH]: raw(), 'a.md': 'original text' });
  const result = await migrateLegacyAttachments(f.app);
  assert.equal(result.moved, 2); assert.equal(result.retained, 0);
  assert.deepEqual(f.disk.get(NEW), binary);
  assert.equal(String(f.disk.get('.gloss/attachments/old/unregistered.png')), 'orphan');
  assert.equal(saved(f).attachments[0].path, NEW);
  assert.ok(!saved(f).content.includes('gloss-attachments'));
  assert.ok(!saved(f).replies[0].content.includes('gloss-attachments'));
  assert.match(saved(f).content, /\.gloss\/attachments/);
  assert.equal(f.disk.get('a.md'), 'original text');
  assert.deepEqual(f.trash.get(OLD), binary);
  assert.equal(f.dirs.has('gloss-attachments'), false);
  const second = await migrateLegacyAttachments(f.app);
  assert.equal(second.moved, 0); assert.equal(second.retained, 0);
});

test('a differing destination is never overwritten; deterministic numbered targets are reused on restart', async () => {
  const clash = Buffer.from('other bytes');
  const numbered = '.gloss/attachments/note/photo 1 (1).png';
  const f = fixture({ [OLD]: binary, [NEW]: clash, [JSON_PATH]: raw(), 'outside.md': '![[photo 1.png]]' });
  const first = await migrateLegacyAttachments(f.app);
  assert.equal(first.moved, 0); assert.equal(first.retained, 1);
  assert.deepEqual(f.disk.get(NEW), clash); assert.deepEqual(f.disk.get(numbered), binary);
  assert.equal(saved(f).attachments[0].path, numbered);
  const second = await migrateLegacyAttachments(f.app);
  assert.equal(second.retained, 1);
  assert.equal(f.disk.has('.gloss/attachments/note/photo 1 (2).png'), false);
  f.disk.delete('outside.md');
  assert.equal((await migrateLegacyAttachments(f.app)).moved, 1);
});

test('partial metadata write failure retains every original and resumes without duplicate copies', async () => {
  const b = '.gloss/annotations/b.md.json';
  const f = fixture({ [OLD]: binary, [JSON_PATH]: raw(), [b]: raw('b.md') });
  const write = f.adapter.write;
  f.adapter.write = async (p, value) => { if (p === b) throw Error('disk full'); await write(p, value); };
  await assert.rejects(migrateLegacyAttachments(f.app), /disk full/);
  assert.ok(f.disk.has(OLD)); assert.deepEqual(f.disk.get(NEW), binary); assert.equal(f.trash.size, 0);
  assert.equal(saved(f).attachments[0].path, NEW);
  assert.equal(JSON.parse(f.disk.get(b)).entries[0].note.attachments[0].path, OLD);
  f.adapter.write = write;
  assert.equal((await migrateLegacyAttachments(f.app)).moved, 1);
  assert.equal(JSON.parse(f.disk.get(b)).entries[0].note.attachments[0].path, NEW);
});

test('external notes, canvas documents, archived annotations and conflict snapshots are left untouched', async t => {
  for (const [p, content] of [
    ['folder/external.md', `![image](<${encodeURI(OLD)}>)`],
    ['board.canvas', JSON.stringify({ nodes: [{ file: OLD }] })],
    ['.gloss/trash/snapshot.json', raw('removed.md')],
    ['.gloss/conflicts/snapshot.json', JSON.stringify({ original: raw() })],
  ]) await t.test(p, async () => {
    const f = fixture({ [OLD]: binary, [JSON_PATH]: raw(), [p]: content });
    const result = await migrateLegacyAttachments(f.app);
    assert.equal(result.moved, 0); assert.equal(result.retained, 1);
    assert.equal(f.disk.get(p), content); assert.ok(f.disk.has(OLD));
    assert.equal(saved(f).attachments[0].path, NEW);
  });
});

test('unreadable or malformed metadata aborts before copying or deleting attachments', async t => {
  for (const bad of ['{broken', JSON.stringify({ version: 1, docPath: 'a.md', entries: [{ note: null }] })]) await t.test(bad, async () => {
    const f = fixture({ [OLD]: binary, [JSON_PATH]: bad });
    await assert.rejects(migrateLegacyAttachments(f.app));
    assert.ok(f.disk.has(OLD)); assert.equal(f.disk.has(NEW), false); assert.equal(f.trash.size, 0);
  });
  const f = fixture({ [OLD]: binary, [JSON_PATH]: raw(), 'unreadable.md': 'note' });
  const read = f.adapter.read;
  f.adapter.read = async p => { if (p === 'unreadable.md') throw Error('cannot read'); return read(p); };
  await assert.rejects(migrateLegacyAttachments(f.app), /cannot read/);
  assert.ok(f.disk.has(OLD)); assert.equal(f.trash.size, 0);
});

test('cloud placeholders never authorize overwrites or source removal', async t => {
  for (const p of [
    'gloss-attachments/note/.photo 1.png.icloud',
    '.gloss/attachments/note/.photo 1.png.icloud',
    '.gloss/attachments/.note.icloud',
    '.gloss/annotations/.missing.md.json.icloud',
    '.missing.md.icloud',
  ]) await t.test(p, async () => {
    const f = fixture({ [OLD]: binary, [JSON_PATH]: raw(), [p]: 'placeholder' });
    await assert.rejects(migrateLegacyAttachments(f.app), /同步/);
    assert.ok(f.disk.has(OLD)); assert.equal(f.trash.size, 0); assert.equal(f.disk.get(p), 'placeholder');
  });
});

test('failed binary verification leaves metadata and original untouched', async () => {
  const original = raw(), f = fixture({ [OLD]: binary, [JSON_PATH]: original });
  const write = f.adapter.writeBinary;
  f.adapter.writeBinary = async (p, bytes) => write(p, Buffer.from('truncated'));
  await assert.rejects(migrateLegacyAttachments(f.app), /校验失败/);
  assert.equal(f.disk.get(JSON_PATH), original); assert.deepEqual(f.disk.get(OLD), binary); assert.equal(f.trash.size, 0);
});

test('a concurrent metadata change is not overwritten and keeps all originals', async () => {
  const f = fixture({ [OLD]: binary, [JSON_PATH]: raw() });
  const write = f.adapter.writeBinary;
  f.adapter.writeBinary = async (p, bytes) => { await write(p, bytes); f.disk.set(JSON_PATH, raw('changed.md')); };
  await assert.rejects(migrateLegacyAttachments(f.app), /批注已变更/);
  assert.equal(JSON.parse(f.disk.get(JSON_PATH)).docPath, 'changed.md');
  assert.ok(f.disk.has(OLD)); assert.equal(f.trash.size, 0);
});

test('source Markdown documents in the legacy directory are preserved as ordinary notes', async () => {
  const p = 'gloss-attachments/manual.md', f = fixture({ [p]: 'do not rewrite this note' });
  const result = await migrateLegacyAttachments(f.app);
  assert.equal(result.retained, 1); assert.equal(result.moved, 0);
  assert.equal(f.disk.get(p), 'do not rewrite this note');
  assert.equal(String(f.disk.get('.gloss/attachments/manual.md')), 'do not rewrite this note');
});


test('unsupported HTML syntax with fully encoded destinations retains its source', async () => {
  const source = 'gloss-attachments/n/photo (1).png';
  const doc = JSON.parse(raw('a.md', source));
  doc.entries[0].note.content = '<img src="gloss-attachments/n/photo%20%281%29.png">';
  const f = fixture({ [source]: binary, [JSON_PATH]: JSON.stringify(doc) });
  const result = await migrateLegacyAttachments(f.app);
  assert.equal(result.retained, 1); assert.equal(result.moved, 0);
  assert.ok(f.disk.has(source));
});


test('truncating metadata writes keep a verified full recovery copy and every source attachment', async () => {
  const original = raw(), f = fixture({ [OLD]: binary, [JSON_PATH]: original });
  const write = f.adapter.write;
  f.adapter.write = async (p, value) => {
    if (p === JSON_PATH) { f.disk.set(p, '{truncated'); throw Error('disk failure'); }
    return write(p, value);
  };
  await assert.rejects(migrateLegacyAttachments(f.app), /原始批注备份/);
  assert.equal(f.disk.get('.trash/gloss-attachment-migration/' + JSON_PATH), original);
  assert.deepEqual(f.disk.get(OLD), binary); assert.equal(f.trash.size, 0);
});

test('metadata recovery copies never overwrite an older different snapshot', async () => {
  const recovery = '.trash/gloss-attachment-migration/' + JSON_PATH;
  const original = raw(), f = fixture({ [OLD]: binary, [JSON_PATH]: original, [recovery]: 'older backup' });
  await migrateLegacyAttachments(f.app);
  assert.equal(f.disk.get(recovery), 'older backup');
  assert.equal(f.disk.get(recovery + '.1'), original);
});


test('migration uses recoverable directory trash when nonrecursive rmdir is unsupported', async () => {
  const f = fixture({ [OLD]: binary, [JSON_PATH]: raw() });
  f.adapter.rmdir = async () => { throw Object.assign(Error('Path is a directory'), { code: 'ERR_FS_EISDIR' }); };
  const result = await migrateLegacyAttachments(f.app);
  assert.equal(result.moved, 1); assert.equal(result.retained, 0);
  assert.equal(f.dirs.has('gloss-attachments/note'), false);
  assert.equal(f.dirs.has('gloss-attachments'), false);
  assert.deepEqual(f.disk.get(NEW), binary);
  assert.deepEqual(f.trash.get('gloss-attachments'), { directory: true });
});

test('retry removes an empty legacy directory tree left after all files were moved', async () => {
  const f = fixture({ [NEW]: binary, [JSON_PATH]: raw('a.md', NEW) });
  f.dirs.add('gloss-attachments');
  f.dirs.add('gloss-attachments/note');
  f.dirs.add('gloss-attachments/note/empty');
  f.adapter.rmdir = async () => { throw Object.assign(Error('Path is a directory'), { code: 'ERR_FS_EISDIR' }); };
  const result = await migrateLegacyAttachments(f.app);
  assert.equal(result.moved, 0); assert.equal(result.retained, 0);
  assert.equal(f.dirs.has('gloss-attachments'), false);
  assert.equal(f.dirs.has('gloss-attachments/note/empty'), false);
  assert.deepEqual(f.disk.get(NEW), binary);
  assert.equal(saved(f).attachments[0].path, NEW);
});
