/* ============================================================
   ThreadThink Server — AI Service (streaming proxy + tool loop)
   ============================================================ */

import { getDb } from '../db/connection.js';
import { decrypt } from './crypto.service.js';
import { getToolDefinitions, executeTool, renderToolResult } from './tools/index.js';
import { searchDocuments } from './document.service.js';
import { randomUUID } from 'crypto';

var MAX_TOOL_ROUNDS = 5;
var MAX_CONSECUTIVE_FAILURES = 2; // 同一工具连续失败达此数 → 注入放弃指令（反思自愈上限）
var RAG_TOP_K = 3;                // 注入的文档片段上限
var RAG_MAX_CHARS = 1500;         // 注入总字符上限（按 K 平分）
var PRE_STEP_HOOKS = [];          // 请求前钩子链（design 3.2）：可改写消息/拦截；默认空

/** 注册请求前钩子（供 RAG 注入、敏感过滤等横切逻辑挂载）。 */
export function addPreStepHook(fn) { PRE_STEP_HOOKS.push(fn); }
/** 测试用：清空钩子。 */
export function clearPreStepHooks() { PRE_STEP_HOOKS.length = 0; }

/** 决策日志（design 3.2/3.3）：追加式、不阻塞主流程（失败仅放弃记录）。 */
function logDecision(db, conversationId, traceId, seqRef, kind, detail) {
  try {
    db.prepare('INSERT INTO agent_logs (id, conversation_id, trace_id, seq, kind, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), conversationId, traceId, seqRef.value++, kind, detail === undefined ? null : JSON.stringify(detail));
  } catch (e) { /* 日志失败不影响主流程 */ }
}

/**
 * RAG 上下文注入（design 3.5 上下文分节——【相关资料】节）：
 * 每轮对话只注入一次（首个请求前）；检索失败/无文档静默降级，
 * 绝不因检索问题阻断对话。返回是否注入了内容。
 */
async function injectRagContext(messages, userId, query) {
  try {
    var db = getDb();
    var hasDocs = db.prepare('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?').get(userId);
    if (!hasDocs || hasDocs.n === 0) return false;
    var results = await searchDocuments(userId, query);
    if (!Array.isArray(results) || results.length === 0) return false;
    var perChunk = Math.floor(RAG_MAX_CHARS / RAG_TOP_K);
    var lines = ['【相关资料】以下是用户知识库中与当前问题相关的片段（供参考，未命中请忽略）：', ''];
    for (var i = 0; i < Math.min(results.length, RAG_TOP_K); i++) {
      var r = results[i];
      var header = r.filename + (r.section_path ? '｜' + r.section_path : '');
      lines.push('· [' + header + '] ' + String(r.content || '').slice(0, perChunk));
    }
    messages.push({ role: 'system', content: lines.join('\n') });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Stream a chat completion. Handles tool calling internally.
 *
 * @param {Object} ctx - { userId, conversationId, message }
 * @param {Function} onToken - (text: string) called for each token chunk
 * @param {Function} onToolStart - ({ tool_name, arguments }) called when tool execution begins
 * @param {Function} onToolEnd - ({ tool_name, result }) called when tool execution completes
 * @param {Function} onDone - ({ messageId }) called when streaming is complete
 * @param {Function} onError - ({ message }) called on error
 */
export async function streamChat(ctx, onToken, onToolStart, onToolEnd, onDone, onError) {
  var db = getDb();
  var userId = ctx.userId;
  var conversationId = ctx.conversationId;

  try {
    // Validate ownership here as well as in the route: this service must not
    // read history for a conversation that belongs to another user.
    var conversation = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
    if (!conversation) { onError({ message: '对话不存在' }); return; }

    var user = db.prepare('SELECT api_key, api_base, model FROM users WHERE id = ?').get(userId);
    if (!user) { onError({ message: '用户不存在' }); return; }

    var apiKey = decrypt(user.api_key);
    if (!apiKey) { onError({ message: '请先在设置中配置 API Key' }); return; }
    var apiBase = user.api_base || 'https://api.deepseek.com/v1/chat/completions';
    var model = user.model || 'deepseek-chat';

    var settings = db.prepare('SELECT system_prompt FROM user_settings WHERE user_id = ?').get(userId);
    var systemPrompt = settings ? settings.system_prompt : '你是一个有帮助的AI助手，请用中文回答用户的问题。';

    var messages = [{ role: 'system', content: systemPrompt }];
    var history = db.prepare(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId);
    for (var i = 0; i < history.length; i++) {
      messages.push({ role: history[i].role, content: history[i].content });
    }

    var userMsgId = randomUUID();
    db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
      userMsgId, conversationId, 'user', ctx.message
    );
    messages.push({ role: 'user', content: ctx.message });
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId);

    // RAG 上下文注入（design 3.5）：每轮一次，检索失败静默降级
    await injectRagContext(messages, userId, ctx.message);

    var toolRounds = 0;
    var toolAudit = [];
    var isAnthropic = isAnthropicApi(apiBase);
    var consecutiveFailures = 0; // 反思自愈：连续失败计数
    var traceId = randomUUID();
    var logSeq = { value: 0 };
    logDecision(db, conversationId, traceId, logSeq, 'request', { message: ctx.message });
    var startedAt = Date.now();

    while (toolRounds < MAX_TOOL_ROUNDS) {
      // pre-step 钩子链（design 3.2）：请求发出前可改写消息/拦截
      var stepState = { messages: messages, allowed: true };
      for (var h = 0; h < PRE_STEP_HOOKS.length; h++) {
        try { stepState = (await PRE_STEP_HOOKS[h](stepState, { userId: userId, conversationId: conversationId, traceId: traceId })) || stepState; }
        catch (e) { /* 钩子异常不阻断主流程 */ }
      }
      if (!stepState.allowed) { messages = stepState.messages; }
      else { messages = stepState.messages || messages; }

      var aiResponse = await callAISync(messages, apiBase, apiKey, model, systemPrompt, isAnthropic, true);
      var choice = normalizeAiResponse(aiResponse, isAnthropic);

      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls.length > 0) {
        toolRounds++;
        messages.push({
          role: 'assistant',
          content: choice.message.content || '',
          tool_calls: choice.message.tool_calls,
        });

        for (var t = 0; t < choice.message.tool_calls.length; t++) {
          var tc = choice.message.tool_calls[t];
          var toolName = tc.function.name;
          var toolArgs;
          var toolResult;
          try {
            toolArgs = JSON.parse(tc.function.arguments || '{}');
            if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) throw new Error('工具参数必须是对象');
          } catch (e) {
            toolArgs = {};
            toolResult = { error: '工具参数无效: ' + e.message };
          }

          logDecision(db, conversationId, traceId, logSeq, 'tool_call', { round: toolRounds, tool: toolName, arguments: toolArgs });
          onToolStart({ tool_name: toolName, arguments: toolArgs });
          if (toolResult === undefined) toolResult = await executeTool(toolName, toolArgs, { userId: userId });
          var toolFailed = !!(toolResult && toolResult.error);
          logDecision(db, conversationId, traceId, logSeq, 'tool_result', { tool: toolName, status: toolFailed ? 'error' : 'done', preview: JSON.stringify(toolResult).slice(0, 200) });
          toolAudit.push({
            tool_name: toolName,
            arguments: toolArgs,
            result: toolResult,
            status: toolFailed ? 'error' : 'done',
          });
          onToolEnd({ tool_name: toolName, result: toolResult });
          // 输出契约（design 3.3）：模型看到的是 render 后的内容（默认 JSON.stringify）
          messages.push({ role: 'tool', tool_call_id: tc.id, content: renderToolResult(toolName, toolArgs, toolResult) });

          // 反思自愈（design 3.2）：显式失败反馈，注入修正/放弃指令
          if (toolFailed) {
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              logDecision(db, conversationId, traceId, logSeq, 'retry', { tool: toolName, attempts: consecutiveFailures, action: 'give_up' });
              messages.push({ role: 'system', content: '工具「' + toolName + '」连续失败，请停止调用该工具，基于现有信息直接回答用户的问题。' });
            } else {
              logDecision(db, conversationId, traceId, logSeq, 'retry', { tool: toolName, attempts: consecutiveFailures, action: 'revise' });
              messages.push({ role: 'system', content: '上一次工具「' + toolName + '」调用失败：' + String(toolResult.error).slice(0, 200) + '。请修正参数或换其他方式，不要重复相同的失败操作。' });
            }
          } else {
            consecutiveFailures = 0;
          }
        }
        continue;
      }

      var streamedContent = '';
      await streamTextResponse(messages, apiBase, apiKey, model, systemPrompt, isAnthropic, function (token) {
        streamedContent += token;
        onToken(token);
      });
      var assistantMsgId = randomUUID();
      persistAssistantAndAudit(db, conversationId, assistantMsgId, streamedContent, toolAudit, ctx.message);
      logDecision(db, conversationId, traceId, logSeq, 'done', { rounds: toolRounds, durationMs: Date.now() - startedAt, chars: streamedContent.length });
      onDone({ messageId: assistantMsgId });
      return;
    }

    messages.push({ role: 'system', content: '你已经调用了太多次工具。请基于现有信息直接回答用户的问题。' });
    var finalResp = await callAISync(messages, apiBase, apiKey, model, systemPrompt, isAnthropic, false);
    var finalChoice = normalizeAiResponse(finalResp, isAnthropic);
    var finalContent = finalChoice.message.content;
    if (!finalContent) throw new Error('AI API 返回了无效的最终响应');
    var finalMsgId = randomUUID();
    persistAssistantAndAudit(db, conversationId, finalMsgId, finalContent, toolAudit, ctx.message);
    logDecision(db, conversationId, traceId, logSeq, 'done', { rounds: toolRounds, durationMs: Date.now() - startedAt, chars: finalContent.length });
    onToken(finalContent);
    onDone({ messageId: finalMsgId });
  } catch (e) {
    onError({ message: e.message || '未知错误' });
  }
}

