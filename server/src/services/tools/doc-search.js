/* ============================================================
   ThreadThink Server — Tool: Document Search (RAG)
   ============================================================ */

import { getDb } from '../../db/connection.js';
import { decrypt } from '../crypto.service.js';
import { getEmbedding, cosineSimilarity } from '../embedding.service.js';

export var docSearchTool = {
  definition: {
    type: 'function',
    function: {
      name: 'doc_search',
      description: '在用户上传的文档库中搜索相关信息。当用户询问的内容可能存在于已上传的文档中时，优先使用此工具。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索查询，用自然语言描述要查找的信息',
          },
        },
        required: ['query'],
      },
    },
  },

  execute: async function (args, userId) {
    var query = args.query;
    if (!query) return { error: '缺少搜索查询' };

    try {
      var db = getDb();

      // Get user API config
      var user = db.prepare('SELECT api_key, api_base, model FROM users WHERE id = ?').get(userId);
      if (!user || !user.api_key) return { error: '用户未配置 API Key，无法检索文档' };

      var apiKey = decrypt(user.api_key);
      if (!apiKey) return { error: 'API Key 解密失败' };
      var apiBase = user.api_base || 'https://api.deepseek.com/v1/chat/completions';
      var model = user.model || 'deepseek-chat';

      // Get query embedding
      var queryEmbedding = await getEmbedding(query, apiKey, apiBase, model);
      if (!queryEmbedding) return { error: '查询向量化失败' };

      // Get all chunks for this user
      var chunks = db.prepare(
        'SELECT c.id, c.content, c.embedding, c.chunk_index, d.filename, d.id as doc_id ' +
        'FROM chunks c JOIN documents d ON c.document_id = d.id ' +
        'WHERE d.user_id = ?'
      ).all(userId);

      if (chunks.length === 0) return { message: '暂无已上传的文档', results: [] };

      // Calculate similarities
      var scored = [];
      for (var i = 0; i < chunks.length; i++) {
        var emb = null;
        try {
          if (chunks[i].embedding) emb = JSON.parse(chunks[i].embedding);
        } catch (e) {}
        if (!emb) continue;

        var score = cosineSimilarity(queryEmbedding, emb);
        scored.push({
          document_id: chunks[i].doc_id,
          filename: chunks[i].filename,
          chunk_index: chunks[i].chunk_index,
          content: chunks[i].content,
          score: score,
        });
      }

      scored.sort(function (a, b) { return b.score - a.score; });
      var top = scored.slice(0, 5);

      return {
        query: query,
        total_documents: countUniqueDocs(top),
        results: top.map(function (s) {
          return {
            filename: s.filename,
            content: s.content,
            relevance: Math.round(s.score * 100) / 100,
          };
        }),
      };
    } catch (e) {
      return { error: '文档检索失败: ' + e.message };
    }
  },
};

function countUniqueDocs(scored) {
  var seen = {};
  for (var i = 0; i < scored.length; i++) {
    seen[scored[i].document_id] = true;
  }
  return Object.keys(seen).length;
}

/** Set the userId context for tool execution */
docSearchTool.setUserId = function (uid) {
  docSearchTool._userId = uid;
};
