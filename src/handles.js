/* ============================================================
   ThreadThink — Main Action Handlers (Send + Annotate)
   ============================================================ */

import { getDom } from './dom.js';
import { getMessages, addMessage, setStreaming, isStreaming } from './state.js';
import { getApiKey, getApiBase, getModel, getSystemPrompt } from './state.js';
import { getColor } from './palette.js';
import { genId, showToast, scrollToBottom, autoScrollIfAllowed } from './utils.js';
import { renderMarkdown } from './markdown.js';
import { renderMessage, refreshMessage } from './renderer.js';
import { syncSidebarHeights, rebuildSidebar } from './sidebar.js';
import { createFloatingCard } from './cards.js';
import { callAI } from './api.js';
import { buildAnnotationContext } from './annotations.js';

export function handleAnnotateClick() {
  var dom = getDom();
  var sel = window.getSelection(); if (!sel || sel.isCollapsed) return;
  var range = sel.getRangeAt(0), st = sel.toString().trim(); if (!st) return;
  var msgEl = sel.anchorNode.parentElement.closest('.message'); if (!msgEl) return;
  var msgId = msgEl.dataset.msgId;
  var messages = getMessages();
  var msg = null; for (var i = 0; i < messages.length; i++) { if (messages[i].id === msgId) { msg = messages[i]; break; } }
  if (!msg) return;
  dom.selectionToolbar.classList.remove('visible');

  var preview = st.length > 80 ? st.slice(0, 80) + '...' : st;
  var q = prompt('对选中内容的追问：\n\n📌 "' + preview + '"\n\n请输入你的问题：');
  if (!q || !q.trim()) { sel.removeAllRanges(); return; }
  q = q.trim();

  if (!msg.annotations) msg.annotations = [];

  // Store surrounding raw context for reliable re-render position matching
  var rawContent = msg.content;
  var firstIdx = rawContent.indexOf(st);
  var ctxStart = Math.max(0, firstIdx - 25);
  var ctxEnd = Math.min(rawContent.length, firstIdx + st.length + 25);
  var rawContext = rawContent.slice(ctxStart, ctxEnd);

  var ci = msg.annotations.length, color = getColor(ci);
  var ann = { id: genId(), selectedText: st, question: q, answer: '', annotations: [], _loading: true, colorIdx: ci, rawContext: rawContext };
  msg.annotations.push(ann);

  // Direct DOM highlight
  var mark = document.createElement('mark'); mark.className = 'annotated-text'; mark.dataset.annId = ann.id;
  mark.style.background = color.bg; mark.style.borderBottomColor = color.dot;
  try { range.surroundContents(mark); } catch (e) { var fr = range.extractContents(); mark.appendChild(fr); range.insertNode(mark); }
  var badge = document.createElement('span'); badge.className = 'ann-badge'; badge.dataset.annId = ann.id;
  badge.style.background = color.badge; badge.textContent = '●';
  mark.parentNode.insertBefore(badge, mark.nextSibling);
  sel.removeAllRanges();

  // Create floating card
  var card = createFloatingCard(ann, color);

  // Call AI for annotation answer
  var ctx = buildAnnotationContext(msgId);
  ctx.push({ role: 'user', content: '在你之前的回答中提到了这段话：\n\n"' + st + '"\n\n追问：' + q + '\n\n请用一句话简洁回答，不要展开。' });

  var config = { apiKey: getApiKey(), apiBase: getApiBase(), model: getModel(), systemPrompt: getSystemPrompt() };
  var answerEl = card.querySelector('[data-ann-content="' + ann.id + '"]');

  callAI(ctx, config, function (ft) {
    ann.answer = ft;
    if (answerEl) answerEl.textContent = ft;
    var pinEl = document.querySelector('.pinned-card [data-ann-content="' + ann.id + '"]');
    if (pinEl) pinEl.textContent = ft;
  }).then(function (ft) {
    ann.answer = ft; ann._loading = false;
    if (answerEl) answerEl.innerHTML = renderMarkdown(ft);
    var pinEl = document.querySelector('.pinned-card [data-ann-content="' + ann.id + '"]');
    if (pinEl) pinEl.innerHTML = renderMarkdown(ft);
    syncSidebarHeights(); rebuildSidebar('left'); rebuildSidebar('right');
  }).catch(function (err) {
    ann._loading = false; ann.answer = '❌ ' + err.message;
    if (answerEl) answerEl.textContent = ann.answer;
    var pinEl = document.querySelector('.pinned-card [data-ann-content="' + ann.id + '"]');
    if (pinEl) pinEl.textContent = ann.answer;
    showToast(err.message, true);
  });
}

export function handleSend() {
  var dom = getDom();
  var text = dom.userInput.value.trim();
  if (!text || isStreaming()) return;
  dom.userInput.value = ''; dom.userInput.style.height = 'auto';
  dom.btnSend.disabled = true; setStreaming(true);

  var uMsg = { id: genId(), role: 'user', content: text, annotations: [] };
  var aMsg = { id: genId(), role: 'assistant', content: '', annotations: [], _loading: true };
  addMessage(uMsg);
  addMessage(aMsg);

  // APPEND only — never destroy existing DOM (preserves annotation highlights)
  dom.conversation.appendChild(renderMessage(uMsg));
  dom.conversation.appendChild(renderMessage(aMsg));
  dom.welcome.style.display = 'none';
  syncSidebarHeights();
  rebuildSidebar('left'); rebuildSidebar('right');
  scrollToBottom(dom.workspace);

  var bodyEl = dom.conversation.querySelector('[data-msg-id="' + aMsg.id + '"] .message-body');
  var messages = getMessages();
  var apiMsgs = [];
  for (var i = 0; i < messages.length; i++) { if (messages[i] === aMsg) break; apiMsgs.push({ role: messages[i].role, content: messages[i].content }); }

  var config = { apiKey: getApiKey(), apiBase: getApiBase(), model: getModel(), systemPrompt: getSystemPrompt() };

  callAI(apiMsgs, config, function (ft) {
    aMsg.content = ft;
    if (bodyEl) bodyEl.innerHTML = renderMarkdown(ft);
    syncSidebarHeights();
    autoScrollIfAllowed(dom.workspace);
  })
    .then(function (ft) { aMsg._loading = false; aMsg.content = ft; refreshMessage(aMsg.id); autoScrollIfAllowed(dom.workspace); setStreaming(false); dom.btnSend.disabled = false; dom.userInput.focus(); })
    .catch(function (err) { aMsg._loading = false; aMsg.content = '❌ ' + err.message; refreshMessage(aMsg.id); showToast(err.message, true); setStreaming(false); dom.btnSend.disabled = false; });
}
