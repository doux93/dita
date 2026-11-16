'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs/promises'), os = require('node:os');
const { Worker } = require('node:worker_threads');
const { preparePackage } = require('../public/knowledge-package');
const { createPublisher } = require('../public/knowledge-publisher');
const { createZip, measureFiles, textBytes } = require('../public/knowledge-zip');
const data = require('../public/knowledge-semantic');
const { createVectorCache } = require('../lib/knowledge-vector-cache'), { createIndexBuilder } = require('../lib/knowledge-index');
const { unzipSync, strFromU8 } = require('fflate');
function request(text = 'HTTP 超时参数。', id = 'm-0123456789abcdef') {
  return { title: '发布验收', model: 'ML307G', sdkVersion: 'v1', generatedAt: '2026-11-16T00:00:00Z', manuals: [{
    id, model: 'ML307G', title: 'HTTP手册', version: 'v1', capturedAt: '2026-11-16T00:00:00Z',
    html: '<html><body><p>' + text + '</p></body></html>', body: '<h2 id="a">HTTP</h2><p>' + text + '</p>',
    toc: [{ anchor: 'a', title: 'HTTP' }], entries: [{ anchor: 'a', title: 'HTTP', text }],
    source: { repository: 'http', commit: 'a'.repeat(40), dirty: false, documents: [] }, report: { included: 0 }
  }] };
}
const vector = () => { const values = Array(512).fill(0); values[0] = 1; return values; };
function publisher(t, workerData) {
  const workers = [], requests = [], value = createPublisher({ createWorker() {
    const thread = new Worker(path.join(__dirname, 'helpers/knowledge-worker-thread.js'), { workerData });
    const handle = { postMessage: message => thread.postMessage(message), terminate: () => thread.terminate() };
    thread.on('message', data => { if (data.type === 'test-request') requests.push(data.url); else handle.onmessage?.({ data }); });
    thread.on('error', error => handle.onerror?.({ message: error.message }));
    workers.push(thread); return handle;
  } });
  t.after(async () => { value.dispose(); await Promise.all(workers.map(worker => worker.terminate())); });
  return { value, requests, workers };
}

test('ZIP measurement matches bytes including Chinese, surrogate replacements and headers', () => {
  const texts = ['中文😀', '\ud800', '\udfff', 'a\ud800b\udc00', 'quotes"\\\n'];
  for (const text of texts) assert.equal(textBytes(text), Buffer.byteLength(text));
  const files = texts.map((content, i) => ({ name: 'docs/' + i + '.txt', content }));
  assert.equal(measureFiles(files), createZip(files).size);
});

test('preflight rebases chunk positions and predicts the exact semantic ZIP without inference', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dita-estimate-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = request('带有中文与emoji😀的 HTTP 参数'), second = request('HTTP response 200', 'm-fedcba9876543210').manuals[0];
  input.manuals[0].entries = Array.from({ length: 12 }, (_, i) => ({ anchor: 'a' + i, title: 'HTTP ' + i, text: 'HTTP 参数😀' + i }));
  input.manuals.push(second);
  let tokenizations = 0;
  const chunksFor = async records => { tokenizations++; return data.chunksFor(records, text => text.length + 2); };
  const cache = createVectorCache({ directory }), builder = createIndexBuilder({ cache, chunksFor, generate: () => assert.fail('preflight must not infer') });
  const estimate = await builder.estimate(input), groups = input.manuals.map(builder.recordsFor), indices = [];
  for (const records of groups) { const chunks = await chunksFor(records); indices.push(data.createIndex(chunks, chunks.map(vector))); }
  const combined = data.combineIndexes(groups, indices);
  assert.equal(estimate.bytes, Buffer.byteLength(JSON.stringify(combined))); assert.equal(estimate.chunks, 13);
  const prepared = preparePackage(input), measured = prepared.measure(estimate), output = prepared.build(combined);
  assert.equal(measured.bytes, output.zip.size);
  for (const [i, records] of groups.entries()) await cache.put(records, input.model, data.PROFILE, indices[i]);
  tokenizations = 0;
  assert.deepEqual(await builder.estimate(input), estimate); assert.equal(tokenizations, 0, 'warm preflight must work without model assets');
  await builder.estimate(input, { force: true }); assert.equal(tokenizations, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(builder.estimate(input, { signal: controller.signal }), { name: 'AbortError' });
});

test('production Worker reuses its sealed preview and produces a readable identical archive', async t => {
  const { value, workers } = publisher(t), input = request();
  const phases = [], summary = await value.prepare(input, { onProgress: progress => phases.push(progress.stage) });
  input.manuals[0].entries[0].text = 'later edit';
  const preview = await value.preview(), output = await value.download({ semantic: false });
  assert.equal(workers.length, 1); assert.equal(output.zip.size, summary.bytes);
  const archive = unzipSync(new Uint8Array(await output.zip.arrayBuffer()));
  assert.equal(strFromU8(archive['docs/index.html']), preview.html);
  assert.equal(JSON.parse(strFromU8(archive['docs/knowledge.json'])).manuals[0].entries[0].text, 'HTTP 超时参数。');
  assert.ok(phases.includes('index') && phases.includes('render'));
  assert.ok(output.metrics.some(phase => phase.stage === 'archive'));
  assert.ok(!output.metrics.some(phase => phase.stage === 'index' || phase.stage === 'render'));
});

