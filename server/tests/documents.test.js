import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

var tempDir = mkdtempSync(join(tmpdir(), 'threadthink-documents-'));
process.env.DB_PATH = join(tempDir, 'test.db');
process.env.UPLOAD_DIR = join(tempDir, 'uploads');
process.env.JWT_SECRET = 'documents-test-secret';
process.env.ENCRYPTION_SECRET = 'documents-test-encryption-key-32chars';

var { buildApp } = await import('../src/app.js');
var { getDb, closeDb } = await import('../src/db/connection.js');
var { searchDocuments } = await import('../src/services/document.service.js');
var { executeTool } = await import('../src/services/tools/index.js');
var app;
var userNumber = 0;
var embeddingInputs = [];

before(async function () { app = await buildApp({ logger: false }); });
beforeEach(function () {
  getDb().exec('DELETE FROM tool_calls; DELETE FROM messages; DELETE FROM conversations; DELETE FROM chunks; DELETE FROM documents; DELETE FROM user_settings; DELETE FROM users;');
  embeddingInputs = [];
  globalThis.fetch = async function (url, options) {
    var body = JSON.parse(options.body);
    embeddingInputs.push(body.input);
    return new Response(JSON.stringify({ data: body.input.map(function (_, i) { return { index: i, embedding: [1, i + 1] }; }) }), { status: 200 });
  };
});
after(async function () {
  await app.close(); closeDb(); rmSync(tempDir, { recursive: true, force: true });
});

async function register(withKey) {
  userNumber++;
  var result = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'docs' + userNumber + '@example.com', password: 'password123' } });
  assert.equal(result.statusCode, 200);
  var auth = result.json();
  if (withKey) {
    var settings = await app.inject({ method: 'PUT', url: '/api/settings', headers: { authorization: 'Bearer ' + auth.token }, payload: { apiKey: 'offline-key', apiBase: 'https://provider.test/v1/chat/completions', model: 'test-model' } });
    assert.equal(settings.statusCode, 200);
  }
  return auth;
}

function multipart(filename, mimetype, content) {
  var boundary = '----threadthink-test-boundary';
  var body = '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
    'Content-Type: ' + mimetype + '\r\n\r\n' + content + '\r\n--' + boundary + '--\r\n';
  return { headers: { 'content-type': 'multipart/form-data; boundary=' + boundary }, payload: body };
}

async function upload(token, filename, mimetype, content) {
  var part = multipart(filename, mimetype, content);
  return app.inject({ method: 'POST', url: '/api/documents/upload', headers: { authorization: 'Bearer ' + token, ...part.headers }, payload: part.payload });
}

var text = 'This document contains enough plain text to produce one useful searchable chunk.';

test('uploads TXT and Markdown offline, stores chunk metadata, and removes temporary files', async function () {
  var auth = await register(true);
  var txt = await upload(auth.token, 'notes.txt', 'text/plain', text);
  var md = await upload(auth.token, 'notes.md', 'text/markdown', '# Notes\n\n' + text);
  assert.equal(txt.statusCode, 201);
  assert.equal(md.statusCode, 201);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM documents').get().n, 2);

  // The embedding call carried the heading-path-augmented text for Markdown,
  // and the bare chunk for plain text.
  assert.deepEqual(embeddingInputs[0], [text]);
  assert.deepEqual(embeddingInputs[1], ['Notes\n' + text]);

  var txtChunks = getDb().prepare('SELECT content, section_path, embedding_text, paragraph_index, is_overflow_split FROM chunks c JOIN documents d ON c.document_id = d.id WHERE d.filename = ? ORDER BY c.chunk_index').all('notes.txt');
  assert.equal(txtChunks.length, 1);
  assert.equal(txtChunks[0].content, text);
  assert.equal(txtChunks[0].section_path, null);
  assert.equal(txtChunks[0].embedding_text, text);
  assert.equal(txtChunks[0].paragraph_index, 0);
  assert.equal(txtChunks[0].is_overflow_split, 0);

  var mdChunks = getDb().prepare('SELECT content, section_path, embedding_text, paragraph_index, is_overflow_split FROM chunks c JOIN documents d ON c.document_id = d.id WHERE d.filename = ? ORDER BY c.chunk_index').all('notes.md');
  assert.equal(mdChunks.length, 1);
  assert.equal(mdChunks[0].content, text);
  assert.equal(mdChunks[0].section_path, 'Notes');
  assert.equal(mdChunks[0].embedding_text, 'Notes\n' + text);
  assert.equal(readdirSync(process.env.UPLOAD_DIR).length, 0);
});

