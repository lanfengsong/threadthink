/* ============================================================
   Tests: production document chunking
   ============================================================ */

import { describe, it, expect } from 'vitest';
import { splitChunks, chunkDocument } from '../../server/src/services/chunking.js';

describe('splitChunks (plain text)', function () {
  it('空文本返回空数组', function () {
    expect(splitChunks('')).toEqual([]);
    expect(splitChunks('   ')).toEqual([]);
  });

  it('整体过短的内容返回空数组', function () {
    expect(splitChunks('a')).toEqual([]);
  });

  it('短文本返回一个块', function () {
    var result = splitChunks('这是一个简短的测试句子，用于验证分段和内容。');
    expect(result.length).toBe(1);
    expect(result[0]).toBe('这是一个简短的测试句子，用于验证分段和内容。');
  });

  it('普通段落各自独立，不跨段落合并', function () {
    var text = '第一段内容比较长，用于测试文档分块功能是否正常工作。\n\n第二段内容也足够长，用于确认段落不会被合并到同一个块中。';
    var result = splitChunks(text);
    expect(result.length).toBe(2);
    expect(result[0]).toBe('第一段内容比较长，用于测试文档分块功能是否正常工作。');
    expect(result[1]).toBe('第二段内容也足够长，用于确认段落不会被合并到同一个块中。');
  });

  it('段落之间没有重叠，且顺序保持', function () {
    var text = '第一段内容独立成块。\n\n第二段内容也独立成块。\n\n第三段内容同样独立。';
    var result = splitChunks(text);
    expect(result).toEqual(['第一段内容独立成块。', '第二段内容也独立成块。', '第三段内容同样独立。']);
  });

  it('段落内部的软换行保留在同一个块中', function () {
    var result = splitChunks('第一行没有空行\n第二行直接续上。\n\n第二段内容。');
    expect(result.length).toBe(2);
    expect(result[0]).toBe('第一行没有空行\n第二行直接续上。');
  });

  it('CRLF 与纯空格行都作为段落分隔符', function () {
    expect(splitChunks('第一段内容足够长。\r\n\r\n第二段内容也足够长。')).toEqual(['第一段内容足够长。', '第二段内容也足够长。']);
    expect(splitChunks('第一段内容足够长。\n   \n第二段内容也足够长。')).toEqual(['第一段内容足够长。', '第二段内容也足够长。']);
  });

  it('超长段落按句子边界切分，重叠只发生在段落内部', function () {
    var sentence = '这是用于测试超长段落按句子边界二次切分的中文句子。';
    var para = sentence.repeat(50);
    var chunks = chunkDocument(para, { isMarkdown: false });
    expect(chunks.length).toBeGreaterThan(1);
    for (var i = 0; i < chunks.length; i++) {
      expect(chunks[i].content.length).toBeLessThanOrEqual(1000);
      expect(chunks[i].content).toMatch(/。$/); // 每个子块都结束在句号上
      expect(chunks[i].isOverflowSplit).toBe(true);
      expect(chunks[i].paragraphIndex).toBe(0);
      expect(chunks[i].embeddingText).toBe(chunks[i].content);
      if (i > 0) expect(chunks[i].content.startsWith(chunks[i - 1].content.slice(-100))).toBe(true);
    }
  });

  it('单句超长时按字符硬切且不丢失内容', function () {
    var para = 'x'.repeat(2500);
    var chunks = chunkDocument(para, { isMarkdown: false });
    expect(chunks.length).toBeGreaterThan(1);
    for (var i = 0; i < chunks.length; i++) {
      expect(chunks[i].content.length).toBeLessThanOrEqual(1000);
      expect(chunks[i].isOverflowSplit).toBe(true);
    }
    var rebuilt = chunks[0].content + chunks.slice(1).map(function (c) { return c.content.slice(100); }).join('');
    expect(rebuilt).toBe(para);
  });

  it('超长段落之后仍从新段落开始，不跨段落重叠', function () {
    var long = 'q'.repeat(1800);
    var chunks = chunkDocument(long + '\n\n后续短段落。', { isMarkdown: false });
    var last = chunks[chunks.length - 1];
    expect(last.content).toBe('后续短段落。');
    expect(last.isOverflowSplit).toBe(false);
    expect(last.paragraphIndex).toBe(1);
  });
});

