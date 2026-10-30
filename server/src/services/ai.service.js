/* HTTP/database host for the shared headless orchestrator. */
import { getDb } from '../db/connection.js';
import { decrypt } from './crypto.service.js';
import { defaultToolRegistry } from './tools/index.js';
import { searchDocuments } from './document.service.js';
import { recordMessage, appendEvent, replayConversation } from './events.service.js';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../../../core/orchestrator.js';
import { createProviderRegistry, isAnthropicApi } from '../../../core/providers.js';
import { assembleContext } from '../../../core/context.js';

var PRE_STEP_HOOKS = [];
export function addPreStepHook(fn) {
  if (typeof fn !== 'function') throw new TypeError('Hook 必须是函数');
  PRE_STEP_HOOKS.push(fn);
  return function () { var index = PRE_STEP_HOOKS.indexOf(fn); if (index !== -1) PRE_STEP_HOOKS.splice(index, 1); };
}
export function clearPreStepHooks() { PRE_STEP_HOOKS.length = 0; }

function logDecision(db, conversationId, traceId, seqRef, kind, detail) {
  // Compatibility projection only. The authoritative appendEvent must succeed.
  try {
    db.prepare('INSERT INTO agent_logs (id, conversation_id, trace_id, seq, kind, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), conversationId, traceId, seqRef.value++, kind, JSON.stringify(detail));
  } catch { /* legacy deployments may omit this projection */ }
}

async function ragContext(userId, query) {
  try {
    var hasDocs = getDb().prepare('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?').get(userId);
    if (!hasDocs?.n) return [];
    var results = await searchDocuments(userId, query);
    return Array.isArray(results) ? results.slice(0, 3).map(item => ({ filename: item.filename, section: item.section_path, content: String(item.content || '').slice(0, 500) })) : [];
  } catch { return []; }
}

/** Existing callback signature retained for both chat and annotation routes. */
export async function streamChat(ctx, onToken, onToolStart, onToolEnd, onDone, onError) {
  var db = getDb();
  var userId = ctx.userId;
  var conversationId = ctx.conversationId;
  var kind = ctx.kind || 'chat';
  var traceId = randomUUID();
  try {
    var conversation = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(conversationId, userId);
    if (!conversation) throw new Error('对话不存在');
    if (!['chat', 'annotation'].includes(kind)) throw new Error('无效消息类型');
    if (kind === 'annotation') {
      var annotation = db.prepare('SELECT a.id FROM annotations a JOIN messages m ON m.id = a.message_id WHERE a.id = ? AND m.conversation_id = ?').get(ctx.annotationId, conversationId);
      if (!annotation) throw new Error('批注不存在');
    }
    var user = db.prepare('SELECT api_key, api_base, model FROM users WHERE id = ?').get(userId);
    if (!user) throw new Error('用户不存在');
    var apiKey = decrypt(user.api_key);
    if (!apiKey && !ctx.provider) throw new Error('请先在设置中配置 API Key');
    var apiBase = user.api_base || 'https://api.deepseek.com/v1/chat/completions';
    var provider = ctx.provider || createProviderRegistry().resolve(isAnthropicApi(apiBase) ? 'anthropic' : 'openai-compatible', { apiKey, apiBase, model: user.model || 'deepseek-chat' });
    var settings = db.prepare('SELECT system_prompt FROM user_settings WHERE user_id = ?').get(userId);
    var history = replayConversation(userId, conversationId).messages.filter(message => (message.kind || 'chat') === 'chat').map(({ role, content }) => ({ role, content }));
    var assembled = ctx.contextMessages
      ? { messages: structuredClone(ctx.contextMessages), sections: ctx.contextSections || [] }
      : await assembleContext({ persona: settings?.system_prompt || '你是一个有帮助的AI助手，请用中文回答用户的问题。', history, rag: await ragContext(userId, ctx.message) }, { budgets: ctx.contextBudgets });
    var messages = [...assembled.messages, { role: 'user', content: ctx.message }];
    var userMessage = recordMessage(userId, conversationId, { role: 'user', content: ctx.message, kind, annotation_id: ctx.annotationId }, { traceId });
    appendEvent(userId, conversationId, 'context_sections', { sections: assembled.sections }, { traceId });
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId);
    var logSeq = { value: 0 };
    var result = await runAgent({
      messages, provider, tools: ctx.tools || defaultToolRegistry, hooks: PRE_STEP_HOOKS,
      signal: ctx.signal, traceId, maxToolRounds: ctx.maxToolRounds,
      context: { userId, conversationId, kind, annotationId: ctx.annotationId },
      onToken, onToolStart, onToolEnd,
      onEvent: async event => {
        appendEvent(userId, conversationId, event.type, event.payload, { traceId });
        if (['request', 'tool_call', 'tool_result', 'retry', 'done'].includes(event.type)) logDecision(db, conversationId, traceId, logSeq, event.type, event.payload);
        await ctx.onEvent?.(event);
      },
    });
    if (['blocked', 'aborted'].includes(result.termination.reason)) throw new Error(result.termination.reason === 'blocked' ? '请求已被 pre-step hook 拦截' : '请求已取消');
    var assistant;
    db.transaction(function () {
      assistant = recordMessage(userId, conversationId, { role: 'assistant', content: result.content, kind, annotation_id: ctx.annotationId }, { traceId });
      persistToolCalls(db, assistant.id, result.toolCalls);
      if (kind === 'chat') {
        var count = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND kind = 'chat'").get(conversationId);
        if (count?.c === 2) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(ctx.message.slice(0, 40) + (ctx.message.length > 40 ? '...' : ''), conversationId);
      } else {
        db.prepare('UPDATE annotations SET answer = ? WHERE id = ?').run(result.content, ctx.annotationId);
        var updated = db.prepare('SELECT * FROM annotations WHERE id = ?').get(ctx.annotationId);
        appendEvent(userId, conversationId, 'annotation_updated', { annotation: updated }, { traceId });
      }
    })();
    onDone({ messageId: assistant.id, userMessageId: userMessage.id, messageSeq: assistant.seq, userMessageSeq: userMessage.seq, traceId, termination: result.termination, usage: result.usage });
  } catch (error) { onError({ message: error.message || '未知错误', traceId }); }
}

function persistToolCalls(db, messageId, calls) {
  var insert = db.prepare('INSERT INTO tool_calls (id, message_id, tool_name, arguments, result, status) VALUES (?, ?, ?, ?, ?, ?)');
  for (var call of calls) insert.run(randomUUID(), messageId, call.tool_name, JSON.stringify(call.arguments), JSON.stringify(call.result ?? null), call.status);
}
