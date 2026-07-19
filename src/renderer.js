/* ============================================================
   ThreadThink — Message Renderer
   ============================================================ */

import { getDom } from './dom.js';
import { getMessages } from './state.js';
import { getColor } from './palette.js';
import { renderMarkdown, stripMarkdown } from './markdown.js';
import { syncSidebarHeights, rebuildSidebar } from './sidebar.js';
import { scrollToBottom } from './utils.js';

/** Highlight selected text range within a DOM tree */
export function highlightTextInDOM(root, s, e, ann, color) {
  var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), n, cp = 0;
  while ((n = w.nextNode())) {
    var len = n.textContent.length, ne = cp + len;
    if (s >= cp && e <= ne) {
      var ls = s - cp, le = e - cp;
      if (le < len) n.splitText(le);
      var mn = ls > 0 ? n.splitText(ls) : n;
      var mark = document.createElement('mark');
      mark.className = 'annotated-text'; mark.dataset.annId = ann.id;
      mark.style.background = color.bg; mark.style.borderBottomColor = color.dot;
      mn.parentNode.insertBefore(mark, mn); mark.appendChild(mn);
      var badge = document.createElement('span');
      badge.className = 'ann-badge'; badge.dataset.annId = ann.id;
      badge.style.background = color.badge; badge.textContent = '●';
      mark.parentNode.insertBefore(badge, mark.nextSibling);
      return;
    }
    cp = ne;
  }
}

/** Render message content with annotation highlights */
export function renderAnnotatedContent(msg) {
  var content = msg.content, anns = msg.annotations || [];
  var tmp = document.createElement('div'); tmp.innerHTML = renderMarkdown(content);
  if (anns.length === 0) { var f0 = document.createDocumentFragment(); while (tmp.firstChild) f0.appendChild(tmp.firstChild); return f0; }

  var ft = tmp.textContent, items = [];
  for (var i = 0; i < anns.length; i++) {
    var ann = anns[i];
    var pos = smartIndexOf(ft, content, ann);
    if (pos !== -1) items.push({ a: ann, s: pos, e: pos + ann.selectedText.length });
  }
  items.sort(function (x, y) { return y.s - x.s; });
  for (var j = 0; j < items.length; j++) highlightTextInDOM(tmp, items[j].s, items[j].e, items[j].a, getColor(items[j].a.colorIdx || 0));
  var frag = document.createDocumentFragment(); while (tmp.firstChild) frag.appendChild(tmp.firstChild); return frag;
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
