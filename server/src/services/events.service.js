import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDb } from '../db/connection.js';
import { importLegacyConversation } from '../db/events.js';
import { runAgent } from '../../../core/orchestrator.js';

function fail(message, statusCode = 400) {
  var error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function ownedConversation(db, userId, conversationId) {
  if (!userId) fail('未登录', 401);
  var conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(conversationId, userId);
  if (!conversation) fail('对话不存在', 404);
  importLegacyConversation(db, conversation);
  return conversation;
}

function readEvents(db, userId, conversationId) {
  return db.prepare('SELECT * FROM events WHERE conversation_id = ? AND user_id = ? ORDER BY seq').all(conversationId, userId)
    .map(function (event) { return { ...event, payload: JSON.parse(event.payload) }; });
}

function validateSeq(events, seq) {
  if (!Number.isSafeInteger(seq) || seq < 0 || (seq !== 0 && !events.some(function (event) { return event.seq === seq; }))) {
    fail('seq 必须是当前对话中的事件流水号（或 0）');
  }
  return seq;
}

function insertEvent(db, userId, conversationId, type, payload, options = {}) {
  if (typeof type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(type)) fail('无效的事件类型');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('事件 payload 必须是对象');
  var json;
  try { json = JSON.stringify(payload); } catch { fail('事件 payload 必须可序列化'); }
  var traceId = options.traceId ?? options.trace_id ?? null;
  if (traceId !== null && (typeof traceId !== 'string' || !traceId || traceId.length > 200)) fail('无效的 traceId');
  var result = db.prepare(`INSERT INTO events (conversation_id, user_id, type, payload, trace_id, fork_from)
    VALUES (?, ?, ?, ?, ?, ?)`).run(conversationId, userId, type, json, traceId, options.forkFrom ?? null);
  return { ...db.prepare('SELECT * FROM events WHERE seq = ?').get(Number(result.lastInsertRowid)), payload: JSON.parse(json) };
}

export function appendEvent(userId, conversationId, type, payload, options = {}) {
  var db = getDb();
  ownedConversation(db, userId, conversationId);
  if (['fork', 'rollback', 'conversation_deleted'].includes(type)) fail('请使用专用回溯接口写入控制事件');
  return insertEvent(db, userId, conversationId, type, payload, options);
}

/** Atomic compatibility projection + canonical event write. */
export function recordMessage(userId, conversationId, data, options = {}) {
  var db = getDb();
  return db.transaction(function () {
    ownedConversation(db, userId, conversationId);
    if (!data || !['user', 'assistant', 'system'].includes(data.role) || typeof data.content !== 'string') fail('无效的消息');
    var kind = data.kind || 'chat';
    if (!['chat', 'annotation'].includes(kind)) fail('无效的消息 kind');
    var annotationId = data.annotation_id ?? data.annotationId ?? null;
    if (kind === 'annotation') {
      if (!annotationId || !replayConversation(userId, conversationId).annotations.some(function (annotation) { return annotation.id === annotationId; })) {
        fail('批注不存在', 404);
      }
    } else if (annotationId) fail('主线消息不能关联批注');
    var id = data.id || randomUUID();
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content, kind, annotation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, conversationId, data.role, data.content, kind, annotationId, data.created_at || new Date().toISOString());
    var message = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    var event = insertEvent(db, userId, conversationId, data.role === 'assistant' ? 'ai_message' : data.role === 'user' ? 'user_message' : 'message_created', message, options);
    return { ...message, seq: event.seq, trace_id: event.trace_id };
  })();
}

export function listEvents(userId, conversationId, options = {}) {
  var db = getDb();
  ownedConversation(db, userId, conversationId);
  var events = readEvents(db, userId, conversationId);
  var headSeq = events.at(-1)?.seq || 0;
  var upTo = options.upTo === undefined ? headSeq : validateSeq(events, options.upTo);
  var after = options.after === undefined ? 0 : validateSeq(events, options.after);
  return { events: events.filter(function (event) { return event.seq > after && event.seq <= upTo; }), headSeq };
}

function put(rows, row) {
  var index = rows.findIndex(function (item) { return item.id === row.id; });
  if (index < 0) rows.push(row);
  else rows[index] = { ...rows[index], ...row };
}

function emptyState() { return { messages: [], annotations: [], toolCalls: [], traceEvents: [] }; }

