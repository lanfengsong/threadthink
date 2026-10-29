import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/migrate.js';

var METADATA_COLUMNS = ['section_path', 'embedding_text', 'paragraph_index', 'is_overflow_split'];

function chunkColumns(db) {
  return db.prepare('PRAGMA table_info(chunks)').all().map(function (column) { return column.name; });
}

test('fresh database gets all chunk metadata columns', function () {
  var db = new Database(':memory:');
  migrate(db);
  var columns = chunkColumns(db);
  for (var name of METADATA_COLUMNS) {
    assert.ok(columns.indexOf(name) !== -1, 'missing column: ' + name);
  }
  db.close();
});

test('migrate upgrades a pre-metadata chunks table idempotently and keeps old rows searchable', function () {
  var db = new Database(':memory:');
  // Simulate a database created before chunk metadata existed.
  db.exec(`
    CREATE TABLE users (
      id          TEXT PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      api_key     TEXT,
      api_base    TEXT DEFAULT 'https://api.deepseek.com/v1/chat/completions',
      model       TEXT DEFAULT 'deepseek-chat',
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE documents (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      filename    TEXT NOT NULL,
      file_type   TEXT NOT NULL,
      file_size   INTEGER DEFAULT 0,
      chunk_count INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE chunks (
      id          TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content     TEXT NOT NULL,
      embedding   TEXT,
      token_count INTEGER DEFAULT 0
    );
    CREATE TABLE conversations (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      title       TEXT DEFAULT '新对话',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL DEFAULT '',
      annotations     TEXT DEFAULT '[]',
      created_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE tool_calls (
      id          TEXT PRIMARY KEY,
      message_id  TEXT NOT NULL,
      tool_name   TEXT NOT NULL,
      arguments   TEXT NOT NULL,
      result      TEXT,
      status      TEXT DEFAULT 'pending',
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE user_settings (
      user_id       TEXT PRIMARY KEY,
      system_prompt TEXT DEFAULT '你是一个有帮助的AI助手，请用中文回答用户的问题。'
    );
  `);
  db.prepare('INSERT INTO users (id, email, password) VALUES (?, ?, ?)').run('u1', 'old@example.com', 'x');
  db.prepare('INSERT INTO documents (id, user_id, filename, file_type) VALUES (?, ?, ?, ?)').run('d1', 'u1', 'old.txt', 'txt');
  db.prepare('INSERT INTO chunks (id, document_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?, ?)').run('c1', 'd1', 0, 'old content', '[1, 0]');

  migrate(db); // add missing columns
  migrate(db); // idempotent — must not throw or duplicate
  var columns = chunkColumns(db);
  for (var name of METADATA_COLUMNS) {
    assert.ok(columns.indexOf(name) !== -1, 'missing column: ' + name);
  }

  // Old rows keep their vector and become metadata-less but intact.
  var row = db.prepare('SELECT content, embedding, section_path, embedding_text, paragraph_index, is_overflow_split FROM chunks WHERE id = ?').get('c1');
  assert.equal(row.content, 'old content');
  assert.equal(row.embedding, '[1, 0]');
  assert.equal(row.section_path, null);
  assert.equal(row.embedding_text, null);
  assert.equal(row.paragraph_index, null);
  assert.equal(row.is_overflow_split, 0);
  db.close();
});