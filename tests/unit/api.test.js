/* ============================================================
   Tests: API client and SSE protocol handling
   ============================================================ */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatStream } from '../../src/api.js';

function sseResponse(chunks, status, lifecycle) {
  var encoder = new TextEncoder();
  var index = 0;
  var body = new ReadableStream({
    pull: function (controller) {
      if (index >= chunks.length) { controller.close(); return; }
      controller.enqueue(chunks[index++] instanceof Uint8Array ? chunks[index - 1] : encoder.encode(chunks[index - 1]));
    },
    cancel: function () {
      if (lifecycle) lifecycle.cancelled = true;
    },
  });
  return new Response(body, { status: status || 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function fragmentedSseResponse(text, size, lifecycle) {
  var bytes = new TextEncoder().encode(text);
  var chunks = [];
  for (var i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return sseResponse(chunks, 200, lifecycle);
}

describe('createChatStream', function () {
  afterEach(function () {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('parses normal events split across network chunks', async function () {
    localStorage.setItem('tt_token', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: token\ndata: {"content":"你好"}\n\n',
      'event: token\ndata: {"content":"，世界"}\n\nevent: done\n',
      'data: {"messageId":"m1"}\n\n',
    ])));

    var tokens = [];
    var done;
    await createChatStream('c1', '问题', {
      onToken: function (value) { tokens.push(value); },
      onDone: function (value) { done = value; },
    });

    expect(tokens).toEqual(['你好', '，世界']);
    expect(done).toEqual({ messageId: 'm1' });
  });

  it('flushes the final unterminated SSE event at EOF', async function () {
    localStorage.setItem('tt_token', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: token\ndata: {"content":"最后一个 token"}\n\n' +
      'event: done\ndata: {"messageId":"m1"}',
    ])));

    var tokens = [];
    var done;
    await createChatStream('c1', '问题', {
      onToken: function (value) { tokens.push(value); },
      onDone: function (value) { done = value; },
    });

    expect(tokens).toEqual(['最后一个 token']);
    expect(done).toEqual({ messageId: 'm1' });
  });

  it('forwards tool events and provider errors', async function () {
    localStorage.setItem('tt_token', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: tool_start\ndata: {"tool_name":"calculator"}\n\n',
      'event: tool_end\ndata: {"tool_name":"calculator","result":{"result":4}}\n\n',
      'event: error\ndata: {"message":"provider failed"}\n\n',
    ])));

    var started;
    var ended;
    var error;
    await createChatStream('c1', '问题', {
      onToolStart: function (value) { started = value; },
      onToolEnd: function (value) { ended = value; },
      onError: function (value) { error = value; },
    });

    expect(started.tool_name).toBe('calculator');
    expect(ended.result.result).toBe(4);
    expect(error.message).toBe('provider failed');
  });

  it('handles CRLF, optional field spaces, multiline data, and UTF-8 byte fragmentation', async function () {
    localStorage.setItem('tt_token', 'test-token');
    var lifecycle = { cancelled: false };
    var payload = 'event:token\r\ndata: {"content":"你好"}\r\n\r\n' +
      'event: done\r\ndata: {\r\n' +
      'data: "messageId":"m2"\r\n' +
      'data: }';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fragmentedSseResponse(payload, 1, lifecycle)));

    var tokens = [];
    var done;
    await createChatStream('c1', '问题', {
      onToken: function (value) { tokens.push(value); },
      onDone: function (value) { done = value; },
    });

    expect(tokens).toEqual(['你好']);
    expect(done).toEqual({ messageId: 'm2' });
  });

  it('stops reading after the terminal event', async function () {
    localStorage.setItem('tt_token', 'test-token');
    var lifecycle = { cancelled: false };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: done\ndata: {}\n\n',
      'event: token\ndata: {"content":"must not be delivered"}\n\n',
    ], 200, lifecycle)));

    var tokens = [];
    await createChatStream('c1', '问题', { onToken: function (value) { tokens.push(value); } });

    expect(tokens).toEqual([]);
    expect(lifecycle.cancelled).toBe(true);
  });

  it('rejects an interrupted stream without done or error', async function () {
    localStorage.setItem('tt_token', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: token\ndata: {"content":"partial"}\n\n',
    ])));

    await expect(createChatStream('c1', '问题', {})).rejects.toThrow('interrupted');
  });

  it('does not swallow callback exceptions as malformed JSON', async function () {
    localStorage.setItem('tt_token', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: token\ndata: not-json\n\n',
      'event: token\ndata: {"content":"ok"}\n\n',
      'event: done\ndata: {}\n\n',
    ])));

    await expect(createChatStream('c1', '问题', {
      onToken: function () { throw new Error('callback failed'); },
    })).rejects.toThrow('callback failed');
  });

  it('resolves after a terminal error and invokes onError', async function () {
    localStorage.setItem('tt_token', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      'event: error\ndata: {"message":"provider failed"}\n\n',
      'event: token\ndata: {"content":"must not be delivered"}\n\n',
    ])));

    var error;
    await expect(createChatStream('c1', '问题', {
      onError: function (value) { error = value; },
    })).resolves.toBeUndefined();
    expect(error).toEqual({ message: 'provider failed' });
  });

  it('rejects when the network request fails', async function () {
    localStorage.setItem('tt_token', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(createChatStream('c1', '问题', {})).rejects.toThrow('network down');
  });
});
