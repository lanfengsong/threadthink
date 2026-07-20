/* ============================================================
   Tests: Cosine Similarity
   ============================================================ */

import { describe, it, expect } from 'vitest';
import { cosineSimilarity } from '../../server/src/services/embedding.service.js';

describe('cosineSimilarity', function () {
  it('相同向量返回 1', function () {
    var a = [1, 2, 3];
    var b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('正方向量返回 0', function () {
    var a = [1, 0, 0];
    var b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('相反向量返回 -1', function () {
    var a = [1, 0];
    var b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('空数组返回 0', function () {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('不等长度返回 0', function () {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('空值输入返回 0', function () {
    expect(cosineSimilarity(null, [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], undefined)).toBe(0);
  });

  it('一般情况计算正确', function () {
    var a = [0.5, 0.3, 0.2];
    var b = [0.6, 0.2, 0.1];
    // 手算: dot=0.38, |a|≈0.616, |b|≈0.640, cos≈0.965
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.9);
    expect(cosineSimilarity(a, b)).toBeLessThan(1.0);
  });
});
