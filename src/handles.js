/* ============================================================
   ThreadThink — Handles (v2: backend chat + tool calls)
   ============================================================ */

import { getDom } from './dom.js';
import {
  getMessages, addMessage, setStreaming, isStreaming,
  getCurrentConversationId, setCurrentConversation, addConversation,
  getConversations, setConversations, getCards, clearMessages as clearAllMessages, setMessages,
} from './state.js';
import { getColor } from './palette.js';
import { genId, showToast, scrollToBottom, autoScrollIfAllowed } from './utils.js';
import { renderMarkdown } from './markdown.js';
import { renderMessage, refreshMessage, renderConversation } from './renderer.js';
import { syncSidebarHeights, rebuildSidebar } from './sidebar.js';
import { createFloatingCard } from './cards.js';
import { createChatStream, createConversation, fetchMessages, fetchConversations } from './api.js';
import { buildAnnotationContext } from './annotations.js';

// ---- Chat Send (backend version) ----

export async function handleSend() {
  var dom = getDom();
  var text = dom.userInput.value.trim();
  if (!text || isStreaming()) return;

  var convId = getCurrentConversationId();

  // Auto-create conversation if none selected
  if (!convId) {
    try {
      var conv = await createConversation(text.slice(0, 40));
      convId = conv.id;
      setCurrentConversation(convId);
      addConversation(conv);
      await refreshConversationList();
    } catch (e) { showToast(e.message, true); return; }
  }

  dom.userInput.value = ''; dom.userInput.style.height = 'auto';
  dom.btnSend.disabled = true; setStreaming(true);

  var messages = getMessages();
  var uMsg = { id: genId(), role: 'user', content: text, annotations: [] };
  var aMsg = { id: genId(), role: 'assistant', content: '', annotations: [], _loading: true };
  addMessage(uMsg);
  addMessage(aMsg);

  dom.conversation.appendChild(renderMessage(uMsg));
  dom.conversation.appendChild(renderMessage(aMsg));
  dom.welcome.style.display = 'none';
  syncSidebarHeights();
  rebuildSidebar('left'); rebuildSidebar('right');
  scrollToBottom(dom.workspace);

  var bodyEl = dom.conversation.querySelector('[data-msg-id="' + aMsg.id + '"] .message-body');

  createChatStream(convId, text, {
    onToken: function (token) {
      aMsg.content += token;
      if (bodyEl) bodyEl.innerHTML = renderMarkdown(aMsg.content);
      syncSidebarHeights();
      autoScrollIfAllowed(dom.workspace);
    },
    onToolStart: function (ts) {
      if (bodyEl) {
        var toolDiv = document.createElement('div');
        toolDiv.className = 'tool-call';
        toolDiv.dataset.toolName = ts.tool_name;
        toolDiv.innerHTML = '<div class="tool-call-header">🔧 正在调用: <strong>' + ts.tool_name + '</strong>…</div>';
        bodyEl.appendChild(toolDiv);
      }
    },
    onToolEnd: function (te) {
      if (bodyEl) {
        var toolEl = bodyEl.querySelector('.tool-call[data-tool-name="' + te.tool_name + '"]:last-child');
        if (toolEl) {
          var resultPreview = typeof te.result === 'string' ? te.result.slice(0, 200) : JSON.stringify(te.result).slice(0, 200);
          toolEl.innerHTML =
            '<details class="tool-call-details">' +
              '<summary>🔧 ' + te.tool_name + ' ✓</summary>' +
              '<pre>' + escapeHTML(resultPreview) + '</pre>' +
            '</details>';
        }
      }
    },
    onDone: function () {
      aMsg._loading = false;
      refreshMessage(aMsg.id);
      autoScrollIfAllowed(dom.workspace);
      setStreaming(false);
      dom.btnSend.disabled = false;
      dom.userInput.focus();
    },
    onError: function (err) {
      aMsg._loading = false; aMsg.content += '\n\n❌ ' + err.message;
      refreshMessage(aMsg.id);
      showToast(err.message, true);
      setStreaming(false);
      dom.btnSend.disabled = false;
    },
  });
}

// ---- Annotation (unchanged core logic) ----

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

  var card = createFloatingCard(ann, color);

  var ctx = buildAnnotationContext(msgId);
  ctx.push({ role: 'user', content: '在你之前的回答中提到了这段话：\n\n"' + st + '"\n\n追问：' + q + '\n\n请用一句话简洁回答，不要展开。' });

  var convId = getCurrentConversationId();
  if (!convId) { showToast('请先开始对话', true); return; }

  var answerEl = card.querySelector('[data-ann-content="' + ann.id + '"]');

  createChatStream(convId, '在你之前的回答中提到了这段话：\n\n"' + st + '"\n\n追问：' + q + '\n\n请用一句话简洁回答，不要展开。', {
    onToken: function (ft) {
      ann.answer = ft;
      if (answerEl) answerEl.textContent = ft;
      var pinEl = document.querySelector('.pinned-card [data-ann-content="' + ann.id + '"]');
      if (pinEl) pinEl.textContent = ft;
    },
    onToolStart: function () {},
    onToolEnd: function () {},
    onDone: function () {
      ann._loading = false;
      if (answerEl) answerEl.innerHTML = renderMarkdown(ann.answer);
      var pinEl = document.querySelector('.pinned-card [data-ann-content="' + ann.id + '"]');
      if (pinEl) pinEl.innerHTML = renderMarkdown(ann.answer);
      syncSidebarHeights(); rebuildSidebar('left'); rebuildSidebar('right');
    },
    onError: function (err) {
      ann._loading = false; ann.answer = '❌ ' + err.message;
      if (answerEl) answerEl.textContent = ann.answer;
    },
  });
}

function escapeHTML(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ---- Conversation management ----

export async function switchConversation(convId) {
  setCurrentConversation(convId);
  clearAllMessages();

  try {
    var msgs = await fetchMessages(convId);
    var mapped = msgs.map(function (m) {
      return { id: m.id, role: m.role, content: m.content, annotations: JSON.parse(m.annotations || '[]'), _loading: false };
    });
    setMessages(mapped);
    renderConversation();
  } catch (e) {
    showToast('加载对话失败: ' + e.message, true);
  }
}

export async function refreshConversationList() {
  try {
    var convs = await fetchConversations();
    setConversations(convs);
    renderConversationList();
  } catch (e) { /* silent */ }
}

function renderConversationList() {
  var listEl = document.getElementById('conversationList');
  if (!listEl) return;
  var convs = getConversations();
  var curId = getCurrentConversationId();
  var html = '';
  for (var i = 0; i < convs.length; i++) {
    var c = convs[i];
    var active = c.id === curId ? ' active' : '';
    html += '<div class="conv-item' + active + '" data-conv-id="' + c.id + '">' +
      '<span class="conv-title">' + escapeHTML(c.title || '新对话') + '</span>' +
      '<button class="conv-delete" data-conv-id="' + c.id + '">×</button>' +
      '</div>';
  }
  listEl.innerHTML = html;
}