test('Worker preflight rejects oversized delivery before requesting any vector generation', async t => {
  const { value, requests } = publisher(t, { oversize: true });
  await value.prepare(request());
  await assert.rejects(value.download({ semantic: true, token: 'test-token' }), /64 MiB/);
  assert.deepEqual(requests, ['/api/knowledge/estimate']);
  const plain = await value.download({ semantic: false }); assert.ok(plain.zip.size > 0);
});

test('production Worker streams semantic results over HTTP with the pinned workspace token', async t => {
  const input = request(), records = input.manuals[0].entries.map(entry => ({ ...entry, manualId: input.manuals[0].id, manualTitle: input.manuals[0].title }));
  const chunks = await data.chunksFor(records, text => text.length + 2), index = data.createIndex(chunks, chunks.map(vector)), received = [];
  const server = require('node:http').createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ path: req.url, token: req.headers['x-workspace-token'], body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'progress', manual: 'HTTP手册', position: 1, totalManuals: 1, done: 1, total: 1 }) + '\n');
    const result = req.url.endsWith('/estimate') ? { profile: data.PROFILE, chunks: chunks.length, bytes: Buffer.byteLength(JSON.stringify(index)) } : { index, source: 'cache', warnings: [] };
    setImmediate(() => res.end(JSON.stringify({ type: 'result', ...result }) + '\n'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { value } = publisher(t, { origin: 'http://127.0.0.1:' + server.address().port });
  await value.prepare(input); const phases = [];
  const result = await value.download({ semantic: true, token: 'workspace-version-123' }, { onProgress: info => phases.push(info) });
  const book = JSON.parse(strFromU8(unzipSync(new Uint8Array(await result.zip.arrayBuffer()))['docs/knowledge.json']));
  assert.deepEqual(book.semantic, index); assert.equal(data.validate(records, book.semantic).length, chunks.length * 512);
  assert.equal(result.stats.reusedManuals, 1); assert.equal(result.stats.rebuiltManuals, 0);
  assert.deepEqual(received.map(item => item.path), ['/api/knowledge/estimate', '/api/knowledge/semantic']);
  assert.ok(received.every(item => item.token === 'workspace-version-123' && item.body.profile === data.PROFILE.id));
  assert.ok(phases.some(info => info.stage === 'estimate') && phases.some(info => info.stage === 'vectors'));
  assert.ok(phases.some(info => info.stage === 'capacity' && info.bytes === result.zip.size));
});

test('cancelling CPU work leaves the main thread responsive and permits a fresh publication', { timeout: 20000 }, async t => {
  const { value, workers } = publisher(t), controller = new AbortController();
  const large = request('HTTP client sends request data. '.repeat(100000));
  let ticks = 0; const timer = setInterval(() => ticks++, 5); t.after(() => clearInterval(timer));
  await assert.rejects(value.prepare(large, { signal: controller.signal, onProgress: progress => {
    if (progress.stage === 'index') controller.abort();
  } }), { name: 'AbortError' });
  assert.ok(ticks > 0);
  await value.prepare(request('fresh publication'));
  const output = await value.download({ semantic: false });
  assert.equal(workers.length, 2);
  assert.match(strFromU8(unzipSync(new Uint8Array(await output.zip.arrayBuffer()))['docs/knowledge.json']), /fresh publication/);
});

test('stale worker replies cannot complete a later job and worker errors are retryable', async t => {
  const created = [], value = createPublisher({ createWorker() {
    const fake = { postMessage() {}, terminate() {} }; created.push(fake); return fake;
  } });
  t.after(() => value.dispose());
  const controller = new AbortController(), old = value.prepare(request(), { signal: controller.signal });
  const rejection = assert.rejects(old, { name: 'AbortError' }); controller.abort(); await rejection;
  const next = value.prepare(request());
  created[0].onmessage({ data: { id: 2, type: 'result', value: { bytes: -1 } } });
  created[1].onmessage({ data: { id: 2, type: 'result', value: { bytes: 42 } } });
  assert.equal((await next).bytes, 42);
  const failed = value.preview(); const rejected = assert.rejects(failed, /后台发布失败/);
  created[1].onerror({ message: 'worker crashed' }); await rejected;
  const retry = value.prepare(request());
  created[2].onmessage({ data: { id: 4, type: 'result', value: { bytes: 43 } } });
  assert.equal((await retry).bytes, 43);
});
