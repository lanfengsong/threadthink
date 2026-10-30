import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchUrlTool } from '../src/services/tools/fetch-url.js';
import { createSafeHttpClient, isPublicAddress, MAX_BODY_BYTES } from '../src/services/tools/safe-http.js';
import { mockHttp } from './helpers/tool-http.js';

function toolWith(http, extra) {
  return createFetchUrlTool({ requestHttp: http.request, requestHttps: http.request,
    resolveHost: async function () { return [{ address: '93.184.216.34', family: 4 }]; }, ...extra });
}

test('public address policy rejects reserved IPv4, IPv6, mapped private and transition ranges', function () {
  for (var address of ['100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '192.0.2.1', '198.51.100.1',
    '203.0.113.2', '192.0.0.1', '224.0.0.1', '255.255.255.255', '::', '0:0:0:0:0:0:0:1', 'fe80::1', 'fec0::1',
    'fd00::1', 'ff02::1', '64:ff9b::7f00:1', '2001:db8::1', '2001:0::1', '2002:7f00:1::', '3fff::1',
    '0:0:0:0:0:ffff:7f00:1', '::ffff:192.168.1.1', 'not-an-ip']) assert.equal(isPublicAddress(address), false, address);
  for (var address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('URL canonicalization blocks alternative loopback spellings and credentials before DNS', async function () {
  var http = mockHttp();
  var tool = toolWith(http, { resolveHost: async function () { throw new Error('DNS must not run'); } });
  for (var url of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/',
    'http://[0:0:0:0:0:0:0:1]/', 'http://service.local/', 'http://user:secret@example.com/']) {
    assert.match((await tool.execute({ url: url })).error, /不允许/);
  }
  assert.equal(http.calls.length, 0);
});

test('DNS fails closed on every answer including mixed public/private, invalid, empty, or failure', async function () {
  for (var addresses of [[{ address: '127.0.0.1' }], [{ address: '93.184.216.34' }, { address: 'fd00::1' }],
    [{ address: 'invalid' }], [null], [], null, new Error('DNS unavailable')]) {
    var http = mockHttp();
    var tool = toolWith(http, { resolveHost: async function () { if (addresses instanceof Error) throw addresses; return addresses; } });
    assert.match((await tool.execute({ url: 'https://example.com/' })).error, /域名/);
    assert.equal(http.calls.length, 0);
  }
});

test('validated DNS answers are bound to native lookup, preserving original TLS/Host target', async function () {
  var resolutions = 0;
  var http = mockHttp();
  var tool = toolWith(http, { resolveHost: async function (hostname, options) {
    assert.equal(hostname, 'example.com'); assert.equal(options.all, true);
    resolutions++;
    // An attacker switches the second DNS answer; it must never be consulted.
    return [{ address: resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
  } });
  assert.equal((await tool.execute({ url: 'https://example.com:8443/page' })).title, 'Example');
  var call = http.calls[0];
  assert.equal(call.url.hostname, 'example.com');
  assert.equal(call.url.port, '8443');
  assert.equal(call.options.agent, false);
  assert.equal(call.options.maxHeaderSize, 16384);
  assert.equal(call.options.headers['Accept-Encoding'], 'identity');
  var answers = await new Promise(function (resolve, reject) {
    call.options.lookup('example.com', { all: true }, function (error, result) { if (error) reject(error); else resolve(result); });
  });
  assert.deepEqual(answers, [{ address: '93.184.216.34', family: 4 }]);
  answers[0].address = '127.0.0.1';
  call.options.lookup('example.com', {}, function (error, address, family) {
    assert.ifError(error); assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
  });
  call.options.lookup('attacker.example', {}, function (error) { assert.match(error.message, /目标/); });
  assert.equal(resolutions, 1);
});

test('IPv6 literals connect without DNS resolution', async function () {
  var http = mockHttp();
  var tool = toolWith(http, { resolveHost: async function () { assert.fail('literal must not resolve'); } });
  assert.equal((await tool.execute({ url: 'https://[2606:4700:4700::1111]/' })).title, 'Example');
  assert.equal(http.calls.length, 1);
});

test('2MB body limit is inclusive and streaming oversize destroys response and request', async function () {
  var exact = mockHttp({ headers: { 'content-type': 'text/plain' }, chunks: [Buffer.alloc(MAX_BODY_BYTES, 97)] });
  var ok = await toolWith(exact).execute({ url: 'https://example.com/' });
  assert.equal(ok.error, undefined);
  assert.match(ok.content, /内容已截断/);
  var over = mockHttp({ chunks: [Buffer.alloc(MAX_BODY_BYTES, 97), Buffer.from('!')] });
  assert.match((await toolWith(over).execute({ url: 'https://example.com/' })).error, /内容过大/);
  assert.equal(over.calls[0].response.destroyed, true);
  assert.equal(over.calls[0].request.destroyed, true);
});

test('early rejection of size, type, encoding, status, redirects closes unread bodies', async function () {
  for (var spec of [
    { headers: { 'content-type': 'text/html', 'content-length': String(MAX_BODY_BYTES + 1) } },
    { headers: { 'content-type': 'text/html', 'content-length': 'invalid' } },
    { headers: { 'content-type': 'application/octet-stream' } },
    { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } },
    { status: 503 }, { status: 301, headers: { location: '/other' } },
  ]) {
    var http = mockHttp({ ...spec, stall: true });
    assert.ok((await toolWith(http).execute({ url: 'https://example.com/' })).error);
    assert.equal(http.calls[0].response.destroyed, true);
    assert.equal(http.calls[0].request.destroyed, true);
  }
});

test('deadline includes DNS and late resolution cannot start a request or consume unbounded slots', async function () {
  var resolveDns;
  var http = mockHttp();
  var client = createSafeHttpClient({ timeoutMs: 10, maxConcurrent: 1, requestHttps: http.request,
    resolveHost: function () { return new Promise(function (resolve) { resolveDns = resolve; }); } });
  await assert.rejects(client('https://example.com/'), /超时/);
  await assert.rejects(client('https://example.com/'), /并发/);
  resolveDns([{ address: '93.184.216.34' }]);
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(http.calls.length, 0);
});

test('stalled body timeout and external cancellation destroy native I/O', async function () {
  var timeoutHttp = mockHttp({ stall: true });
  var timeout = await toolWith(timeoutHttp, { timeoutMs: 10 }).execute({ url: 'https://example.com/' });
  assert.match(timeout.error, /超时/);
  assert.equal(timeoutHttp.calls[0].request.destroyed, true);
  assert.equal(timeoutHttp.calls[0].response.destroyed, true);
  var controller = new AbortController();
  var cancelHttp = mockHttp({ stall: true, onResponse: function () { controller.abort(new Error('cancelled')); } });
  var cancelled = await toolWith(cancelHttp).execute({ url: 'https://example.com/' }, { signal: controller.signal });
  assert.match(cancelled.error, /cancelled/);
  assert.equal(cancelHttp.calls[0].request.destroyed, true);
  var neverHttp = mockHttp();
  assert.match((await toolWith(neverHttp).execute({ url: 'https://example.com/' }, { signal: controller.signal })).error, /cancelled/);
  assert.equal(neverHttp.calls.length, 0);
});

test('HTML extraction handles malformed repeated tags in bounded space and strips scripts/styles', async function () {
  for (var body of ['<'.repeat(MAX_BODY_BYTES), '<script>'.repeat(100000), '<title>'.repeat(100000), '<>'.repeat(100000)]) {
    var http = mockHttp({ body: body });
    var result = await toolWith(http).execute({ url: 'https://example.com/' });
    assert.equal(result.error, undefined);
    assert.ok(result.content.length < 8100);
    assert.ok(result.title.length <= 1000);
  }
  var html = mockHttp({ body: 'İ<TITLE>A &amp; B</TITLE><SCRIPT>hidden</SCRIPT><!-- hidden --><style>hidden</style><p>Visible &lt;text&gt;</p>' });
  var page = await toolWith(html).execute({ url: 'https://example.com/' });
  assert.equal(page.title, 'A & B');
  assert.equal(page.content, 'İ A & B Visible <text>');
  var plain = mockHttp({ headers: { 'content-type': 'text/plain' }, body: '1 < 2 and &amp; stays literal' });
  assert.equal((await toolWith(plain).execute({ url: 'https://example.com/' })).content, '1 < 2 and &amp; stays literal');
});

test('premature body close is an error, not a successful partial page', async function () {
  var http = mockHttp({ stall: true, onResponse: function (call) { call.response.write('partial'); call.response.destroy(); } });
  assert.match((await toolWith(http).execute({ url: 'https://example.com/' })).error, /完整|中断/);
});
