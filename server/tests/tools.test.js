import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatorTool } from '../src/services/tools/calculator.js';
import { fetchUrlTool } from '../src/services/tools/fetch-url.js';

test('calculator supports bounded arithmetic grammar and whitelisted functions', async function () {
  var cases = [
    ['2 + 3 * 4', 14],
    ['2^3', 8],
    ['2**3', 8],
    ['-2^2', -4],
    ['(-2)^2', 4],
    ['1e3 + .5', 1000.5],
    ['pi + Math.E', Math.PI + Math.E],
    ['Math.PI / 2', Math.PI / 2],
    ['sqrt(16)', 4],
    ['Math.sqrt(9) + abs(-2)', 5],
    ['pow(2, 3) + cbrt(8)', 10],
    ['sin(pi / 2)', 1],
    ['round(1.23456) + floor(2.9) + ceil(3.1)', 7],
  ];
  for (var entry of cases) {
    var result = await calculatorTool.execute({ expression: entry[0] });
    assert.equal(result.result, entry[1], entry[0]);
    assert.equal(result.expression, entry[0]);
    assert.equal(Number.isFinite(result.result), true);
  }
});

test('calculator rejects JavaScript syntax, properties, mutation, comments, and globals', async function () {
  var payloads = [
    'sqrt(4); globalThis.process',
    'sin(1).constructor.constructor("return process")()',
    'Math.sqrt(4); throw new Error("bad")',
    'globalThis',
    'Math.Math.sqrt(4)',
    'Math.PI++',
    'Math.PI = 4',
    '2 // comment',
    '2 /* comment */',
    'Math.random()',
    'process.version',
    'sqrt.constructor',
    '2, 3',
    '1 + !0',
    '2 | 1',
  ];
  for (var expression of payloads) {
    var result = await calculatorTool.execute({ expression: expression });
    assert.ok(result.error, expression);
    assert.match(result.error, /不安全|语法|标识符|函数|错误|过于复杂/);
  }
});

test('calculator enforces finite results and parser bounds', async function () {
  for (var expression of ['1 / 0', 'sqrt(-1)', '10^10000', '1'.repeat(1001)]) {
    var result = await calculatorTool.execute({ expression: expression });
    assert.ok(result.error, expression);
  }

  var deep = '';
  for (var i = 0; i < 33; i++) deep += '(';
  deep += '1';
  for (var j = 0; j < 33; j++) deep += ')';
  assert.ok((await calculatorTool.execute({ expression: deep })).error);
});

test('fetch_url rejects unsupported protocols and non-public literal addresses', async function () {
  for (var url of [
    'file:///etc/passwd',
    'http://127.0.0.2/',
    'http://169.254.169.254/latest/meta-data/',
    'http://172.20.0.1/',
    'http://192.168.1.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://localhost./',
    'http://service.localhost./',
  ]) {
    var result = await fetchUrlTool.execute({ url: url });
    assert.match(result.error, /不允许|只支持/, url);
  }
});

test('fetch_url allows a public literal with a pure mocked fetch and restores the mock', async function () {
  var originalFetch = globalThis.fetch;
  var calledUrl;
  globalThis.fetch = async function (url) {
    calledUrl = url;
    return new Response('<title>Example</title><p>Hello</p>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };
  try {
    var result = await fetchUrlTool.execute({ url: 'https://93.184.216.34/example' });
    assert.equal(result.title, 'Example');
    assert.equal(result.content, 'Example Hello');
    assert.equal(calledUrl, 'https://93.184.216.34/example');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(globalThis.fetch, originalFetch);
});

test('fetch_url does not follow redirects automatically', async function () {
  var originalFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return new Response('', {
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
    });
  };
  try {
    var result = await fetchUrlTool.execute({ url: 'https://example.com/start' });
    assert.match(result.error, /重定向/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
