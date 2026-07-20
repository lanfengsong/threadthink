/* ============================================================
   ThreadThink — Document Management Module
   ============================================================ */

import { getToken } from './auth.js';

/** Upload a file to the server */
export async function uploadFile(file) {
  var token = getToken();
  if (!token) throw new Error('未登录');

  var form = new FormData();
  form.append('file', file);

  var resp = await fetch('/api/documents/upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: form,
  });

  var data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '上传失败');
  return data.document;
}

/** Fetch list of uploaded documents */
export async function fetchDocuments() {
  var token = getToken();
  if (!token) throw new Error('未登录');

  var resp = await fetch('/api/documents', {
    headers: { 'Authorization': 'Bearer ' + token },
  });

  var data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '获取文档列表失败');
  return data.documents;
}

/** Delete a document by ID */
export async function deleteDocument(id) {
  var token = getToken();
  if (!token) throw new Error('未登录');

  var resp = await fetch('/api/documents/' + id, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token },
  });

  if (!resp.ok) {
    var data = await resp.json();
    throw new Error(data.error || '删除失败');
  }
}

/** Render document list in the UI */
export function renderDocumentList(docs) {
  var listEl = document.getElementById('documentList');
  if (!listEl) return;

  if (!docs || docs.length === 0) {
    listEl.innerHTML = '<div class="doc-empty">暂无文档<br><small>拖拽或点击上传</small></div>';
    return;
  }

  var html = '';
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    var icon = d.file_type === 'pdf' ? '📄' : '📝';
    var size = formatFileSize(d.file_size);
    html += '<div class="doc-item" data-doc-id="' + d.id + '">' +
      '<span class="doc-icon">' + icon + '</span>' +
      '<div class="doc-info">' +
        '<span class="doc-name">' + escapeHTML(d.filename) + '</span>' +
        '<span class="doc-meta">' + d.chunk_count + ' 片段 · ' + size + '</span>' +
      '</div>' +
      '<button class="doc-delete" data-doc-id="' + d.id + '" title="删除">×</button>' +
    '</div>';
  }
  listEl.innerHTML = html;
}

function escapeHTML(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return Math.round(bytes / 1024 / 1024 * 10) / 10 + ' MB';
}
