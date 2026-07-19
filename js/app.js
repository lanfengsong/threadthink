/* ============================================================
   ThreadThink — sidebar-aligned annotation cards
   ============================================================ */

// ============================================================
// State & Config
// ============================================================
var PALETTE = [
  { name:'amber',  bg:'#fff8e1', border:'#ff8f00', header:'#e65100', badge:'#bf360c', dot:'#ff8f00' },
  { name:'green',  bg:'#e8f5e9', border:'#43a047', header:'#2e7d32', badge:'#1b5e20', dot:'#66bb6a' },
  { name:'blue',   bg:'#e3f2fd', border:'#1e88e5', header:'#1565c0', badge:'#0d47a1', dot:'#42a5f5' },
  { name:'pink',   bg:'#fce4ec', border:'#e91e63', header:'#ad1457', badge:'#880e4f', dot:'#ec407a' },
  { name:'purple', bg:'#f3e5f5', border:'#8e24aa', header:'#6a1b9a', badge:'#4a148c', dot:'#ab47bc' },
  { name:'teal',   bg:'#e0f2f1', border:'#00897b', header:'#00695c', badge:'#004d40', dot:'#26a69a' },
];

var state = {
  apiKey:     localStorage.getItem('tt_api_key') || '',
  apiBase:    localStorage.getItem('tt_api_base') || '',
  model:      localStorage.getItem('tt_model') || 'deepseek-chat',
  systemPrompt: localStorage.getItem('tt_system') || '你是一个有帮助的AI助手，请用中文回答用户的问题。',
  messages:   [],
  cards:      {},     // { annId: { el, pinned:'left'|'right'|false } }
  nextId:     1,
  isStreaming: false,
};

// ============================================================
// DOM refs
// ============================================================
var $ = function (s) { return document.querySelector(s); };
var dom = {
  workspace: $('#workspace'), conversation: $('#conversation'), welcome: $('#welcome'),
  sidebarLeft: $('#sidebarLeft'), sidebarRight: $('#sidebarRight'),
  sidebarLeftInner: $('#sidebarLeftInner'), sidebarRightInner: $('#sidebarRightInner'),
  userInput: $('#userInput'), btnSend: $('#btnSend'),
  selectionToolbar: $('#selectionToolbar'), btnAnnotate: $('#btnAnnotate'),
  modalOverlay: $('#modalOverlay'), btnSettings: $('#btnSettings'), btnCloseModal: $('#btnCloseModal'),
  btnSaveSettings: $('#btnSaveSettings'), btnResetSettings: $('#btnResetSettings'), btnClear: $('#btnClear'),
  apiKeyInput: $('#apiKeyInput'), apiBaseInput: $('#apiBaseInput'),
  modelInput: $('#modelInput'), systemPromptInput: $('#systemPromptInput'),
  toastContainer: $('#toastContainer'),
};

