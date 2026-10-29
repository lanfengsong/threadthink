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

test('output.render 决定模型视角：注册输出契约的工具格式化结果', async function () {
  var { registerTool, renderToolResult } = await import('../src/services/tools/index.js');
  registerTool('contract-test-tool', {
    type: 'function',
    function: {
      name: 'contract-test-tool',
      description: 'test',
      parameters: { type: 'object', properties: {} },
      output: { render: function (args, value) { return 'RENDERED:' + (value && value.v); } },
    },
  }, async function () { return { v: 'ok' }; });

  assert.equal(renderToolResult('contract-test-tool', {}, { v: 'ok' }), 'RENDERED:ok');
});

test('无输出契约的工具回退 JSON.stringify（向后兼容）', async function () {
  var { renderToolResult } = await import('../src/services/tools/index.js');
  assert.equal(renderToolResult('calculator', { expression: '1+1' }, { result: 2 }), JSON.stringify({ result: 2 }));
});

test('doc_search 输出契约：正常值为格式化摘要、错误值回退 JSON', async function () {
  var { renderToolResult } = await import('../src/services/tools/index.js');
  var ok = renderToolResult('doc_search', { query: 'q' }, {
    query: 'q', total_documents: 1,
    results: [{ filename: 'a.md', section_path: '概述', content: '内容' }],
  });
  assert.match(ok, /找到 1 条相关文档/);
  assert.match(ok, /a\.md｜概述/);
  assert.ok(ok.indexOf('"results"') === -1 && ok.indexOf('"query"') === -1, '模型视角不应包含原始 JSON 字段');

  var err = renderToolResult('doc_search', { query: 'q' }, { error: '缺少搜索查询' });
  assert.equal(err, JSON.stringify({ error: '缺少搜索查询' }));
});
