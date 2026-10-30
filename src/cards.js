/* ============================================================
   ThreadThink — Annotation Card System
   ============================================================ */

import './annotations.css';
import { getCards, setCard, deleteCard, isStreaming, getReplaySeq } from './state.js';
import { getColor } from './palette.js';
import { escapeHTML, showToast } from './utils.js';
import { renderMarkdown } from './markdown.js';
import { findAnnotationById, findParentMessage } from './annotations.js';
import { updateAnnotation } from './api.js';
import { handleChildAnnotation, replyToAnnotation, retryDraftAnnotation } from './handles.js';
import { annotationStatusText, refreshMessage, renderToolCalls, renderAnnotatedContent } from './renderer.js';
import { rebuildSidebar, syncSidebarHeights } from './sidebar.js';

/** Create a floating annotation card */
export function createFloatingCard(ann, color) {
  var cards = getCards();
  if (cards[ann.id] && cards[ann.id].el) cards[ann.id].el.remove();

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
      '<div class="ann-card-answer">' +
        (ann.answer ? renderMarkdown(ann.answer) : (ann._loading ? '<em>思考中...</em>' : '<em>等待回答...</em>')) +
      '</div>' +
    '</div>';

  card.querySelector('.ann-card-answer').dataset.annContent = ann.id;
  var markEl = Array.from(document.querySelectorAll('.annotated-text')).find(function (el) { return el.dataset.annId === ann.id; });
  var rect = markEl ? markEl.getBoundingClientRect() : { right: 300, top: 200 };
  card.style.left = Math.min(rect.right + 16, window.innerWidth - 380) + 'px';
  card.style.top = Math.max(60, rect.top) + 'px';

  document.body.appendChild(card);
  setCard(ann.id, { el: card, pinned: false });
  makeDraggable(card, ann.id);

  card.querySelector('.btn-pin-left').onclick = function (e) { e.stopPropagation(); pinCard(ann.id, 'left'); };
  card.querySelector('.btn-pin-right').onclick = function (e) { e.stopPropagation(); pinCard(ann.id, 'right'); };
  card.querySelector('.btn-card-close').onclick = function (e) { e.stopPropagation(); closeCard(ann.id); };
  card.querySelector('.ann-card-question').onclick = function (e) { e.stopPropagation(); editAnnQuestion(ann, card.querySelector('.ann-card-question'), 'floating'); };
  appendAnnotationControls(card, ann);
  return card;
}

