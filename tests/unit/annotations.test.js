import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { hashText, matchesTextHash, offsetInElement, selectionToAnchor, annotationText } from '../../src/annotations.js';
import { renderAnnotatedContent, locateByAnchor } from '../../src/renderer.js';
import { renderMarkdown } from '../../src/markdown.js';

function oldHash(text) {
  var hash = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = (hash * 0x01000193) >>> 0; }
  return ('0000000' + hash.toString(16)).slice(-8);
}

describe('annotation fingerprints', function () {
  it.each(['', 'abc', '中文引文', '🙂跨节点', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), 'long quote'.repeat(1000)])('matches SHA-1 for UTF-8 input %s', function (text) {
    expect(hashText(text)).toBe(createHash('sha1').update(text).digest('hex'));
  });

  it('accepts legacy FNV anchors without weakening the quote equality requirement', function () {
    var root = document.createElement('div'); root.innerHTML = renderMarkdown('legacy quote');
    var ann = { selectedText: 'legacy', blockId: root.firstChild.dataset.blockId, startOffset: 0, endOffset: 6, textHash: oldHash('legacy') };
    expect(matchesTextHash('legacy', ann.textHash)).toBe(true);
    expect(locateByAnchor(root, ann)).toEqual({ start: 0, end: 6 });
    expect(locateByAnchor(root, { ...ann, selectedText: 'other!' })).toBeNull();
    expect(matchesTextHash('changed', ann.textHash)).toBe(false);
  });
});

describe('selection coordinates', function () {
  it('resolves element child boundaries instead of counting to the end of the block', function () {
    var root = document.createElement('div'); root.innerHTML = '<p data-block-id="b">one <strong>two</strong> three</p>';
    var block = root.firstChild, range = document.createRange(); range.setStart(block, 1); range.setEnd(block, 2);
    expect(offsetInElement(block, block, 1)).toBe(4);
    expect(selectionToAnchor(range)).toEqual({ blockId: 'b', start: 4, end: 7, textHash: hashText('two') });
  });

  it('ignores existing badges in offsets and selected text fingerprints', function () {
    var root = document.createElement('div');
    root.appendChild(renderAnnotatedContent({ content: 'one two three', annotations: [{ id: 'a', selectedText: 'one', question: 'q' }] }));
    var block = root.firstChild, last = block.lastChild, range = document.createRange();
    range.setStart(last, 1); range.setEnd(last, 4);
    expect(annotationText(root)).toBe('one two three');
    expect(selectionToAnchor(range)).toEqual({ blockId: block.dataset.blockId, start: 4, end: 7, textHash: hashText('two') });
  });

  it('cross-block selections use quote recovery instead of a misleading block offset', function () {
    var root = document.createElement('div'); root.innerHTML = '<p data-block-id="a">one</p><p data-block-id="b">two</p>';
    var range = document.createRange(); range.setStart(root.firstChild.firstChild, 0); range.setEnd(root.lastChild.firstChild, 3);
    expect(selectionToAnchor(range)).toBeNull();
  });
});
