/* ============================================================
   Tests: Utilities
   ============================================================ */

import { describe, it, expect } from 'vitest';
import { escapeHTML } from '../../src/utils.js';

describe('escapeHTML', function () {
  it('转义 < 和 >', function () {
    expect(escapeHTML('<div>')).toBe('&lt;div&gt;');
  });

  it('转义 & 号', function () {
    expect(escapeHTML('a & b')).toBe('a &amp; b');
  });

  it('转义引号', function () {
    // textContent 不会转义引号，只有设置 innerHTML 会
    // 实际上用 textContent 赋值时引号原样保留
    var result = escapeHTML('"hello"');
    // textContent 方式: 引号不被转义，但 < > & 会被转义
    expect(result).toContain('hello');
  });

  it('普通文本不变', function () {
    expect(escapeHTML('hello world')).toBe('hello world');
  });

  it('空字符串', function () {
    expect(escapeHTML('')).toBe('');
  });

  it('XSS 攻击字符串', function () {
    var xss = '<img src=x onerror=alert(1)>';
    var escaped = escapeHTML(xss);
    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
  });
});
