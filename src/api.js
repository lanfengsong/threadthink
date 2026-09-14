/* ============================================================
   ThreadThink — API Client (backend proxy)
   ============================================================ */

import { getToken, logout } from './auth.js';

var BASE = '/api';

function authHeaders() {
  var token = getToken();
  return token ? { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

function handleAuthError(resp) {
  if (resp.status === 401) { logout(); window.location.reload(); }
}

export async function fetchConversations() {
  var resp = await fetch(BASE + '/conversations', { headers: authHeaders() });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('获取对话列表失败');
  return (await resp.json()).conversations;
}

export async function createConversation(title) {
  var resp = await fetch(BASE + '/conversations', {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ title: title || '新对话' }),
  });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('创建对话失败');
  return (await resp.json()).conversation;
}

export async function deleteConversation(id) {
  var resp = await fetch(BASE + '/conversations/' + id, { method: 'DELETE', headers: authHeaders() });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('删除失败');
}

export async function fetchMessages(conversationId) {
  var resp = await fetch(BASE + '/conversations/' + conversationId + '/messages', { headers: authHeaders() });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('获取消息失败');
  return (await resp.json()).messages;
}

export async function fetchSettings() {
  var resp = await fetch(BASE + '/settings', { headers: authHeaders() });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('获取设置失败');
  return await resp.json();
}

export async function updateSettings(data) {
  var resp = await fetch(BASE + '/settings', {
    method: 'PUT', headers: authHeaders(), body: JSON.stringify(data),
  });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('保存设置失败');
  return await resp.json();
}

/**
 * Stream a chat completion from the backend.
 *
 * The returned promise resolves only after a valid terminal `done` or `error`
 * event has been received. It rejects for HTTP/network failures, callback
 * exceptions, or a body that reaches EOF without a terminal event. A protocol
 * `error` still uses `callbacks.onError` and resolves after that callback; it
 * is not a transport rejection.
 */
export function createChatStream(conversationId, message, callbacks) {
  callbacks = callbacks || {};
  return (async function () {
    var token = getToken();
    if (!token) throw new Error('未登录');

    var resp = await fetch(BASE + '/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ conversationId: conversationId, message: message }),
    });
    if (resp.status === 401) {
      logout();
      window.location.reload();
      throw new Error('未登录');
    }
    if (!resp.ok) {
      var errorData;
      try { errorData = await resp.json(); } catch (e) { errorData = {}; }
      throw new Error(errorData.error || '请求失败');
    }
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      throw new Error('响应不支持流式读取');
    }

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var terminal = false;

    async function cleanup() {
      try { await reader.cancel(); } catch (e) { /* already closed */ }
      try { reader.releaseLock(); } catch (e) { /* already released */ }
    }

    function nextBlock() {
      // Keep the incomplete delimiter in the buffer so CRLF split across
      // byte chunks is handled on the next read.
      var match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
      if (!match) return null;
      var block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      return block;
    }

    function processBlock(block) {
      block = block.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      var lines = block.split('\n');
      var event = 'message';
      var data = '';
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        var colon = line.indexOf(':');
        if (colon === -1) continue;
        var field = line.slice(0, colon);
        var value = line.slice(colon + 1);
        if (value.charAt(0) === ' ') value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data += (data ? '\n' : '') + value;
      }
      if (!data) return;

      var parsed;
      try { parsed = JSON.parse(data); } catch (e) { return; }

      if (event === 'token' && callbacks.onToken) callbacks.onToken(parsed.content);
      else if (event === 'tool_start' && callbacks.onToolStart) callbacks.onToolStart(parsed);
      else if (event === 'tool_end' && callbacks.onToolEnd) callbacks.onToolEnd(parsed);
      else if (event === 'done') {
        terminal = true;
        if (callbacks.onDone) callbacks.onDone(parsed);
      } else if (event === 'error') {
        terminal = true;
        if (callbacks.onError) callbacks.onError(parsed);
      }
    }

    try {
      while (!terminal) {
        var value = await reader.read();
        if (value.done) {
          buffer += decoder.decode();
          if (buffer) processBlock(buffer);
          if (!terminal) throw new Error('SSE stream interrupted before terminal event');
          break;
        }

        buffer += decoder.decode(value.value, { stream: true });
        var block;
        while (!terminal && (block = nextBlock()) !== null) processBlock(block);
      }
    } finally {
      await cleanup();
    }
  })();
}
