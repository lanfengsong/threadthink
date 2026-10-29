/* ============================================================
   Tests: annotation highlight recovery in the renderer
   ============================================================ */

import { describe, it, expect } from 'vitest';
import { renderAnnotatedContent, renderMessage, updateStreamingBody } from '../../src/renderer.js';
import { parseBlocks } from '../../src/blocks.js';
import { hashText } from '../../src/annotations.js';
import { stripMarkdown } from '../../src/text.js';
import { renderMarkdown } from '../../src/markdown.js';

function makeAnn(id, selectedText, rawContext) {
  return {
    id: id, selectedText: selectedText, question: '为什么',
    answer: '', annotations: [], colorIdx: 0, rawContext: rawContext || '',
  };
}

/** 返回指定批注高亮在容器文本中的起始位置；不存在返回 -1 */
function markStart(fragment, annId) {
  var w = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT, null);
  var cp = 0, n;
  while ((n = w.nextNode())) {
    var p = n.parentNode;
    if (p && p.classList) {
      if (p.classList.contains('ann-badge')) continue; // 装饰圆点不参与定位
      if (p.classList.contains('annotated-text') && p.dataset.annId === annId) return cp;
    }
    cp += n.textContent.length;
  }
  return -1;
}

/** 渲染内容（排除批注圆点装饰） */
function bodyText(fragment) {
  return fragment.textContent.split('●').join('');
}

describe('renderAnnotatedContent', function () {
  it('单次出现的文字：高亮位置正确且正文完整', function () {
    var msg = { id: 'm1', role: 'assistant', content: '这是第一段内容，用于测试高亮恢复。', annotations: [makeAnn('a1', '测试高亮恢复')] };
    var frag = renderAnnotatedContent(msg);
    var mark = frag.querySelector('.annotated-text');
    expect(mark).not.toBeNull();
    expect(mark.dataset.annId).toBe('a1');
    expect(mark.textContent).toBe('测试高亮恢复');
    expect(markStart(frag, 'a1')).toBe(msg.content.indexOf('测试高亮恢复'));
    expect(bodyText(frag)).toBe(msg.content);
    expect(frag.querySelector('.ann-badge')).not.toBeNull();
  });

  it('重复文字定位到第二次出现（rawContext 消歧）', function () {
    var content = '首先强调一点：注意这一点。然后补充其他内容。最后再次强调：注意这一点。';
    var ann = makeAnn('a1', '注意这一点', '最后再次强调：注意这一点。');
    var frag = renderAnnotatedContent({ content: content, annotations: [ann] });
    var second = content.indexOf('注意这一点', content.indexOf('注意这一点') + 1);
    expect(markStart(frag, 'a1')).toBe(second);
    expect(bodyText(frag)).toBe(content);
  });

  it('重复文字且无上下文时回退到第一次出现', function () {
    var content = '首先强调一点：注意这一点。然后补充其他内容。最后再次强调：注意这一点。';
    var frag = renderAnnotatedContent({ content: content, annotations: [makeAnn('a1', '注意这一点', '')] });
    expect(markStart(frag, 'a1')).toBe(content.indexOf('注意这一点'));
  });

  it('选中文字跨加粗节点时高亮仍完整覆盖', function () {
    var content = '前置文字**加粗部分**后续文字。';
    var ann = makeAnn('a1', '文字加粗部分');
    var frag = renderAnnotatedContent({ content: content, annotations: [ann] });
    var mark = frag.querySelector('.annotated-text');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('文字加粗部分');
    expect(bodyText(frag)).toBe('前置文字加粗部分后续文字。');
    expect(markStart(frag, 'a1')).toBe(2);
  });

  it('同一消息多个批注互不偏移', function () {
    var msg = { content: '第一段话要批注的地方。第二段话也要批注的地方。', annotations: [makeAnn('a1', '第一段话'), makeAnn('a2', '第二段话')] };
    var frag = renderAnnotatedContent(msg);
    expect(markStart(frag, 'a1')).toBe(0);
    expect(markStart(frag, 'a2')).toBe(msg.content.indexOf('第二段话'));
    expect(bodyText(frag)).toBe(msg.content);
  });
});

