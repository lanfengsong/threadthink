/* ============================================================
   Tests: message block parser (stable anchor containers)
   ============================================================ */

import { describe, it, expect } from 'vitest';
import { parseBlocks, findBlockByRange } from '../../src/blocks.js';
import { renderMarkdown } from '../../src/markdown.js';
import { stripMarkdown } from '../../src/text.js';

/** 渲染后文本（与块 text 连续拼接应一致） */
function renderedText(markdown) {
  var div = document.createElement('div');
  div.innerHTML = renderMarkdown(markdown);
  return div.textContent;
}

describe('parseBlocks', function () {
  it('空内容返回空数组', function () {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('   \n  ')).toEqual([]);
  });

  it('普通段落、标题、代码块、列表各成一块', function () {
    var src = '第一段，普通文字。\n\n# 一级标题\n\n## 二级标题\n\n```\ncode line 1\ncode line 2\n```\n\n- 无序项\n- 第二项\n\n1. 有序项\n2. 第二项';
    var blocks = parseBlocks(src);
    expect(blocks.map(function (b) { return b.type; })).toEqual(['p', 'h2', 'h3', 'pre', 'ul', 'ul', 'ol', 'ol']);
    expect(blocks[0].text).toBe('第一段，普通文字。');
    expect(blocks[3].text).toBe('code line 1\ncode line 2');
    expect(blocks[4].text).toBe('无序项');
  });

  it('块级前缀已剥、行内标记保留（渲染层处理）', function () {
    var blocks = parseBlocks('**加粗**和`代码`以及*斜体*。');
    expect(blocks[0].text).toBe('**加粗**和`代码`以及*斜体*。');
  });

  it('块 id 确定性：同一内容两次解析完全一致', function () {
    var src = '# 标题\n\n段落一。\n\n段落二。';
    expect(parseBlocks(src)).toEqual(parseBlocks(src));
  });

  it('相同文本不同位置：id 不同（同文块出现次数区分）', function () {
    var src = '注意这一点。\n\n注意这一点。';
    var blocks = parseBlocks(src);
    expect(blocks[0].id).not.toBe(blocks[1].id);
    expect(blocks[0].text).toBe(blocks[1].text);
  });

  it('插入、删除和重排其他块不改变未变块的身份', function () {
    var original = parseBlocks('第一段。\n\n第二段。\n\n第三段。');
    var changed = parseBlocks('新开头。\n\n第三段。\n\n第一段。');
    expect(changed[1].id).toBe(original[2].id);
    expect(changed[2].id).toBe(original[0].id);
  });

  it('内容改变时该块 id 改变（其余块不变）', function () {
    var a = parseBlocks('第一段。\n\n第二段。\n\n第三段。');
    var b = parseBlocks('第一段。\n\n第二段改过了。\n\n第三段。');
    expect(a[0].id).toBe(b[0].id);
    expect(a[1].id).not.toBe(b[1].id);
    expect(a[2].id).toBe(b[2].id);
  });

  it('与 renderMarkdown 的 textContent 一致（锚定 vs 展示同源）', function () {
    var samples = [
      '只有一段简单文字。',
      '# 标题\n\n正文段落。',
      '第一段。\n\n- 项一\n- 项二\n\n第二段。',
      '代码前。\n\n```\nvar x = 1;\n```\n\n代码后。',
      '混合**加粗**、`code`、*斜体*。\n\n尾段。',
    ];
    for (var i = 0; i < samples.length; i++) {
      var blocks = parseBlocks(samples[i]);
      // 锚定视角：块文本剥离行内标记后拼接 == 用户看到的渲染文本
      var joined = blocks.map(function (b) { return stripMarkdown(b.text); }).join('');
      expect(joined).toBe(renderedText(samples[i]), 'sample ' + i);
    }
  });

  it('CRLF 与围栏内井号（不是标题）', function () {
    var blocks = parseBlocks('# 真标题\r\n\r\n```\r\n# 不是标题\r\n```');
    expect(blocks.map(function (b) { return b.type; })).toEqual(['h2', 'pre']);
    expect(blocks[1].text).toBe('# 不是标题');
  });
});

describe('findBlockByRange', function () {
  it('整段偏移映射到块内区间', function () {
    var blocks = parseBlocks('第一段。\n\n第二段内容。');
    // 第一段 4 字 -> 偏移 0..4；第二段从 4 开始
    var hit = findBlockByRange(blocks, 4, 4);
    expect(hit.block.text).toBe('第二段内容。');
    expect(hit.start).toBe(0);
    expect(hit.end).toBe(4);
  });

  it('跨块区间返回 null（由解析链降级处理）', function () {
    var blocks = parseBlocks('第一段。\n\n第二段。');
    expect(findBlockByRange(blocks, 2, 4)).toBeNull();
  });
});