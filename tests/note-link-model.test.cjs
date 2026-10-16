const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const m = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/note-link-model.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText, { module: m, exports: m.exports });
const { findWikiLinkContext, completeWikiLink } = m.exports;
function at(text, target = '资料/新笔记') {
  const caret = text.indexOf('¦');
  assert.notEqual(caret, -1);
  const value = text.replace('¦', '');
  const context = findWikiLinkContext(value, caret, caret);
  return { context, result: context ? completeWikiLink(value, context, target) : null };
}
function expectCompletion(before, after, query, suffix = '') {
  const { context, result } = at(before);
  assert.ok(context, before);
  assert.equal(context.query, query);
  assert.equal(context.suffix, suffix);
  assert.equal(result.value, after.replace('¦', ''));
  assert.equal(result.caret, after.indexOf('¦'));
}
test('empty opening and Chinese filename prefixes trigger completion', () => {
  expectCompletion('说明 [[¦', '说明 [[资料/新笔记]]¦', '');
  expectCompletion('[[研究¦', '[[资料/新笔记]]¦', '研究');
});
test('a complete token is replaced when editing its middle without duplicating brackets', () => {
  expectCompletion('前 [[old¦name]] 后', '前 [[资料/新笔记]]¦ 后', 'old');
  expectCompletion('[[oldname¦]]', '[[资料/新笔记]]¦', 'oldname');
});
test('existing headings, block references and aliases survive note selection', () => {
  expectCompletion('[[old¦name#Heading with spaces|别名]] tail', '[[资料/新笔记#Heading with spaces|别名]]¦ tail', 'old', '#Heading with spaces|别名');
  expectCompletion('[[old¦#^block]]', '[[资料/新笔记#^block]]¦', 'old', '#^block');
  expectCompletion('[[old¦|label]]', '[[资料/新笔记|label]]¦', 'old', '|label');
});
test('filename whitespace already typed belongs to the query', () => {
  expectCompletion('[[My Note¦', '[[资料/新笔记]]¦', 'My Note');
  expectCompletion('[[My¦ Note]]', '[[资料/新笔记]]¦', 'My');
});
test('incomplete tokens preserve prose and line breaks after the caret', () => {
  expectCompletion('[[old¦name remaining text', '[[资料/新笔记]]¦ remaining text', 'old');
  expectCompletion('[[¦ 后面的正文', '[[资料/新笔记]]¦ 后面的正文', '');
  expectCompletion('[[old¦\nnext line', '[[资料/新笔记]]¦\nnext line', 'old');
});
test('incomplete suffixes and a single closing bracket are retained or completed', () => {
  expectCompletion('[[old¦#Heading|Alias', '[[资料/新笔记#Heading|Alias]]¦', 'old', '#Heading|Alias');
  expectCompletion('[[old¦]', '[[资料/新笔记]]¦', 'old');
});
test('embed markers and surrounding Unicode text remain untouched', () => {
  expectCompletion('图 ![[old¦]] 完', '图 ![[资料/新笔记]]¦ 完', 'old');
});
test('a later wiki link cannot donate its closing delimiter to an incomplete token', () => {
  expectCompletion('[[old¦ prose [[other]]', '[[资料/新笔记]]¦ prose [[other]]', 'old');
});
test('caret outside a token, in a suffix, or after its closing delimiter is inactive', () => {
  for (const text of ['plain¦', '[¦[', '[[old]]¦', '[[old]¦]', '[[old#head¦]]', '[[old|alias¦]]', '[[old^block¦]]', '[[old\ntext¦']) {
    assert.equal(at(text).context, null, text);
  }
  assert.equal(findWikiLinkContext('[[old]]', 2, 4), null);
  assert.equal(findWikiLinkContext('[[old]]', -1, -1), null);
  assert.equal(findWikiLinkContext('[[old]]', 20, 20), null);
});
test('escaped openings are inactive and an even escape count leaves a real token', () => {
  assert.equal(at('\\[[old¦').context, null);
  expectCompletion('\\\\[[old¦', '\\\\[[资料/新笔记]]¦', 'old');
});
test('inline code suppresses completion with matching backtick run lengths', () => {
  for (const text of ['`[[old¦]]`', '``a ` [[old¦]]``', '`one\n[[old¦]]`']) assert.equal(at(text).context, null, text);
  expectCompletion('`code` [[old¦]]', '`code` [[资料/新笔记]]¦', 'old');
  expectCompletion('\\` [[old¦]]', '\\` [[资料/新笔记]]¦', 'old');
  expectCompletion('`unclosed\n\n[[old¦', '`unclosed\n\n[[资料/新笔记]]¦', 'old');
});
test('backtick and tilde fences suppress completion until a matching closing fence', () => {
  for (const text of ['```md\n[[old¦]]\n```', '~~~\n[[old¦\n~~~', '````\n```\n[[old¦\n````', '   ```\n[[old¦']) assert.equal(at(text).context, null, text);
  expectCompletion('```md\nexample\n```\n[[old¦', '```md\nexample\n```\n[[资料/新笔记]]¦', 'old');
  expectCompletion('~~~\nexample\n~~~~\n[[old¦', '~~~\nexample\n~~~~\n[[资料/新笔记]]¦', 'old');
});
