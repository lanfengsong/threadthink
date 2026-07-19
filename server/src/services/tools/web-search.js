/* ============================================================
   ThreadThink Server — Tool: Web Search (DuckDuckGo)
   ============================================================ */

export var webSearchTool = {
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网获取最新信息。当需要查找实时数据、新闻、或你不知道的事实时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词，用中文或英文',
          },
        },
        required: ['query'],
      },
    },
  },

  execute: async function (args) {
    var query = args.query;
    if (!query) return { error: '缺少搜索关键词' };

    try {
      // Use DuckDuckGo Instant Answer API (free, no key needed)
      var url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
      var resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      var data = await resp.json();

      var results = [];

      // Abstract
      if (data.AbstractText) {
        results.push({ title: data.Heading || '摘要', snippet: data.AbstractText, source: data.AbstractURL });
      }

      // Related topics
      if (data.RelatedTopics && data.RelatedTopics.length > 0) {
        var topics = data.RelatedTopics.filter(function (t) { return t.Text; }).slice(0, 5);
        for (var i = 0; i < topics.length; i++) {
          results.push({
            title: topics[i].FirstURL ? topics[i].FirstURL.split('/').pop().replace(/_/g, ' ') : '相关结果',
            snippet: topics[i].Text,
            source: topics[i].FirstURL || '',
          });
        }
      }

      if (results.length === 0) {
        return { query: query, results: [{ title: '无结果', snippet: 'DuckDuckGo 未返回相关结果，请尝试其他关键词。' }] };
      }

      return { query: query, results: results.slice(0, 6) };
    } catch (e) {
      return { error: '搜索失败: ' + e.message };
    }
  },
};
