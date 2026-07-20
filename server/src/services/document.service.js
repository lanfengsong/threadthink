/* ============================================================
   ThreadThink Server — Document Processing Service
   ============================================================ */

import { readFileSync, unlinkSync } from 'fs';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';
import { decrypt } from './crypto.service.js';
import { getEmbeddings } from './embedding.service.js';

var MAX_CHUNK_SIZE = 1000;  // characters per chunk
var CHUNK_OVERLAP = 100;    // overlap between chunks

/**
 * Process an uploaded file:
 * 1. Read file content
 * 2. Extract plain text based on file type
 * 3. Split into chunks
 * 4. Get embeddings for all chunks
 * 5. Store document + chunks in DB
 *
 * @param {string} filePath - path to uploaded file
 * @param {string} filename - original filename
 * @param {string} mimetype - MIME type
 * @param {string} userId
 * @returns {Promise<Object>} document record
 */
export async function processDocument(filePath, filename, mimetype, userId) {
  var db = getDb();

  // 1. Detect file type
  var fileType = detectFileType(filename, mimetype);
  if (!fileType) throw new Error('不支持的文件类型。支持: PDF, TXT, Markdown');

  // 2. Extract text
  var rawText = extractText(filePath, fileType);

  if (!rawText || rawText.trim().length === 0) {
    throw new Error('文件内容为空或无法提取文本');
  }

  // 3. Split into chunks
  var chunks = splitChunks(rawText);

  if (chunks.length === 0) throw new Error('无法分段，文件内容可能太短');

  // 4. Save document record
  var docId = uuid();
  var fileSize = 0;
  try { var stat = require('fs').statSync(filePath); fileSize = stat.size; } catch (e) {}

  db.prepare(
    'INSERT INTO documents (id, user_id, filename, file_type, file_size, chunk_count) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(docId, userId, filename, fileType, fileSize, chunks.length);

  // 5. Get user API config for embeddings
  var user = db.prepare('SELECT api_key, api_base, model FROM users WHERE id = ?').get(userId);
  if (!user || !user.api_key) throw new Error('请先在设置中配置 API Key');
  var apiKey = decrypt(user.api_key);
  if (!apiKey) throw new Error('API Key 解密失败，请重新设置');
  var apiBase = user.api_base || 'https://api.deepseek.com/v1/chat/completions';
  var model = user.model || 'deepseek-chat';

  // 6. Get embeddings for all chunks (batch)
  try {
    var embeddings = await getEmbeddings(chunks, apiKey, apiBase, model);

    // 7. Save chunks with embeddings
    var insertChunk = db.prepare(
      'INSERT INTO chunks (id, document_id, chunk_index, content, embedding, token_count) VALUES (?, ?, ?, ?, ?, ?)'
    );

    var insertAll = db.transaction(function () {
      for (var i = 0; i < chunks.length; i++) {
        var embJson = embeddings[i] ? JSON.stringify(embeddings[i]) : null;
        insertChunk.run(uuid(), docId, i, chunks[i], embJson, Math.ceil(chunks[i].length / 2));
      }
    });

    insertAll();
  } catch (e) {
    // Clean up document record on failure
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
    throw new Error('向量化失败: ' + e.message);
  }

  // Clean up uploaded file
  try { unlinkSync(filePath); } catch (e) {}

  return db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
}

/**
 * Search documents for relevant chunks.
 * Uses cosine similarity on stored embeddings.
 */
export async function searchDocuments(userId, query) {
  var db = getDb();

  var user = db.prepare('SELECT api_key, api_base, model FROM users WHERE id = ?').get(userId);
  if (!user || !user.api_key) throw new Error('请先配置 API Key');
  var apiKey = decrypt(user.api_key);
  if (!apiKey) throw new Error('API Key 解密失败');
  var apiBase = user.api_base || 'https://api.deepseek.com/v1/chat/completions';
  var model = user.model || 'deepseek-chat';

  // Get query embedding
  var { getEmbedding, cosineSimilarity } = require('./embedding.service.js');
  var queryEmbedding = await getEmbedding(query, apiKey, apiBase, model);
  if (!queryEmbedding) throw new Error('查询向量化失败');

  // Get all chunks for this user's documents
  var chunks = db.prepare(
    'SELECT c.id, c.content, c.embedding, c.chunk_index, d.filename, d.id as doc_id ' +
    'FROM chunks c JOIN documents d ON c.document_id = d.id ' +
    'WHERE d.user_id = ?'
  ).all(userId);

  if (chunks.length === 0) return [];

  // Calculate similarities
  var scored = [];
  for (var i = 0; i < chunks.length; i++) {
    var emb = null;
    try {
      if (chunks[i].embedding) emb = JSON.parse(chunks[i].embedding);
    } catch (e) {}
    if (!emb) continue;

    var score = cosineSimilarity(queryEmbedding, emb);
    scored.push({
      chunk_id: chunks[i].id,
      document_id: chunks[i].doc_id,
      filename: chunks[i].filename,
      chunk_index: chunks[i].chunk_index,
      content: chunks[i].content,
      score: score,
    });
  }

  // Sort by similarity descending, take top 5
  scored.sort(function (a, b) { return b.score - a.score; });
  var top = scored.slice(0, 5);

  return top.map(function (s) {
    return {
      filename: s.filename,
      content: s.content,
      score: Math.round(s.score * 100) / 100,
    };
  });
}

/**
 * Delete a document and all its chunks.
 */
export function deleteDocument(docId, userId) {
  var db = getDb();
  var doc = db.prepare('SELECT * FROM documents WHERE id = ? AND user_id = ?').get(docId, userId);
  if (!doc) throw new Error('文档不存在');
  db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
  return { success: true };
}

// ============================================================
// Internal helpers
// ============================================================

function detectFileType(filename, mimetype) {
  var ext = filename.split('.').pop().toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'txt' || ext === 'text') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  // Fallback to mimetype
  if (mimetype && mimetype.includes('pdf')) return 'pdf';
  if (mimetype && (mimetype.includes('text/plain') || mimetype.includes('text/markdown'))) return 'txt';
  return null;
}