function toolCard(call) {
  var status = call.status || (call.type === 'tool_result' ? (call.result?.error ? 'error' : 'done') : 'running');
  return { ...call, name: call.tool || call.tool_name, status, done: status === 'done' || status === 'error' };
}

/** Associate only the already-replayed records; no mutable projections or future events. */
function attachToolCards(state) {
  var assistantByTrace = new Map();
  state.messages.forEach(function (message) {
    if (message.role === 'assistant' && message.trace_id) assistantByTrace.set(message.trace_id, message.id);
  });
  var toolsByMessage = new Map();
  state.toolCalls = state.toolCalls.map(function (call) {
    var messageId = call.message_id || assistantByTrace.get(call.trace_id) || null;
    var linked = { ...call, message_id: messageId };
    if (messageId) {
      if (!toolsByMessage.has(messageId)) toolsByMessage.set(messageId, []);
      toolsByMessage.get(messageId).push(toolCard(linked));
    }
    return linked;
  });
  var latestReply = new Map();
  state.messages = state.messages.map(function (message) {
    if (message.role !== 'assistant') return message;
    var linked = { ...message, tools: toolsByMessage.get(message.id) || message.tools || [] };
    if (message.kind === 'annotation' && message.annotation_id) {
      var previous = latestReply.get(message.annotation_id);
      if (!previous || message.seq >= previous.seq) latestReply.set(message.annotation_id, linked);
    }
    return linked;
  });
  state.annotations = state.annotations.map(function (annotation) {
    var reply = latestReply.get(annotation.id);
    if (!reply) return { ...annotation, tools: annotation.tools || [], trace_id: annotation.trace_id || null, reply_message_id: annotation.reply_message_id || null };
    return { ...annotation,
      // The assistant event may be the historical cutoff immediately before annotation_updated.
      answer: reply.seq >= annotation.seq ? reply.content : annotation.answer,
      tools: reply.tools, trace_id: reply.trace_id || null, reply_message_id: reply.id };
  });
  return state;
}

function derive(events) {
  var state = emptyState();
  var targets = new Set(events.filter(function (event) { return event.type === 'rollback'; }).map(function (event) { return event.payload.seq; }));
  var checkpoints = new Map([[0, emptyState()]]);
  events.forEach(function (event) {
    var payload = event.payload;
    if (event.type === 'rollback') {
      if (!checkpoints.has(payload.seq)) fail('回退事件引用了无效历史', 500);
      state = structuredClone(checkpoints.get(payload.seq));
    } else if (event.type === 'fork') {
      state = { ...emptyState(), ...structuredClone(payload.snapshot || {}) };
      state.messages = state.messages.map(function (message) { return { ...message, seq: event.seq }; });
      state.annotations = state.annotations.map(function (annotation) { return { ...annotation, seq: event.seq }; });
    } else if (['user_message', 'ai_message', 'message_created', 'message_updated'].includes(event.type)) {
      var message = payload.message || payload;
      if (message.id) put(state.messages, { ...message, conversation_id: event.conversation_id, kind: message.kind || 'chat', annotations: '[]', seq: event.seq, trace_id: event.trace_id, created_at: message.created_at || event.created_at });
    } else if (['annotation_created', 'annotation_updated', 'annotation_answered'].includes(event.type)) {
      var annotation = payload.annotation || payload;
      if (annotation.id) put(state.annotations, { ...annotation, seq: event.seq, created_at: annotation.created_at || event.created_at });
    } else if (event.type === 'tool_call' || event.type === 'tool_result') {
      // A provider call id is local to one trace; it must not collapse calls from another turn.
      var callId = payload.id || payload.callId || payload.call_id;
      var key = callId ? (event.trace_id || '') + ':' + callId : 'event:' + event.seq;
      put(state.toolCalls, { ...payload, id: key, call_id: callId || null, type: event.type, seq: event.seq, trace_id: event.trace_id, created_at: event.created_at });
    }
    if (event.trace_id) state.traceEvents.push(event);
    if (targets.has(event.seq)) checkpoints.set(event.seq, structuredClone(state));
  });
  var messageIds = new Set(state.messages.map(function (message) { return message.id; }));
  state.annotations = state.annotations.filter(function (annotation) { return messageIds.has(annotation.message_id); });
  return attachToolCards(state);
}

