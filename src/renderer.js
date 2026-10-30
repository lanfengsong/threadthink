/* ThreadThink — Message renderer and annotation decorations */
import { getDom } from './dom.js';
import { getMessages } from './state.js';
import { getColor } from './palette.js';
import { renderMarkdown, stripMarkdown } from './markdown.js';
import { matchesTextHash, annotationText, annotationTextNodes, anchorForOffsets } from './annotations.js';
import { syncSidebarHeights, rebuildSidebar } from './sidebar.js';
import { clickAnnotation } from './cards.js';
import { scrollToBottom } from './utils.js';

/** Wrap each text segment in place: links, emphasis and block structure survive. */
export function highlightTextInDOM(root, s, e, ann, color) {
  var nodes = annotationTextNodes(root), cp = 0, lastMark = null;
  nodes.forEach(function (node) {
    var len = node.textContent.length, end = cp + len;
    if (s < end && e > cp) {
      var startLocal = Math.max(s, cp) - cp, endLocal = Math.min(e, end) - cp;
      if (endLocal < len) node.splitText(endLocal);
      var selected = startLocal > 0 ? node.splitText(startLocal) : node;
      var mark = document.createElement('mark');
      mark.className = 'annotated-text'; mark.dataset.annId = ann.id;
      mark.style.background = color.bg; mark.style.borderBottomColor = color.dot;
      selected.parentNode.insertBefore(mark, selected);
      mark.appendChild(selected);
      lastMark = mark;
    }
    cp = end;
  });
  if (!lastMark) return;
  var badge = document.createElement('span');
  badge.className = 'ann-badge'; badge.dataset.annId = ann.id;
  badge.style.background = color.badge; badge.textContent = '●';
  badge.setAttribute('aria-hidden', 'true');
  lastMark.after(badge);
}

export function annotationStatusText(ann) {
  if (ann._draft) return ann._saveState === 'failed' ? '未保存 · 保存失败' : ann._saveState === 'saving' ? '未保存 · 正在保存' : '未保存 · 等待当前回答完成';
  if (ann._replyQueued) return '等待当前回答完成后生成回答';
  if (ann.status === 'resolved') return '已解决' + (ann._outdated ? ' · 内容已变更' : '');
  return ann.status === 'outdated' || ann._outdated ? '内容已变更' : '待处理';
}

/** Pure DOM projection. Persistence of changed anchor states happens in handles. */
export function renderAnnotatedContent(msg) {
  var content = msg.content || '', anns = msg.annotations || [];
  var tmp = document.createElement('div'); tmp.innerHTML = renderMarkdown(content);
  decorateAnnotations(tmp, content, anns);
  var frag = document.createDocumentFragment();
  while (tmp.firstChild) frag.appendChild(tmp.firstChild);
  return frag;
}

function decorateAnnotations(tmp, content, anns) {
  tmp.querySelectorAll('.ann-badge').forEach(function (badge) { badge.remove(); });
  tmp.querySelectorAll('.annotated-text').forEach(function (mark) { mark.replaceWith(...mark.childNodes); });
  var text = annotationText(tmp), items = [];
  anns.forEach(function (ann) {
    var anchored = locateByAnchor(tmp, ann);
    var pos = anchored ? anchored.start : smartIndexOf(text, content, ann);
    ann._outdated = pos === -1;
    if (ann.status !== 'resolved') ann.status = ann._outdated ? 'outdated' : 'active';
    ann._anchorPatch = null;
    if (pos !== -1) {
      var end = anchored ? anchored.end : pos + ann.selectedText.length;
      items.push({ ann: ann, start: pos, end: end });
      var recovered = anchorForOffsets(tmp, pos, end);
      ann._resolvedAnchor = recovered ? {
        blockId: recovered.blockId, startOffset: recovered.start, endOffset: recovered.end,
        textHash: recovered.textHash, rawContext: text.slice(Math.max(0, pos - 32), end + 32),
      } : { blockId: null, startOffset: null, endOffset: null, textHash: ann.textHash || null, rawContext: text.slice(Math.max(0, pos - 32), end + 32) };
      if (!anchored && Object.keys(ann._resolvedAnchor).some(function (key) { return ann[key] !== ann._resolvedAnchor[key]; })) ann._anchorPatch = ann._resolvedAnchor;
    } else ann._resolvedAnchor = null;
    // Child quotes belong to this annotation's answer, not to the root message.
    if (ann.annotations?.length) renderAnnotatedContent({ content: ann.answer, annotations: ann.annotations });
  });
  items.forEach(function (item) {
    highlightTextInDOM(tmp, item.start, item.end, item.ann, getColor(item.ann.colorIdx || 0));
  });
}