test('paragraph-level chunking stores overflow flags and search returns metadata', async function () {
  var auth = await register(true);
  var sentence = '超长段落用于验证句子边界二次切分与局部重叠。';
  var body = '第一段内容足够长，用于验证自然段独立分块。\n\n第二段内容同样足够长，不会被合并。\n\n' + sentence.repeat(50);
  var uploaded = await upload(auth.token, 'chunks.txt', 'text/plain', body);
  assert.equal(uploaded.statusCode, 201);

  var rows = getDb().prepare('SELECT chunk_index, content, section_path, embedding_text, paragraph_index, is_overflow_split FROM chunks c JOIN documents d ON c.document_id = d.id WHERE d.filename = ? ORDER BY c.chunk_index').all('chunks.txt');
  assert.equal(rows.length, 4); // two short paragraphs + two overflow pieces
  assert.deepEqual(rows.map(function (r) { return r.paragraph_index; }), [0, 1, 2, 2]);
  assert.deepEqual(rows.map(function (r) { return r.is_overflow_split; }), [0, 0, 1, 1]);
  // Only sub-chunks of the same overlong paragraph overlap.
  assert.equal(rows[2].content.length, 990);
  assert.equal(rows[3].content.startsWith(rows[2].content.slice(-100)), true);
  assert.equal(rows[3].content.length, 210);
  for (var i = 0; i < rows.length; i++) {
    assert.equal(rows[i].section_path, null);
    assert.equal(rows[i].embedding_text, rows[i].content);
  }

  var results = await searchDocuments(auth.user.id, '查询');
  assert.equal(results.length, 4);
  assert.equal(results[0].content, rows[0].content);
  assert.equal(results[0].section_path, '');
  assert.equal(results[0].paragraph_index, 0);
  assert.ok(results.some(function (r) { return r.is_overflow_split === true; }));
});

test('rejects extension, MIME, empty, size, and traversal input without database or temp artifacts', async function () {
  var auth = await register(true);
  for (var item of [
    ['notes.exe', 'text/plain', text],
    ['notes.txt', 'text/markdown', text],
    ['empty.txt', 'text/plain', ''],
    ['../escape.txt', 'text/plain', text],
  ]) {
    var rejected = await upload(auth.token, item[0], item[1], item[2]);
    assert.equal(rejected.statusCode, 400);
  }
  var huge = await upload(auth.token, 'huge.txt', 'text/plain', 'x'.repeat(10 * 1024 * 1024 + 1));
  assert.equal(huge.statusCode, 400);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM documents').get().n, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 0);
  assert.equal(readdirSync(process.env.UPLOAD_DIR).length, 0);
});

test('missing key and embedding failures leave zero rows and no temporary file', async function () {
  var noKey = await register(false);
  var missing = await upload(noKey.token, 'missing.txt', 'text/plain', text);
  assert.equal(missing.statusCode, 400);

  var keyed = await register(true);
  globalThis.fetch = async function () { return new Response('provider failure', { status: 502 }); };
  var failed = await upload(keyed.token, 'failed.txt', 'text/plain', text);
  assert.equal(failed.statusCode, 400);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM documents').get().n, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 0);
  assert.equal(readdirSync(process.env.UPLOAD_DIR).length, 0);
});

test('search returns the five highest scores in descending order and deletes with ownership cascade', async function () {
  var alice = await register(true);
  var bob = await register(true);
  var inserted = getDb().prepare('INSERT INTO documents (id,user_id,filename,file_type,file_size,chunk_count) VALUES (?,?,?,?,?,?)');
  // Old-shape rows (no metadata columns) must keep working after migration.
  var chunk = getDb().prepare('INSERT INTO chunks (id,document_id,chunk_index,content,embedding) VALUES (?,?,?,?,?)');
  var docs = [];
  for (var i = 0; i < 6; i++) {
    var id = 'doc-' + i;
    docs.push(id);
    inserted.run(id, alice.user.id, 'doc' + i + '.txt', 'txt', 10, 1);
    chunk.run('chunk-' + i, id, 0, 'content ' + i + ' with enough words', JSON.stringify([i + 1, 1]));
  }
  // Search uses an explicit query vector so ranking is deterministic.
  var aliceId = alice.user.id;
  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 });
  };
  var results = await searchDocuments(aliceId, 'query');
  assert.equal(results.length, 5);
  assert.deepEqual(results.map(function (r) { return r.content; }), ['content 5 with enough words', 'content 4 with enough words', 'content 3 with enough words', 'content 2 with enough words', 'content 1 with enough words']);
  // Pre-metadata rows surface an empty section path instead of failing.
  assert.ok(results.every(function (r) { return r.section_path === ''; }));

  var ownedDoc = docs[0];
  var forbidden = await app.inject({ method: 'DELETE', url: '/api/documents/' + ownedDoc, headers: { authorization: 'Bearer ' + bob.token } });
  assert.equal(forbidden.statusCode, 404);
  var deleted = await app.inject({ method: 'DELETE', url: '/api/documents/' + ownedDoc, headers: { authorization: 'Bearer ' + alice.token } });
  assert.equal(deleted.statusCode, 200);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?').get(ownedDoc).n, 0);
});

