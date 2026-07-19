/* ============================================================
   ThreadThink — Events & Init
   ============================================================ */

import { getDom } from './dom.js';
import { getMessages, clearAllMessages, clearAllCards, resetNextId, persistSettings } from './state.js';
import { trackUserScroll, scrollToBottom } from './utils.js';
import { handleSend, handleAnnotateClick } from './handles.js';
import { handleSelection } from './selection.js';
import { openSettings, closeSettings, saveSettings, resetSettings, clearConversation, autoResize } from './settings.js';
import { clickAnnotation } from './cards.js';
import { renderConversation } from './renderer.js';
import { getApiKey } from './state.js';
import { showToast } from './utils.js';

export function init() {
  var dom = getDom();

  // ---- User input events ----
  dom.btnSend.addEventListener('click', handleSend);
  dom.userInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  dom.userInput.addEventListener('input', autoResize);

  // ---- Selection events ----
  document.addEventListener('mouseup', function () { setTimeout(handleSelection, 0); });
  document.addEventListener('mousedown', function (e) {
    if (!e.target.closest('.selection-toolbar') && !e.target.closest('.message-body'))
      dom.selectionToolbar.classList.remove('visible');
  });

  // ---- Annotation toolbar ----
  dom.btnAnnotate.addEventListener('click', handleAnnotateClick);

  // ---- Annotation click delegation (replaces addMarkClickHandler / addBadgeClickHandler) ----
  dom.conversation.addEventListener('click', function (e) {
    var annEl = e.target.closest('.annotated-text, .ann-badge');
    if (annEl && annEl.dataset.annId) {
      e.stopPropagation();
      clickAnnotation(annEl.dataset.annId);
    }
  });

  // ---- Sidebar pinned card click delegation ----
  dom.sidebarLeftInner.addEventListener('click', function (e) {
    var pinnedCard = e.target.closest('.pinned-card');
    if (pinnedCard && pinnedCard.dataset.pinnedAnn) {
      if (e.target.closest('.btn-unpin')) return; // handled by createPinnedCardEl
      if (e.target.closest('.pinned-title')) return; // handled by createPinnedCardEl
      e.stopPropagation();
      clickAnnotation(pinnedCard.dataset.pinnedAnn);
    }
  });
  dom.sidebarRightInner.addEventListener('click', function (e) {
    var pinnedCard = e.target.closest('.pinned-card');
    if (pinnedCard && pinnedCard.dataset.pinnedAnn) {
      if (e.target.closest('.btn-unpin')) return;
      if (e.target.closest('.pinned-title')) return;
      e.stopPropagation();
      clickAnnotation(pinnedCard.dataset.pinnedAnn);
    }
  });

  // ---- Settings events ----
  dom.btnSettings.addEventListener('click', openSettings);
  dom.btnCloseModal.addEventListener('click', closeSettings);
  dom.modalOverlay.addEventListener('click', function (e) { if (e.target === dom.modalOverlay) closeSettings(); });
  dom.btnSaveSettings.addEventListener('click', saveSettings);
  dom.btnResetSettings.addEventListener('click', resetSettings);

  // ---- Clear conversation ----
  dom.btnClear.addEventListener('click', clearConversation);

  // ---- Scroll tracking ----
  dom.workspace.addEventListener('scroll', function () { trackUserScroll(dom.workspace); });

  // ---- Global keyboard shortcuts ----
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { dom.selectionToolbar.classList.remove('visible'); closeSettings(); }
  });

  // ---- Initial render ----
  renderConversation();
  dom.userInput.focus();
  requestAnimationFrame(function () { dom.workspace.scrollTop = 0; });

  // ---- Prompt for API key if not set ----
  if (!getApiKey()) {
    setTimeout(function () { showToast('💡 点击右上角 ⚙️ 设置 API Key'); }, 500);
  }
}