function persistAssistantAndAudit(db, conversationId, messageId, content, calls, userMessage) {
  var tx = db.transaction(function () {
    db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
      messageId, conversationId, 'assistant', content
    );
    persistToolCalls(db, messageId, calls);
    var msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(conversationId);
    if (msgCount && msgCount.c === 2) {
      var title = userMessage.slice(0, 40) + (userMessage.length > 40 ? '...' : '');
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversationId);
    }
  });
  tx();
}

function persistToolCalls(db, messageId, calls) {
  if (!calls || calls.length === 0) return;
  var insert = db.prepare(
    'INSERT INTO tool_calls (id, message_id, tool_name, arguments, result, status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (var i = 0; i < calls.length; i++) {
    var call = calls[i];
    insert.run(
      randomUUID(), messageId, call.tool_name,
      JSON.stringify(call.arguments || {}),
      JSON.stringify(call.result === undefined ? null : call.result),
      call.status || 'done'
    );
  }
}

function isAnthropicApi(apiBase) {
  try { return new URL(apiBase).hostname === 'api.anthropic.com'; } catch (e) { return false; }
}

function normalizeAiResponse(response, isAnthropic) {
  if (!response || typeof response !== 'object') throw new Error('AI API 返回了无效响应');
  if (!isAnthropic) {
    if (!Array.isArray(response.choices) || !response.choices[0] || typeof response.choices[0] !== 'object') {
      throw new Error('AI API 返回了无效响应');
    }
    var openChoice = response.choices[0];
    if (!openChoice.message || typeof openChoice.message !== 'object') throw new Error('AI API 返回了无效响应');
    var openToolCalls = openChoice.message.tool_calls === undefined ? [] : openChoice.message.tool_calls;
    if (!Array.isArray(openToolCalls)) throw new Error('AI API 返回了无效响应');
    if (!openChoice.finish_reason) throw new Error('AI API 返回了无效响应');
    openChoice.message.tool_calls = openToolCalls;
    return openChoice;
  }

  if (!Array.isArray(response.content) || response.content.length === 0) throw new Error('AI API 返回了无效响应');
  var blocks = response.content;
  var toolCalls = blocks.filter(function (block) { return block && block.type === 'tool_use'; }).map(function (block) {
    if (!block.id || !block.name) throw new Error('AI API 返回了无效工具调用');
    return { id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input === undefined ? {} : block.input) } };
  });
  var text = blocks.filter(function (block) { return block && block.type === 'text'; }).map(function (block) {
    return typeof block.text === 'string' ? block.text : '';
  }).join('');
  var finishReason = response.stop_reason;
  if (finishReason === 'tool_use' || toolCalls.length > 0) finishReason = 'tool_calls';
  if (!finishReason) throw new Error('AI API 返回了无效响应');
  return { finish_reason: finishReason, message: { content: text, tool_calls: toolCalls } };
}

