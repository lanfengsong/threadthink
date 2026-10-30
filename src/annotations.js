/* ============================================================
   ThreadThink — Annotation Tree Helpers
   ============================================================ */

import { getMessages } from './state.js';

/** Decorations never participate in anchor coordinates. */
export function annotationTextNodes(root) {
  var nodes = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), node;
  while ((node = walker.nextNode())) {
    if (!node.parentElement?.closest('.ann-badge, .tool-call, .typing-indicator, [data-decoration]')) nodes.push(node);
  }
  return nodes;
}

export function annotationText(root) {
  return annotationTextNodes(root).map(function (node) { return node.textContent; }).join('');
}

/** Range boundaries can reference text nodes or element child indexes. */
export function offsetInElement(el, container, offset) {
  if (container !== el && !el.contains(container)) return -1;
  var prefix = document.createRange();
  prefix.selectNodeContents(el);
  prefix.setEnd(container, offset);
  return annotationText(prefix.cloneContents()).length;
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
  var text = annotationText(blockEl).slice(start, end);
  if (!text.trim()) return null;
  return { blockId: blockEl.dataset.blockId, start: start, end: end, textHash: hashText(text) };
}

/** Recover a block anchor from source-text offsets after a quote fallback. */
export function anchorForOffsets(root, start, end) {
  var nodes = annotationTextNodes(root), position = 0, range = document.createRange(), foundStart = false;
  for (var node of nodes) {
    var next = position + node.textContent.length;
    if (!foundStart && start < next) { range.setStart(node, start - position); foundStart = true; }
    if (foundStart && end <= next) { range.setEnd(node, end - position); return selectionToAnchor(range); }
    position = next;
  }
  return null;
}

/** SHA-1 over UTF-8. Synchronous so rendering/replay cannot race an async digest. */
export function hashText(text) {
  var input = new TextEncoder().encode(text), length = input.length;
  var bytes = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  bytes.set(input); bytes[length] = 0x80;
  var view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(bytes.length - 4, (length * 8) >>> 0);
  var hash = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0], words = new Uint32Array(80);
  function rotate(value, shift) { return (value << shift) | (value >>> (32 - shift)); }
  for (var offset = 0; offset < bytes.length; offset += 64) {
    for (var i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (i = 16; i < 80; i++) words[i] = rotate(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    var [a, b, c, d, e] = hash;
    for (i = 0; i < 80; i++) {
      var f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      var next = (rotate(a, 5) + f + e + k + words[i]) >>> 0;
      e = d; d = c; c = rotate(b, 30); b = a; a = next;
    }
    [a, b, c, d, e].forEach(function (value, index) { hash[index] = (hash[index] + value) >>> 0; });
  }
  return hash.map(function (word) { return word.toString(16).padStart(8, '0'); }).join('');
}

/** Old persisted anchors used this FNV variant; accept it without rewriting old rows. */
export function matchesTextHash(text, fingerprint) {
  if (!fingerprint) return true;
  if (fingerprint.length === 40) return hashText(text) === fingerprint.toLowerCase();
  var hash = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = (hash * 0x01000193) >>> 0; }
  return fingerprint === ('0000000' + hash.toString(16)).slice(-8);
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
