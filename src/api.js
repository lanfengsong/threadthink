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

// ---- Conversations ----

export async function fetchConversations() {
  var resp = await fetch(BASE + '/conversations', { headers: authHeaders() });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('获取对话列表失败');
  return (await resp.json()).conversations;
}

export async function createConversation(title) {
  var resp = await fetch(BASE + '/conversations', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ title: title || '新对话' }),
  });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('创建对话失败');
  return (await resp.json()).conversation;
}

export async function deleteConversation(id) {
  var resp = await fetch(BASE + '/conversations/' + id, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('删除失败');
}

export async function fetchMessages(conversationId) {
  var resp = await fetch(BASE + '/conversations/' + conversationId + '/messages', { headers: authHeaders() });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('获取消息失败');
  return (await resp.json()).messages;
}

// ---- Settings ----

export async function fetchSettings() {
  var resp = await fetch(BASE + '/settings', { headers: authHeaders() });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('获取设置失败');
  return await resp.json();
}

export async function updateSettings(data) {
  var resp = await fetch(BASE + '/settings', {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(data),
  });
  handleAuthError(resp);
  if (!resp.ok) throw new Error('保存设置失败');
  return await resp.json();
}

// ---- Chat (SSE) ----

/**
 * Stream a chat completion from the backend.
 *
 * @param {string} conversationId
 * @param {string} message
 * @param {Object} callbacks - { onToken, onToolStart, onToolEnd, onDone, onError }
 * @returns {Promise} — resolves when stream ends
 */
export function createChatStream(conversationId, message, callbacks) {
  return new Promise(function (resolve, reject) {
    var token = getToken();
    if (!token) { reject(new Error('未登录')); return; }

    fetch(BASE + '/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ conversationId: conversationId, message: message }),
    }).then(function (resp) {
      if (resp.status === 401) { logout(); window.location.reload(); reject(new Error('未登录')); return; }
      if (!resp.ok) { resp.json().then(function (e) { reject(new Error(e.error)); }); return; }

      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function pump() {
        reader.read().then(function (v) {
          if (v.done) { resolve(); return; }
          buffer += decoder.decode(v.value, { stream: true });
          var parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (var i = 0; i < parts.length; i++) {
            var block = parts[i].trim();
            if (!block) continue;
            var lines = block.split('\n');
            var event = 'message';
            var data = '';
            for (var j = 0; j < lines.length; j++) {
              if (lines[j].startsWith('event: ')) event = lines[j].slice(7).trim();
              else if (lines[j].startsWith('data: ')) data = lines[j].slice(6);
            }
            if (!data) continue;
            try {
              var parsed = JSON.parse(data);
              if (event === 'token' && callbacks.onToken) callbacks.onToken(parsed.content);
              else if (event === 'tool_start' && callbacks.onToolStart) callbacks.onToolStart(parsed);
              else if (event === 'tool_end' && callbacks.onToolEnd) callbacks.onToolEnd(parsed);
              else if (event === 'done' && callbacks.onDone) callbacks.onDone(parsed);
              else if (event === 'error' && callbacks.onError) callbacks.onError(parsed);
            } catch (e) {}
          }
          pump();
        }).catch(reject);
      }
      pump();
    }).catch(reject);
  });
}
