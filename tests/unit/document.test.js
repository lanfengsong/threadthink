/* ============================================================
   Tests: production document chunking
   ============================================================ */

import { describe, it, expect } from 'vitest';
import { splitChunks } from '../../server/src/services/chunking.js';

describe('splitChunks', function () {
  it('空文本返回空数组', function () {
    expect(splitChunks('')).toEqual([]);
  });

  it('短文本返回一个块', function () {
    var result = splitChunks('这是一个简短的测试句子，用于验证分段和内容。');
    expect(result.length).toBe(1);
    expect(result[0]).toBe('这是一个简短的测试句子，用于验证分段和内容。');
  });

  it('段落按换行分组', function () {
    var text = `第一段内容比较长，用于测试文档分块功能是否正常工作。

第二段内容也足够长，用于确认段落会合并到同一个块中。`;
    var result = splitChunks(text);
    expect(result.length).toBe(1);
    expect(result[0]).toContain('第一段');
    expect(result[0]).toContain('第二段');
  });

  it('太短的片段被过滤', function () {
    expect(splitChunks('a')).toEqual([]);
  });

  it('超长单句被强制分割且不超过上限', function () {
    var long = '';
    for (var i = 0; i < 2000; i++) long += 'x';
    var result = splitChunks(long);
    expect(result.length).toBeGreaterThan(1);
    for (var j = 0; j < result.length; j++) {
      expect(result[j].length).toBeLessThanOrEqual(1000);
    }
    expect(result[0].slice(-100)).toBe(result[1].slice(0, 100));
  });

  it('accounts for paragraph separators at the exact size boundary', function () {
    var first = 'a'.repeat(498);
    var second = 'b'.repeat(498);
    var result = splitChunks(first + '\n\n' + second);
    expect(result).toHaveLength(1);
    expect(result[0].length).toBe(998);

    var third = 'c'.repeat(499);
    result = splitChunks(first + '\n\n' + third);
    expect(result.every(function (chunk) { return chunk.length <= 1000; })).toBe(true);
  });

  it('keeps overlap when an oversized sentence follows an earlier paragraph', function () {
    var prefix = 'p'.repeat(900);
    var long = 'q'.repeat(1800);
    var result = splitChunks(prefix + '\n\n' + long);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every(function (chunk) { return chunk.length <= 1000; })).toBe(true);
    expect(result[0].slice(-100)).toBe(result[1].slice(0, 100));
  });

  it('普通多段落中文文本', function () {
    var text = '人工智能是计算机科学的一个分支。它企图了解智能的实质。\n\n机器学习是AI的一个子集。它使用统计方法。\n\n深度学习使用多层神经网络。';
    var result = splitChunks(text);
    expect(result.length).toBe(1);
    expect(result[0].length).toBeGreaterThan(50);
  });
});