async function callAISync(messages, apiBase, apiKey, model, systemPrompt, isAnthropic, withTools) {
  var body;
  if (isAnthropic) {
    body = { model: model, max_tokens: 4096, system: getAnthropicSystemPrompt(messages, systemPrompt), messages: convertForAnthropic(messages), stream: false };
    if (withTools) body.tools = getToolDefinitions().map(function (d) {
      return { name: d.function.name, description: d.function.description, input_schema: d.function.parameters };
    });
  } else {
    body = { model: model, max_tokens: 4096, messages: messages, stream: false };
    if (withTools) { body.tools = getToolDefinitions(); body.tool_choice = 'auto'; }
  }
  var headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else headers['Authorization'] = 'Bearer ' + apiKey;
  var resp = await fetch(apiBase, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    var errorText = await resp.text();
    throw new Error('AI API ' + resp.status + ': ' + errorText.slice(0, 300));
  }
  return await resp.json();
}

async function streamTextResponse(messages, apiBase, apiKey, model, systemPrompt, isAnthropic, onToken) {
  var body;
  if (isAnthropic) body = { model: model, max_tokens: 4096, system: getAnthropicSystemPrompt(messages, systemPrompt), messages: convertForAnthropic(messages), stream: true };
  else body = { model: model, max_tokens: 4096, messages: messages, stream: true };
  var headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) { headers['x-api-key'] = apiKey; headers['anthropic-version'] = '2023-06-01'; }
  else headers['Authorization'] = 'Bearer ' + apiKey;

  var resp = await fetch(apiBase, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    var errorText = await resp.text();
    throw new Error('AI API ' + resp.status + ': ' + errorText.slice(0, 300));
  }
  if (!resp.body || typeof resp.body.getReader !== 'function') throw new Error('AI API 返回了无效流');

  var reader = resp.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';
  var eventData = [];
  var sawTerminal = false;

  function processEvent() {
    if (eventData.length === 0) return;
    var data = eventData.join('\n');
    eventData = [];
    if (data === '[DONE]') { sawTerminal = true; return; }
    var json;
    try { json = JSON.parse(data); } catch (e) { throw new Error('AI 流返回了无效事件'); }
    if (json.error || json.type === 'error') {
      var providerError = json.error && (json.error.message || json.error.type) || json.message || 'AI provider error';
      throw new Error('AI API 流错误: ' + providerError);
    }
    if (isAnthropic && json.type === 'message_stop') { sawTerminal = true; return; }
    var chunk = '';
    if (isAnthropic) {
      if (json.type === 'content_block_delta' && json.delta && typeof json.delta.text === 'string') chunk = json.delta.text;
    } else {
      var delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (delta && typeof delta.content === 'string') chunk = delta.content;
      if (json.choices && json.choices[0] && json.choices[0].finish_reason === 'error') throw new Error('AI API 流错误');
    }
    // Keep callback failures outside the JSON parse guard so they reach the
    // request handler instead of being silently mistaken for malformed data.
    if (chunk) onToken(chunk);
  }

  function processLine(line) {
    var normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (normalized === '') { processEvent(); return; }
    if (normalized.startsWith(':')) return;
    if (normalized.startsWith('data:')) {
      var value = normalized.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      eventData.push(value);
    }
  }

  try {
    while (true) {
      var value = await reader.read();
      if (value.done) {
        buffer += decoder.decode();
        if (buffer) { processLine(buffer); buffer = ''; }
        processEvent();
        break;
      }
      buffer += decoder.decode(value.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) processLine(lines[i]);
    }
    if (!sawTerminal) throw new Error('AI 流在终止事件前中断');
  } finally {
    try { await reader.cancel(); } finally { if (reader.releaseLock) reader.releaseLock(); }
  }
}

function getAnthropicSystemPrompt(messages, systemPrompt) {
  var systemMessages = messages.filter(function (message) { return message.role === 'system'; });
  if (systemMessages.length === 0) return systemPrompt;
  return systemMessages.map(function (message) { return message.content; }).join('\n');
}

function convertForAnthropic(messages) {
  var result = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      var last = result[result.length - 1];
      var block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every(function (b) { return b.type === 'tool_result'; })) last.content.push(block);
      else result.push({ role: 'user', content: [block] });
    } else if (m.tool_calls) {
      var contentBlocks = [];
      if (m.content) contentBlocks.push({ type: 'text', text: m.content });
      for (var j = 0; j < m.tool_calls.length; j++) {
        contentBlocks.push({
          type: 'tool_use', id: m.tool_calls[j].id, name: m.tool_calls[j].function.name,
          input: JSON.parse(m.tool_calls[j].function.arguments || '{}'),
        });
      }
      result.push({ role: 'assistant', content: contentBlocks });
    } else result.push({ role: m.role, content: m.content });
  }
  return result;
}
