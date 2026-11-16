'use strict';
const { inspectSource } = require('../public/xml-source');

const references = new Set('topicref topichead topicgroup chapter appendix notices preface part frontmatter backmatter booklists'.split(' '));
const elements = node => node.children.filter(child => child.kind === 'element');
const endOf = node => node.close?.end ?? node.end;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Structural edits move original source slices. Unaffected tags, entities,
// comments, CDATA, PIs and line endings never pass through a serializer.
async function editMap(source, request, resolveTopicHref) {
  const root = inspectSource(source);
  if (!['map', 'bookmap'].includes(root.name)) fail('Not a DITA map');
  const locations = new Map();
  function index(node, path = '', parent = null) {
    locations.set(path, { node, parent });
    elements(node).forEach((child, i) => index(child, path ? path + '.' + i : String(i), node));
  }
  index(root);
  const location = locations.get(String(request.sourcePath ?? ''));
  if (!location) fail('Selected map node was not found', 404);
  const { node, parent } = location;
  if (node !== root && !references.has(node.name)) fail('Selected node is not a Map reference');
  const operation = String(request.operation || '');
  const raw = item => source.slice(item.start, endOf(item));
  const leading = item => /(?:\r\n|\r|\n)[\t ]*$/.exec(source.slice(0, item.start))?.[0] || '';
  const eol = source.includes('\r\n') ? '\r\n' : source.includes('\n') ? '\n' : source.includes('\r') ? '\r' : '';
  const patches = [];
  function guard(container) {
    if (container?.children.some(child => child.kind === 'pi' && /^<\?oxy_/.test(source.slice(child.start, child.end)))) {
      fail('目录包含 Oxygen 修订或批注边界，请先审核或在源码模式调整结构');
    }
  }
  function remove(item) {
    patches.push({ start: item.start - leading(item).length, end: endOf(item), text: '' });
  }
  function after(item, text) {
    const prefix = leading(item);
    patches.push({ start: endOf(item), end: endOf(item), text: prefix + text, selected: prefix.length });
  }
  function append(container, text) {
    guard(container);
    const last = container.children.at(-1);
    const trailing = last?.kind === 'text' && !source.slice(last.start, last.end).trim() ? last : null;
    const example = elements(container).find(child => leading(child));
    const indent = leading(container).replace(/[\r\n]/g, '');
    const prefix = example ? leading(example) : eol ? eol + indent + '  ' : '';
    if (container.close) {
      const at = trailing?.start ?? container.close.start;
      patches.push({ start: at, end: at, text: prefix + text, selected: prefix.length });
    } else {
      const suffix = eol ? eol + indent : '';
      patches.push({ start: container.end - 2, end: container.end,
        text: '>' + prefix + text + suffix + '</' + container.name + '>', selected: 1 + prefix.length });
    }
  }

  if (operation === 'addTopicref' || operation === 'addTopichead') {
    let text;
    if (operation === 'addTopicref') {
      text = '<topicref href="' + escape(await resolveTopicHref(request.href)) + '"/>';
    } else {
      const title = String(request.title || '').trim();
      if (!title) fail('Topic heading title is required');
      text = '<topichead><title>' + escape(title) + '</title></topichead>';
    }
    const container = node === root || !node.attrs.href ? node : parent;
    guard(container);
    if (container === parent) after(node, text); else append(container, text);
  } else if (operation === 'moveUp' || operation === 'moveDown') {
    if (!parent) fail('Cannot move the map root');
    guard(parent);
    const siblings = elements(parent).filter(item => references.has(item.name));
    const sibling = siblings[siblings.indexOf(node) + (operation === 'moveUp' ? -1 : 1)];
    if (!sibling) fail(operation === 'moveUp' ? 'Node is already first' : 'Node is already last', 409);
    // Swap only the two element ranges; their surrounding trivia stays put.
    patches.push({ start: node.start, end: endOf(node), text: raw(sibling) });
    patches.push({ start: sibling.start, end: endOf(sibling), text: raw(node), selected: 0 });
  } else if (operation === 'promote') {
    if (!parent || parent === root) fail('Node cannot be promoted further', 409);
    const grandparent = [...locations.values()].find(item => item.node === parent).parent;
    guard(parent); guard(grandparent);
    remove(node); after(parent, raw(node));
  } else if (operation === 'demote') {
    if (!parent) fail('Cannot demote the map root');
    guard(parent);
    const siblings = elements(parent).filter(item => references.has(item.name));
    const sibling = siblings[siblings.indexOf(node) - 1];
    if (!sibling) fail('No previous sibling can contain this node', 409);
    remove(node); append(sibling, raw(node));
  } else if (operation === 'remove') {
    if (!parent) fail('Cannot remove the map root');
    guard(parent); remove(node);
  } else fail('Unsupported map operation');

  let content = '', cursor = 0, selectedAt = -1;
  for (const patch of patches.sort((a, b) => a.start - b.start)) {
    if (patch.start < cursor) fail('Map source edits overlap');
    content += source.slice(cursor, patch.start);
    if (patch.selected !== undefined) selectedAt = content.length + patch.selected;
    content += patch.text; cursor = patch.end;
  }
  content += source.slice(cursor);
  const updated = inspectSource(content);
  function selection(item, path = '') {
    if (item.start === selectedAt) return path;
    for (const [i, child] of elements(item).entries()) {
      const found = selection(child, path ? path + '.' + i : String(i));
      if (found !== undefined) return found;
    }
  }
  const selectedSourcePath = operation === 'remove' ? '' : selection(updated);
  if (selectedSourcePath === undefined) fail('Cannot locate the edited Map reference');
  return { content, selectedSourcePath };
}

module.exports = { editMap };
