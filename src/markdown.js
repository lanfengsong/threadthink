/* ============================================================
   ThreadThink — Markdown Renderer (block-based)

   renderMarkdown = renderBlocks(parseBlocks(text)): the parser
   (blocks.js) is the single source of truth for structure, and
   this file renders blocks to HTML with output identical to the
   previous line-based renderer (covered by tests).
   ============================================================ */

import { escapeHTML } from './utils.js';
import { inline, stripMarkdown } from './text.js';
import { parseBlocks } from './blocks.js';

export { stripMarkdown };

/** Render parsed blocks to HTML. Consecutive list items (no blank
 *  line between) form one <ul>/<ol> group; a `gap` block starts a
 *  new group (mirrors the line-based renderer's blank-line handling).
 *  Every block container carries data-block-id so selections can be
 *  mapped back to their anchor (block + offset). */
export function renderBlocks(blocks) {
  var h = '', i = 0;
  while (i < blocks.length) {
    var b = blocks[i], t = b.type;
    if (t === 'ul' || t === 'ol') {
      h += t === 'ul' ? '<ul>' : '<ol>';
      h += '<li data-block-id="' + b.id + '">' + inline(b.text) + '</li>';
      i++;
      while (i < blocks.length && blocks[i].type === t && !blocks[i].gap) {
        h += '<li data-block-id="' + blocks[i].id + '">' + inline(blocks[i].text) + '</li>';
        i++;
      }
      h += t === 'ul' ? '</ul>' : '</ol>';
    } else if (t === 'pre') {
      h += '<pre data-block-id="' + b.id + '"><code>' + escapeHTML(b.text) + '</code></pre>';
      i++;
    } else if (t === 'h2') { h += '<h2 data-block-id="' + b.id + '">' + inline(b.text) + '</h2>'; i++; }
    else if (t === 'h3') { h += '<h3 data-block-id="' + b.id + '">' + inline(b.text) + '</h3>'; i++; }
    else if (t === 'h4') { h += '<h4 data-block-id="' + b.id + '">' + inline(b.text) + '</h4>'; i++; }
    else if (t === 'h5') { h += '<h5 data-block-id="' + b.id + '">' + inline(b.text) + '</h5>'; i++; }
    else { h += '<p data-block-id="' + b.id + '">' + inline(b.text) + '</p>'; i++; }
  }
  return h;
}

/** Render a Markdown message to HTML (parse then render blocks). */
export function renderMarkdown(text) {
  if (!text) return '';
  return renderBlocks(parseBlocks(text));
}