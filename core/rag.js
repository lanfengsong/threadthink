import { randomUUID } from 'node:crypto';

function similarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) throw new Error('Embedding 维度不一致');
  var dot = 0, left = 0, right = 0;
  for (var i = 0; i < a.length; i++) { dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2; }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}
function validateVectors(vectors, count) {
  if (!Array.isArray(vectors) || vectors.length !== count || vectors.some(vector => !Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value)))) throw new Error('Embedding 返回值无效');
}

export class KnowledgeBase {
  constructor(provider, config) { this.provider = provider; this.config = config; this.chunks = []; }
  async add(text, metadata = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('文档内容不能为空');
    if (typeof this.provider.embed !== 'function') throw new Error('当前 provider 不支持 embed');
    var { chunkSize, overlap } = this.config;
    var id = metadata.id || randomUUID();
    var parts = [];
    var characters = [...text];
    for (var offset = 0; offset < characters.length; offset += chunkSize - overlap) {
      parts.push({ id: id + ':' + parts.length, documentId: id, content: characters.slice(offset, offset + chunkSize).join(''), metadata: structuredClone(metadata) });
      if (offset + chunkSize >= characters.length) break;
    }
    var vectors = await this.provider.embed(parts.map(part => part.content));
    validateVectors(vectors, parts.length);
    if (this.chunks.length && this.chunks[0].embedding.length !== vectors[0].length) throw new Error('Embedding 维度不一致');
    this.chunks.push(...parts.map((part, index) => ({ ...part, embedding: vectors[index] })));
    return { id, chunkCount: parts.length };
  }
  async search(query, { topK = this.config.topK, signal } = {}) {
    if (!this.chunks.length) return [];
    if (!Number.isInteger(topK) || topK < 1) throw new TypeError('topK 必须是正整数');
    var vectors = await this.provider.embed([query], { signal });
    validateVectors(vectors, 1);
    return this.chunks.map(({ embedding, ...chunk }) => ({ ...chunk, score: similarity(vectors[0], embedding) })).sort((a, b) => b.score - a.score).slice(0, topK);
  }
}
