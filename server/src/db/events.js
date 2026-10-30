import { createHash } from 'node:crypto';

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function legacyAnnotationId(messageId, path) {
  return 'legacy-' + createHash('sha256').update(messageId + ':' + path).digest('hex').slice(0, 32);
}

/** Import the old embedded tree once, retaining the original JSON as a read-only backup. */
function importAnnotationTree(db, message) {
  var roots = parseJson(message.annotations, []);
  if (!Array.isArray(roots)) return;
  function visit(nodes, parentId, path) {
    nodes.forEach(function (node, index) {
      if (!node || typeof node !== 'object') return;
      var nodePath = path + '.' + index;
      var id = typeof node.id === 'string' && node.id ? node.id : legacyAnnotationId(message.id, nodePath);
      var existing = db.prepare('SELECT message_id FROM annotations WHERE id = ?').get(id);
      if (existing && existing.message_id !== message.id) id = legacyAnnotationId(message.id, nodePath);
      var question = typeof node.question === 'string' ? node.question : '';
      db.prepare(`INSERT OR IGNORE INTO annotations
        (id, message_id, block_id, start_offset, end_offset, selected_text, text_hash,
         raw_context, question, answer, status, parent_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, message.id, node.block_id ?? node.blockId ?? null,
        node.start_offset ?? node.startOffset ?? node.start ?? null,
        node.end_offset ?? node.endOffset ?? node.end ?? null,
        node.selected_text ?? node.selectedText ?? '', node.text_hash ?? node.textHash ?? null,
        node.raw_context ?? node.rawContext ?? '', question,
        typeof node.answer === 'string' ? node.answer : '',
        ['active', 'outdated', 'resolved'].includes(node.status) ? node.status : 'active',
        parentId, node.created_at || message.created_at
      );
      if (Array.isArray(node.annotations)) visit(node.annotations, id, nodePath);
    });
  }
  visit(roots, null, 'root');
}

/** Bootstrap only conversations without an event history. Re-running never imports stale projections. */
export function importLegacyConversation(db, conversation) {
  if (db.prepare('SELECT 1 FROM events WHERE conversation_id = ? AND user_id = ? LIMIT 1').get(conversation.id, conversation.user_id)) return;
  db.transaction(function () {
    var messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversation.id);
    messages.forEach(function (message) { importAnnotationTree(db, message); });
    var records = [];
    function add(type, payload, sourceKey, createdAt, traceId) {
      records.push({ type, payload, sourceKey, createdAt, traceId: traceId || null, order: records.length });
    }
    messages.forEach(function (message) {
      var payload = { ...message, annotations: '[]' };
      add(message.role === 'assistant' ? 'ai_message' : message.role === 'user' ? 'user_message' : 'message_created',
        payload, 'message:' + message.id, message.created_at);
    });
    db.prepare(`SELECT a.* FROM annotations a JOIN messages m ON m.id = a.message_id
      WHERE m.conversation_id = ? ORDER BY a.created_at, a.rowid`).all(conversation.id).forEach(function (annotation) {
      add('annotation_created', { annotation }, 'annotation:' + annotation.id, annotation.created_at);
    });
    db.prepare(`SELECT t.* FROM tool_calls t JOIN messages m ON m.id = t.message_id
      WHERE m.conversation_id = ? ORDER BY t.created_at, t.rowid`).all(conversation.id).forEach(function (call) {
      add('tool_result', { ...call, tool: call.tool_name, arguments: parseJson(call.arguments, call.arguments),
        result: parseJson(call.result, call.result), legacy: true }, 'tool:' + call.id, call.created_at);
    });
    db.prepare('SELECT * FROM agent_logs WHERE conversation_id = ? ORDER BY created_at, seq, rowid').all(conversation.id).forEach(function (log) {
      var detail = parseJson(log.detail, {});
      add(log.kind, { ...(detail && typeof detail === 'object' ? detail : { value: detail }), legacy: true },
        'log:' + log.id, log.created_at, log.trace_id);
    });
    records.sort(function (a, b) {
      return String(a.createdAt).localeCompare(String(b.createdAt)) || a.order - b.order;
    });
    var insert = db.prepare(`INSERT INTO events
      (conversation_id, user_id, type, payload, trace_id, source_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    records.forEach(function (record) {
      insert.run(conversation.id, conversation.user_id, record.type, JSON.stringify(record.payload),
        record.traceId, record.sourceKey, record.createdAt);
    });
  })();
}

export function migrateEvents(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload)),
      trace_id TEXT,
      fork_from INTEGER,
      source_key TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id, user_id, seq);
    CREATE INDEX IF NOT EXISTS idx_events_trace ON events(conversation_id, user_id, trace_id, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source ON events(conversation_id, user_id, source_key) WHERE source_key IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS events_no_replace BEFORE INSERT ON events
      WHEN EXISTS (SELECT 1 FROM events WHERE seq = NEW.seq)
        OR (NEW.source_key IS NOT NULL AND EXISTS (SELECT 1 FROM events
          WHERE conversation_id = NEW.conversation_id AND user_id = NEW.user_id AND source_key = NEW.source_key))
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `);
  // No cascading foreign keys: deleting a compatibility projection cannot erase the audit log.
  db.prepare('SELECT id, user_id FROM conversations').all().forEach(function (conversation) {
    importLegacyConversation(db, conversation);
  });
}
