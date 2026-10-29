/* ============================================================
   ThreadThink — Message Renderer
   ============================================================ */

import { getDom } from './dom.js';
import { getMessages } from './state.js';
import { getColor } from './palette.js';
import { renderMarkdown, stripMarkdown } from './markdown.js';
import { hashText } from './annotations.js';
import { syncSidebarHeights, rebuildSidebar } from './sidebar.js';
import { scrollToBottom } from './utils.js';

/** Highlight selected text range within a DOM tree */
export function highlightTextInDOM(root, s, e, ann, color) {
  // Snapshot text nodes first: moving nodes into the mark must not disturb
  // the traversal (TreeWalker would otherwise re-visit moved nodes).
  var nodes = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), t;
  while ((t = w.nextNode())) nodes.push(t);
  var cp = 0, mark = null;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i], len = n.textContent.length, ne = cp + len;
    if (s < ne && e > cp) { // 区间与该文本节点相交（含完全包含，也含跨节点）
      var ls = Math.max(s, cp) - cp, le = Math.min(e, ne) - cp;
      if (le < len) n.splitText(le);
      var mn = ls > 0 ? n.splitText(ls) : n;
      if (!mark) {
        mark = document.createElement('mark');
        mark.className = 'annotated-text'; mark.dataset.annId = ann.id;
        mark.style.background = color.bg; mark.style.borderBottomColor = color.dot;
        mn.parentNode.insertBefore(mark, mn);
      }
      mark.appendChild(mn);
      if (ne >= e) break; // 已覆盖到区间终点
    }
    cp = ne;
  }
  if (!mark) return;
  var badge = document.createElement('span');
  badge.className = 'ann-badge'; badge.dataset.annId = ann.id;
  badge.style.background = color.badge; badge.textContent = '●';
  mark.parentNode.insertBefore(badge, mark.nextSibling);
}

/** Render message content with annotation highlights */
export function renderAnnotatedContent(msg) {
  var content = msg.content, anns = msg.annotations || [];
  var tmp = document.createElement('div'); tmp.innerHTML = renderMarkdown(content);
  if (anns.length === 0) { var f0 = document.createDocumentFragment(); while (tmp.firstChild) f0.appendChild(tmp.firstChild); return f0; }

  var ft = tmp.textContent, items = [];
  for (var i = 0; i < anns.length; i++) {
    var ann = anns[i];
    // ① 锚精确命中（design 4.2）：block_id + 偏移 + 文本指纹一致才命中
    var anchored = locateByAnchor(tmp, ann);
    // ② 引文回退：锚失效（内容变更/无锚/跨块）→ 全段文本搜索
    var pos = anchored ? -1 : smartIndexOf(ft, content, ann);
    if (anchored) items.push({ a: ann, s: anchored.start, e: anchored.end });
    else if (pos !== -1) items.push({ a: ann, s: pos, e: pos + ann.selectedText.length });
    // ③ 兜底（outdated）：找不到则不高亮，批注仍可在侧栏查看（阶段 2 边界）
  }
  items.sort(function (x, y) { return y.s - x.s; });
  for (var j = 0; j < items.length; j++) highlightTextInDOM(tmp, items[j].s, items[j].e, items[j].a, getColor(items[j].a.colorIdx || 0));
  var frag = document.createDocumentFragment(); while (tmp.firstChild) frag.appendChild(tmp.firstChild); return frag;
}

/**
 * 锚定位（design 4.2 解析链第一级）：
 * 按 (blockId, start, end) 找到块元素，校验文本指纹一致后返回全局偏移；
 * 任何一步不符（块丢失/越界/指纹不一致）→ null（调用方走引文回退）。
 */
function locateByAnchor(renderedDOM, ann) {
  if (!ann.blockId || ann.startOffset == null || ann.endOffset == null) return null;
  var blockEl = renderedDOM.querySelector('[data-block-id="' + ann.blockId + '"]');
  if (!blockEl) return null;
  var text = blockEl.textContent;
  if (ann.startOffset < 0 || ann.endOffset > text.length || ann.endOffset <= ann.startOffset) return null;
  if (ann.textHash && hashText(text.slice(ann.startOffset, ann.endOffset)) !== ann.textHash) return null;
  // 块起点在整段渲染文本中的全局偏移
  var w = document.createTreeWalker(renderedDOM, NodeFilter.SHOW_TEXT, null);
  var n, cp = 0;
  while ((n = w.nextNode())) {
    if (blockEl.contains(n)) return { start: cp + ann.startOffset, end: cp + ann.endOffset };
    cp += n.textContent.length;
  }
  return null;
}

/** Find selectedText in rendered textContent, using rawContext to resolve duplicates */
function smartIndexOf(renderedText, rawContent, ann) {
  var st = ann.selectedText;
  var count = 0, pos = -1;
  while ((pos = renderedText.indexOf(st, pos + 1)) !== -1) count++;
  if (count <= 1) return renderedText.indexOf(st);

  var ctx = ann.rawContext;
  if (!ctx) return renderedText.indexOf(st);

  var ctxRendered = stripMarkdown(ctx);
  var ctxPos = renderedText.indexOf(ctxRendered);
  if (ctxPos === -1) return renderedText.indexOf(st);

  var relPos = ctxRendered.indexOf(st);
  if (relPos === -1) return renderedText.indexOf(st);

  return ctxPos + relPos;
}

/** Render a single message DOM element */
export function renderMessage(msg) {
  var el = document.createElement('div'); el.className = 'message ' + msg.role; el.dataset.msgId = msg.id;
  var rl = document.createElement('div'); rl.className = 'message-role'; rl.textContent = msg.role === 'user' ? '你' : 'AI'; el.appendChild(rl);
  var body = document.createElement('div'); body.className = 'message-body'; body.appendChild(renderAnnotatedContent(msg)); el.appendChild(body);
  if (msg._loading) { var ty = document.createElement('div'); ty.className = 'typing-indicator'; ty.innerHTML = '<span></span><span></span><span></span>'; el.querySelector('.message-body').appendChild(ty); }
  return el;
}

/** Full conversation re-render (used for clear) */
export function renderConversation() {
  var dom = getDom();
  var messages = getMessages();
  var ex = dom.conversation.querySelectorAll('.message');
  for (var i = 0; i < ex.length; i++) ex[i].remove();
  dom.welcome.style.display = messages.length === 0 ? '' : 'none';
  for (var j = 0; j < messages.length; j++) dom.conversation.appendChild(renderMessage(messages[j]));
  syncSidebarHeights();
  rebuildSidebar('left'); rebuildSidebar('right');
  if (messages.length > 0) {
    scrollToBottom(dom.workspace);
  } else {
    dom.workspace.scrollTop = 0;
  }
}

/** Refresh a single message in-place */
export function refreshMessage(msgId) {
  var messages = getMessages();
  var dom = getDom();
  var msg = null;
  for (var i = 0; i < messages.length; i++) { if (messages[i].id === msgId) { msg = messages[i]; break; } }
  if (!msg) return;
  var old = dom.conversation.querySelector('[data-msg-id="' + msgId + '"]'); if (!old) return;
  old.replaceWith(renderMessage(msg));
  syncSidebarHeights(); rebuildSidebar('left'); rebuildSidebar('right');
}
