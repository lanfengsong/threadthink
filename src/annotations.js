/* ============================================================
   ThreadThink — Annotation Tree Helpers
   ============================================================ */

import { getMessages } from './state.js';

/** Character offset of (container, offset) within element el. */
export function offsetInElement(el, container, offset) {
  var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  var n, cp = 0;
  while ((n = w.nextNode())) {
    if (n === container) return cp + offset;
    cp += n.textContent.length;
  }
  return cp;
}

/**
 * Map a DOM selection range to a block anchor (design 4.2).
 * Returns { blockId, start, end, textHash } when the whole selection
 * falls inside a single data-block-id container; null when it spans
 * blocks (caller falls back to quote search).
 */
export function selectionToAnchor(range) {
  if (!range || !range.startContainer) return null;
  var startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
  if (!startEl || !startEl.closest) return null;
  var blockEl = startEl.closest('[data-block-id]');
  if (!blockEl) return null;
  var endEl = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer;
  if (!endEl || !endEl.closest || endEl.closest('[data-block-id]') !== blockEl) return null; // spans blocks

  var start = offsetInElement(blockEl, range.startContainer, range.startOffset);
  var end = offsetInElement(blockEl, range.endContainer, range.endOffset);
  if (end <= start) return null;
  var text = blockEl.textContent.slice(start, end);
  if (!text.trim()) return null;
  return { blockId: blockEl.dataset.blockId, start: start, end: end, textHash: hashText(text) };
}

/** FNV-1a (matches server-side anchor hashing semantics; sync, no crypto). */
export function hashText(text) {
  var h = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

export function findAnnotationById(id) {
  var messages = getMessages();
  for (var i = 0; i < messages.length; i++) {
    var anns = messages[i].annotations; if (!anns) continue;
    for (var j = 0; j < anns.length; j++) { var f = findAnnRec(anns[j], id); if (f) return f; }
  }
  return null;
}

export function findAnnRec(a, id) {
  if (a.id === id) return a;
  if (a.annotations) for (var i = 0; i < a.annotations.length; i++) { var f = findAnnRec(a.annotations[i], id); if (f) return f; }
  return null;
}

export function findParentMessage(annId) {
  var messages = getMessages();
  for (var i = 0; i < messages.length; i++) {
    var anns = messages[i].annotations; if (!anns) continue;
    for (var j = 0; j < anns.length; j++) { if (hasAnn(anns[j], annId)) return messages[i]; }
  }
  return null;
}

export function hasAnn(a, id) {
  if (a.id === id) return true;
  if (a.annotations) for (var i = 0; i < a.annotations.length; i++) { if (hasAnn(a.annotations[i], id)) return true; }
  return false;
}

export function buildAnnotationContext(msgId) {
  var messages = getMessages();
  var ctx = [];
  for (var i = 0; i < messages.length; i++) { ctx.push({ role: messages[i].role, content: messages[i].content }); if (messages[i].id === msgId) break; }
  return ctx;
}
