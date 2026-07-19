/* ============================================================
   ThreadThink — Text Selection Toolbar
   ============================================================ */

import { getDom } from './dom.js';

export function handleSelection() {
  var dom = getDom();
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
