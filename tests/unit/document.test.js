/* ============================================================
   Tests: splitChunks (document processing)
   ============================================================ */

import { describe, it, expect } from 'vitest';

// Manually extract splitChunks for testing since it's not exported
function splitChunks(text) {
  var MAX_CHUNK_SIZE = 1000;
  var CHUNK_OVERLAP = 100;

  var paragraphs = text.split(/\n\s*\n/);
  var chunks = [];
  var current = '';

  for (var i = 0; i < paragraphs.length; i++) {
    var p = paragraphs[i].trim();
    if (!p) continue;

    if (current.length + p.length < MAX_CHUNK_SIZE) {
      current += (current ? '\n\n' : '') + p;
    } else {
      if (current) {
        chunks.push(current.trim());
        var words = current.split('');
        current = words.slice(-CHUNK_OVERLAP).join('');
      }

      if (p.length > MAX_CHUNK_SIZE) {
        var subChunks = splitLongText(p, MAX_CHUNK_SIZE);
        for (var j = 0; j < subChunks.length; j++) {
          chunks.push(subChunks[j]);
        }
        current = '';
      } else {
        current = p;
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(function (c) { return c.length >= 20; });
}

function splitLongText(text, maxSize) {
  var chunks = [];
  var sentences = text.split(/(?<=[。！？.!?])\s*/);
  var current = '';

  for (var i = 0; i < sentences.length; i++) {
    var s = sentences[i].trim();
    if (!s) continue;

    if (current.length + s.length < maxSize) {
      current += s;
    } else {
      if (current) {
        chunks.push(current.trim());
        current = s;
      } else {
        for (var j = 0; j < s.length; j += maxSize) {
          chunks.push(s.slice(j, j + maxSize));
        }
      }
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

describe('splitChunks', function () {
  it('空文本返回空数组', function () {
    expect(splitChunks('')).toEqual([]);
  });

  it('短文本返回一个块', function () {
    var result = splitChunks('这是一个简短的测试句子，用于验证分段和内容。');
    expect(result.length).toBe(1);
    expect(result[0]).toBe('这是一个简短的测试句子，用于验证分段和内容。');
  });

  it('段落按 \n\n 分割', function () {
    var text = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
    var result = splitChunks(text);
    expect(result.length).toBe(1);
    expect(result[0]).toContain('第一段');
    expect(result[0]).toContain('第二段');
  });

  it('太短的片段被过滤', function () {
    var result = splitChunks('a');
    expect(result.length).toBe(0);
  });

  it('超长单句被强制分割', function () {
    var long = '';
    for (var i = 0; i < 2000; i++) long += 'x';
    var result = splitChunks(long);
    expect(result.length).toBeGreaterThan(1);
    // 每块不应超过 1000 字符
    for (var j = 0; j < result.length; j++) {
      expect(result[j].length).toBeLessThanOrEqual(1000);
    }
  });

  it('普通多段落中文文本', function () {
    var text = '人工智能是计算机科学的一个分支。它企图了解智能的实质。\n\n机器学习是AI的一个子集。它使用统计方法。\n\n深度学习使用多层神经网络。';
    var result = splitChunks(text);
    expect(result.length).toBe(1);
    expect(result[0].length).toBeGreaterThan(50);
  });
});
