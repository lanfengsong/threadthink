/* ============================================================
   Tests: annotation highlight recovery in the renderer
   ============================================================ */

import { describe, it, expect } from 'vitest';
import { renderAnnotatedContent, renderMessage, updateStreamingBody, smartIndexOf, locateByAnchor, highlightTextInDOM } from '../../src/renderer.js';
import { getColor } from '../../src/palette.js';
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

  it('重复文字无唯一上下文时保留为outdated，不猜第一个', function () {
    var content = '首先强调一点：注意这一点。然后补充其他内容。最后再次强调：注意这一点。';
    var ann = makeAnn('a1', '注意这一点', '');
    var frag = renderAnnotatedContent({ content: content, annotations: [ann] });
    expect(markStart(frag, 'a1')).toBe(-1);
    expect(ann.status).toBe('outdated');
  });

  it('选中文字跨加粗节点时高亮仍完整覆盖', function () {
    var content = '前置文字**加粗部分**后续文字。';
    var ann = makeAnn('a1', '文字加粗部分');
    var frag = renderAnnotatedContent({ content: content, annotations: [ann] });
    var mark = frag.querySelector('.annotated-text');
    expect(mark).not.toBeNull();
    expect(Array.from(frag.querySelectorAll('.annotated-text')).map(function (el) { return el.textContent; }).join('')).toBe('文字加粗部分');
    expect(frag.querySelector('strong').textContent.replace('●', '')).toBe('加粗部分');
    expect(frag.querySelector('strong .annotated-text')).not.toBeNull();
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
    expect(Array.from(frag.querySelectorAll('.annotated-text')).map(function (el) { return el.textContent; }).join('')).toBe(SEL);
    expect(markStart(frag, 'anchored')).toBe(13);
  });

  it('指纹不一致（内容已变更）→ 回退引文搜索，仍高亮在正确位置', function () {
    var frag = renderAnnotatedContent({ content: CONTENT, annotations: [anchoredAnn({ textHash: 'stalehash' })] });
    var mark = frag.querySelector('.annotated-text');
    expect(mark).not.toBeNull();
    expect(Array.from(frag.querySelectorAll('.annotated-text')).map(function (el) { return el.textContent; }).join('')).toBe(SEL);
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

  it('中间块变化后仍复用后续未变块的DOM', function () {
    var body = document.createElement('div'); body.innerHTML = renderMarkdown('first\n\nmiddle\n\nlast');
    var first = body.firstChild, last = body.lastChild;
    updateStreamingBody(body, 'first\n\nchanged\n\nlast');
    expect(body.firstChild).toBe(first); expect(body.lastChild).toBe(last);
  });

  it('列表增长时仍复用已有条目与高亮', function () {
    var body = document.createElement('div');
    body.appendChild(renderAnnotatedContent({ content: '- first\n- second', annotations: [makeAnn('a', 'first')] }));
    var list = body.firstChild, item = body.querySelector('li');
    updateStreamingBody(body, '- first\n- second\n- third');
    expect(body.firstChild).toBe(list); expect(body.querySelector('li')).toBe(item);
    expect(item.querySelector('mark').textContent).toBe('first'); expect(body.querySelectorAll('li')).toHaveLength(3);
  });

  it('保持完整列表容器而不是根据顶层块数量反复重建', function () {
    var body = document.createElement('div');
    body.innerHTML = renderMarkdown('- first\n- second\n\nTail');
    var list = body.firstChild;
    updateStreamingBody(body, '- first\n- second\n\nTail grows');
    expect(body.firstChild).toBe(list);
    expect(body.querySelectorAll('li')).toHaveLength(2);
    expect(body.lastChild.textContent).toBe('Tail grows');
  });
});