describe('chunkDocument (Markdown heading paths)', function () {
  it('一级标题路径作为 embedding 上下文，标题本身不生成正文块', function () {
    var body = '这是正文内容，用于验证标题路径作为嵌入上下文。';
    var chunks = chunkDocument('# 第一章\n\n' + body, { isMarkdown: true });
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe(body);
    expect(chunks[0].sectionPath).toBe('第一章');
    expect(chunks[0].embeddingText).toBe('第一章\n' + body);
  });

  it('多级标题维护完整章节路径', function () {
    var chunks = chunkDocument('# 一级标题\n\n文本A。\n\n## 二级标题\n\n文本B。', { isMarkdown: true });
    expect(chunks.length).toBe(2);
    expect(chunks[0].sectionPath).toBe('一级标题');
    expect(chunks[1].sectionPath).toBe('一级标题 / 二级标题');
    expect(chunks[1].content).toBe('文本B。');
  });

  it('同级标题替换当前章节路径', function () {
    var chunks = chunkDocument('# 甲\n\n内容甲。\n\n# 乙\n\n内容乙。', { isMarkdown: true });
    expect(chunks.map(function (c) { return c.sectionPath; })).toEqual(['甲', '乙']);
  });

  it('连续标题只保留最后一个层级', function () {
    var chunks = chunkDocument('# 甲\n\n## 乙\n\n### 丙\n\n正文在此，验证连续标题。', { isMarkdown: true });
    expect(chunks.length).toBe(1);
    expect(chunks[0].sectionPath).toBe('甲 / 乙 / 丙');
  });

  it('标题行尾的 ATX 井号被剥离', function () {
    var chunks = chunkDocument('## 二级标题 ##\n\n这是正文内容，验证 ATX 井号剥离。', { isMarkdown: true });
    expect(chunks[0].sectionPath).toBe('二级标题');
  });

  it('代码围栏中的井号不是标题，也不改变章节路径', function () {
    var doc = '# 真实标题\n\n```\n# 不是标题\n```\n\n正文内容在围栏之后。';
    var chunks = chunkDocument(doc, { isMarkdown: true });
    expect(chunks.length).toBe(2);
    expect(chunks[0].content).toBe('# 不是标题');
    expect(chunks[0].sectionPath).toBe('真实标题');
    expect(chunks[1].content).toBe('正文内容在围栏之后。');
    expect(chunks[1].sectionPath).toBe('真实标题');
  });

  it('没有井号空格的文本行不是标题', function () {
    var chunks = chunkDocument('#不是标题\n\n这是一段足够长的正文内容，验证井号不算标题。', { isMarkdown: true });
    expect(chunks[0].content).toBe('#不是标题');
    expect(chunks[0].sectionPath).toBe('');
  });

  it('纯文本不解析 Markdown 标题', function () {
    var chunks = chunkDocument('# 标题\n\n这是正文内容，验证纯文本模式不解析标题。', { isMarkdown: false });
    expect(chunks[0].content).toBe('# 标题');
    expect(chunks[0].sectionPath).toBe('');
    expect(chunks[0].embeddingText).toBe(chunks[0].content);
  });

  it('无标题的 Markdown 路径为空且 embedding 输入等于正文', function () {
    var body = '只有正文没有标题的文档内容，用于验证路径为空。';
    var chunks = chunkDocument(body, { isMarkdown: true });
    expect(chunks[0].sectionPath).toBe('');
    expect(chunks[0].embeddingText).toBe(body);
  });

  it('超长 Markdown 段落携带标题路径的 embedding 输入', function () {
    var sentence = '超长段落用于验证标题路径嵌入与局部重叠。';
    var chunks = chunkDocument('# 章节\n\n' + sentence.repeat(51), { isMarkdown: true });
    expect(chunks.length).toBeGreaterThan(1);
    for (var i = 0; i < chunks.length; i++) {
      expect(chunks[i].sectionPath).toBe('章节');
      expect(chunks[i].embeddingText).toBe('章节\n' + chunks[i].content);
      if (i > 0) expect(chunks[i].content.startsWith(chunks[i - 1].content.slice(-100))).toBe(true);
    }
  });
});