function traceSummary(traceId, events) {
  var request = events.find(function (event) { return event.type === 'request'; });
  var final = events.findLast(function (event) { return event.type === 'done' || event.type === 'error'; });
  return {
    trace_id: traceId, startSeq: events[0].seq, endSeq: events.at(-1).seq,
    created_at: events[0].created_at, input: request?.payload.message ?? null,
    status: final?.type === 'done' ? 'done' : final?.type === 'error' ? 'error' : 'incomplete',
    eventCount: events.length, toolCalls: events.filter(function (event) { return event.type === 'tool_call'; }).length,
    durationMs: final?.payload.durationMs ?? null, tokens: final?.payload.tokens ?? final?.payload.usage ?? null,
  };
}

function summarizeTraces(events) {
  var groups = new Map();
  events.forEach(function (event) {
    if (!event.trace_id) return;
    if (!groups.has(event.trace_id)) groups.set(event.trace_id, []);
    groups.get(event.trace_id).push(event);
  });
  return Array.from(groups, function ([traceId, records]) { return traceSummary(traceId, records); });
}

export function replayConversation(userId, conversationId, options = {}) {
  var db = getDb();
  ownedConversation(db, userId, conversationId);
  var events = readEvents(db, userId, conversationId);
  var headSeq = events.at(-1)?.seq || 0;
  var upTo = options.upTo === undefined ? headSeq : validateSeq(events, options.upTo);
  var state = derive(events.filter(function (event) { return event.seq <= upTo; }));
  return { conversationId, upTo, headSeq, messages: state.messages, annotations: state.annotations,
    toolCalls: state.toolCalls, traces: summarizeTraces(state.traceEvents) };
}

function copySnapshot(state, conversationId) {
  var idMap = { messages: {}, annotations: {}, toolCalls: {} };
  state.messages.forEach(function (message) { idMap.messages[message.id] = randomUUID(); });
  state.annotations.forEach(function (annotation) { idMap.annotations[annotation.id] = randomUUID(); });
  var snapshot = {
    messages: state.messages.map(function (message) {
      return { ...message, id: idMap.messages[message.id], conversation_id: conversationId,
        annotation_id: idMap.annotations[message.annotation_id] || null, trace_id: null, source_seq: message.seq, source_id: message.id };
    }),
    annotations: state.annotations.map(function (annotation) {
      return { ...annotation, id: idMap.annotations[annotation.id], message_id: idMap.messages[annotation.message_id],
        parent_id: idMap.annotations[annotation.parent_id] || null,
        reply_message_id: idMap.messages[annotation.reply_message_id] || null, trace_id: null,
        source_seq: annotation.seq, source_id: annotation.id };
    }),
    toolCalls: state.toolCalls.map(function (call) {
      var id = randomUUID(); idMap.toolCalls[call.id] = id;
      return { ...call, id, message_id: idMap.messages[call.message_id] || null, trace_id: null, source_seq: call.seq };
    }),
  };
  return { snapshot, idMap };
}