/** Reuse every unchanged block, including blocks after an edited/reordered block. */
export function updateStreamingBody(bodyEl, content, annotations) {
  var next = document.createElement('div'); next.innerHTML = renderMarkdown(content);
  var blocks = new Map(), lists = Array.from(bodyEl.querySelectorAll('ul, ol')), usedLists = new Set();
  bodyEl.querySelectorAll('[data-block-id]').forEach(function (el) { blocks.set(el.tagName + ':' + el.dataset.blockId, el); });
  function reuse(block) {
    var key = block.tagName + ':' + block.dataset.blockId, old = blocks.get(key);
    if (old) { blocks.delete(key); return old; }
    return block;
  }
  function replaceIfChanged(parent, children) {
    if (parent.childNodes.length !== children.length || children.some(function (node, i) { return parent.childNodes[i] !== node; })) parent.replaceChildren(...children);
  }
  var children = Array.from(next.children).map(function (incoming) {
    if (incoming.dataset.blockId) return reuse(incoming);
    if (!incoming.matches('ul, ol')) return incoming;
    var ids = new Set(Array.from(incoming.children).map(function (el) { return el.dataset.blockId; }));
    var list = lists.find(function (old) { return !usedLists.has(old) && old.tagName === incoming.tagName && Array.from(old.children).some(function (el) { return ids.has(el.dataset.blockId); }); });
    if (list) usedLists.add(list);
    var items = Array.from(incoming.children).map(reuse);
    list ||= incoming; replaceIfChanged(list, items); return list;
  });
  replaceIfChanged(bodyEl, children);
  if (annotations?.length) decorateAnnotations(bodyEl, content, annotations);
}

export function locateByAnchor(root, ann) {
  if (!ann.selectedText || !ann.blockId || !Number.isInteger(ann.startOffset) || !Number.isInteger(ann.endOffset)) return null;
  var block = Array.from(root.querySelectorAll('[data-block-id]')).find(function (el) { return el.dataset.blockId === ann.blockId; });
  if (!block) return null;
  var text = annotationText(block);
  if (ann.startOffset < 0 || ann.endOffset > text.length || ann.endOffset <= ann.startOffset) return null;
  var quote = text.slice(ann.startOffset, ann.endOffset);
  if (quote !== ann.selectedText || !matchesTextHash(quote, ann.textHash)) return null;
  var nodes = annotationTextNodes(root), cp = 0;
  for (var node of nodes) {
    if (block.contains(node)) {
      var start = cp + ann.startOffset, fullText = annotationText(root);
      // Duplicate content can reuse an occurrence-based block ID after deletion.
      // Require uniquely matching context even when offsets and fingerprint match.
      if (occurrences(fullText, ann.selectedText).length > 1 && smartIndexOf(fullText, '', ann) !== start) return null;
      return { start: start, end: cp + ann.endOffset };
    }
    cp += node.textContent.length;
  }
  return null;
}

function occurrences(text, quote) {
  if (!quote) return [];
  var result = [], pos = -1;
  while ((pos = text.indexOf(quote, pos + 1)) !== -1) result.push(pos);
  return result;
}

