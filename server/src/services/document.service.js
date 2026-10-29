/* ============================================================
   ThreadThink Server — Document Processing Service
   ============================================================ */

import { readFileSync, statSync } from 'fs';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';
import { decrypt } from './crypto.service.js';
import { getEmbeddings, getEmbedding, cosineSimilarity } from './embedding.service.js';
import { chunkDocument } from './chunking.js';

export { splitChunks, chunkDocument } from './chunking.js';

export async function processDocument(filePath, filename, mimetype, userId) {
  var db = getDb();
  var fileType = detectFileType(filename, mimetype);
  if (!fileType) throw new Error('不支持的文件类型。支持: PDF, TXT, Markdown');

  var rawText = extractText(filePath, fileType);
  if (!rawText || rawText.trim().length === 0) throw new Error('文件内容为空或无法提取文本');

  // One retrieval unit per natural paragraph; Markdown carries its heading
  // path as embedding context, and only overlong paragraphs are split further.
  var chunks = chunkDocument(rawText, { isMarkdown: fileType === 'md' });
  if (chunks.length === 0) throw new Error('无法分段，文件内容可能太短');

  var user = db.prepare('SELECT api_key, api_base, model FROM users WHERE id = ?').get(userId);
  if (!user || !user.api_key) throw new Error('请先在设置中配置 API Key');
  var apiKey = decrypt(user.api_key);
  if (!apiKey) throw new Error('API Key 解密失败，请重新设置');
  var apiBase = user.api_base || 'https://api.deepseek.com/v1/chat/completions';
  var model = user.model || 'deepseek-chat';

  // Network work must finish before entering the synchronous SQLite transaction.
  // The embedding input is the heading-path-augmented text, not the bare chunk.
  var embeddings;
  try {
    embeddings = await getEmbeddings(chunks.map(function (chunk) { return chunk.embeddingText; }), apiKey, apiBase, model);
  } catch (e) {
    throw new Error('向量化失败: ' + e.message);
  }
  if (!Array.isArray(embeddings) || embeddings.length !== chunks.length) {
    throw new Error('向量化失败: 向量数量与文本分块数量不一致');
  }

  var docId = uuid();
  var fileSize = 0;
  try { fileSize = statSync(filePath).size; } catch (e) { /* best effort */ }

  var insertChunk = db.prepare(
    'INSERT INTO chunks (id, document_id, chunk_index, content, embedding, token_count, ' +
    'section_path, embedding_text, paragraph_index, is_overflow_split) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  var insertAll = db.transaction(function () {
    db.prepare(
      'INSERT INTO documents (id, user_id, filename, file_type, file_size, chunk_count) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(docId, userId, filename, fileType, fileSize, chunks.length);
    for (var i = 0; i < chunks.length; i++) {
      insertChunk.run(
        uuid(), docId, i,
        chunks[i].content, JSON.stringify(embeddings[i]), Math.ceil(chunks[i].content.length / 2),
        chunks[i].sectionPath || null, chunks[i].embeddingText, chunks[i].paragraphIndex,
        chunks[i].isOverflowSplit ? 1 : 0
      );
    }
  });
  insertAll();

  return db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
}

export async function searchDocuments(userId, query) {
  var db = getDb();
  var user = db.prepare('SELECT api_key, api_base, model FROM users WHERE id = ?').get(userId);
  if (!user || !user.api_key) throw new Error('请先配置 API Key');
  var apiKey = decrypt(user.api_key);
  if (!apiKey) throw new Error('API Key 解密失败');
  var apiBase = user.api_base || 'https://api.deepseek.com/v1/chat/completions';
  var model = user.model || 'deepseek-chat';
  var queryEmbedding = await getEmbedding(query, apiKey, apiBase, model);
  if (!queryEmbedding) throw new Error('查询向量化失败');

  var chunks = db.prepare(
    'SELECT c.id, c.content, c.embedding, c.chunk_index, c.section_path, c.paragraph_index, c.is_overflow_split, d.filename, d.id as doc_id ' +
    'FROM chunks c JOIN documents d ON c.document_id = d.id WHERE d.user_id = ?'
  ).all(userId);
  var scored = [];
  for (var i = 0; i < chunks.length; i++) {
    var emb = null;
    try { if (chunks[i].embedding) emb = JSON.parse(chunks[i].embedding); } catch (e) { /* skip malformed old rows */ }
    if (!emb) continue;
    scored.push({
      filename: chunks[i].filename,
      content: chunks[i].content,
      section_path: chunks[i].section_path || '',
      paragraph_index: chunks[i].paragraph_index,
      is_overflow_split: chunks[i].is_overflow_split ? true : false,
      score: cosineSimilarity(queryEmbedding, emb),
    });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, 5).map(function (item) {
    return {
      filename: item.filename,
      content: item.content,
      section_path: item.section_path,
      paragraph_index: item.paragraph_index,
      is_overflow_split: item.is_overflow_split,
      score: Math.round(item.score * 100) / 100,
    };
  });
}

export function deleteDocument(docId, userId) {
  var db = getDb();
  var doc = db.prepare('SELECT id FROM documents WHERE id = ? AND user_id = ?').get(docId, userId);
  if (!doc) throw new Error('文档不存在');
  db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  return { success: true };
}

