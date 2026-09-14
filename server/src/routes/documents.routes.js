/* ============================================================
   ThreadThink Server — Documents Routes
   ============================================================ */

import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';
import { processDocument, deleteDocument } from '../services/document.service.js';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { resolve, basename } from 'path';

export function documentsRoutes(fastify, opts, done) {
  var uploadDir = resolve((opts && opts.uploadDir) || process.env.UPLOAD_DIR || 'data/uploads');
  if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

  fastify.get('/api/documents', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    var docs = getDb().prepare(
      'SELECT id, filename, file_type, file_size, chunk_count, created_at FROM documents WHERE user_id = ? ORDER BY created_at DESC'
    ).all(request.user.id);
    reply.send({ documents: docs });
  });

  fastify.post('/api/documents/upload', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    var tempPath = null;
    try {
      var data = await request.file({ preservePath: true });
      if (!data) { reply.code(400).send({ error: '未选择文件' }); return; }

      var filename = data.filename;
      var mimetype = data.mimetype;
      var safeName = basename(filename || '');
      if (!filename || filename === '.' || filename === '..' ||
          filename !== safeName || /[\\/]/.test(filename)) {
        reply.code(400).send({ error: '文件名包含非法字符' }); return;
      }

      var ext = filename.split('.').pop().toLowerCase();
      var mimeByExt = {
        pdf: ['application/pdf'],
        txt: ['text/plain'], text: ['text/plain'],
        md: ['text/markdown', 'text/x-markdown'], markdown: ['text/markdown', 'text/x-markdown'],
      };
      if (!mimeByExt[ext]) {
        reply.code(400).send({ error: '不支持的文件类型，请上传 PDF/TXT/Markdown 文件' }); return;
      }
      if (mimeByExt[ext].indexOf(mimetype) === -1) {
        reply.code(400).send({ error: '文件扩展名与 MIME 类型不匹配' }); return;
      }

      var buffer = await data.toBuffer();
      if (!buffer || buffer.length === 0) {
        reply.code(400).send({ error: '文件内容为空' }); return;
      }
      if (buffer.length > 10 * 1024 * 1024) {
        reply.code(400).send({ error: '文件过大，最大支持 10MB' }); return;
      }

      tempPath = resolve(uploadDir, uuid() + '_' + safeName);
      writeFileSync(tempPath, buffer, { flag: 'wx' });
      var doc = await processDocument(tempPath, safeName, mimetype, request.user.id);
      reply.code(201).send({ document: doc });
    } catch (e) {
      var tooLarge = e && (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.code === 'FST_FILES_LIMIT');
      reply.code(tooLarge ? 400 : 400).send({ error: tooLarge ? '文件过大，最大支持 10MB' : e.message });
    } finally {
      if (tempPath) { try { unlinkSync(tempPath); } catch (e) {} }
    }
  });

  fastify.delete('/api/documents/:id', async function (request, reply) {
    if (!request.user) { reply.code(401).send({ error: '未登录' }); return; }
    try {
      reply.send(deleteDocument(request.params.id, request.user.id));
    } catch (e) {
      reply.code(404).send({ error: e.message });
    }
  });

  done();
}
