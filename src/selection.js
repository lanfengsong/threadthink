/* ThreadThink — Text selection toolbar */
import { getDom } from './dom.js';
import { getMessages, getReplaySeq, isStreaming } from './state.js';

export function handleSelection() {
  var dom = getDom(), selection = window.getSelection();
  dom.selectionToolbar.classList.remove('visible');
  if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return;
  var range = selection.getRangeAt(0);
  var start = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
  var body = start?.closest('.message-body'), message = body?.closest('.message.assistant');
  if (!message || !body.contains(range.endContainer)) return;
  var msg = getMessages().find(function (item) { return item.id === message.dataset.msgId; });
  var reason = getReplaySeq() !== null ? '历史查看为只读' : msg?._persisted === false && !msg?._loading ? '消息尚未保存，无法创建批注' : '';
  var button = dom.btnAnnotate || dom.selectionToolbar.querySelector('button');
  if (button) { button.disabled = !!reason; button.title = reason; }
  dom.selectionToolbar.title = reason;
  var hint = dom.selectionToolbar.querySelector('.annotation-selection-hint');
  if (!hint) { hint = document.createElement('span'); hint.className = 'annotation-selection-hint'; dom.selectionToolbar.appendChild(hint); }
  hint.textContent = reason || (isStreaming() ? '将创建未保存草稿，当前回答完成后自动保存' : '');
  var rect = range.getBoundingClientRect();
  dom.selectionToolbar.style.left = (rect.left + rect.width / 2) + 'px';
  dom.selectionToolbar.style.top = rect.top + 'px';
  dom.selectionToolbar.classList.add('visible');
}
