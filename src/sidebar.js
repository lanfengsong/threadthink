/* ============================================================
   ThreadThink — Sidebar Alignment System
   ============================================================ */

import { getDom } from './dom.js';
import { getCards } from './state.js';
import { getMessages } from './state.js';
import { getColor } from './palette.js';
import { escapeHTML } from './utils.js';
import { renderMarkdown } from './markdown.js';
import { findAnnotationById } from './annotations.js';
import { unpinCard, editAnnQuestion } from './cards.js';

/** Sync sidebar-inner heights to match conversation content height */
export function syncSidebarHeights() {
  var dom = getDom();
  var messages = getMessages();
  // When empty, reset sidebars to natural height
  if (messages.length === 0) {
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
  dom.sidebarLeftInner.style.height = (h - hintH) + 'px';
  dom.sidebarRightInner.style.height = (h - hintH) + 'px';
}

/** Find the vertical offset of an annotation's highlight relative to conversation content top */
export function getAnnotationMarkTop(annId) {
  var dom = getDom();
  var mark = document.querySelector('.annotated-text[data-ann-id="' + annId + '"]');
  if (!mark) return 0;
  return mark.getBoundingClientRect().top - dom.conversation.getBoundingClientRect().top;
}

/** Build a single pinned card DOM element */
export function createPinnedCardEl(annId) {
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

  // Bind unpin button — use setTimeout to ensure DOM is attached before querying
  setTimeout(function () {
    var unpinBtn = el.querySelector('.btn-unpin');
    if (unpinBtn) unpinBtn.onclick = function (e) { e.stopPropagation(); unpinCard(annId); };
    var titleEl = el.querySelector('.pinned-title');
    if (titleEl) titleEl.onclick = function (e) { e.stopPropagation(); editAnnQuestion(ann, titleEl, 'pinned'); };
  }, 0);
}

/** Rebuild a sidebar: spacers align pinned cards with annotations */
export function rebuildSidebar(side) {
  var dom = getDom();
  var inner = side === 'left' ? dom.sidebarLeftInner : dom.sidebarRightInner;
  var hint = (side === 'left' ? dom.sidebarLeft : dom.sidebarRight).querySelector('.sidebar-hint');
  var cards = getCards();

  // Collect pinned cards for this sidebar
  var pinned = [];
  for (var annId in cards) {
    if (cards[annId] && cards[annId].pinned === side) pinned.push(annId);
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