function detectFileType(filename, mimetype) {
  if (typeof filename !== 'string' || typeof mimetype !== 'string') return null;
  var ext = filename.split('.').pop().toLowerCase();
  if (ext === 'pdf' && mimetype === 'application/pdf') return 'pdf';
  if ((ext === 'txt' || ext === 'text') && mimetype === 'text/plain') return 'txt';
  if ((ext === 'md' || ext === 'markdown') &&
      (mimetype === 'text/markdown' || mimetype === 'text/x-markdown')) return 'md';
  return null;
}

function extractText(filePath, fileType) {
  if (fileType === 'txt' || fileType === 'md') return readFileSync(filePath, 'utf-8');
  if (fileType === 'pdf') return extractPdfText(filePath);
  return null;
}

/*
 * Intentionally NOT a general PDF parser or OCR. Supported subset only:
 * one ASCII page, one unfiltered stream with a direct /Length, a standard
 * Type1 Helvetica font named F1, and BT/ET, Tf, Td/TD/Tm/TL/T*, literal Tj
 * operators. Hex strings, TJ arrays, nested/octal strings, custom encodings,
 * compression, images, encryption and layout reconstruction are unsupported.
 * Reject the entire file on unsupported syntax; never scrape raw PDF bytes.
 */
function extractPdfText(filePath) {
  var unsupported = 'PDF 解析失败: 仅支持单页、未压缩、Helvetica 字体的基本 ASCII 文本 PDF（literal Tj）；不支持通用 PDF 或 OCR，请导出为 TXT/Markdown';
  var content = readFileSync(filePath).toString('latin1');
  if (!/^%PDF-1\.[0-7][\r\n]/.test(content) || !/%%EOF\s*$/.test(content) ||
      /[^\x09\x0a\x0d\x20-\x7e]/.test(content) ||
      /\/(?:Filter|Encrypt|Encoding|ToUnicode|XObject|ObjStm)\b/.test(content) ||
      (content.match(/\/Type\s*\/Page\b/g) || []).length !== 1) throw new Error(unsupported);

  // Deliberately require simple, explicit font and stream objects. A literal
  // string in metadata, an image stream, or an unreferenced stream is not text.
  var font = /(?:^|\n)(\d+) 0 obj\s*<<\s*\/Type\s*\/Font\s*\/Subtype\s*\/Type1\s*\/BaseFont\s*\/Helvetica\s*>>\s*endobj/.exec(content);
  var streams = Array.from(content.matchAll(/(?:^|\n)(\d+) 0 obj\s*<<\s*\/Length\s+(\d+)\s*>>\s*stream\r?\n([\s\S]*?)\r?\nendstream\s*endobj/g));
  if (!font || streams.length !== 1 || (content.match(/\bstream\r?\n/g) || []).length !== 1) throw new Error(unsupported);
  var stream = streams[0];
  var page = /(?:^|\n)\d+ 0 obj\s*(<<\s*\/Type\s*\/Page\b[\s\S]*?)endobj/.exec(content);
  if (!page || !new RegExp('/Contents\\s+' + stream[1] + '\\s+0\\s+R\\b').test(page[1]) ||
      !new RegExp('/Font\\s*<<\\s*/F1\\s+' + font[1] + '\\s+0\\s+R\\s*>>').test(page[1]) ||
      Number(stream[2]) !== stream[3].length) throw new Error(unsupported);

  // Tokenize literal strings as a whole so words such as BT and ET inside
  // actual text cannot accidentally become PDF operators.
  var tokens = /\s+|\((?:\\[()\\nrt]|[^()\\\x00-\x1f\x7f-\xff])*\)|\/F1\b|[+-]?(?:\d+(?:\.\d*)?|\.\d+)|BT\b|ET\b|Tf\b|Td\b|TD\b|Tm\b|TL\b|T\*|Tj\b/gy;
  var offset = 0, operands = [], inside = false, hasFont = false, text = '';
  while (offset < stream[3].length) {
    tokens.lastIndex = offset;
    var match = tokens.exec(stream[3]);
    if (!match) throw new Error(unsupported);
    var token = match[0];
    offset = tokens.lastIndex;
    if (/^\s+$/.test(token)) continue;
    if (token[0] === '(' || token[0] === '/' || /^[+\-.\d]/.test(token)) {
      operands.push(token);
      continue;
    }
    if (token === 'BT') {
      if (inside || operands.length) throw new Error(unsupported);
      inside = true;
      hasFont = false;
    } else if (token === 'ET') {
      if (!inside || operands.length) throw new Error(unsupported);
      inside = false;
      text += '\n';
    } else {
      if (!inside) throw new Error(unsupported);
      if (token === 'Tf') {
        if (operands.length !== 2 || operands[0] !== '/F1' || !Number.isFinite(Number(operands[1]))) throw new Error(unsupported);
        hasFont = true;
      } else if (token === 'Tj') {
        if (!hasFont || operands.length !== 1 || operands[0][0] !== '(') throw new Error(unsupported);
        text += operands[0].slice(1, -1).replace(/\\([()\\nrt])/g, function (_, escaped) {
          return { n: '\n', r: '\r', t: '\t' }[escaped] || escaped;
        });
      } else {
        var counts = { Td: 2, TD: 2, Tm: 6, TL: 1, 'T*': 0 };
        if (operands.length !== counts[token] || operands.some(function (value) { return !Number.isFinite(Number(value)); })) throw new Error(unsupported);
        if (token !== 'TL') text += '\n';
      }
      operands = [];
    }
  }
  if (inside || operands.length || !text.trim()) throw new Error(unsupported);
  return text.trim();
}
