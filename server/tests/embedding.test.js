import test, { after } from 'node:test';
import assert from 'node:assert/strict';

var { getEmbeddings } = await import('../src/services/embedding.service.js');
var originalFetch = globalThis.fetch;

after(function () { globalThis.fetch = originalFetch; });

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
