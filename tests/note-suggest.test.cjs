const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

class Target {
  listeners = [];
  addEventListener(type, fn, options) { this.listeners.push({ type, fn, options }); }
  removeEventListener(type, fn, options) { this.listeners = this.listeners.filter(item => item.type !== type || item.fn !== fn || item.options !== options); }
  dispatchEvent(event) {
    event.target ??= this;
    for (const { type, fn } of [...this.listeners]) if (type === event.type) fn(event);
    this['on' + event.type]?.(event);
    return !event.defaultPrevented;
  }
}
class Element extends Target {
  constructor(doc, tag = 'div', options = {}) {
    super(); this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.children = [];
    this.attrs = {}; this.cls = options.cls || ''; this.textContent = options.text || ''; this.dataset = {};
    this.value = ''; this.selectionStart = this.selectionEnd = 0; this.hidden = false;
    this.disabled = false; this.readOnly = false; this.isConnected = true;
    this.style = { setProperty() {} };
    this.classList = { add: (...names) => { this.cls += ' ' + names.join(' '); }, remove: (...names) => { this.cls = this.cls.split(' ').filter(name => !names.includes(name)).join(' '); }, contains: name => this.cls.split(' ').includes(name), toggle() {} };
    for (const [key, value] of Object.entries(options.attr || {})) this.setAttribute(key, value);
  }
  createEl(tag, options) { const child = new Element(this.ownerDocument, tag, options); this.appendChild(child); return child; }
  createDiv(options) { return this.createEl('div', options); }
  createSpan(options) { return this.createEl('span', options); }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.empty(); this.append(...children); }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  empty() { for (const child of this.children) child.remove(); this.children = []; }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'id') this.id = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  setText(text) { this.textContent = text; }
  addClass(...names) { this.classList.add(...names); }
  removeClass(...names) { this.classList.remove(...names); }
  toggleClass(name, value) { this.classList.toggle(name, value); }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.setSelectionRange(start + text.length, start + text.length); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100 }; }
}
class File {
  constructor(filePath) { this.path = filePath; this.name = filePath.split('/').pop(); this.basename = this.name.replace(/\.[^.]+$/, ''); this.extension = this.name.split('.').pop(); this.stat = { mtime: 1 }; }
}
class Scope {
  constructor(parent) { this.parent = parent; this.bindings = []; }
  register(modifiers, key, func) { const binding = { modifiers, key, func }; this.bindings.push(binding); return binding; }
  unregister(binding) { this.bindings = this.bindings.filter(item => item !== binding); }
}
function key(key, overrides = {}) {
  return { type: 'keydown', key, code: key, isComposing: false, keyCode: 0,
    altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.immediateStopped = true; }, ...overrides };
}
function press(h, name, overrides = {}) { return h.controller.handleKeydown(key(name, { target: h.input, ...overrides })); }
function load(name, obsidian, cache = new Map()) {
  if (cache.has(name)) return cache.get(name);
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, setTimeout, clearTimeout, queueMicrotask,
    require: request => request === 'obsidian' ? obsidian : load(request.replace(/^\.\//, ''), obsidian, cache),
  });
  cache.set(name, module.exports); return module.exports;
}
function harness(paths = ['Alpha.md', 'Folder/Beta.md', 'Another/Beta.md']) {
  const files = paths.map(filePath => new File(filePath)), aliases = new Map();
  const pushed = [], popped = [], resolved = [], cacheReads = [];
  const app = {
    scope: new Scope(),
    vault: { getFiles: () => files, getMarkdownFiles: () => files.filter(file => file.extension.toLowerCase() === 'md'), getAbstractFileByPath: filePath => files.find(file => file.path === filePath) || null },
    metadataCache: {
      getFileCache(file) { cacheReads.push(file.path); return { frontmatter: { aliases: aliases.get(file.path) || [] } }; },
      fileToLinktext(file, sourcePath, omitMdExtension) { resolved.push({ file, sourcePath, omitMdExtension }); return omitMdExtension ? file.path.replace(/\.md$/i, '') : file.path; },
    },
    keymap: { pushScope(scope) { pushed.push(scope); }, popScope(scope) { popped.push(scope); } },
  };
  const doc = new Target();
  class OwnerEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }
  doc.defaultView = { Event: OwnerEvent, setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout };
  doc.createElement = tag => new Element(doc, tag); doc.body = new Element(doc, 'body');
  const host = doc.body.createDiv(), input = host.createEl('textarea'); input.focus();
  const obsidian = { TFile: File, Scope, parseFrontMatterAliases: frontmatter => frontmatter?.aliases || [] };
  const exports = load('note-suggest', obsidian);
  const controller = exports.attachNoteSuggest(app, input, host, 'Current/source.md', app.scope);
  function type(value, caret = value.length) {
    input.value = value; input.setSelectionRange(caret, caret); input.dispatchEvent(new OwnerEvent('input', { bubbles: true }));
  }
  function all(element) { return [element, ...element.children.flatMap(all)]; }
  const visible = element => !element.hidden && (!element.parentElement || visible(element.parentElement));
  const listbox = () => all(host).find(element => element.attrs.role === 'listbox' && visible(element));
  const options = () => all(host).filter(element => element.attrs.role === 'option');
  return { ...exports, controller, app, files, aliases, doc, input, host, type, options, listbox, pushed, popped, resolved, cacheReads, OwnerEvent };
}

