/* ============================================================
   ThreadThink Server — Embedding Service
   ============================================================ */

/**
 * Get embedding vector for a single text.
 * Uses OpenAI-compatible embeddings API.
 */
export async function getEmbedding(text, apiKey, apiBase, model) {
  var embeddings = await getEmbeddings([text], apiKey, apiBase, model);
  return embeddings[0];
}

/**
 * Batch get embedding vectors for multiple texts.
 * Tries /embeddings endpoint first. Falls back gracefully.
 *
 * @param {string[]} texts
 * @param {string} apiKey
 * @param {string} apiBase - e.g. https://api.deepseek.com/v1/chat/completions
 * @param {string} model - chat model; we derive embedding model from this
 * @returns {Promise<number[][]>}
 */
export async function getEmbeddings(texts, apiKey, apiBase, model) {
  if (!texts || texts.length === 0) return [];

  // Derive embedding API base from chat API base
  var embedBase = apiBase.replace(/\/chat\/completions$/, '/embeddings');
  if (embedBase === apiBase) embedBase = apiBase.replace(/\/v1\/?$/, '/v1/embeddings');

  // Derive embedding model from chat model
  var embedModel = 'text-embedding-3-small';
  if (model && model.includes('deepseek')) embedModel = 'deepseek-chat'; // DeepSeek uses same model
  if (model && model.includes('anthropic')) {
    // Anthropic doesn't have embeddings; throw helpful error
    throw new Error('Anthropic API 不支持 Embedding，请在设置中配置 OpenAI 或 DeepSeek 的 API');
  }

  // Truncate texts to avoid token limits (rough: 1 token ≈ 2 chars, max 8000 tokens)
  var truncated = texts.map(function (t) {
    if (t.length > 16000) return t.slice(0, 16000);
    return t;
  });

  var headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + apiKey,
  };

  var body = {
    model: embedModel,
    input: truncated,
    encoding_format: 'float',
  };

  try {
    var resp = await fetch(embedBase, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      var errText = await resp.text();
      throw new Error('Embedding API ' + resp.status + ': ' + errText.slice(0, 200));
    }

    var data = await resp.json();

    // OpenAI format: { data: [{ embedding: [...] }, ...] }
    if (data.data && data.data.length > 0) {
      return data.data.map(function (d) { return d.embedding; });
    }

    throw new Error('Embedding 返回格式异常');
  } catch (e) {
    if (e.message.includes('Embedding')) throw e;
    // Network error or other
    throw new Error('Embedding 请求失败: ' + e.message);
  }
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  var dot = 0, normA = 0, normB = 0;
  for (var i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
