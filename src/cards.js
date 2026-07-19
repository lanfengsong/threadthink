/* ============================================================
   ThreadThink — Annotation Card System
   ============================================================ */

import { getDom } from './dom.js';
import { getMessages, getCards, setCard, deleteCard } from './state.js';
import { getColor } from './palette.js';
import { escapeHTML, showToast } from './utils.js';
import { renderMarkdown } from './markdown.js';
import { findAnnotationById } from './annotations.js';
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
      '<div class="ann-card-answer" data-ann-content="' + ann.id + '">' +
        (ann.answer ? renderMarkdown(ann.answer) : (ann._loading ? '<em>思考中...</em>' : '<em>等待回答...</em>')) +
      '</div>' +
    '</div>';

  var markEl = document.querySelector('.annotated-text[data-ann-id="' + ann.id + '"]');
  var rect = markEl ? markEl.getBoundingClientRect() : { left: 300, top: 200 };
  card.style.left = Math.min(rect.right + 16, window.innerWidth - 380) + 'px';
  card.style.top = Math.max(60, rect.top) + 'px';

  document.body.appendChild(card);
  setCard(ann.id, { el: card, pinned: false });
  makeDraggable(card, ann.id);

  card.querySelector('.btn-pin-left').onclick = function (e) { e.stopPropagation(); pinCard(ann.id, 'left'); };
  card.querySelector('.btn-pin-right').onclick = function (e) { e.stopPropagation(); pinCard(ann.id, 'right'); };
  card.querySelector('.btn-card-close').onclick = function (e) { e.stopPropagation(); closeCard(ann.id); };
  card.querySelector('.ann-card-question').onclick = function (e) { e.stopPropagation(); editAnnQuestion(ann, card.querySelector('.ann-card-question'), 'floating'); };
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

/** Turn question text into editable input */
export function editAnnQuestion(ann, el, type) {
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

/** Handle click on annotation (highlight or badge) */
export function clickAnnotation(annId) {
  var messages = getMessages();
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