test('note candidates match note names, paths, and aliases case-insensitively', () => {
  const h = harness(['Project/Alpha.md', 'Other/Beta.md', '研究笔记.md', 'picture.png']);
  h.aliases.set('Other/Beta.md', ['Alternative title', '别名']);
  const paths = query => Array.from(h.findNoteCandidates(h.app, query), file => file.path);
  assert.deepEqual(paths('ALPHA'), ['Project/Alpha.md']);
  assert.deepEqual(paths('project/'), ['Project/Alpha.md']);
  assert.deepEqual(paths('alternative'), ['Other/Beta.md']);
  assert.deepEqual(paths('别名'), ['Other/Beta.md']);
  assert.deepEqual(paths('研究'), ['研究笔记.md']);
  assert.deepEqual(paths('missing'), []);
  assert.ok(paths('').includes('picture.png'));
  h.controller.dispose();
});

test('candidate ordering is deterministic and the result cap is respected', () => {
  const h = harness(['Z/Note.md', 'A/Note.md', 'Note.md', 'Other.md']);
  const first = Array.from(h.findNoteCandidates(h.app, ''), file => file.path);
  h.files.reverse();
  assert.deepEqual(Array.from(h.findNoteCandidates(h.app, ''), file => file.path), first);
  assert.equal(h.findNoteCandidates(h.app, '', 2).length, 2);
  h.controller.dispose();
});

test('typing a wiki-link opens accessible candidates and selection keeps surrounding prose', () => {
  const h = harness(); let emitted;
  h.input.addEventListener('input', event => { emitted = event; });
  h.type('before [[Be]] after', 'before [[Be'.length);
  assert.ok(h.listbox()); assert.equal(h.options().length, 2);
  const event = key('Enter', { target: h.input });
  assert.equal(h.controller.handleKeydown(event), true);
  assert.match(h.input.value, /^before \[\[(?:Another|Folder)\/Beta\]\] after$/);
  assert.equal(h.resolved[0].sourcePath, 'Current/source.md');
  assert.ok(emitted instanceof h.OwnerEvent);
  assert.equal(h.input.selectionStart, h.input.value.indexOf(' after'));
  assert.equal(h.input.selectionEnd, h.input.selectionStart);
  assert.equal(h.listbox(), undefined);
  h.controller.dispose();
});

test('arrow navigation and Tab select the highlighted candidate', () => {
  const h = harness(); h.type('[[');
  const first = h.options()[0];
  assert.equal(press(h, 'ArrowDown'), true);
  assert.equal(press(h, 'ArrowUp'), true);
  assert.equal(press(h, 'Tab'), true);
  assert.equal(h.input.value, '[[Alpha]]');
  assert.ok(first); h.controller.dispose();
});

test('Escape dismisses candidates while retaining the draft and returns keyboard scope', () => {
  const h = harness(); h.type('draft [[');
  assert.equal(h.pushed.length, 1);
  assert.equal(press(h, 'Escape'), true);
  assert.equal(h.input.value, 'draft [['); assert.equal(h.listbox(), undefined);
  assert.equal(h.popped.length, 1); assert.equal(h.popped[0], h.pushed[0]);
  assert.equal(press(h, 'Escape'), false);
  h.controller.dispose();
});

test('modifier shortcuts and IME Enter never commit a suggestion', () => {
  const h = harness(); h.type('[[');
  for (const overrides of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.equal(press(h, 'Enter', overrides), false);
    assert.equal(h.input.value, '[[');
  }
  h.controller.dispose();
});

test('composition hides candidates until text composition finishes', () => {
  const h = harness(['研究笔记.md']); h.type('[[');
  h.input.dispatchEvent(new h.OwnerEvent('compositionstart'));
  assert.equal(h.listbox(), undefined);
  h.type('[[研究'); assert.equal(h.listbox(), undefined);
  h.input.dispatchEvent(new h.OwnerEvent('compositionend'));
  h.input.dispatchEvent(new h.OwnerEvent('input'));
  assert.ok(h.listbox());
  assert.equal(press(h, 'Enter'), true);
  assert.equal(h.input.value, '[[研究笔记]]'); h.controller.dispose();
});