function extractText(filePath, fileType) {
  if (fileType === 'txt' || fileType === 'md') {
    return readFileSync(filePath, 'utf-8');
  }

  if (fileType === 'pdf') {
    return extractPdfText(filePath);
  }

  return null;
}

/**
 * Simple PDF text extraction.
 * Parses raw PDF content — handles text-only PDFs.
 * For scanned/image PDFs, will return empty (OCR not supported yet).
 */
function extractPdfText(filePath) {
  try {
    var buf = readFileSync(filePath);
    var content = buf.toString('utf-8');

    // Try to find text between stream/endstream markers
    // This is a basic approach — works for many text PDFs
    var text = '';

    // Remove binary data, extract readable text
    // Find "BT" ... "ET" blocks (Begin Text / End Text in PDF)
    var btRegex = /BT\s*([\s\S]*?)\s*ET/g;
    var match;
    while ((match = btRegex.exec(content)) !== null) {
      var block = match[1];
      // Extract text between parentheses: (Hello World)
      var tRegex = /\(([^)]*)\)/g;
      var tMatch;
      while ((tMatch = tRegex.exec(block)) !== null) {
        text += tMatch[1];
      }
      text += '\n';
    }

    // If BT/ET method found nothing, try raw content scraping
    if (!text.trim()) {
      // Try to find any readable ASCII strings
      var parts = content.split(/[\x00-\x08\x0E-\x1F]/);
      var readable = [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p.length > 10 && /^[\x20-\x7E一-鿿　-〿＀-￯\n\r\t]+/.test(p)) {
          readable.push(p.replace(/[^\x20-\x7E一-鿿　-〿＀-￯\n\r\t]/g, ' '));
        }
      }
      text = readable.join(' ');
    }

    // If still empty, try extracting stream contents
    if (!text.trim()) {
      var streamRegex = /stream\s*([\s\S]*?)\s*endstream/g;
      var sMatch;
      while ((sMatch = streamRegex.exec(content)) !== null) {
        var sContent = sMatch[1];
        // Try to decompress FlateDecode
        // For now, extract readable portions
        var readable2 = sContent.replace(/[^\x20-\x7E一-鿿　-〿＀-￯\n\r]/g, ' ');
        if (readable2.trim().length > 20) {
          text += readable2 + '\n';
        }
      }
    }

    return text.trim();
  } catch (e) {
    throw new Error('PDF 解析失败: ' + e.message);
  }
}

function splitChunks(text) {
  // First, try to split by double newlines (paragraphs)
  var paragraphs = text.split(/\n\s*\n/);
  var chunks = [];
  var current = '';

  for (var i = 0; i < paragraphs.length; i++) {
    var p = paragraphs[i].trim();
    if (!p) continue;

    if (current.length + p.length < MAX_CHUNK_SIZE) {
      current += (current ? '\n\n' : '') + p;
    } else {
      // Current chunk is full, save it
      if (current) {
        chunks.push(current.trim());
        // Keep overlap
        var words = current.split('');
        current = words.slice(-CHUNK_OVERLAP).join('');
      }

      // If the paragraph itself is longer than MAX_CHUNK_SIZE, split by sentences
      if (p.length > MAX_CHUNK_SIZE) {
        var subChunks = splitLongText(p);
        for (var j = 0; j < subChunks.length; j++) {
          chunks.push(subChunks[j]);
        }
        current = '';
      } else {
        current = p;
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());

  // Filter out very short chunks
  return chunks.filter(function (c) { return c.length >= 20; });
}

function splitLongText(text) {
  var chunks = [];
  // Split by sentence boundary
  var sentences = text.split(/(?<=[。！？.!?])\s*/);
  var current = '';

  for (var i = 0; i < sentences.length; i++) {
    var s = sentences[i].trim();
    if (!s) continue;

    if (current.length + s.length < MAX_CHUNK_SIZE) {
      current += s;
    } else {
      if (current) {
        chunks.push(current.trim());
        current = s;
      } else {
        // Single sentence is too long, force split
        for (var j = 0; j < s.length; j += MAX_CHUNK_SIZE) {
          chunks.push(s.slice(j, j + MAX_CHUNK_SIZE));
        }
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
