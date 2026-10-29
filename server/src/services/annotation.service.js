/* ============================================================
   ThreadThink Server — Annotation Service
   ============================================================ */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';

/** Ownership check first (IDOR): message -> conversation -> user. */
function ownedMessage(db, messageId, userId) {
  var msg = db.prepare(
    'SELECT m.id, m.conversation_id, c.user_id FROM messages m ' +
    'JOIN conversations c ON m.conversation_id = c.id WHERE m.id = ?'
  ).get(messageId);
  return (msg && msg.user_id === userId) ? msg : null;
}

export function createAnnotation(userId, payload) {
  var db = getDb();
  var data = payload || {};
  var messageId = data.messageId, question = data.question;
  if (typeof messageId !== 'string' || !messageId.trim()) throw new Error('缺少 messageId');
  if (typeof question !== 'string' || !question.trim()) throw new Error('缺少追问内容');

  var msg = ownedMessage(db, messageId, userId);
  if (!msg || msg.user_id !== userId) throw new Error('消息不存在');

  var id = uuid();
  db.prepare(
    'INSERT INTO annotations (id, message_id, block_id, start_offset, end_offset, ' +
    'selected_text, text_hash, raw_context, question) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id, messageId,
    data.blockId || null,
    Number.isInteger(data.startOffset) ? data.startOffset : null,
    Number.isInteger(data.endOffset) ? data.endOffset : null,
    data.selectedText || '', data.textHash || null, data.rawContext || '', question.trim()
  );
  return db.prepare('SELECT * FROM annotations WHERE id = ?').get(id);
}

export function listAnnotations(userId, conversationId) {
  var db = getDb();
  var conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
  if (!conv) throw new Error('对话不存在');
  return db.prepare(
    'SELECT a.* FROM annotations a JOIN messages m ON a.message_id = m.id ' +
    'WHERE m.conversation_id = ? ORDER BY a.created_at ASC'
  ).all(conversationId);
}