/** Make a floating card draggable */
export function makeDraggable(card, annId) {
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

/** Pin a card to a sidebar */
export function pinCard(annId, side) {
  var cards = getCards();
  if (!cards[annId]) return;
  if (cards[annId].el) { cards[annId].el.remove(); cards[annId].el = null; }
  cards[annId].pinned = side;
  syncSidebarHeights();
  rebuildSidebar(side);
  showToast('已固定到' + (side === 'left' ? '左' : '右') + '侧栏');
}

/** Unpin a card from sidebar */
export function unpinCard(annId) {
  var cards = getCards();
  if (!cards[annId]) return;
  var oldSide = cards[annId].pinned;
  cards[annId].pinned = false;
  rebuildSidebar(oldSide);
  var ann = findAnnotationById(annId);
  if (ann) createFloatingCard(ann, getColor(ann.colorIdx || 0));
}

/** Close a floating card */
export function closeCard(annId) {
  var cards = getCards();
  if (cards[annId] && cards[annId].el) { cards[annId].el.remove(); cards[annId].el = null; }
}

/** Move the whole card registry entry after persistence, including pinned/closed state. */
export function remapAnnotationCard(oldId, ann) {
  var previous = getCards()[oldId], position = previous?.el && { left: previous.el.style.left, top: previous.el.style.top };
  if (previous?.el) previous.el.remove();
  deleteCard(oldId);
  setCard(ann.id, { el: null, pinned: previous?.pinned || false });
  if (position) Object.assign(createFloatingCard(ann, getColor(ann.colorIdx || 0)).style, position);
  rebuildSidebar('left'); rebuildSidebar('right');
}

export function canEditAnnotation(ann) {
  if (getReplaySeq() !== null) { showToast('历史查看为只读，请返回当前对话后操作', true); return false; }
  if (isStreaming() || ann._loading || ann._saving || ann._replyQueued || ann._draft) { showToast('请等待当前回复或保存完成', true); return false; }
  if (ann._legacy) { showToast('旧版批注为只读', true); return false; }
  return true;
}

export function refreshAnnotationCards(ann) {
  // An asynchronous save may finish after switching conversations.
  if (findAnnotationById(ann.id) !== ann) return;
  var current = getCards()[ann.id];
  if (current?.el) {
    var position = { left: current.el.style.left, top: current.el.style.top };
    Object.assign(createFloatingCard(ann, getColor(ann.colorIdx || 0)).style, position);
  }
  rebuildSidebar('left'); rebuildSidebar('right');
}

/** Edit commits once (Enter also causes blur); failed saves retain the persisted question. */
export function editAnnQuestion(ann, el, type) {
  if (!canEditAnnotation(ann) || el.querySelector('input')) return;
  var input = document.createElement('input'); input.value = ann.question;
  var finished = false;
  async function finish(save) {
    if (finished) return;
    finished = true;
    var next = input.value.trim(); input.disabled = true;
    try {
      if (save && next && next !== ann.question && canEditAnnotation(ann)) {
        ann._saving = true;
        var row = await updateAnnotation(ann.id, { question: next });
        ann.question = row?.question ?? next;
      }
    } catch (err) { showToast('问题保存失败: ' + err.message, true); }
    finally {
      ann._saving = false;
      var msg = findParentMessage(ann.id);
      if (msg) refreshMessage(msg.id);
      refreshAnnotationCards(ann);
    }
  }
  input.addEventListener('blur', function () { finish(true); });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  el.replaceChildren(input); input.focus(); input.select();
}

/** Shared controls ensure pinned and floating cards expose the same thread lifecycle. */
export function appendAnnotationControls(host, ann) {
  var answer = host.querySelector('[data-ann-content]');
  if (answer && ann.answer) {
    // A partial regeneration is not a committed source for child anchor status.
    answer.replaceChildren(renderAnnotatedContent({ content: ann.answer, annotations: ann._loading ? [] : ann.annotations }));
    answer.onclick = function (event) {
      var mark = event.target.closest('.annotated-text, .ann-badge');
      if (mark) { event.stopPropagation(); clickAnnotation(mark.dataset.annId); }
    };
  }
  var controls = document.createElement('div'); controls.className = 'annotation-controls';
  var status = document.createElement('span'); status.className = 'annotation-status';
  status.textContent = annotationStatusText(ann) + (ann._legacy ? ' · 旧版只读' : ''); controls.appendChild(status);
  function button(label, className, callback, mutation) {
    var el = document.createElement('button'); el.textContent = label; el.className = className;
    el.disabled = !!(mutation && (getReplaySeq() !== null || ann._legacy || ann._loading || ann._saving || ann._draft || ann._replyQueued));
    el.onclick = function (event) { event.stopPropagation(); callback(); }; controls.appendChild(el); return el;
  }
  if (ann._draft && ann._saveState === 'failed') button('重试保存', 'btn-annotation-save', function () { retryDraftAnnotation(ann); }).disabled = getReplaySeq() !== null;
  button('追问', 'btn-annotation-child', function () { handleChildAnnotation(ann.id); }, true).disabled ||= !ann.answer;
  button(ann.answer ? '重新回答' : '生成回答', 'btn-annotation-reply', function () { replyToAnnotation(ann); }, true);
  button(ann.status === 'resolved' ? '重新打开' : '标记已解决', 'btn-annotation-status', async function () {
    if (!canEditAnnotation(ann)) return;
    var next = ann.status === 'resolved' ? 'active' : 'resolved'; ann._saving = true;
    try {
      var saved = await updateAnnotation(ann.id, { status: next });
      ann.status = saved?.status || next; ann._storedStatus = ann.status;
      var msg = findParentMessage(ann.id); if (msg) refreshMessage(msg.id);
    } catch (err) { showToast('状态保存失败: ' + err.message, true); }
    finally { ann._saving = false; refreshAnnotationCards(ann); }
  }, true);
  button('从此处重新对话', 'btn-annotation-fork', function () {
    if (isStreaming()) { showToast('请等待回复完成', true); return; }
    var msg = findParentMessage(ann.id);
    if (msg) document.dispatchEvent(new window.CustomEvent('threadthink:history', { detail: { action: 'fork', messageId: msg.id, seq: msg.seq, traceId: msg.traceId } }));
  });
  if (ann.traceId) button('查看 Trace', 'btn-annotation-trace', function () {
    document.dispatchEvent(new window.CustomEvent('threadthink:history', { detail: { messageId: ann.replyMessageId || findParentMessage(ann.id)?.id, seq: ann.seq, traceId: ann.traceId } }));
  });
  (ann.annotations || []).forEach(function (child) {
    button('子批注 · ' + annotationStatusText(child) + ' · ' + child.question, 'btn-annotation-open-child', function () { clickAnnotation(child.id); });
  });
  host.appendChild(controls);
  var tools = document.createElement('div'); tools.className = 'annotation-tools'; renderToolCalls(ann.tools, tools); host.appendChild(tools);
  if (ann._error) {
    var error = document.createElement('div'); error.className = 'annotation-error'; error.textContent = ann._error; host.appendChild(error);
  }
}

/** Handle click on annotation (highlight or badge) */
export function clickAnnotation(annId) {
  var cards = getCards();
  var ann = findAnnotationById(annId); if (!ann) return;
  var cd = cards[annId];
  if (cd && cd.pinned) {
    var mark = document.querySelector('.annotated-text[data-ann-id="' + annId + '"]');
    if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (cd && cd.el) {
    cd.el.style.zIndex = 110;
  } else {
    createFloatingCard(ann, getColor(ann.colorIdx || 0));
  }
}
