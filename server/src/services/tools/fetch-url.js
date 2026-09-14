/* ============================================================
   ThreadThink Server — Tool: Fetch URL
   ============================================================ */

import { isIP } from 'net';

export var fetchUrlTool = {
  definition: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '读取一个网页的内容并提取关键文本信息。当需要查看具体网页内容时使用。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要读取的网页完整 URL' },
        },
        required: ['url'],
      },
    },
  },

  execute: async function (args) {
    var url = args && args.url;
    if (typeof url !== 'string' || !url.trim()) return { error: '缺少 URL' };

    var parsed;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: '只支持 HTTP/HTTPS 协议' };
      }
      if (isBlockedHostname(parsed.hostname)) {
        return { error: '不允许访问内网地址' };
      }
    } catch (e) {
      return { error: '无效的 URL 格式' };
    }

    try {
      var resp = await fetch(parsed.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'ThreadThink/1.0 (AI Assistant)' },
      });

      if (resp.status >= 300 && resp.status < 400) {
        var location = resp.headers.get('location');
        if (!location) return { error: '网页重定向缺少目标地址', url: url };
        var redirectUrl;
        try { redirectUrl = new URL(location, parsed); } catch (e) { return { error: '网页重定向地址无效', url: url }; }
        if (redirectUrl.protocol !== 'http:' && redirectUrl.protocol !== 'https:' || isBlockedHostname(redirectUrl.hostname)) {
          return { error: '不允许重定向到内网地址', url: url };
        }
        return { error: '网页发生重定向，请提供最终地址', url: url };
      }

      if (!resp.ok) return { error: 'HTTP ' + resp.status + ': ' + resp.statusText, url: url };

      var contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        return { error: '不支持的内容类型: ' + contentType, url: url };
      }

      var html = await resp.text();
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

      if (text.length > 8000) text = text.slice(0, 8000) + '...[内容已截断]';
      return { url: url, title: extractTitle(html), content: text, length: text.length };
    } catch (e) {
      return { error: '获取网页失败: ' + e.message, url: url };
    }
  },
};

function isBlockedHostname(hostname) {
  var host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  var version = isIP(host);
  if (version === 4) return isBlockedIPv4(host);
  if (version === 6) {
    var mapped = mappedIPv4(host);
    if (mapped) return isBlockedIPv4(mapped);
    return host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') ||
      host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
  }
  return false;
}

function isBlockedIPv4(host) {
  var octets = host.split('.').map(Number);
  return octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] === 0;
}

function mappedIPv4(host) {
  var direct = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (direct && isIP(direct[1]) === 4) return direct[1];

  // Also accept the hexadecimal spelling, e.g. ::ffff:7f00:1.
  var parts = expandIPv6(host);
  if (!parts || parts[0] !== 0 || parts[1] !== 0 || parts[2] !== 0 || parts[3] !== 0 || parts[4] !== 0 || parts[5] !== 0xffff) return null;
  var high = parts[6], low = parts[7];
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.');
}

function expandIPv6(host) {
  var halves = host.split('::');
  if (halves.length > 2) return null;
  var left = halves[0] ? halves[0].split(':') : [];
  var right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (left.some(function (part) { return !/^[0-9a-f]{1,4}$/i.test(part); }) ||
      right.some(function (part) { return !/^[0-9a-f]{1,4}$/i.test(part); })) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  var zeros = 8 - left.length - right.length;
  return left.concat(new Array(zeros).fill('0'), right).map(function (part) { return parseInt(part, 16); });
}

function extractTitle(html) {
  var match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '未知标题';
}