describe('锚定恢复（design 4.2 解析链）', function () {
  var CONTENT = '第一段内容在这里。\n\n第二段是**加粗**的。\n\n尾段完成。';
  var BLOCKS = parseBlocks(CONTENT);
  var BODY = BLOCKS[1].text;                 // '第二段是**加粗**的。'
  var PLAIN = stripMarkdown(BODY);           // '第二段是加粗的。'
  var SEL = '加粗的';
  var START = PLAIN.indexOf(SEL);            // 4
  // 第一段 '第一段内容在这里。' = 9 字；'加粗的' 全局起点 = 9 + 4 = 13

  function anchoredAnn(overrides) {
    var ann = {
      id: 'anchored', selectedText: SEL, question: '为何？', answer: '', annotations: [],
      colorIdx: 0, rawContext: PLAIN, blockId: BLOCKS[1].id,
      startOffset: START, endOffset: START + SEL.length, textHash: hashText(SEL),
    };
    return Object.assign(ann, overrides || {});
  }

  it('锚精确命中：blockId + 偏移 + 指纹一致 → 高亮在原位（零搜索）', function () {
    var frag = renderAnnotatedContent({ content: CONTENT, annotations: [anchoredAnn()] });
    var mark = frag.querySelector('.annotated-text');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe(SEL);
    expect(markStart(frag, 'anchored')).toBe(13);
  });

  it('指纹不一致（内容已变更）→ 回退引文搜索，仍高亮在正确位置', function () {
    var frag = renderAnnotatedContent({ content: CONTENT, annotations: [anchoredAnn({ textHash: 'stalehash' })] });
    var mark = frag.querySelector('.annotated-text');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe(SEL);
    expect(markStart(frag, 'anchored')).toBe(13);
  });

  it('块丢失（块重排）→ 回退引文搜索；块边界越界 → 回退', function () {
    var lost = renderAnnotatedContent({ content: CONTENT, annotations: [anchoredAnn({ blockId: 'missing-block' })] });
    expect(lost.querySelector('.annotated-text')).not.toBeNull();

    var oob = renderAnnotatedContent({ content: CONTENT, annotations: [anchoredAnn({ startOffset: 999 })] });
    expect(oob.querySelector('.annotated-text')).not.toBeNull();
  });

  it('无锚的旧批注（无 blockId）→ 走引文搜索（回归）', function () {
    var legacy = { id: 'legacy', selectedText: '尾段完成', question: 'q', rawContext: '尾段完成', colorIdx: 0 };
    var frag = renderAnnotatedContent({ content: CONTENT, annotations: [legacy] });
    expect(frag.querySelector('.annotated-text').textContent).toBe('尾段完成');
  });
});

describe('renderMessage 重渲染恢复', function () {
  it('流式结束后全量重渲染，高亮依然恢复', function () {
    var msg = { id: 'm1', role: 'assistant', content: '完整回答内容，包含一段引用。', annotations: [makeAnn('a1', '一段引用')], _loading: false };
    var first = renderMessage(msg);
    var second = renderMessage(msg); // 模拟 onDone 后的全量重渲染
    expect(first.querySelector('.annotated-text').textContent).toBe('一段引用');
    expect(second.querySelector('.annotated-text').textContent).toBe('一段引用');
    expect(second.querySelector('.message-body').textContent).toContain('完整回答内容');
  });
});
describe('updateStreamingBody（流式增量渲染）', function () {
  it('前缀块 DOM 引用不变，仅更新尾部块（不重建已渲染内容）', function () {
    var body = document.createElement('div');
    body.innerHTML = renderMarkdown('第一段完整内容。');
    var firstBlock = body.children[0];

    updateStreamingBody(body, '第一段完整内容。'); // 无变化
    expect(body.children[0]).toBe(firstBlock);

    updateStreamingBody(body, '第一段完整内容。\n\n第二段正在生成'); // 新增第二块
    expect(body.children[0]).toBe(firstBlock);
    expect(body.children.length).toBe(2);
    expect(body.textContent).toBe('第一段完整内容。第二段正在生成');
  });

  it('流式期间已挂载的批注高亮（mark）在后续 token 中保留', function () {
    var body = document.createElement('div');
    body.innerHTML = renderMarkdown('第一段内容。\n\n');
    var block1 = body.children[0];
    // 模拟用户批注：第一块内挂 mark（批注高亮）
    var textNode = block1.firstChild;
    block1.textContent = '';
    var mark = document.createElement('mark');
    mark.className = 'annotated-text'; mark.dataset.annId = 'a1';
    mark.appendChild(textNode);
    block1.appendChild(mark);

    updateStreamingBody(body, '第一段内容。\n\n第二段追加中。');
    expect(body.children[0].querySelector('.annotated-text')).not.toBeNull(); // 高亮保留
    expect(body.children[0].querySelector('.annotated-text').dataset.annId).toBe('a1');
    expect(body.children.length).toBe(2);
  });
});
