/* ============================================================
   ThreadThink Server — Document Chunking
   ============================================================ */

var MAX_CHUNK_SIZE = 1000;
var CHUNK_OVERLAP = 100;

export function splitChunks(text) {
  if (typeof text !== 'string') return [];
  var normalized = text.split(/\n\s*\n/).map(function (paragraph) {
    return paragraph.trim();
  }).filter(Boolean).join('\n\n');
  if (normalized.length < 20) return [];

  var chunks = [];
  var start = 0;
  while (start < normalized.length) {
    var end = Math.min(start + MAX_CHUNK_SIZE, normalized.length);
    if (end < normalized.length) {
      // Prefer a paragraph or sentence boundary in the latter half of the
      // window. Otherwise hard-split, including oversized single sentences.
      var paragraphEnd = normalized.lastIndexOf('\n\n', end);
      if (paragraphEnd >= start + MAX_CHUNK_SIZE / 2) {
        end = paragraphEnd;
      } else {
        var window = normalized.slice(start, end);
        var boundaries = /[。！？.!?](?=\s|$)/g;
        var match;
        var sentenceEnd = 0;
        while ((match = boundaries.exec(window)) !== null) sentenceEnd = match.index + 1;
        if (sentenceEnd >= MAX_CHUNK_SIZE / 2) end = start + sentenceEnd;
      }
    }
    chunks.push(normalized.slice(start, end));
    if (end === normalized.length) break;
    // Keep the actual previous suffix, including whitespace, so no text is
    // lost and every continuation has exactly 100 characters of context.
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}
