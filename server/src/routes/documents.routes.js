/* ============================================================
   ThreadThink Server — Documents Routes
   ============================================================ */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';
import { processDocument, deleteDocument } from '../services/document.service.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

var UPLOAD_DIR = resolve('data/uploads');

export function documentsRoutes(fastify, opts, done) {
  // Ensure upload dir
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

  // List documents
  fastify.get('/api/documents', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    var db = getDb();
    var docs = db.prepare(
      'SELECT id, filename, file_type, file_size, chunk_count, created_at FROM documents WHERE user_id = ? ORDER BY created_at DESC'
    ).all(request.user.id);
    reply.send({ documents: docs });
  });

  // Upload document
  fastify.post('/api/documents/upload', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }

    try {
      var data = await request.file();
      if (!data) { reply.code(400).send({ error: '未选择文件' }); return; }

      var buffer = await data.toBuffer();
      var filename = data.filename;
      var mimetype = data.mimetype;

      // Validate file type by extension
      var ext = filename.split('.').pop().toLowerCase();
      if (['pdf','txt','md','markdown','text'].indexOf(ext) === -1) {
        reply.code(400).send({ error: '不支持的文件类型，请上传 PDF/TXT/Markdown 文件' });
        return;
      }

      // Validate file size (10MB max)
      var MAX_SIZE = 10 * 1024 * 1024;
      if (buffer.length > MAX_SIZE) {
        reply.code(400).send({ error: '文件过大，最大支持 10MB' });
        return;
      }

      // Save to disk temporarily
      var tempPath = resolve(UPLOAD_DIR, uuid() + '_' + filename);
      writeFileSync(tempPath, buffer);

      // Process document (extract text, chunk, embed, store)
      var doc = await processDocument(tempPath, filename, mimetype, request.user.id);

      reply.code(201).send({ document: doc });
    } catch (e) {
      reply.code(400).send({ error: e.message });
    }
  });

  // Delete document
  fastify.delete('/api/documents/:id', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    try {
      var result = deleteDocument(request.params.id, request.user.id);
      reply.send(result);
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  done();
}