test('PDF parser accepts only the documented basic literal-text subset', async function () {
  var auth = await register(true);
  var streamText = 'BT /F1 12 Tf (This basic PDF contains enough text for indexing.) Tj ET';
  var pdf = '%PDF-1.4\n' +
    '1 0 obj\n<< /Type /Page /Contents 2 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj\n' +
    '2 0 obj\n<< /Length ' + streamText.length + ' >>\nstream\n' + streamText + '\nendstream\nendobj\n' +
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n%%EOF\n';
  var accepted = await upload(auth.token, 'basic.pdf', 'application/pdf', pdf);
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(accepted.json().document.file_type, 'pdf');

  var fake = '%PDF-1.4\n1 0 obj\n(stream contains no document text)\nendobj\n%%EOF';
  var rejected = await upload(auth.token, 'fake.pdf', 'application/pdf', fake);
  assert.equal(rejected.statusCode, 400);
});

test('doc_search keeps concurrent user context isolated', async function () {
  var alice = await register(true);
  var bob = await register(true);
  var users = getDb().prepare('SELECT id,email FROM users ORDER BY email').all();
  var a = users.find(function (u) { return u.email.endsWith('@example.com') && u.email.indexOf('docs') === 0; });
  var b = users[users.length - 1];
  // Direct rows make this test independent of upload parsing while exercising the tool boundary.
  getDb().prepare('INSERT INTO documents (id,user_id,filename,file_type,chunk_count) VALUES (?,?,?,?,?)').run('a-doc', a.id, 'alice.txt', 'txt', 1);
  getDb().prepare('INSERT INTO chunks (id,document_id,chunk_index,content,embedding) VALUES (?,?,?,?,?)').run('a-chunk', 'a-doc', 0, 'Alice private context', JSON.stringify([1, 0]));
  getDb().prepare('INSERT INTO documents (id,user_id,filename,file_type,chunk_count) VALUES (?,?,?,?,?)').run('b-doc', b.id, 'bob.txt', 'txt', 1);
  getDb().prepare('INSERT INTO chunks (id,document_id,chunk_index,content,embedding) VALUES (?,?,?,?,?)').run('b-chunk', 'b-doc', 0, 'Bob private context', JSON.stringify([1, 0]));
  globalThis.fetch = async function (_, options) {
    await new Promise(function (resolve) { setTimeout(resolve, 10); });
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 });
  };
  var results = await Promise.all([executeTool('doc_search', { query: 'A' }, { userId: a.id }), executeTool('doc_search', { query: 'B' }, { userId: b.id })]);
  assert.equal(results[0].results[0].filename, 'alice.txt');
  assert.equal(results[1].results[0].filename, 'bob.txt');
});

test('doc_search returns at most five independent chunks without adjacent-paragraph expansion', async function () {
  var auth = await register(true);
  var inserted = getDb().prepare('INSERT INTO documents (id,user_id,filename,file_type,chunk_count) VALUES (?,?,?,?,?)');
  inserted.run('tool-doc', auth.user.id, 'tool.txt', 'txt', 6);
  var chunk = getDb().prepare('INSERT INTO chunks (id,document_id,chunk_index,content,embedding,section_path,paragraph_index,is_overflow_split) VALUES (?,?,?,?,?,?,?,?)');
  var contents = [];
  for (var i = 0; i < 6; i++) {
    contents.push('solo paragraph ' + i);
    chunk.run('tool-chunk-' + i, 'tool-doc', i, 'solo paragraph ' + i, JSON.stringify([i + 1, 1]), null, i, 0);
  }
  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 });
  };
  var result = await executeTool('doc_search', { query: 'find' }, { userId: auth.user.id });
  assert.equal(result.results.length, 5);
  // Every result is exactly one stored chunk: no neighbor concatenation.
  assert.ok(result.results.every(function (r) { return contents.indexOf(r.content) !== -1; }));
  assert.equal(result.results.some(function (r) { return r.content === 'solo paragraph 0'; }), false);
  assert.ok(result.results.every(function (r) { return r.section_path === ''; }));
});
