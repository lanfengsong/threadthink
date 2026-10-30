import test, { after } from 'node:test';
import assert from 'node:assert/strict';

var { getEmbeddings } = await import('../src/services/embedding.service.js');
var originalFetch = globalThis.fetch;

after(function () { globalThis.fetch = originalFetch; });

test('embedding propagates cancellation and cancels oversized response bodies', async function () {
  var cancelled = false;
  globalThis.fetch = async function (url, options) {
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(new ReadableStream({
      start: function (controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel: function () { cancelled = true; },
    }));
  };
  await assert.rejects(getEmbeddings(['a'], 'key', 'https://provider.test/v1/chat/completions', 'model'), /2MB/);
  assert.equal(cancelled, true);
  var controller = new AbortController(); controller.abort(new Error('cancelled-by-user'));
  globalThis.fetch = async function () { assert.fail('aborted request must not start'); };
  await assert.rejects(getEmbeddings(['a'], 'key', 'https://provider.test/v1/chat/completions', 'model', { signal: controller.signal }), /cancelled-by-user/);
});

function response(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } });
}

test('embeddings are reordered by provider index and validated', async function () {
  globalThis.fetch = async function () {
    return response({ data: [
      { index: 1, embedding: [0, 2] },
      { index: 0, embedding: [1, 0] },
    ] });
  };
  assert.deepEqual(await getEmbeddings(['a', 'b'], 'key', 'https://provider.test/v1/chat/completions', 'model'), [[1, 0], [0, 2]]);
});

test('embedding HTTP and schema failures are rejected', async function () {
  globalThis.fetch = async function () { return new Response('upstream down', { status: 503 }); };
  await assert.rejects(getEmbeddings(['a'], 'key', 'https://provider.test/v1/chat/completions', 'model'), /Embedding API 503/);

  var invalid = [
    { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1] }] },
    { data: [{ index: 0, embedding: [0, 0] }] },
    { data: [{ index: 0, embedding: [1, NaN] }] },
    { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] },
    { data: [{ index: 3, embedding: [1, 0] }] },
  ];
  for (var body of invalid) {
    globalThis.fetch = async function () { return response(body); };
    await assert.rejects(getEmbeddings(body.data.length === 2 ? ['a', 'b'] : ['a'], 'key', 'https://provider.test/v1/chat/completions', 'model'), /Embedding/);
  }
});
