/* ============================================================
   ThreadThink Server — Annotation Service
   ============================================================ */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';
import { appendEvent, replayConversation } from './events.service.js';
import { assembleContext } from '../../../core/context.js';

function ownedState(userId, messageId) {
  var db = getDb();
  var row = db.prepare('SELECT m.conversation_id FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE m.id = ? AND c.user_id = ? AND c.deleted_at IS NULL').get(messageId, userId);
  if (!row) throw new Error('消息不存在');
  var state = replayConversation(userId, row.conversation_id);
  var message = state.messages.find(function (msg) { return msg.id === messageId; });
  if (!message || message.kind === 'annotation') throw new Error('消息不存在');
  return { conversationId: row.conversation_id, state: state, message: message };
}

function text(value, label, limit, required) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > limit) throw new Error(label + '无效');
  return value;
}

function anchorFields(data) {
  var hasStart = data.startOffset != null, hasEnd = data.endOffset != null;
  if (hasStart !== hasEnd || (hasStart && (!Number.isInteger(data.startOffset) || !Number.isInteger(data.endOffset) || data.startOffset < 0 || data.endOffset <= data.startOffset))) throw new Error('批注偏移无效');
  if (data.blockId != null) text(data.blockId, '块标识', 200, true);
  if (data.textHash != null) text(data.textHash, '文本指纹', 100, true);
  if (data.rawContext !== undefined) text(data.rawContext, '引用上下文', 20000);
  return { block_id: data.blockId || null, start_offset: hasStart ? data.startOffset : null,
    end_offset: hasEnd ? data.endOffset : null, text_hash: data.textHash || null, raw_context: data.rawContext || '' };
}

export function createAnnotation(userId, payload) {
  var data = payload || {};
  var messageId = text(data.messageId, 'messageId', 200, true);
  var question = text(data.question, '追问内容', 10000, true).trim();
  var owned = ownedState(userId, messageId);
  if (owned.message.role !== 'assistant') throw new Error('只能批注 AI 回答');
  var parentId = data.parentId == null ? null : text(data.parentId, '父批注', 200, true);
  if (parentId && !owned.state.annotations.some(function (ann) { return ann.id === parentId && ann.message_id === messageId; })) throw new Error('父批注不存在');
  var selectedText = text(data.selectedText, '引用', 20000, true);
  var anchor = anchorFields(data), db = getDb();
  return db.transaction(function () {
    var id = uuid();
    db.prepare('INSERT INTO annotations (id, message_id, block_id, start_offset, end_offset, selected_text, text_hash, raw_context, question, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, messageId, anchor.block_id, anchor.start_offset, anchor.end_offset, selectedText, anchor.text_hash, anchor.raw_context, question, parentId);
    var annotation = db.prepare('SELECT * FROM annotations WHERE id = ?').get(id);
    appendEvent(userId, owned.conversationId, 'annotation_created', { annotation: annotation });
    return annotation;
  })();
}

export function listAnnotations(userId, conversationId) {
  return replayConversation(userId, conversationId).annotations;
}

export function getAnnotation(userId, id) {
  var row = getDb().prepare('SELECT message_id FROM annotations WHERE id = ?').get(id);
  if (!row) throw new Error('批注不存在');
  var owned;
  try { owned = ownedState(userId, row.message_id); } catch (e) { throw new Error('批注不存在'); }
  var annotation = owned.state.annotations.find(function (ann) { return ann.id === id; });
  if (!annotation) throw new Error('批注不存在');
  return Object.assign(owned, { annotation: annotation });
}

export function updateAnnotation(userId, id, payload) {
  var owned = getAnnotation(userId, id), data = payload || {};
  var annotation = Object.assign({}, owned.annotation);
  if (data.question !== undefined) annotation.question = text(data.question, '追问内容', 10000, true).trim();
  if (data.status !== undefined) {
    if (!['active', 'open', 'outdated', 'resolved'].includes(data.status)) throw new Error('批注状态无效');
    annotation.status = data.status === 'open' ? 'active' : data.status;
  }
  if (['blockId', 'startOffset', 'endOffset', 'textHash', 'rawContext'].some(function (key) { return Object.hasOwn(data, key); })) {
    Object.assign(annotation, anchorFields(Object.assign({ blockId: annotation.block_id,
      startOffset: annotation.start_offset, endOffset: annotation.end_offset,
      textHash: annotation.text_hash, rawContext: annotation.raw_context }, data)));
  }
  var db = getDb();
  return db.transaction(function () {
    db.prepare('UPDATE annotations SET question = ?, status = ?, block_id = ?, start_offset = ?, end_offset = ?, text_hash = ?, raw_context = ? WHERE id = ?')
      .run(annotation.question, annotation.status, annotation.block_id, annotation.start_offset, annotation.end_offset, annotation.text_hash, annotation.raw_context, id);
    appendEvent(userId, owned.conversationId, 'annotation_updated', { annotation: annotation });
    return annotation;
  })();
}

function sourceWindow(content, quote, rawContext) {
  if (content.length <= 1600) return content;
  var index = rawContext ? content.indexOf(rawContext) : -1;
  if (index === -1) index = quote ? content.indexOf(quote) : -1;
  if (index === -1) {
    content = content.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '');
    index = quote ? content.indexOf(quote) : -1;
  }
  if (index === -1) return content.slice(0, 1600);
  var start = Math.max(0, index - 500), end = Math.min(content.length, index + Math.min(quote.length, 600) + 500);
  return (start > 0 ? '…\n' : '') + content.slice(start, end) + (end < content.length ? '\n…' : '');
}

export async function buildAnnotationContext(userId, id) {
  var owned = getAnnotation(userId, id), annotation = owned.annotation;
  var history = [];
  for (var message of owned.state.messages) {
    if ((message.kind || 'chat') === 'chat') history.push({ role: message.role, content: message.content });
    if (message.id === annotation.message_id) break;
  }
  var thread = [], seen = new Set(), parentId = annotation.parent_id;
  while (parentId) {
    if (seen.has(parentId)) throw new Error('批注支线存在循环');
    seen.add(parentId);
    var parent = owned.state.annotations.find(function (item) { return item.id === parentId; });
    if (!parent) break;
    thread.unshift({ question: parent.question, answer: parent.answer || '' });
    parentId = parent.parent_id;
  }
  var context = await assembleContext({
    persona: '你是批注问答助手。用户对之前回答的一段文字发起追问，请围绕引用回答，结合原回答和前序批注理解语义。',
    history: history.slice(-12), source: sourceWindow(owned.message.content, annotation.selected_text, annotation.raw_context),
    thread: thread.length ? thread.slice(-4).reverse().map(function (item) {
      return { question: item.question.slice(0, 200), answer: sourceWindow(item.answer, annotation.selected_text).slice(0, 600) };
    }) : undefined,
    selectedText: annotation.selected_text,
  });
  return { conversationId: owned.conversationId, annotation: annotation, messages: context.messages, sections: context.sections };
}