test('blur and freeze dismiss suggestions without losing text', () => {
  const h = harness(); h.type('[[');
  h.input.dispatchEvent(new h.OwnerEvent('blur'));
  assert.equal(h.listbox(), undefined);
  h.input.focus(); h.type('[['); assert.ok(h.listbox());
  h.controller.freeze(true); assert.equal(h.listbox(), undefined);
  h.type('[[Al'); assert.equal(h.listbox(), undefined);
  h.controller.freeze(false); h.type('[[Al'); assert.ok(h.listbox());
  assert.equal(h.input.value, '[[Al'); h.controller.dispose();
});

test('a stale candidate cannot replace text that changed without an input event', () => {
  const h = harness(); h.type('[[Al');
  h.input.value = 'new draft'; h.input.setSelectionRange(9, 9);
  press(h, 'Enter');
  assert.equal(h.input.value, 'new draft'); h.controller.dispose();
});

test('a file removed while the menu is open cannot be inserted', () => {
  const h = harness(['Alpha.md']); h.type('[[Al'); h.files.splice(0);
  press(h, 'Enter');
  assert.equal(h.input.value, '[[Al'); assert.equal(h.resolved.length, 0); h.controller.dispose();
});

test('disposing removes listeners, listbox, and active scope once', () => {
  const h = harness(); h.type('[['); assert.ok(h.listbox());
  h.controller.dispose(); h.controller.dispose();
  assert.equal(h.listbox(), undefined); assert.equal(h.input.listeners.length, 0);
  assert.equal(h.popped.length, 1); assert.equal(h.popped[0], h.pushed[0]);
  h.type('[[Al'); assert.equal(h.listbox(), undefined);
  assert.equal(press(h, 'Enter'), false);
});

test('empty search favors recently modified notes and exact names precede prefix/alias matches', () => {
  const h = harness(['Aardvark.md', 'Alpha.md', 'Al.md', 'Other.md']);
  h.aliases.set('Other.md', ['Al']); h.files[3].stat.mtime = 99;
  assert.equal(h.findNoteCandidates(h.app, '')[0].path, 'Other.md');
  assert.deepEqual(Array.from(h.findNoteCandidates(h.app, 'Al'), file => file.path), ['Al.md', 'Alpha.md', 'Other.md']);
  h.controller.dispose();
});

test('the active Obsidian keyboard scope consumes completion and returns to its parent', () => {
  const h = harness(); h.type('[[Al');
  const scope = h.pushed[0]; assert.equal(scope.parent, h.app.scope);
  const event = key('Enter', { target: h.input });
  const binding = scope.bindings.find(item => item.key === 'Enter');
  assert.equal(binding.func(event), false);
  assert.equal(event.defaultPrevented, true); assert.equal(h.input.value, '[[Alpha]]');
  h.input.dispatchEvent(event); assert.equal(h.input.value, '[[Alpha]]');
  assert.equal(h.popped[0], scope); h.controller.dispose();
});

test('mouse selection displays both duplicate paths and inserts the clicked note', () => {
  const h = harness(); h.type('[[Be');
  const rows = h.options();
  assert.equal(rows.length, 2);
  const row = rows.find(element => element.children.some(child => child.textContent.includes('Folder/Beta.md')));
  assert.ok(row); assert.ok(row.children.some(child => child.textContent === 'Beta'));
  const down = key('mousedown', { type: 'mousedown' }); row.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  row.dispatchEvent(key('click', { type: 'click' }));
  assert.equal(h.input.value, '[[Folder/Beta]]');
  assert.equal(h.doc.activeElement, h.input); h.controller.dispose();
});

test('no-match menus allow normal Enter/Tab behavior and can be dismissed with Escape', () => {
  const h = harness(); h.type('[[No such note');
  assert.equal(h.input.getAttribute('aria-expanded'), 'true');
  assert.equal(press(h, 'Enter'), false); assert.equal(h.input.value, '[[No such note');
  h.type('[[No such note'); assert.equal(press(h, 'Tab'), false);
  h.type('[[No such note'); assert.equal(press(h, 'Escape'), true);
  assert.equal(h.input.getAttribute('aria-expanded'), 'false'); h.controller.dispose();
});