// ============================================================
// Utilities
// ============================================================
function genId() { return 'm' + (state.nextId++); }
function escapeHTML(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
var _userScrolledAway = false;

/** Track whether user has scrolled away from the bottom */
function trackUserScroll() {
  var atBottom = dom.workspace.scrollTop + dom.workspace.clientHeight >= dom.workspace.scrollHeight - 20;
  if (!atBottom) _userScrolledAway = true;
  else _userScrolledAway = false;
}

function scrollToBottom() {
  // Only scroll if conversation content exceeds viewport height
  if (dom.conversation.scrollHeight <= dom.workspace.clientHeight) return;
  dom.workspace.scrollTop = dom.workspace.scrollHeight;
  _userScrolledAway = false;
}

/** Only scroll to bottom if user hasn't scrolled away manually */
function autoScrollIfAllowed() {
  if (!_userScrolledAway) scrollToBottom();
}
function showToast(m, e) { var t = document.createElement('div'); t.className = 'toast' + (e ? ' error' : ''); t.textContent = m; dom.toastContainer.appendChild(t); setTimeout(function () { t.remove(); }, 3000); }
function getColor(i) { return PALETTE[i % PALETTE.length]; }

// ============================================================
// Markdown Renderer
// ============================================================
function renderMarkdown(text) {
  if (!text) return '';
  var L = text.split('\n'), h = '', c = false, cd = '', il = false, lt = '';
  for (var i = 0; i < L.length; i++) {
    var l = L[i];
    if (/^```/.test(l)) { if (c) { h += '<pre><code>' + escapeHTML(cd.trim()) + '</code></pre>'; cd = ''; c = false; } else { c = true; } if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } continue; }
    if (c) { cd += l + '\n'; continue; }
    if (!l.trim()) { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } continue; }
    var p = escapeHTML(l);
    p = p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    p = p.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
    p = p.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
    if (/^#### (.+)/.test(l)) { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } h += '<h5>' + p.replace(/^#### /, '') + '</h5>'; }
    else if (/^### (.+)/.test(l)) { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } h += '<h4>' + p.replace(/^### /, '') + '</h4>'; }
    else if (/^## (.+)/.test(l)) { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } h += '<h3>' + p.replace(/^## /, '') + '</h3>'; }
    else if (/^# (.+)/.test(l)) { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } h += '<h2>' + p.replace(/^# /, '') + '</h2>'; }
    else if (/^\d+\.\s/.test(l)) { if (!il || lt !== 'ol') { if (il) h += '</ul>'; h += '<ol>'; il = true; lt = 'ol'; } h += '<li>' + p.replace(/^\d+\.\s/, '') + '</li>'; }
    else if (/^[-*]\s/.test(l)) { if (!il || lt !== 'ul') { if (il) h += '</ol>'; h += '<ul>'; il = true; lt = 'ul'; } h += '<li>' + p.replace(/^[-*]\s/, '') + '</li>'; }
    else { if (il) { h += lt === 'ul' ? '</ul>' : '</ol>'; il = false; } h += '<p>' + p + '</p>'; }
  }
  if (il) h += lt === 'ul' ? '</ul>' : '</ol>';
  if (c) h += '<pre><code>' + escapeHTML(cd.trim()) + '</code></pre>';
  return h;
}

// ============================================================
// API
// ============================================================
function callAI(messages, onChunk) {
  return new Promise(function (resolve, reject) {
    if (!state.apiKey) { reject(new Error('请设置 API Key')); return; }
    var isAnthropic = state.apiBase.indexOf('anthropic.com') !== -1;
    var body;
    if (isAnthropic) {
      var am = []; for (var i = 0; i < messages.length; i++) am.push({ role: messages[i].role, content: messages[i].content });
      body = { model: state.model, max_tokens: 4096, system: state.systemPrompt, messages: am, stream: true };
    } else {
      var om = [{ role: 'system', content: state.systemPrompt }];
      for (var j = 0; j < messages.length; j++) om.push({ role: messages[j].role, content: messages[j].content });
      body = { model: state.model, max_tokens: 4096, messages: om, stream: true };
    }
    var headers = { 'Content-Type': 'application/json' };
    if (isAnthropic) { headers['x-api-key'] = state.apiKey; headers['anthropic-version'] = '2023-06-01'; }
    else { headers['Authorization'] = 'Bearer ' + state.apiKey; }
    fetch(state.apiBase, { method: 'POST', headers: headers, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { reject(new Error('API ' + r.status + ': ' + t.slice(0, 200))); });
        var reader = r.body.getReader(), dec = new TextDecoder(), full = '', buf = '';
        function pump() {
          reader.read().then(function (v) {
            if (v.done) { resolve(full); return; }
            buf += dec.decode(v.value, { stream: true });
            var lines = buf.split('\n'); buf = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) {
              var ln = lines[i].trim();
              if (!ln || ln.indexOf('data: ') !== 0) continue;
              var d = ln.slice(6); if (d === '[DONE]') continue;
              try {
                var json = JSON.parse(d), chunk = '';
                if (isAnthropic) { if (json.type === 'content_block_delta' && json.delta && json.delta.text) chunk = json.delta.text; }
                else { var delta = json.choices && json.choices[0] && json.choices[0].delta; if (delta && delta.content) chunk = delta.content; }
                if (chunk) { full += chunk; onChunk(full); }
              } catch (e) {}
            }
            pump();
          }).catch(reject);
        }
        pump();
      }).catch(reject);
  });
}

// ============================================================
// Annotation Helpers
// ============================================================
function findAnnotationById(id) {
  for (var i = 0; i < state.messages.length; i++) {
    var anns = state.messages[i].annotations; if (!anns) continue;
    for (var j = 0; j < anns.length; j++) { var f = findAnnRec(anns[j], id); if (f) return f; }
  }
  return null;
}
function findAnnRec(a, id) { if (a.id === id) return a; if (a.annotations) for (var i = 0; i < a.annotations.length; i++) { var f = findAnnRec(a.annotations[i], id); if (f) return f; } return null; }
function findParentMessage(annId) {
  for (var i = 0; i < state.messages.length; i++) {
    var anns = state.messages[i].annotations; if (!anns) continue;
    for (var j = 0; j < anns.length; j++) { if (hasAnn(anns[j], annId)) return state.messages[i]; }
  }
  return null;
}
function hasAnn(a, id) { if (a.id === id) return true; if (a.annotations) for (var i = 0; i < a.annotations.length; i++) { if (hasAnn(a.annotations[i], id)) return true; } return false; }
function buildAnnotationContext(msgId) {
  var ctx = [];
  for (var i = 0; i < state.messages.length; i++) { ctx.push({ role: state.messages[i].role, content: state.messages[i].content }); if (state.messages[i].id === msgId) break; }
  return ctx;
}

// ============================================================
// Sidebar Alignment System
// ============================================================

/** Sync sidebar-inner heights to match conversation content height */
function syncSidebarHeights() {
  // When empty, reset sidebars to natural height to avoid unnecessary overflow
  if (state.messages.length === 0) {
    dom.sidebarLeft.style.height = '';
    dom.sidebarRight.style.height = '';
    dom.sidebarLeftInner.style.height = '';
    dom.sidebarRightInner.style.height = '';
    return;
  }
  var h = dom.conversation.scrollHeight;
  var hintEl = dom.sidebarLeft.querySelector('.sidebar-hint');
  var hintH = hintEl ? hintEl.offsetHeight : 0;
  dom.sidebarLeft.style.height = h + 'px';
  dom.sidebarRight.style.height = h + 'px';
  // Inner height excludes hint height so sidebar content doesn't overflow
  dom.sidebarLeftInner.style.height = (h - hintH) + 'px';
  dom.sidebarRightInner.style.height = (h - hintH) + 'px';
}

/** On workspace scroll: sync sidebar native scrollTop (zero-lag, same render pipeline) */

/** Find the vertical offset of an annotation's highlight relative to conversation content top */
function getAnnotationMarkTop(annId) {
  var mark = document.querySelector('.annotated-text[data-ann-id="' + annId + '"]');
  if (!mark) return 0;
  // Both mark and conversation are viewport-relative; their difference is constant regardless of scroll
  return mark.getBoundingClientRect().top - dom.conversation.getBoundingClientRect().top;
}

/** Build a single pinned card DOM element */
function createPinnedCardEl(annId) {
  var ann = findAnnotationById(annId); if (!ann) return null;
  var color = getColor(ann.colorIdx || 0);

  var el = document.createElement('div');
  el.className = 'pinned-card';
  el.dataset.pinnedAnn = annId;
  el.style.borderColor = color.border;

  el.innerHTML =
    '<div class="pinned-header" style="background:' + color.header + '">' +
      '<span style="width:8px;height:8px;border-radius:50%;background:#fff;flex-shrink:0"></span>' +
      '<span class="pinned-title">' + escapeHTML(ann.question.slice(0, 30)) + (ann.question.length > 30 ? '...' : '') + '<span class="edit-hint">✎</span></span>' +
      '<button class="btn-unpin" title="取消固定">↗</button>' +
    '</div>' +
    '<div class="pinned-body">' +
      '<div style="color:#999;font-size:11px;margin-bottom:4px">📌 ' + escapeHTML(ann.selectedText.slice(0, 60)) + (ann.selectedText.length > 60 ? '...' : '') + '</div>' +
      '<div data-ann-content="' + annId + '">' + (ann.answer ? renderMarkdown(ann.answer) : (ann._loading ? '<em>…</em>' : '')) + '</div>' +
    '</div>';

  el.querySelector('.btn-unpin').onclick = function (e) { e.stopPropagation(); unpinCard(annId); };
  el.querySelector('.pinned-title').onclick = function (e) { e.stopPropagation(); editAnnQuestion(ann, this, 'pinned'); };
  el.addEventListener('click', function () { clickAnnotation(annId); });
  return el;
}

/** Rebuild a sidebar: spacers align pinned cards with annotations */
function rebuildSidebar(side) {
  var inner = side === 'left' ? dom.sidebarLeftInner : dom.sidebarRightInner;
  var hint = (side === 'left' ? dom.sidebarLeft : dom.sidebarRight).querySelector('.sidebar-hint');

  // Collect pinned cards for this sidebar
  var pinned = [];
  for (var annId in state.cards) {
    if (state.cards[annId] && state.cards[annId].pinned === side) pinned.push(annId);
  }

  // Sort by annotation vertical position
  pinned.sort(function (a, b) { return getAnnotationMarkTop(a) - getAnnotationMarkTop(b); });

  // Clear
  inner.innerHTML = '';

  if (pinned.length === 0) {
    if (hint) hint.style.display = '';
    return;
  }

  // Estimate card height for spacer calculations
  var EST_H = 170;
  var prevBottom = 0;

  for (var i = 0; i < pinned.length; i++) {
    var markTop = getAnnotationMarkTop(pinned[i]);
    var gap = Math.max(0, markTop - prevBottom);

    if (gap > 0) {
      var spacer = document.createElement('div');
      spacer.className = 'sidebar-spacer';
      spacer.style.height = gap + 'px';
      inner.appendChild(spacer);
    }

    var cardEl = createPinnedCardEl(pinned[i]);
    if (cardEl) { inner.appendChild(cardEl); prevBottom = markTop + EST_H; }
  }

  // Pad bottom to match inner height
  var totalH = parseFloat(inner.style.height) || dom.conversation.scrollHeight;
  if (prevBottom < totalH) {
    var pad = document.createElement('div');
    pad.className = 'sidebar-spacer';
    pad.style.height = (totalH - prevBottom) + 'px';
    inner.appendChild(pad);
  }

  if (hint) hint.style.display = 'none';
}

// ============================================================
// Card System
// ============================================================
function createFloatingCard(ann, color) {
  if (state.cards[ann.id] && state.cards[ann.id].el) state.cards[ann.id].el.remove();

  var card = document.createElement('div');
  card.className = 'ann-card';
  card.id = 'card-' + ann.id;
  card.style.borderColor = color.border;

  card.innerHTML =
    '<div class="ann-card-header" style="background:' + color.header + '">' +
      '<span class="card-title">📌 批注</span>' +
      '<button class="btn-pin-left" title="固定左侧">L</button>' +
      '<button class="btn-pin-right" title="固定右侧">R</button>' +
      '<button class="btn-card-close" title="关闭">✕</button>' +
    '</div>' +
    '<div class="ann-card-body">' +
      '<div class="ann-card-quote" style="border-color:' + color.dot + '">"' + escapeHTML(ann.selectedText.slice(0, 120)) + (ann.selectedText.length > 120 ? '...' : '') + '"</div>' +
      '<div class="ann-card-question">' + escapeHTML(ann.question) + '<span class="edit-hint">可单击编辑</span></div>' +
      '<div class="ann-card-answer" data-ann-content="' + ann.id + '">' +
        (ann.answer ? renderMarkdown(ann.answer) : (ann._loading ? '<em>思考中...</em>' : '<em>等待回答...</em>')) +
      '</div>' +
    '</div>';

  var markEl = document.querySelector('.annotated-text[data-ann-id="' + ann.id + '"]');
  var rect = markEl ? markEl.getBoundingClientRect() : { left: 300, top: 200 };
  card.style.left = Math.min(rect.right + 16, window.innerWidth - 380) + 'px';
  card.style.top = Math.max(60, rect.top) + 'px';

  document.body.appendChild(card);
  state.cards[ann.id] = { el: card, pinned: false };
  makeDraggable(card, ann.id);

  card.querySelector('.btn-pin-left').onclick = function (e) { e.stopPropagation(); pinCard(ann.id, 'left'); };
  card.querySelector('.btn-pin-right').onclick = function (e) { e.stopPropagation(); pinCard(ann.id, 'right'); };
  card.querySelector('.btn-card-close').onclick = function (e) { e.stopPropagation(); closeCard(ann.id); };
  card.querySelector('.ann-card-question').onclick = function (e) { e.stopPropagation(); editAnnQuestion(ann, this, 'floating'); };
  return card;
}

function makeDraggable(card, annId) {
  var header = card.querySelector('.ann-card-header');
  header.addEventListener('mousedown', function (e) {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    var sx = e.clientX, sy = e.clientY, ol = card.offsetLeft, ot = card.offsetTop;
    card.style.transition = 'none';
    function mv(ev) { card.style.left = (ol + ev.clientX - sx) + 'px'; card.style.top = (ot + ev.clientY - sy) + 'px'; }
    function up(ev) {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      card.style.transition = '';
      card.style.display = 'none';
      var below = document.elementFromPoint(ev.clientX, ev.clientY);
      card.style.display = '';
      var sb = below ? below.closest('.sidebar') : null;
      if (sb) { pinCard(annId, sb.id === 'sidebarLeft' ? 'left' : 'right'); }
    }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
}

function pinCard(annId, side) {
  if (!state.cards[annId]) return;
  if (state.cards[annId].el) { state.cards[annId].el.remove(); state.cards[annId].el = null; }
  state.cards[annId].pinned = side;
  syncSidebarHeights();
  rebuildSidebar(side);
  showToast('已固定到' + (side === 'left' ? '左' : '右') + '侧栏');
}

function unpinCard(annId) {
  if (!state.cards[annId]) return;
  var oldSide = state.cards[annId].pinned;
  state.cards[annId].pinned = false;
  rebuildSidebar(oldSide);
  var ann = findAnnotationById(annId);
  if (ann) createFloatingCard(ann, getColor(ann.colorIdx || 0));
}

function closeCard(annId) {
  if (state.cards[annId] && state.cards[annId].el) { state.cards[annId].el.remove(); state.cards[annId].el = null; }
}

/** Turn question text into editable input */
function editAnnQuestion(ann, el, type) {
  var current = ann.question;
  var input = document.createElement('input');
  input.value = current;

  function finish(shouldSave) {
    var newQ = input.value.trim();
    if (shouldSave && newQ) { ann.question = newQ; }
    if (type === 'floating') {
      closeCard(ann.id);
      createFloatingCard(ann, getColor(ann.colorIdx || 0));
    }
    rebuildSidebar('left'); rebuildSidebar('right');
  }

  input.addEventListener('blur', function () { finish(true); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { finish(false); }
  });

  el.innerHTML = '';
  el.appendChild(input);
  input.focus();
  input.select();
}

function clickAnnotation(annId) {
  var ann = findAnnotationById(annId); if (!ann) return;
  var cd = state.cards[annId];
  if (cd && cd.pinned) {
    // Scroll conversation to annotation
    var mark = document.querySelector('.annotated-text[data-ann-id="' + annId + '"]');
    if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (cd && cd.el) {
    cd.el.style.zIndex = 110;
  } else {
    createFloatingCard(ann, getColor(ann.colorIdx || 0));
  }
}

// ============================================================
// Rendering
// ============================================================
function addMarkClickHandler(m) { m.onclick = function (e) { e.stopPropagation(); clickAnnotation(this.dataset.annId); }; }
function addBadgeClickHandler(b) {
  b.onclick = function (e) { e.stopPropagation(); clickAnnotation(this.dataset.annId); };
}

function highlightTextInDOM(root, s, e, ann, color) {
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
      addMarkClickHandler(mark);
      mn.parentNode.insertBefore(mark, mn); mark.appendChild(mn);
      var badge = document.createElement('span');
      badge.className = 'ann-badge'; badge.dataset.annId = ann.id;
      badge.style.background = color.badge; badge.textContent = '●';
      addBadgeClickHandler(badge);
      mark.parentNode.insertBefore(badge, mark.nextSibling);
      return;
    }
    cp = ne;
  }
}

function renderAnnotatedContent(msg) {
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
  // Count occurrences
  var count = 0, pos = -1;
  while ((pos = renderedText.indexOf(st, pos + 1)) !== -1) count++;
  if (count <= 1) return renderedText.indexOf(st);  // Unique, simple case

  // Multiple occurrences: use rawContext as fingerprint
  var ctx = ann.rawContext;
  if (!ctx) return renderedText.indexOf(st);

  // Strip markdown from rawContext to get rendered equivalent
  var ctxRendered = stripMarkdown(ctx);
  // Find ctxRendered in renderedText
  var ctxPos = renderedText.indexOf(ctxRendered);
  if (ctxPos === -1) return renderedText.indexOf(st);

  // Find selectedText within the context in rendered text
  var relPos = ctxRendered.indexOf(st);
  if (relPos === -1) return renderedText.indexOf(st);

  return ctxPos + relPos;
}

/** Strip markdown formatting chars from text (for matching raw → rendered) */
function stripMarkdown(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1')
             .replace(/^#{1,4}\s/gm, '').replace(/^[-*]\s/gm, '').replace(/^\d+\.\s/gm, '');
}

function renderMessage(msg) {
  var el = document.createElement('div'); el.className = 'message ' + msg.role; el.dataset.msgId = msg.id;
  var rl = document.createElement('div'); rl.className = 'message-role'; rl.textContent = msg.role === 'user' ? '你' : 'AI'; el.appendChild(rl);
  var body = document.createElement('div'); body.className = 'message-body'; body.appendChild(renderAnnotatedContent(msg)); el.appendChild(body);
  if (msg._loading) { var ty = document.createElement('div'); ty.className = 'typing-indicator'; ty.innerHTML = '<span></span><span></span><span></span>'; el.querySelector('.message-body').appendChild(ty); }
  return el;
}

function renderConversation() {
  var ex = dom.conversation.querySelectorAll('.message'); for (var i = 0; i < ex.length; i++) ex[i].remove();
  dom.welcome.style.display = state.messages.length === 0 ? '' : 'none';
  for (var j = 0; j < state.messages.length; j++) dom.conversation.appendChild(renderMessage(state.messages[j]));
  syncSidebarHeights();
  rebuildSidebar('left'); rebuildSidebar('right');
  if (state.messages.length > 0) {
    scrollToBottom();
  } else {
    dom.workspace.scrollTop = 0;
  }
}

function refreshMessage(msgId) {
  var msg = null; for (var i = 0; i < state.messages.length; i++) { if (state.messages[i].id === msgId) { msg = state.messages[i]; break; } }
  if (!msg) return;
  var old = dom.conversation.querySelector('[data-msg-id="' + msgId + '"]'); if (!old) return;
  old.replaceWith(renderMessage(msg));
  syncSidebarHeights(); rebuildSidebar('left'); rebuildSidebar('right');
}

// ============================================================
// Annotation Operations
// ============================================================
function handleAnnotateClick() {
  var sel = window.getSelection(); if (!sel || sel.isCollapsed) return;
  var range = sel.getRangeAt(0), st = sel.toString().trim(); if (!st) return;
  var msgEl = sel.anchorNode.parentElement.closest('.message'); if (!msgEl) return;
  var msgId = msgEl.dataset.msgId;
  var msg = null; for (var i = 0; i < state.messages.length; i++) { if (state.messages[i].id === msgId) { msg = state.messages[i]; break; } }
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
  mark.style.background = color.bg; mark.style.borderBottomColor = color.dot; addMarkClickHandler(mark);
  try { range.surroundContents(mark); } catch (e) { var fr = range.extractContents(); mark.appendChild(fr); range.insertNode(mark); }
  var badge = document.createElement('span'); badge.className = 'ann-badge'; badge.dataset.annId = ann.id;
  badge.style.background = color.badge; badge.textContent = '●'; addBadgeClickHandler(badge);
  mark.parentNode.insertBefore(badge, mark.nextSibling);
  sel.removeAllRanges();

  // Create floating card
  var card = createFloatingCard(ann, color);

  // Call AI
  var ctx = buildAnnotationContext(msgId);
  ctx.push({ role: 'user', content: '在你之前的回答中提到了这段话：\n\n"' + st + '"\n\n追问：' + q + '\n\n请用一句话简洁回答，不要展开。' });

  var answerEl = card.querySelector('[data-ann-content="' + ann.id + '"]');

  callAI(ctx, function (ft) {
    ann.answer = ft;
    if (answerEl) answerEl.textContent = ft;
    // Also update pinned if exists
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

// ============================================================
// Main Send
// ============================================================
function handleSend() {
  var text = dom.userInput.value.trim(); if (!text || state.isStreaming) return;
  dom.userInput.value = ''; dom.userInput.style.height = 'auto';
  dom.btnSend.disabled = true; state.isStreaming = true;

  var uMsg = { id: genId(), role: 'user', content: text, annotations: [] };
  var aMsg = { id: genId(), role: 'assistant', content: '', annotations: [], _loading: true };
  state.messages.push(uMsg);
  state.messages.push(aMsg);

  // APPEND only — never destroy existing DOM (preserves annotation highlights)
  dom.conversation.appendChild(renderMessage(uMsg));
  dom.conversation.appendChild(renderMessage(aMsg));
  dom.welcome.style.display = 'none';
  syncSidebarHeights();
  rebuildSidebar('left'); rebuildSidebar('right');
  scrollToBottom();

  var bodyEl = dom.conversation.querySelector('[data-msg-id="' + aMsg.id + '"] .message-body');
  var apiMsgs = [];
  for (var i = 0; i < state.messages.length; i++) { if (state.messages[i] === aMsg) break; apiMsgs.push({ role: state.messages[i].role, content: state.messages[i].content }); }

  callAI(apiMsgs, function (ft) { aMsg.content = ft; if (bodyEl) bodyEl.innerHTML = renderMarkdown(ft); syncSidebarHeights(); autoScrollIfAllowed(); })
    .then(function (ft) { aMsg._loading = false; aMsg.content = ft; refreshMessage(aMsg.id); autoScrollIfAllowed(); state.isStreaming = false; dom.btnSend.disabled = false; dom.userInput.focus(); })
    .catch(function (err) { aMsg._loading = false; aMsg.content = '❌ ' + err.message; refreshMessage(aMsg.id); showToast(err.message, true); state.isStreaming = false; dom.btnSend.disabled = false; });
}

// ============================================================
// Selection
// ============================================================
function handleSelection() {
  var sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { dom.selectionToolbar.classList.remove('visible'); return; }
  var node = sel.anchorNode; if (!node) { dom.selectionToolbar.classList.remove('visible'); return; }
  var msgEl = node.parentElement.closest('.message');
  if (!msgEl || !msgEl.classList.contains('assistant')) { dom.selectionToolbar.classList.remove('visible'); return; }
  var rect = sel.getRangeAt(0).getBoundingClientRect();
  dom.selectionToolbar.style.left = (rect.left + rect.width / 2) + 'px';
  dom.selectionToolbar.style.top = rect.top + 'px';
  dom.selectionToolbar.classList.add('visible');
}

// ============================================================
// Settings
// ============================================================
function openSettings() { dom.apiKeyInput.value = state.apiKey; dom.apiBaseInput.value = state.apiBase; dom.modelInput.value = state.model; dom.systemPromptInput.value = state.systemPrompt; dom.modalOverlay.classList.add('visible'); }
function closeSettings() { dom.modalOverlay.classList.remove('visible'); }
function saveSettings() {
  state.apiKey = dom.apiKeyInput.value.trim(); state.apiBase = dom.apiBaseInput.value.trim();
  state.model = dom.modelInput.value.trim() || 'deepseek-chat'; state.systemPrompt = dom.systemPromptInput.value.trim();
  localStorage.setItem('tt_api_key', state.apiKey); localStorage.setItem('tt_api_base', state.apiBase);
  localStorage.setItem('tt_model', state.model); localStorage.setItem('tt_system', state.systemPrompt);
  closeSettings(); showToast('已保存 ✓');
}
function resetSettings() { dom.apiKeyInput.value = ''; dom.apiBaseInput.value = 'https://api.deepseek.com/v1/chat/completions'; dom.modelInput.value = 'deepseek-chat'; dom.systemPromptInput.value = '你是一个有帮助的AI助手，请用中文回答用户的问题。'; }
function clearConversation() {
  if (!confirm('清空所有对话和批注？')) return;
  state.messages = [];
  for (var k in state.cards) { if (state.cards[k].el) state.cards[k].el.remove(); }
  state.cards = {};
  dom.sidebarLeftInner.innerHTML = ''; dom.sidebarRightInner.innerHTML = '';
  $('#sidebarLeftHint').style.display = ''; $('#sidebarRightHint').style.display = '';
  renderConversation(); showToast('已清空');
}

function autoResize() { dom.userInput.style.height = 'auto'; dom.userInput.style.height = Math.min(dom.userInput.scrollHeight, 120) + 'px'; }

// ============================================================
// Events
// ============================================================
function bindEvents() {
  document.addEventListener('mouseup', function () { setTimeout(handleSelection, 0); });
  document.addEventListener('mousedown', function (e) { if (!e.target.closest('.selection-toolbar') && !e.target.closest('.message-body')) dom.selectionToolbar.classList.remove('visible'); });
  dom.btnAnnotate.addEventListener('click', handleAnnotateClick);
  dom.btnSend.addEventListener('click', handleSend);
  dom.userInput.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } });
  dom.userInput.addEventListener('input', autoResize);
  dom.btnSettings.addEventListener('click', openSettings);
  dom.btnCloseModal.addEventListener('click', closeSettings);
  dom.modalOverlay.addEventListener('click', function (e) { if (e.target === dom.modalOverlay) closeSettings(); });
  dom.btnSaveSettings.addEventListener('click', saveSettings);
  dom.btnResetSettings.addEventListener('click', resetSettings);
  dom.btnClear.addEventListener('click', clearConversation);
  dom.workspace.addEventListener('scroll', trackUserScroll);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { dom.selectionToolbar.classList.remove('visible'); closeSettings(); } });
}

function init() { bindEvents(); renderConversation(); dom.userInput.focus(); requestAnimationFrame(function () { dom.workspace.scrollTop = 0; }); if (!state.apiKey) setTimeout(function () { showToast('💡 点击右上角 ⚙️ 设置 API Key'); }, 500); }
document.addEventListener('DOMContentLoaded', init);
