/* ============================================================
   ThreadThink — Message Block Parser

   Parses an assistant message (Markdown source) into stable
   semantic blocks.  Each block is the anchor container for
   annotations (design 4.2): block id is deterministic (same
   content -> same id), text is pure (Markdown syntax stripped),
   so a selection maps to (blockId, start, end) exactly.

   The parsing rules mirror markdown.js's renderMarkdown 1:1 so
   the block stream stays consistent with what the user sees.
   ============================================================ */

import { stripMarkdown } from './text.js';

/** FNV-1a 32-bit hash -> 8 hex chars. Deterministic, no random ids. */
function hash(text) {
  var h = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

/** Content identity survives inserting, deleting or reordering other blocks. */
function blockId(occurrence, type, text) {
  return 'b' + hash(type + '|' + text) + '-' + occurrence;
}

/**
 * Parse a Markdown message into blocks.
 * Each block: { id, type, text, gap } where type is one of:
 *   'p'  paragraph | 'h2'..'h5' headings (# .. ####) | 'pre' fenced code
 *   | 'ul' '-'/'*' list item | 'ol' 'N.' list item
 * `gap` = a blank line preceded this block (rendering uses it to
 * split consecutive list items into separate groups).
 * Blank lines are separators; fenced code '#...' is code, not a heading.
 */
export function parseBlocks(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];
  var lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  var blocks = [];
  var inFence = false;
  var fenceLines = [];
  var blank = false;
  var occurrences = new Map();

  function push(type, text) {
    var key = type + '|' + text;
    var occurrence = occurrences.get(key) || 0;
    occurrences.set(key, occurrence + 1);
    blocks.push({ id: blockId(occurrence, type, text), type: type, text: text, gap: blank });
    blank = false;
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^```/.test(line)) {
      if (inFence) {
        // Code is code: keep it verbatim, never strip Markdown markers
        // (a '#' inside a fence is not a heading and must survive).
        push('pre', fenceLines.join('\n').trim());
        fenceLines = [];
        inFence = false;
      } else {
        inFence = true;
      }
      continue;
    }
    if (inFence) { fenceLines.push(line); continue; }
    if (!line.trim()) { blank = true; continue; }

    var text = line; // keep inline markers (**bold**, `code`) for the renderer;
    // block-level prefixes are stripped in the push() calls below; inline
    // stripping happens in the anchor/compare layer (stripMarkdown).
    if (/^#### /.test(line)) push('h5', text.replace(/^#### /, ''));
    else if (/^### /.test(line)) push('h4', text.replace(/^### /, ''));
    else if (/^## /.test(line)) push('h3', text.replace(/^## /, ''));
    else if (/^# /.test(line)) push('h2', text.replace(/^# /, ''));
    else if (/^\d+\.\s/.test(line)) push('ol', text.replace(/^\d+\.\s/, ''));
    else if (/^[-*]\s/.test(line)) push('ul', text.replace(/^[-*]\s/, ''));
    else push('p', text);
  }
  // Unterminated fence: mirror renderMarkdown (flush what was collected).
  if (inFence) push('pre', fenceLines.join('\n').trim());
  return blocks;
}

/** Map a whole-message offset to a block-internal range. Offsets are
 *  measured on the rendered (markdown-stripped) text, i.e. what the
 *  user sees — so block lengths are compared after stripping. */
export function findBlockByRange(blocks, offset, length) {
  var pos = 0;
  for (var i = 0; i < blocks.length; i++) {
    var len = stripMarkdown(blocks[i].text).length;
    var start = pos, end = pos + len;
    if (offset >= start && offset + length <= end) {
      return { block: blocks[i], start: offset - start, end: offset - start + length };
    }
    pos = end; // textContent is contiguous across blocks, matching renderMarkdown
  }
  return null;
}