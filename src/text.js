/* ============================================================
   ThreadThink — Inline Text Utilities

   Shared by markdown.js (rendering) and blocks.js (parsing).
   Kept separate so the two can depend on it without circular
   imports.
   ============================================================ */

import { escapeHTML } from './utils.js';

/** Escape then apply inline Markdown: **bold**, *italic*, `code`. */
export function inline(text) {
  var p = escapeHTML(text);
  p = p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  p = p.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
  p = p.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
  return p;
}

/** Strip markdown formatting chars from text (for matching raw → rendered). */
export function stripMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1')
             .replace(/^#{1,4}\s/gm, '').replace(/^[-*]\s/gm, '').replace(/^\d+\.\s/gm, '');
}