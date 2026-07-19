/* ============================================================
   ThreadThink — Markdown Renderer
   ============================================================ */

import { escapeHTML } from './utils.js';

export function renderMarkdown(text) {
  if (!text) return '';
  var L = text.split('\n'), h = '', c = false, cd = '', il = false, lt = '';
  for (var i = 0; i < L.length; i++) {
    var l = L[i];
    if (/^```/.test(l)) { if (c) { h += '<pre><code>' + escapeHTML(cd.trim()) + '</code></pre>'; cd = ''; c = false; } else { c = true; } if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } continue; }
    if (c) { cd += l + '\n'; continue; }
    if (!l.trim()) { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } continue; }
    var p = escapeHTML(l);
    p = p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    p = p.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
    p = p.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
    if (/^#### (.+)/.test(l)) { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } h += '<h5>' + p.replace(/^#### /, '') + '</h5>'; }
    else if (/^### (.+)/.test(l)) { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } h += '<h4>' + p.replace(/^### /, '') + '</h4>'; }
    else if (/^## (.+)/.test(l)) { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } h += '<h3>' + p.replace(/^## /, '') + '</h3>'; }
    else if (/^# (.+)/.test(l)) { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } h += '<h2>' + p.replace(/^# /, '') + '</h2>'; }
    else if (/^\d+\.\s/.test(l)) { if (!il || lt !== 'ol') { if (il) h += '</ul>'; h += '<ol>'; il = true; lt = 'ol'; } h += '<li>' + p.replace(/^\d+\.\s/, '') + '</li>'; }
    else if (/^[-*]\s/.test(l)) { if (!il || lt !== 'ul') { if (il) h += '</ol>'; h += '<ul>'; il = true; lt = 'ul'; } h += '<li>' + p.replace(/^[-*]\s/, '') + '</li>'; }
    else { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } h += '<p>' + p + '</p>'; }
  }
  if (il) h += lt === 'ul' ? '</ul>' : '</ol>';
  if (c) h += '<pre><code>' + escapeHTML(cd.trim()) + '</code></pre>';
  return h;
}

/** Strip markdown formatting chars from text (for matching raw → rendered) */
export function stripMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1')
             .replace(/^#{1,4}\s/gm, '').replace(/^[-*]\s/gm, '').replace(/^\d+\.\s/gm, '');
}