function materializeSnapshot(db, snapshot, conversationId) {
  snapshot.messages.forEach(function (message) {
    db.prepare(`INSERT INTO messages (id, conversation_id, role, content, kind, annotation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(message.id, conversationId, message.role, message.content,
      message.kind || 'chat', message.annotation_id || null, message.created_at);
  });
  // Parent ids are remapped first; defer self-reference checks until the transaction ends.
  var pending = snapshot.annotations.slice();
  var inserted = new Set();
  while (pending.length) {
    var index = pending.findIndex(function (annotation) { return !annotation.parent_id || inserted.has(annotation.parent_id); });
    if (index < 0) fail('批注父子关系无效', 500);
    var annotation = pending.splice(index, 1)[0];
    db.prepare(`INSERT INTO annotations (id, message_id, block_id, start_offset, end_offset, selected_text, text_hash,
      raw_context, question, answer, status, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      annotation.id, annotation.message_id, annotation.block_id ?? null, annotation.start_offset ?? null, annotation.end_offset ?? null,
      annotation.selected_text || '', annotation.text_hash || null, annotation.raw_context || '', annotation.question || '',
      annotation.answer || '', annotation.status || 'active', annotation.parent_id || null, annotation.created_at
    );
    inserted.add(annotation.id);
  }
}

export function forkConversation(userId, conversationId, seq, options = {}) {
  var db = getDb();
  return db.transaction(function () {
    var source = ownedConversation(db, userId, conversationId);
    validateSeq(readEvents(db, userId, conversationId), seq);
    var state = replayConversation(userId, conversationId, { upTo: seq });
    var id = randomUUID();
    if (options.title !== undefined && (typeof options.title !== 'string' || !options.title.trim() || options.title.length > 500)) fail('无效的对话标题');
    db.prepare('INSERT INTO conversations (id, user_id, title) VALUES (?, ?, ?)').run(id, userId, options.title?.trim() || source.title + ' · 分叉');
    var { snapshot, idMap } = copySnapshot(state, id);
    var event = insertEvent(db, userId, id, 'fork', { sourceConversationId: conversationId, seq, snapshot, idMap }, { forkFrom: seq });
    materializeSnapshot(db, snapshot, id);
    return { conversation: db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?').get(id), sourceSeq: seq, idMap, event };
  })();
}

export function rollbackConversation(userId, conversationId, seq) {
  var db = getDb();
  return db.transaction(function () {
    ownedConversation(db, userId, conversationId);
    validateSeq(readEvents(db, userId, conversationId), seq);
    var event = insertEvent(db, userId, conversationId, 'rollback', { seq });
    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId);
    return { event, state: replayConversation(userId, conversationId) };
  })();
}

export function deleteConversation(userId, conversationId) {
  var db = getDb();
  return db.transaction(function () {
    ownedConversation(db, userId, conversationId);
    insertEvent(db, userId, conversationId, 'conversation_deleted', {});
    db.prepare("UPDATE conversations SET deleted_at = datetime('now') WHERE id = ?").run(conversationId);
    return { success: true };
  })();
}

export function listTraces(userId, conversationId) {
  return { traces: summarizeTraces(listEvents(userId, conversationId).events) };
}

export function getTrace(userId, conversationId, traceId) {
  var events = listEvents(userId, conversationId).events.filter(function (event) { return event.trace_id === traceId; });
  if (!events.length) fail('Trace 不存在', 404);
  return { trace: traceSummary(traceId, events), events };
}

function behavior(events) {
  return {
    tools: events.filter(function (event) { return event.type === 'tool_call'; }).map(function (event) {
      return { tool: event.payload.tool || event.payload.tool_name, arguments: event.payload.arguments };
    }),
    answers: events.filter(function (event) { return event.type === 'ai_message'; }).map(function (event) { return (event.payload.message || event.payload).content; }),
    termination: events.findLast(function (event) { return event.type === 'done' || event.type === 'error'; })?.type || 'incomplete',
    reason: events.findLast(function (event) { return event.type === 'done'; })?.payload.termination?.reason || null,
    error: events.findLast(function (event) { return event.type === 'error'; })?.payload.message || null,
  };
}

async function rerunRecorded(events) {
  var request = events.find(function (event) { return event.type === 'request'; });
  var plan = events.find(function (event) { return event.type === 'plan'; });
  var decisions = events.filter(function (event) { return event.type === 'provider_response' && event.payload.phase !== 'answer'; });
  var answers = events.filter(function (event) { return event.type === 'provider_response' && event.payload.phase === 'answer'; });
  var results = events.filter(function (event) { return event.type === 'tool_result'; });
  var originalContexts = events.filter(function (event) { return event.type === 'context'; }).map(function (event) { return event.payload; });
  var toolIndex = -1, decisionIndex = 0, answerIndex = 0;
  var replayed = [];
  var recordingError = events.findLast(function (event) { return event.type === 'error'; });
  function toolResult(name, args) {
    var payload = results[toolIndex]?.payload;
    if (!payload || (payload.tool || payload.tool_name) !== name || !isDeepStrictEqual(payload.arguments, args)) throw new Error('录制工具调用与重跑参数不一致');
    return payload;
  }
  var provider = {
    name: 'recorded',
    async complete() {
      var event = decisions[decisionIndex++];
      if (!event) throw new Error(recordingError?.payload.message || '缺少录制的模型决策');
      return structuredClone(event.payload.response);
    },
    async *chat() {
      var event = answers[answerIndex++];
      if (!event) throw new Error(recordingError?.payload.message || '缺少录制的模型回答');
      var response = event.payload.response;
      if (response.content) yield { type: 'text', text: response.content };
      yield { type: 'done', finishReason: response.finishReason, usage: response.usage };
    },
  };
  if (request.payload.providerMode === 'stream') {
    delete provider.complete;
    provider.chat = async function* () {
      var event = decisions[decisionIndex++];
      if (!event) throw new Error(recordingError?.payload.message || '缺少录制的模型决策');
      var response = event.payload.response;
      if (response.content) yield { type: 'text', text: response.content };
      for (var call of response.toolCalls || []) yield { type: 'tool_call', call: structuredClone(call) };
      yield { type: 'done', finishReason: response.finishReason, usage: response.usage };
    };
  }
  var tools = {
    getToolDefinitions: function () {
      return (plan?.payload.tools || [...new Set(results.map(function (event) { return event.payload.tool || event.payload.tool_name; }))])
        .map(function (name) { return { type: 'function', function: { name, parameters: { type: 'object' } } }; });
    },
    executeTool: async function (name, args) { return structuredClone(toolResult(name, args).result); },
    renderToolResult: function (name, args, value) {
      var recorded = toolResult(name, args);
      if (!isDeepStrictEqual(recorded.result, value)) throw new Error('录制工具结果与重跑结果不一致');
      return recorded.rendered ?? JSON.stringify(recorded.result);
    },
    getToolPresentationMeta: function (name, args) { return toolResult(name, args).presentation ?? null; },
  };
  var runError = null;
  try {
    var result = await runAgent({
      provider, tools, traceId: request.trace_id, messages: request.payload.contextMessages,
      maxToolRounds: request.payload.maxToolRounds ?? plan?.payload.steps?.find(function (step) { return step.id === 'act'; })?.maxRounds ?? 5,
      maxConsecutiveFailures: request.payload.maxConsecutiveFailures ?? 2,
      context: { kind: request.payload.kind, annotationId: request.payload.annotationId },
      onEvent: function (event) { if (event.type === 'tool_call') toolIndex++; replayed.push(event); },
    });
    // Message persistence belongs to the HTTP host; add its final output to the comparison.
    if (events.some(function (event) { return event.type === 'ai_message'; })) replayed.push({ type: 'ai_message', payload: { content: result.content } });
  } catch (error) { runError = error.message; }
  var contexts = replayed.filter(function (event) { return event.type === 'context'; }).map(function (event) { return event.payload; });
  return { behavior: behavior(replayed), contextsMatch: isDeepStrictEqual(contexts, originalContexts),
    recordingsConsumed: decisionIndex === decisions.length && answerIndex === answers.length && toolIndex + 1 === results.length,
    error: runError };
}

/** Re-execute using recorded provider decisions and tool results; no live side effects. */
export async function replayTrace(userId, conversationId, traceId, options = {}) {
  var { trace, events } = getTrace(userId, conversationId, traceId);
  var expected = behavior(events);
  var request = events.find(function (event) { return event.type === 'request'; });
  var checks = { hasInput: Boolean(request), complete: expected.termination !== 'incomplete' };
  var actual = expected;
  var mode = 'recorded';
  var replayError = null;
  if (options.runner) {
    mode = 'rerun';
    var replayed = await options.runner({ input: structuredClone(request?.payload || {}), events: structuredClone(events),
      toolResults: events.filter(function (event) { return event.type === 'tool_result'; }).map(function (event) { return structuredClone(event.payload); }) });
    actual = Array.isArray(replayed) ? behavior(replayed) : replayed;
    checks.behaviorMatches = isDeepStrictEqual(actual, expected);
  } else if (Array.isArray(request?.payload.contextMessages) && events.some(function (event) { return event.type === 'provider_response'; })) {
    mode = 'rerun';
    var rerun = await rerunRecorded(events);
    actual = rerun.behavior;
    checks.contextsMatch = rerun.contextsMatch;
    checks.recordingsConsumed = rerun.recordingsConsumed;
    checks.behaviorMatches = isDeepStrictEqual(actual, expected);
    replayError = rerun.error;
  } else {
    checks.reexecutionAvailable = false;
  }
  if (options.expected !== undefined) checks.expectationMatches = isDeepStrictEqual(expected, options.expected);
  var fingerprint = createHash('sha256').update(JSON.stringify(expected)).digest('hex');
  return { traceId, mode, consistent: Object.values(checks).every(Boolean), checks, fingerprint, behavior: actual, expectedBehavior: expected, error: replayError, trace, events };
}
