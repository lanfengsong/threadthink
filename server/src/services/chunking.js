/* ============================================================
   ThreadThink Server — Document Chunking

   Retrieval units are natural paragraphs.  Regular paragraphs are
   never merged and never overlapped; only a paragraph longer than
   MAX_CHUNK_SIZE is split at sentence boundaries, and the overlap
   stays inside that one paragraph.

   Markdown files may carry a heading path (# .. ######) which is
   attached to each following paragraph as embedding context.
   Headings themselves never become chunks, and `#` inside fenced
   code blocks is not treated as a heading.
   ============================================================ */

var MAX_CHUNK_SIZE = 1000;
var CHUNK_OVERLAP = 100;
var MIN_TEXT_LENGTH = 20;
var SENTENCE_BOUNDARY = /[。！？.!?]/;

/** Legacy interface: plain-text strings without metadata. */
export function splitChunks(text) {
  return chunkDocument(text, { isMarkdown: false }).map(function (chunk) {
    return chunk.content;
  });
}

/**
 * Split a document into retrieval units with metadata.
 *
 * options.isMarkdown — parse `#`..`######` headings into a section path.
 * Plain text never treats `#` as a heading.
 *
 * Each chunk: { content, embeddingText, sectionPath, paragraphIndex,
 *               isOverflowSplit }.
 */
export function chunkDocument(text, options) {
  if (typeof text !== 'string' || text.trim().length < MIN_TEXT_LENGTH) return [];
  var isMarkdown = !!(options && options.isMarkdown);
  var lines = text.replace(/\r\n?/g, '\n').split('\n');

  var chunks = [];
  var headingStack = []; // [{ level, text }] — marks the current section
  var current = [];      // lines of the paragraph being built
  var inFence = false;
  var paragraphIndex = 0;

  function sectionPath() {
    return headingStack.map(function (heading) { return heading.text; }).join(' / ');
  }

  function flush() {
    if (current.length === 0) return;
    // Join soft-wrapped lines, strip trailing spaces, and trim the edges.
    var content = current.join('\n').replace(/[ \t]+$/gm, '').trim();
    current = [];
    if (!content) return;
    var path = isMarkdown ? sectionPath() : '';
    var pieces = splitOversized(content, path, paragraphIndex);
    for (var i = 0; i < pieces.length; i++) chunks.push(pieces[i]);
    paragraphIndex++;
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!isMarkdown) {
      if (/^\s*$/.test(line)) { flush(); continue; }
      current.push(line);
      continue;
    }
    if (!inFence && /^[`~]{3,}/.test(line)) { // code fence opener
      flush();
      inFence = true;
      continue;
    }
    if (inFence) {
      if (/^[`~]{3,}\s*$/.test(line)) { flush(); inFence = false; } // closer
      else current.push(line);
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); continue; }
    var heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      var level = heading[1].length;
      // Same or shallower heading replaces the previous entry at that level;
      // a deeper heading appends to the current section.
      while (headingStack.length >= level) headingStack.pop();
      headingStack.push({ level: level, text: heading[2].replace(/\s+#+\s*$/, '').trim() });
      continue;
    }
    current.push(line);
  }
  flush();
  return chunks;
}

/**
 * One natural paragraph -> one chunk.  Only a paragraph longer than
 * MAX_CHUNK_SIZE is split: prefer the last sentence boundary in the window
 * (never closer than half a window, so every piece makes progress), falling
 * back to a hard character cut for a single oversized sentence.  Overlap is
 * applied only between sub-chunks of this same paragraph.
 */
function splitOversized(content, path, paragraphIndex) {
  if (content.length <= MAX_CHUNK_SIZE) {
    return [{
      content: content,
      embeddingText: path ? path + '\n' + content : content,
      sectionPath: path,
      paragraphIndex: paragraphIndex,
      isOverflowSplit: false,
    }];
  }
  var pieces = [];
  var start = 0;
  while (start < content.length) {
    var end = Math.min(start + MAX_CHUNK_SIZE, content.length);
    if (end < content.length) {
      var cut = lastSentenceCut(content, start, end);
      if (cut !== null) end = cut;
    }
    var piece = content.slice(start, end);
    pieces.push({
      content: piece,
      embeddingText: path ? path + '\n' + piece : piece,
      sectionPath: path,
      paragraphIndex: paragraphIndex,
      isOverflowSplit: true,
    });
    if (end === content.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return pieces;
}

/** Last sentence boundary in [start, end), or null. */
function lastSentenceCut(text, start, end) {
  var minCut = start + Math.floor(MAX_CHUNK_SIZE / 2);
  for (var i = end - 1; i >= minCut; i--) {
    if (SENTENCE_BOUNDARY.test(text[i])) return i + 1;
  }
  return null;
}