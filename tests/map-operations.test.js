'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { editMap } = require('../lib/map-operations');
const { parseXml } = require('../lib/xml-tree');
const { createMapReader, resolveMapHref } = require('../lib/map-reader');

const prefix = "\uFEFF<?xml version='1.0' encoding='GBK'?>\r\n<!DOCTYPE map PUBLIC '-//OASIS//DTD DITA Map//EN' 'map.dtd'>\r\n<!--outside--><?setup keep?>\r\n";
const a = "<topicref href = 'a.dita' navtitle='A &#x26; B'><topicmeta><!--inside--><navtitle><![CDATA[A & B]]></navtitle><?oxy_comment keep?></topicmeta></topicref>";
const b = '<topicref href="b.dita" />';
const tail = '\r\n</map>\r\n<?tail keep?>';
const source = prefix + "<map id = 'manual'>\r\n  <title>A &#x26; B</title>\r\n  " + a + '\r\n  <!--between--><?keep value?>\r\n  ' + b + tail;

test('Map reordering swaps only element source slices and its inverse restores every character', async () => {
  const result = await editMap(source, { operation: 'moveDown', sourcePath: '1' });
  const expected = prefix + "<map id = 'manual'>\r\n  <title>A &#x26; B</title>\r\n  " + b + '\r\n  <!--between--><?keep value?>\r\n  ' + a + tail;
  assert.equal(result.content, expected);
  assert.equal(result.selectedSourcePath, '2');
  const restored = await editMap(result.content, { operation: 'moveUp', sourcePath: result.selectedSourcePath });
  assert.equal(restored.content, source);
  assert.equal(restored.selectedSourcePath, '1');
});

test('adding and removing Map entries leave existing XML untouched and select the exact new entry', async () => {
  const result = await editMap(source, { operation: 'addTopicref', sourcePath: '1', href: 'new.dita' }, async href => href + '?a=1&b=2');
  assert.equal(result.content, source.replace(a, a + '\r\n  <topicref href="new.dita?a=1&amp;b=2"/>'));
  assert.equal(result.selectedSourcePath, '2');
  const removed = await editMap(result.content, { operation: 'remove', sourcePath: result.selectedSourcePath });
  assert.equal(removed.content, source);
  assert.equal(removed.selectedSourcePath, '');
  const heading = await editMap(source, { operation: 'addTopichead', title: 'More < & >' });
  assert.equal(heading.content, source.replace(tail, '\r\n  <topichead><title>More &lt; &amp; &gt;</title></topichead>' + tail));
  assert.equal(heading.selectedSourcePath, '3');
});

test('promotion and demotion preserve the entire moved subtree and unrelated siblings', async () => {
  const group = "<topichead navtitle = 'Group'>\r\n    <topicref href='first.dita'/>\r\n    " + a + '\r\n  </topichead>';
  const original = prefix + '<map>\r\n  ' + group + '\r\n  ' + b + tail;
  const promoted = await editMap(original, { operation: 'promote', sourcePath: '0.1' });
  assert.equal(promoted.content, original.replace('\r\n    ' + a, '').replace('</topichead>', '</topichead>\r\n  ' + a));
  assert.equal(promoted.selectedSourcePath, '1');
  const restored = await editMap(promoted.content, { operation: 'demote', sourcePath: '1' });
  assert.equal(restored.content, original);
  assert.equal(restored.selectedSourcePath, '0.1');
});

test('self-closing containers expand locally without normalizing their attributes or adjacent source', async () => {
  const original = "<map id = 'm'><topicref href = 'parent.dita' /><topicref href='child.dita'/></map>";
  const nested = await editMap(original, { operation: 'demote', sourcePath: '1' });
  assert.equal(nested.content, "<map id = 'm'><topicref href = 'parent.dita' ><topicref href='child.dita'/></topicref></map>");
  assert.equal(nested.selectedSourcePath, '0.0');
  const empty = await editMap("<?xml version='1.0'?><map id = 'm' />", { operation: 'addTopichead', title: 'Heading' });
  assert.equal(empty.content, "<?xml version='1.0'?><map id = 'm' ><topichead><title>Heading</title></topichead></map>");
  assert.equal(empty.selectedSourcePath, '0');
});

test('Bookmap source paths include metadata elements and still locate the moved chapter', async () => {
  const original = "<bookmap><booktitle><mainbooktitle>A &#38; B</mainbooktitle></booktitle><chapter href='a.dita'/><chapter href='b.dita'/></bookmap>";
  const result = await editMap(original, { operation: 'moveDown', sourcePath: '1' });
  assert.equal(result.content, original.replace("<chapter href='a.dita'/><chapter href='b.dita'/>", "<chapter href='b.dita'/><chapter href='a.dita'/>"));
  assert.equal(result.selectedSourcePath, '2');
});

test('structure edits cannot detach references from surrounding Oxygen annotation boundaries', async () => {
  const original = '<map><?oxy_comment_start author="QA"?><topicref href="a.dita"/><?oxy_comment_end?><topicref href="b.dita"/></map>';
  for (const operation of ['moveDown', 'remove', 'addTopichead']) {
    await assert.rejects(editMap(original, { operation, sourcePath: '0', title: 'New' }), /Oxygen/);
  }
  await assert.rejects(editMap('<map><topicref href="a.dita"/></map>', { operation: 'moveUp', sourcePath: '0' }), error => error.status === 409);
  await assert.rejects(editMap('<map><title>Title</title></map>', { operation: 'remove', sourcePath: '0' }), /not a Map reference/);
  await assert.rejects(editMap('<topic/>', { operation: 'remove' }), /Not a DITA map/);
});

test('Map readers use exact relative paths and reject unsupported or escaping references', () => {
  assert.equal(resolveMapHref('books/main.ditamap', '../topics/a%20b.dita#t'), 'topics/a b.dita');
  const map = createMapReader().describe(parseXml('<map><topicref href="topics/missing.dita"/></map>').root, 'main.ditamap');
  assert.equal(map.children[0].path, 'topics/missing.dita');
  for (const href of ['../private.dita', 'https://example.invalid/a.dita', '/absolute.dita', '%invalid.dita']) {
    assert.throws(() => resolveMapHref('main.ditamap', href));
  }
});

test('external scope is inherited without resolving links, while explicit local descendants retain source paths', () => {
  const calls = [], reader = createMapReader((from, href) => { calls.push(href); return resolveMapHref(from, href); });
  const xml = '<map><topicref scope="external" href="https://example.invalid/remote.ditamap#part">' +
    '<topicref href="relative-external.dita"/><topicref scope="local" href="topics/local.dita"/>' +
    '</topicref><topicref href="topics/next.dita"/></map>';
  const map = reader.describe(parseXml(xml).root, 'main.ditamap');
  assert.deepEqual(calls, ['topics/local.dita', 'topics/next.dita']);
  assert.deepEqual(map.children.map(node => [node.path, node.sourcePath]), [['topics/local.dita', '0.1'], ['topics/next.dita', '1']]);
  assert.deepEqual(reader.describe(parseXml('<map scope="external"><topicref href="/remote.dita"/></map>').root, 'main.ditamap').children, []);
  assert.throws(() => reader.describe(parseXml('<map scope="external"><topicref scope="local" href="/bad.dita"/></map>').root, 'main.ditamap'), /相对路径/);
});
