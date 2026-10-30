import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createDeadline, abortable, boundedTimeout } from './runtime.js';

export var MAX_BODY_BYTES = 2 * 1024 * 1024;

function normalizeHost(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

function expandIPv6(host) {
  // IPv4 embedded in IPv6 is normalized before interpreting the eight words.
  host = host.replace(/(\d+\.\d+\.\d+\.\d+)$/, function (ip) {
    var bytes = ip.split('.').map(Number);
    return ((bytes[0] << 8) | bytes[1]).toString(16) + ':' + ((bytes[2] << 8) | bytes[3]).toString(16);
  });
  var halves = host.split('::');
  var left = halves[0] ? halves[0].split(':') : [];
  var right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  return left.concat(new Array(8 - left.length - right.length).fill('0'), right).map(function (word) { return parseInt(word, 16); });
}

export function isPublicAddress(address) {
  var host = normalizeHost(address);
  var family = isIP(host);
  if (family === 4) {
    var b = host.split('.').map(Number);
    return !(b[0] === 0 || b[0] === 10 || b[0] === 127 || b[0] >= 224 ||
      (b[0] === 100 && b[1] >= 64 && b[1] <= 127) ||
      (b[0] === 169 && b[1] === 254) ||
      (b[0] === 172 && b[1] >= 16 && b[1] <= 31) ||
      (b[0] === 192 && (b[1] === 168 || (b[1] === 0 && (b[2] === 0 || b[2] === 2)) || (b[1] === 88 && b[2] === 99))) ||
      (b[0] === 198 && (b[1] === 18 || b[1] === 19 || (b[1] === 51 && b[2] === 100))) ||
      (b[0] === 203 && b[1] === 0 && b[2] === 113));
  }
  if (family === 6) {
    var words = expandIPv6(host);
    if (words.slice(0, 5).every(function (word) { return word === 0; }) && words[5] === 0xffff) {
      return isPublicAddress([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.'));
    }
    // Only global unicast; exclude special-purpose, documentation and 6to4.
    return (words[0] & 0xe000) === 0x2000 &&
      !(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8)) &&
      words[0] !== 0x2002 && !(words[0] === 0x3fff && words[1] < 0x1000);
  }
  return false;
}

export function parsePublicUrl(value) {
  var parsed;
  try { parsed = new URL(value); } catch (error) { throw new Error('无效的 URL 格式'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 HTTP/HTTPS 协议');
  if (parsed.username || parsed.password) throw new Error('不允许 URL 包含认证信息');
  var hostname = normalizeHost(parsed.hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
      (isIP(hostname) && !isPublicAddress(hostname))) throw new Error('不允许访问内网或非公网地址');
  return parsed;
}

/** Validate every DNS answer and pass only those answers to the socket's lookup.
 * Keeping the original URL preserves Host and TLS hostname verification/SNI.
 * agent:false prevents an unrelated pooled connection bypassing this binding.
 */
export function createSafeHttpClient(options) {
  var opts = options || {};
  var resolver = opts.resolveHost || lookup;
  var maxBodyBytes = opts.maxBodyBytes || MAX_BODY_BYTES;
  var timeoutMs = opts.timeoutMs || 10000;
  var active = 0;
  var maxConcurrent = opts.maxConcurrent || 8;

  return async function (value, context) {
    var ctx = context || {};
    var parsed = parsePublicUrl(value);
    if (active >= maxConcurrent) throw new Error('网络请求并发已达上限');
    active++;
    var deadline = createDeadline(ctx.signal, boundedTimeout(ctx.timeoutMs, timeoutMs));
    // Keep the slot until actual work settles, even when an uncancellable DNS
    // lookup outlives its caller. Repeated timeouts cannot queue unbounded DNS.
    var work = (async function () {
      deadline.signal.throwIfAborted();
      var hostname = normalizeHost(parsed.hostname);
      var addresses;
      if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
      else {
        try { addresses = await resolver(hostname, { all: true }); }
        catch (error) { throw new Error('域名解析失败，无法确认公网地址'); }
      }
      deadline.signal.throwIfAborted();
      if (!Array.isArray(addresses) || !addresses.length) throw new Error('域名无有效解析结果');
      addresses = addresses.map(function (record) {
        if (!record || typeof record.address !== 'string' || !isPublicAddress(record.address)) {
          throw new Error('域名解析到内网或无效地址，已拒绝访问');
        }
        return { address: normalizeHost(record.address), family: isIP(normalizeHost(record.address)) };
      });
      return readResponse(parsed, addresses, deadline.signal, maxBodyBytes, opts, ctx);
    })();
    work.then(function () { active--; }, function () { active--; });
    try { return await abortable(work, deadline.signal); }
    finally { deadline.dispose(); }
  };
}

function readResponse(parsed, addresses, signal, limit, options, context) {
  return new Promise(function (resolve, reject) {
    var request;
    var response;
    var settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) {
        if (response) response.destroy();
        if (request) request.destroy();
        reject(error);
      } else resolve(value);
    }
    function onAbort() { finish(signal.reason || new Error('操作已取消')); }
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    var requestFn = parsed.protocol === 'https:' ? options.requestHttps || httpsRequest : options.requestHttp || httpRequest;
    try {
      request = requestFn(parsed, {
        method: 'GET',
        agent: false,
        signal: signal,
        maxHeaderSize: 16384,
        headers: { 'User-Agent': 'ThreadThink/1.0 (AI Assistant)', 'Accept-Encoding': 'identity' },
        lookup: function (hostname, lookupOptions, callback) {
          if (typeof lookupOptions === 'function') { callback = lookupOptions; lookupOptions = {}; }
          if (normalizeHost(hostname) !== normalizeHost(parsed.hostname)) {
            callback(new Error('连接目标与校验域名不一致'));
            return;
          }
          var family = typeof lookupOptions === 'number' ? lookupOptions : lookupOptions.family;
          var candidates = family ? addresses.filter(function (address) { return address.family === family; }) : addresses;
          if (!candidates.length) { callback(new Error('没有已校验的目标地址')); return; }
          if (lookupOptions.all) callback(null, candidates.map(function (address) { return { ...address }; }));
          else callback(null, candidates[0].address, candidates[0].family);
        },
      }, function (incoming) {
        response = incoming;
        response.on('error', function (error) { finish(error); });
        if (settled) { response.destroy(); return; }
        var status = response.statusCode;
        var headers = response.headers;
        if (status >= 300 && status < 400) { finish(new Error('网页发生重定向，请提供最终地址')); return; }
        if (status < 200 || status >= 300) { finish(new Error('HTTP ' + status + ': ' + (response.statusMessage || ''))); return; }
        var type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (context.acceptContentTypes && !context.acceptContentTypes.includes(type)) {
          finish(new Error('不支持的内容类型: ' + type)); return;
        }
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
          finish(new Error('不支持的内容编码')); return;
        }
        var length = headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > limit)) {
          finish(new Error('网页内容过大（超过 ' + limit + ' bytes），已中止读取')); return;
        }
        var received = 0;
        var chunks = [];
        var ended = false;
        response.on('data', function (chunk) {
          if (settled) return;
          received += chunk.length;
          if (received > limit) { finish(new Error('网页内容过大（超过 ' + limit + ' bytes），已中止读取')); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', function () {
          ended = true;
          finish(null, { status: status, headers: headers, body: Buffer.concat(chunks, received).toString('utf8') });
        });
        response.on('aborted', function () { finish(new Error('响应读取被中断')); });
        response.on('close', function () { if (!ended && !settled) finish(new Error('响应未完整读取')); });
      });
      request.on('error', function (error) { finish(error); });
      if (settled) request.destroy();
      else request.end();
    } catch (error) { finish(error); }
  });
}