describe('strict quote recovery and decoration invariants', function () {
  it('empty quotes and ambiguous contexts terminate as misses', function () {
    expect(smartIndexOf('abc', '', makeAnn('a', ''))).toBe(-1);
    expect(smartIndexOf('left q right left q right', '', makeAnn('a', 'q', 'left q right'))).toBe(-1);
    expect(smartIndexOf('x q q y', '', makeAnn('a', 'q', 'x q q y'))).toBe(-1);
    expect(smartIndexOf('q q', '', makeAnn('a', 'q', 'missing q'))).toBe(-1);
    var ann = makeAnn('empty', '');
    expect(renderAnnotatedContent({ content: 'abc', annotations: [ann] }).querySelector('mark')).toBeNull();
    expect(ann.status).toBe('outdated');
  });

  it('duplicate block IDs cannot silently reattach a deleted occurrence', function () {
    var before = document.createElement('div'); before.innerHTML = renderMarkdown('A\n\nsame\n\nB\n\nsame\n\nC\n\nsame');
    var block = before.children[1];
    var ann = { ...makeAnn('a', 'same', 'AsameB'), blockId: block.dataset.blockId, startOffset: 0, endOffset: 4, textHash: hashText('same') };
    expect(locateByAnchor(before, ann)).not.toBeNull();
    var after = document.createElement('div'); after.innerHTML = renderMarkdown('B\n\nsame\n\nC\n\nsame');
    expect(locateByAnchor(after, ann)).toBeNull();
    expect(renderAnnotatedContent({ content: 'B\n\nsame\n\nC\n\nsame', annotations: [ann] }).querySelector('mark')).toBeNull();
    expect(ann.status).toBe('outdated');
  });

  it('an anchor without a hash must still match selectedText exactly', function () {
    var root = document.createElement('div'); root.innerHTML = renderMarkdown('wrong text');
    var ann = { ...makeAnn('a', 'other'), blockId: root.firstChild.dataset.blockId, startOffset: 0, endOffset: 5 };
    expect(locateByAnchor(root, ann)).toBeNull();
    expect(locateByAnchor(root, { ...ann, selectedText: 'wrong' })).toEqual({ start: 0, end: 5 });
  });

  it('cross-block highlights retain links, emphasis, and paragraph boundaries', function () {
    var ann = makeAnn('a', 'bold linkedafter');
    var frag = document.createElement('div');
    frag.innerHTML = '<p>before <strong>bold</strong> <a href="https://example.com">linked</a></p><p>after</p>';
    highlightTextInDOM(frag, 7, frag.textContent.length, ann, getColor(0));
    expect(frag.querySelectorAll('p')).toHaveLength(2);
    expect(frag.querySelector('strong mark').textContent).toBe('bold');
    expect(frag.querySelector('a mark').textContent).toBe('linked');
    expect(frag.querySelector('a').getAttribute('href')).toBe('https://example.com');
    expect(bodyText(frag)).toBe('before bold linkedafter');
  });

  it('overlapping highlights never count badges as source characters', function () {
    var frag = renderAnnotatedContent({ content: 'abcdef', annotations: [makeAnn('a', 'bcd'), makeAnn('b', 'cde')] });
    expect(bodyText(frag)).toBe('abcdef');
    var marks = frag.querySelectorAll('[data-ann-id="b"].annotated-text');
    expect(Array.from(marks).map(function (el) { return el.textContent; }).join('')).toBe('cde');
  });

  it('outdated and resolved threads remain reachable and history keeps metadata', function () {
    var missing = { ...makeAnn('a', 'gone'), status: 'open' };
    var resolved = { ...makeAnn('b', 'present'), status: 'resolved' };
    var message = renderMessage({ id: 'm', role: 'assistant', content: 'present', annotations: [missing, resolved], seq: 42, traceId: 'trace' });
    expect(message.querySelectorAll('.btn-open-annotation')).toHaveLength(2);
    expect(message.textContent).toContain('内容已变更');
    expect(message.textContent).toContain('已解决');
    var detail;
    document.addEventListener('threadthink:history', function (event) { detail = event.detail; }, { once: true });
    message.querySelector('.btn-message-history').click();
    expect(detail).toEqual({ messageId: 'm', seq: 42, traceId: 'trace' });
    expect(resolved.status).toBe('resolved');
  });
});