test('Escape dismissal survives keyup and moving the caret outside a link closes the menu', () => {
  const h = harness(); h.type('prefix [[Al'); press(h, 'Escape');
  h.input.dispatchEvent(key('Escape', { type: 'keyup' }));
  assert.equal(h.input.getAttribute('aria-expanded'), 'false');
  h.type('prefix [[Al'); h.input.setSelectionRange(3, 3);
  h.input.dispatchEvent(key('ArrowLeft', { type: 'keyup' }));
  assert.equal(h.input.getAttribute('aria-expanded'), 'false');
  assert.equal(h.input.value, 'prefix [[Al'); h.controller.dispose();
});

test('candidates include supported image, PDF, and video extensions with case-insensitive filtering', () => {
  const supported = ['md', 'avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp', 'pdf', 'mkv', 'mov', 'mp4', 'ogv', 'webm'];
  const paths = supported.map((extension, index) => `Assets/file-${index}.${index % 2 ? extension.toUpperCase() : extension}`);
  const excluded = ['data.json', 'archive.zip', 'audio.mp3', 'style.css', 'text.txt', 'README', 'fake.png.exe'];
  const h = harness([...paths, ...excluded]);
  h.aliases.set('Assets/file-1.AVIF', ['media alias must not match']);
  const candidates = Array.from(h.findNoteCandidates(h.app, '', 50), file => file.path);
  assert.deepEqual(candidates.sort(), paths.sort());
  assert.deepEqual(Array.from(h.findNoteCandidates(h.app, 'media alias')), []);
  assert.ok(h.cacheReads.length > 0);
  assert.ok(h.cacheReads.every(filePath => /\.md$/i.test(filePath)), 'only Markdown files should have frontmatter aliases read');
  h.controller.dispose();
});

test('extension searches prioritize exact filenames and support full paths', () => {
  const h = harness(['report.pdf-extra.md', 'Archive/Report.PDF', 'Other.md', 'Archive/Report.png']);
  h.aliases.set('Other.md', ['report.pdf']);
  const paths = query => Array.from(h.findNoteCandidates(h.app, query), file => file.path);
  assert.equal(paths('REPORT.PDF')[0], 'Archive/Report.PDF');
  assert.ok(paths('REPORT.PDF').includes('report.pdf-extra.md'));
  assert.deepEqual(paths('archive/report.p'), ['Archive/Report.PDF', 'Archive/Report.png']);
  assert.deepEqual(paths('.png'), ['Archive/Report.png']);
  h.controller.dispose();
});

test('same-basename notes and media show file type and select the exact clicked file', () => {
  const formats = [['md', '笔记'], ['png', '图片'], ['pdf', 'PDF'], ['mp4', '视频']];
  const paths = formats.map(([extension]) => `Attachments/asset.${extension}`);
  for (const [extension, type] of formats) {
    const h = harness(paths); h.type('[[asset');
    const expectedPath = `Attachments/asset.${extension}`;
    const row = h.options().find(element => element.children.some(child => child.textContent.includes(expectedPath)));
    assert.ok(row, `missing ${extension} candidate`);
    assert.ok(row.children.some(child => child.textContent === (extension === 'md' ? 'asset' : `asset.${extension}`)));
    assert.ok(row.children.some(child => child.textContent.includes(type) && child.textContent.includes(expectedPath)));
    row.dispatchEvent(key('click', { type: 'click' }));
    assert.equal(h.input.value, `[[Attachments/asset${extension === 'md' ? '' : '.' + extension}]]`);
    assert.equal(h.resolved[0].file.path, expectedPath);
    assert.equal(h.resolved[0].sourcePath, 'Current/source.md');
    assert.equal(h.resolved[0].omitMdExtension, true);
    h.controller.dispose();
  }
});

test('media completion preserves embed prefixes, image widths, PDF pages, and surrounding prose', () => {
  const cases = [['png', '|320'], ['pdf', '#page=3'], ['mp4', '']];
  for (const [extension, suffix] of cases) {
    const h = harness([`Attachments/asset.${extension}`]);
    const prefix = 'before ![[asset';
    h.type(`${prefix}${suffix}]] after`, prefix.length);
    assert.equal(press(h, 'Tab'), true);
    assert.equal(h.input.value, `before ![[Attachments/asset.${extension}${suffix}]] after`);
    assert.equal(h.input.selectionStart, h.input.value.indexOf(' after'));
    assert.equal(h.input.selectionEnd, h.input.selectionStart);
    h.controller.dispose();
  }
});

test('media deleted after candidates appear cannot be inserted', () => {
  const h = harness(['Attachments/asset.mp4']); h.type('![[asset');
  assert.equal(h.options().length, 1);
  h.files.splice(0);
  press(h, 'Enter');
  assert.equal(h.input.value, '![[asset');
  assert.equal(h.resolved.length, 0);
  assert.equal(h.listbox(), undefined);
  h.controller.dispose();
});
