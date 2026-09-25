const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
let selection = null;
function load(name) {
  const module = { exports: {} };
  const src = fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8');
  const code = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Node: { ELEMENT_NODE: 1 }, window: { getSelection: () => selection }, NodeFilter: { SHOW_TEXT: 4 },
    document: { createTreeWalker(el) { let i = 0; return { nextNode: () => i++ === 0 ? { nodeValue: el.text, parentElement: el } : null }; } },
    require: p => p.startsWith('@codemirror/') ? require(p) : p === './anchor-context' ? load('anchor-context') : {} });
  return module.exports;
}
const { textMatches, locateAnchor } = load('anchor');
const { sourceRange } = load('editor');
const anchor = text => ({ kind: 'md', blockId: '', start: 0, end: text.length, text });
const block = text => ({ text, closest: () => null, contains: () => false, getAttribute: () => null });
const host = (...blocks) => ({ querySelectorAll: () => blocks });
test('same phrase in two paragraphs selects the original block, not the shortest block', () => {
  const first = block('重点'), second = block('这里的重点才是选中的原文');
  const a = { ...anchor('重点'), start: 3, end: 5, blockText: second.text, prefix: '这里的', suffix: '才是选中的原文' };
  const hit = locateAnchor(host(first, second), a, 'p');
  assert.equal(hit.block, second); assert.equal(hit.start, 3); assert.equal(hit.end, 5);
});
test('second occurrence within a paragraph keeps the actual selected range', () => {
  const text = '重点，其他内容，重点';
  const a = { ...anchor('重点'), start: 8, end: 10, blockText: text, prefix: '重点，其他内容，' };
  const matches = textMatches(text, a).sort((a, b) => b.score - a.score);
  assert.equal(matches[0].start, 8);
});
test('ambiguous legacy anchors do not silently highlight a different paragraph', () => {
  assert.equal(locateAnchor(host(block('相同原文'), block('相同原文')), anchor('原文'), 'p'), null);
});
test('exact match wins over punctuation-stripped guessing in another paragraph', () => {
  const correct = block('我选择 a-b-c-d');
  assert.equal(locateAnchor(host(block('abcd'), correct), anchor('a-b-c-d'), 'p').block, correct);
});
test('source anchors disambiguate repeated phrases after text is inserted before them', () => {
  const old = '第一段重点。\n\n第二段重点。';
  const from = old.lastIndexOf('重点');
  const a = { ...anchor('重点'), source: { from, to: from + 2, text: '重点', prefix: old.slice(0, from), suffix: '。' } };
  const current = '新增内容\n' + old;
  assert.equal(sourceRange(current, a).from, current.lastIndexOf('重点'));
});
test('editor range uses source characters across Markdown and newlines', () => {
  const text = '**加粗**\n下一行';
  const a = { ...anchor('加粗\n下一行'), source: { from: 0, to: text.length, text } };
  assert.equal(sourceRange(text, a).to, text.length);
});
test('removed text has no highlight', () => {
  assert.equal(sourceRange('正文已被删除', anchor('原来的正文')), null);
});

test('reading-view quote across bold text maps back to source offsets', () => {
  const text = '前文：这是**重点**内容。';
  const range = sourceRange(text, anchor('这是重点内容'));
  assert.equal(text.slice(range.from, range.to), '这是**重点**内容');
});
test('deleted contextual source does not jump to an unrelated occurrence', () => {
  const a = { ...anchor('重点'), source: { from: 100, to: 102, text: '重点', prefix: '原来的段落', suffix: '原来的结尾' } };
  assert.equal(sourceRange('另一处重点仍然存在', a), null);
});

test('reading selections spanning two paragraphs are rejected before storing the sizer text', () => {
  const paragraph = () => ({ nodeType: 1, closest: () => null, hasAttribute: () => false, matches: () => true });
  const range = { startContainer: { nodeType: 3, parentElement: paragraph() }, endContainer: { nodeType: 3, parentElement: paragraph() }, getBoundingClientRect: () => ({ width: 100, height: 40 }) };
  selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
  assert.equal(load('anchor').selectionToMdAnchor('p'), null);
  selection = null;
});

test('small edits on both sides of an unchanged quote retain its contextual anchor', () => {
  const old = '这是一段足够长的原始前文重点以及这是一段足够长的原始后文';
  const from = old.indexOf('重点');
  const a = { ...anchor('重点'), blockText: old, prefix: old.slice(0, from), suffix: old.slice(from + 2), source: { from, to: from + 2, text: '重点', prefix: old.slice(0, from), suffix: old.slice(from + 2) } };
  const changed = old.replace('原始前文', '原来前文').replace('原始后文', '原来后文');
  assert.equal(textMatches(changed, a)[0].start, from);
  assert.equal(sourceRange(changed, a).from, from);
});
