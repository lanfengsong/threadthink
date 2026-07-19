/* ============================================================
   ThreadThink Server — Tool: Fetch URL
   ============================================================ */

export var fetchUrlTool = {
  definition: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '读取一个网页的内容并提取关键文本信息。当需要查看具体网页内容时使用。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要读取的网页完整 URL',
          },
        },
        required: ['url'],
      },
    },
  },

  execute: async function (args) {
    var url = args.url;
    if (!url) return { error: '缺少 URL' };

    // Security: validate URL
    try {
      var parsed = new URL(url);
      // Block private/internal IPs
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname.startsWith('192.168.') || parsed.hostname.startsWith('10.') || parsed.hostname.startsWith('172.16.')) {
        return { error: '不允许访问内网地址' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: '只支持 HTTP/HTTPS 协议' };
      }
    } catch (e) {
      return { error: '无效的 URL 格式' };
    }

    try {
      var resp = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'ThreadThink/1.0 (AI Assistant)' },
      });

      if (!resp.ok) {
        return { error: 'HTTP ' + resp.status + ': ' + resp.statusText, url: url };
      }

      var contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        return { error: '不支持的内容类型: ' + contentType, url: url };
      }

      var html = await resp.text();
      // Simple text extraction: remove scripts, styles, tags
      var text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();

      // Truncate if too long
      if (text.length > 8000) {
        text = text.slice(0, 8000) + '...[内容已截断]';
      }

      return { url: url, title: extractTitle(html), content: text, length: text.length };
    } catch (e) {
      return { error: '获取网页失败: ' + e.message, url: url };
    }
  },
};

function extractTitle(html) {
  var match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '未知标题';
}