/** Ambiguity is a miss, never a guess at the first occurrence. */
export function smartIndexOf(renderedText, rawContent, ann) {
  var quote = ann.selectedText;
  if (typeof quote !== 'string' || !quote.trim()) return -1;
  var positions = occurrences(renderedText, quote);
  if (positions.length === 1) return positions[0];
  if (!positions.length || !ann.rawContext) return -1;
  var matches = new Set();
  // New quotes store rendered context. Old quotes may store Markdown context.
  [ann.rawContext, stripMarkdown(ann.rawContext)].forEach(function (context) {
    var offsets = occurrences(context, quote);
    occurrences(renderedText, context).forEach(function (start) {
      offsets.forEach(function (offset) { matches.add(start + offset); });
    });
  });
  return matches.size === 1 ? Array.from(matches)[0] : -1;
}

/** Tool names and results are text, never executable markup. */
export function renderToolCalls(tools, host) {
  host.replaceChildren();
  (tools || []).forEach(function (tool) {
    var details = document.createElement('details'); details.className = 'tool-call';
    var summary = document.createElement('summary');
    summary.textContent = (tool.name || tool.tool_name || tool.tool || '工具') + (tool.done ? ' · 已完成' : ' · 调用中');
    details.appendChild(summary);
    if (tool.done) {
      var pre = document.createElement('pre');
      pre.textContent = typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result ?? null, null, 2);
      details.appendChild(pre);
    }
    host.appendChild(details);
  });
}

export function renderMessage(msg) {
  var el = document.createElement('div'); el.className = 'message ' + msg.role; el.dataset.msgId = msg.id;
  var role = document.createElement('div'); role.className = 'message-role'; role.textContent = msg.role === 'user' ? '你' : 'AI'; el.appendChild(role);
  if (msg._persisted !== false && !msg._loading) {
    var history = document.createElement('button'); history.className = 'btn-message-history'; history.textContent = '历史 / Trace';
    history.onclick = function () {
      document.dispatchEvent(new window.CustomEvent('threadthink:history', { detail: { messageId: msg.id, seq: msg.seq, traceId: msg.traceId } }));
    };
    role.appendChild(history);
  }
  var body = document.createElement('div'); body.className = 'message-body'; body.appendChild(renderAnnotatedContent(msg)); el.appendChild(body);
  var tools = document.createElement('div'); tools.className = 'message-tools'; renderToolCalls(msg.tools, tools); el.appendChild(tools);
  if (msg._loading) {
    var typing = document.createElement('div'); typing.className = 'typing-indicator'; typing.textContent = '正在生成…'; el.appendChild(typing);
  }
  if (msg.annotations?.length) {
    var threads = document.createElement('div'); threads.className = 'message-annotations';
    msg.annotations.forEach(function (ann) {
      var button = document.createElement('button'); button.className = 'btn-open-annotation'; button.dataset.annId = ann.id;
      button.textContent = annotationStatusText(ann) + ' · ' + ann.question;
      button.onclick = function (event) { event.stopPropagation(); clickAnnotation(ann.id); };
      threads.appendChild(button);
    });
    el.appendChild(threads);
  }
  return el;
}

export function renderConversation() {
  var dom = getDom(), messages = getMessages();
  dom.conversation.querySelectorAll('.message').forEach(function (el) { el.remove(); });
  dom.welcome.style.display = messages.length === 0 ? '' : 'none';
  messages.forEach(function (msg) { dom.conversation.appendChild(renderMessage(msg)); });
  syncSidebarHeights(); rebuildSidebar('left'); rebuildSidebar('right');
  if (messages.length > 0) scrollToBottom(dom.workspace);
  else dom.workspace.scrollTop = 0;
}

/** previousId lets a terminal server ID replace the optimistic local ID atomically. */
export function refreshMessage(msgId, previousId) {
  var msg = getMessages().find(function (item) { return item.id === msgId; });
  if (!msg) return;
  var old = Array.from(getDom().conversation.querySelectorAll('.message')).find(function (el) { return el.dataset.msgId === (previousId || msgId); });
  if (!old) return;
  old.replaceWith(renderMessage(msg));
  syncSidebarHeights(); rebuildSidebar('left'); rebuildSidebar('right');
}
