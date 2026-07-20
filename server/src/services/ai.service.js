/* ============================================================
   ThreadThink Server — AI Service (streaming proxy + tool loop)
   ============================================================ */

import { getDb } from '../db/connection.js';
import { decrypt } from './crypto.service.js';
import { getToolDefinitions, executeTool, setToolUserId } from './tools/index.js';

var MAX_TOOL_ROUNDS = 5;

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

  // Set userId for doc_search tool context
  setToolUserId(userId);

  try {
    // 1. Get user config (decrypted API key)
    var user = db.prepare('SELECT api_key, api_base, model FROM users WHERE id = ?').get(userId);
    if (!user) { onError({ message: '用户不存在' }); return; }

    var apiKey = decrypt(user.api_key);
    if (!apiKey) { onError({ message: '请先在设置中配置 API Key' }); return; }
    var apiBase = user.api_base || 'https://api.deepseek.com/v1/chat/completions';
    var model = user.model || 'deepseek-chat';

    var settings = db.prepare('SELECT system_prompt FROM user_settings WHERE user_id = ?').get(userId);
    var systemPrompt = settings ? settings.system_prompt : '你是一个有帮助的AI助手，请用中文回答用户的问题。';

    // 2. Build messages array from history
    var messages = [];

    // System prompt
    messages.push({ role: 'system', content: systemPrompt });

    // History messages for this conversation
    var history = db.prepare(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId);

    for (var i = 0; i < history.length; i++) {
      messages.push({ role: history[i].role, content: history[i].content });
    }

    // 3. Save user message
    var userMsgId = crypto_randomUUID();
    db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
      userMsgId, conversationId, 'user', ctx.message
    );
    messages.push({ role: 'user', content: ctx.message });

    // Update conversation updated_at
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId);

    // 4. Tool execution loop — non-streaming calls until AI decides to respond with text
    var toolRounds = 0;
    var isAnthropic = apiBase.indexOf('anthropic.com') !== -1;

    while (toolRounds < MAX_TOOL_ROUNDS) {
      var aiResponse = await callAISync(messages, apiBase, apiKey, model, systemPrompt, isAnthropic, true);

      var choice = (aiResponse.choices && aiResponse.choices[0]) || {};
      var finishReason = choice.finish_reason;

      // Check for tool calls
      if (finishReason === 'tool_calls' && choice.message && choice.message.tool_calls) {
        toolRounds++;

        // Add assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: choice.message.content || '',
          tool_calls: choice.message.tool_calls,
        });

        // Execute each tool
        for (var t = 0; t < choice.message.tool_calls.length; t++) {
          var tc = choice.message.tool_calls[t];
          var toolName = tc.function.name;
          var toolArgs = JSON.parse(tc.function.arguments || '{}');

          onToolStart({ tool_name: toolName, arguments: toolArgs });

          var toolResult = await executeTool(toolName, toolArgs);
          onToolEnd({ tool_name: toolName, result: toolResult });

          // Add tool result to messages
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult),
          });
        }

        continue; // Loop back to let AI process tool results
      }

      // Normal text response — extract content and break
      var content = (choice.message && choice.message.content) || '';

      // Save assistant message
      var assistantMsgId = crypto_randomUUID();
      db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
        assistantMsgId, conversationId, 'assistant', content
      );

      // 5. Stream the final text to frontend
      await streamTextResponse(messages, apiBase, apiKey, model, systemPrompt, isAnthropic, onToken);

      onDone({ messageId: assistantMsgId });

      // Auto-title: set conversation title from first exchange
      var msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(conversationId);
      if (msgCount && msgCount.c === 2) {
        var title = ctx.message.slice(0, 40) + (ctx.message.length > 40 ? '...' : '');
        db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conversationId);
      }

      return;
    }

    // Exceeded max tool rounds — force final response
    messages.push({ role: 'system', content: '你已经调用了太多次工具。请基于现有信息直接回答用户的问题。' });
    var finalResp = await callAISync(messages, apiBase, apiKey, model, systemPrompt, isAnthropic, false);
    var finalContent = (finalResp.choices && finalResp.choices[0] && finalResp.choices[0].message && finalResp.choices[0].message.content) || '抱歉，处理超时。';
    var finalMsgId = crypto_randomUUID();
    db.prepare('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)').run(
      finalMsgId, conversationId, 'assistant', finalContent
    );
    onToken(finalContent);
    onDone({ messageId: finalMsgId });

  } catch (e) {
    onError({ message: e.message || '未知错误' });
  }
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Non-streaming AI call (for tool execution rounds).
 * Returns parsed JSON response.
 */
