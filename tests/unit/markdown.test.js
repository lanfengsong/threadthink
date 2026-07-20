/* ============================================================
   Tests: Markdown Renderer
   ============================================================ */

import { describe, it, expect } from 'vitest';
import { renderMarkdown, stripMarkdown } from '../../src/markdown.js';

describe('stripMarkdown', function () {
  it('去除粗体标记', function () {
    expect(stripMarkdown('**hello**')).toBe('hello');
  });

  it('去除斜体标记', function () {
    expect(stripMarkdown('*world*')).toBe('world');
  });

  it('去除行内代码标记', function () {
    expect(stripMarkdown('`code`')).toBe('code');
  });

  it('去除标题标记', function () {
    expect(stripMarkdown('## 标题')).toBe('标题');
  });

  it('去除列表标记', function () {
    expect(stripMarkdown('- item')).toBe('item');
  });

  it('空字符串', function () {
    expect(stripMarkdown('')).toBe('');
  });
});

describe('renderMarkdown', function () {
  it('空输入返回空字符串', function () {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
  });

  it('粗体渲染', function () {
    expect(renderMarkdown('**hello**')).toContain('<strong>hello</strong>');
  });

  it('行内代码渲染', function () {
    var result = renderMarkdown('use `var` keyword');
    expect(result).toContain('<code>var</code>');
  });

  it('代码块渲染', function () {
    var result = renderMarkdown('```\nvar x = 1;\n```');
    expect(result).toContain('<pre><code>');
    expect(result).toContain('var x = 1;');
  });

  it('标题渲染', function () {
    expect(renderMarkdown('## 你好')).toContain('<h3>你好</h3>');
  });

  it('无序列表', function () {
    var result = renderMarkdown('- 项目一\n- 项目二');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>项目一</li>');
  });

  it('有序列表', function () {
    var result = renderMarkdown('1. 第一步\n2. 第二步');
    expect(result).toContain('<ol>');
    expect(result).toContain('<li>第一步</li>');
  });

  it('HTML 转义', function () {
    var result = renderMarkdown('<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('普通段落', function () {
    var result = renderMarkdown('hello world');
    expect(result).toContain('<p>hello world</p>');
  });
});
