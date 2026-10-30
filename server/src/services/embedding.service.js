/* ============================================================
   ThreadThink Server — Embedding Service
   ============================================================

   The provider response is treated as untrusted input.  Keeping validation
   here means document ingestion and document search never persist or score
   malformed vectors.
   ============================================================ */

/** Get embedding vector for a single text. */
export async function getEmbedding(text, apiKey, apiBase, model, context) {
  var embeddings = await getEmbeddings([text], apiKey, apiBase, model, context);
  return embeddings[0];
}

/** Get and validate vectors from an OpenAI-compatible embeddings endpoint. */
export async function getEmbeddings(texts, apiKey, apiBase, model, context) {
  if (!Array.isArray(texts)) throw new Error('Embedding 输入必须为文本数组');
  if (texts.length === 0) return [];
  for (var inputIndex = 0; inputIndex < texts.length; inputIndex++) {
    if (typeof texts[inputIndex] !== 'string' || !texts[inputIndex].trim()) {
      throw new Error('Embedding 输入必须为非空文本');
    }
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Embedding API Key 不能为空');
  if (typeof apiBase !== 'string' || !apiBase) throw new Error('Embedding API 地址无效');
  if (model !== undefined && typeof model !== 'string') throw new Error('Embedding 模型格式异常');

  var embedBase = apiBase.replace(/\/chat\/completions$/, '/embeddings');
  if (embedBase === apiBase) embedBase = apiBase.replace(/\/v1\/?$/, '/v1/embeddings');

  var embedModel = 'text-embedding-3-small';
  if (model && model.includes('deepseek')) embedModel = 'deepseek-chat';
  if (model && model.includes('anthropic')) {
    throw new Error('Anthropic API 不支持 Embedding，请在设置中配置 OpenAI 或 DeepSeek 的 API');
  }

  var truncated = texts.map(function (text) {
    return text.length > 16000 ? text.slice(0, 16000) : text;
  });
  var headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + apiKey,
  };

  var timeoutSignal = AbortSignal.timeout(10000);
  var signal = context && context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;
  try {
    signal.throwIfAborted();
    var resp = await fetch(embedBase, {
      method: 'POST',
      headers: headers,
      signal: signal,
      body: JSON.stringify({ model: embedModel, input: truncated, encoding_format: 'float' }),
    });
    var responseText = await readEmbeddingBody(resp, signal);
    if (!resp.ok) throw new Error('Embedding API ' + resp.status + ': ' + responseText.slice(0, 200));
    var data = JSON.parse(responseText);
    if (!data || !Array.isArray(data.data) || data.data.length !== texts.length) {
      throw new Error('Embedding 返回数量异常');
    }

    // Providers are allowed to return data in a different order.
    var ordered = new Array(texts.length);
    for (var i = 0; i < data.data.length; i++) {
      var item = data.data[i];
      var index = item && item.index === undefined ? i : item && item.index;
      if (!Number.isInteger(index) || index < 0 || index >= texts.length || ordered[index]) {
        throw new Error('Embedding 返回索引异常');
      }
      ordered[index] = item.embedding;
    }

    var dimension = null;
    for (var j = 0; j < ordered.length; j++) {
      var vector = ordered[j];
      if (!Array.isArray(vector) || vector.length === 0 ||
          vector.some(function (value) { return typeof value !== 'number' || !Number.isFinite(value); })) {
        throw new Error('Embedding 向量格式异常');
      }
      if (dimension === null) dimension = vector.length;
      if (vector.length !== dimension) throw new Error('Embedding 向量维度不一致');
      var norm = 0;
      for (var k = 0; k < vector.length; k++) norm += vector[k] * vector[k];
      if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding 向量不能为零向量');
    }
    return ordered;
  } catch (e) {
    if (e && e.message && e.message.indexOf('Embedding') !== -1) throw e;
    throw new Error('Embedding 请求失败: ' + (e && e.message ? e.message : String(e)));
  }
}

async function readEmbeddingBody(response, signal) {
  if (!response.body) return '';
  var reader = response.body.getReader(), chunks = [], bytes = 0;
  function abort() { reader.cancel().catch(function () {}); }
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      var part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('Embedding 响应超过 2MB');
      chunks.push(Buffer.from(part.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal.removeEventListener('abort', abort);
    try { await reader.cancel(); } catch (error) { /* already closed */ }
    reader.releaseLock();
  }
}

/** Cosine similarity between two finite, non-zero vectors. */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  var dot = 0, normA = 0, normB = 0;
  for (var i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!Number.isFinite(dot) || normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