async function callAISync(messages, apiBase, apiKey, model, systemPrompt, isAnthropic, withTools) {
  var body;
  if (isAnthropic) {
    body = {
      model: model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: convertForAnthropic(messages),
      stream: false,
    };
    if (withTools) {
      body.tools = getToolDefinitions().map(function (d) {
        return { name: d.function.name, description: d.function.description, input_schema: d.function.parameters };
      });
    }
  } else {
    body = {
      model: model,
      max_tokens: 4096,
      messages: messages,
      stream: false,
    };
    if (withTools) {
      body.tools = getToolDefinitions();
      body.tool_choice = 'auto';
    }
  }

  var headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = 'Bearer ' + apiKey;
  }

  var resp = await fetch(apiBase, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    var text = await resp.text();
    throw new Error('AI API ' + resp.status + ': ' + text.slice(0, 300));
  }
  return await resp.json();
}

/**
 * Stream only the final text response to the frontend.
 * Uses SSE internally from the AI provider, forwards tokens via onToken.
 */
async function streamTextResponse(messages, apiBase, apiKey, model, systemPrompt, isAnthropic, onToken) {
  var body;
  if (isAnthropic) {
    body = {
      model: model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: convertForAnthropic(messages),
      stream: true,
    };
  } else {
    body = {
      model: model,
      max_tokens: 4096,
      messages: messages,
      stream: true,
    };
  }

  var headers = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = 'Bearer ' + apiKey;
  }

  var resp = await fetch(apiBase, { method: 'POST', headers: headers, body: JSON.stringify(body) });
  if (!resp.ok) {
    var text = await resp.text();
    throw new Error('AI API ' + resp.status + ': ' + text.slice(0, 300));
  }

  var reader = resp.body.getReader();
  var decoder = new TextDecoder();
  var buffer = '';

  while (true) {
    var v = await reader.read();
    if (v.done) break;
    buffer += decoder.decode(v.value, { stream: true });
    var lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (!ln || ln.indexOf('data: ') !== 0) continue;
      var d = ln.slice(6);
      if (d === '[DONE]') continue;
      try {
        var json = JSON.parse(d);
        var chunk = '';
        if (isAnthropic) {
          if (json.type === 'content_block_delta' && json.delta && json.delta.text) chunk = json.delta.text;
        } else {
          var delta = json.choices && json.choices[0] && json.choices[0].delta;
          if (delta && delta.content) chunk = delta.content;
        }
        if (chunk) onToken(chunk);
      } catch (e) {}
    }
  }
}

/**
 * Convert OpenAI-format messages to Anthropic format.
 * Anthropic doesn't support 'system' or 'tool' roles in messages array.
 */
function convertForAnthropic(messages) {
  var result = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.role === 'system') continue; // system prompt is separate
    if (m.role === 'tool') {
      result.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] });
    } else if (m.tool_calls) {
      var contentBlocks = [];
      if (m.content) contentBlocks.push({ type: 'text', text: m.content });
      for (var j = 0; j < m.tool_calls.length; j++) {
        contentBlocks.push({
          type: 'tool_use',
          id: m.tool_calls[j].id,
          name: m.tool_calls[j].function.name,
          input: JSON.parse(m.tool_calls[j].function.arguments || '{}'),
        });
      }
      result.push({ role: 'assistant', content: contentBlocks });
    } else {
      result.push({ role: m.role, content: m.content });
    }
  }
  return result;
}

// Node-compatible crypto.randomUUID (polyfill for older Node versions)
function crypto_randomUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
