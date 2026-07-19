/* ============================================================
   ThreadThink — Settings & Clear Conversation
   ============================================================ */

import { getDom } from './dom.js';
import { getApiKey, getApiBase, getModel, getSystemPrompt, setApiKey, setApiBase, setModel, setSystemPrompt, getMessages, getCards, clearAllMessages, clearAllCards, persistSettings } from './state.js';
import { showToast } from './utils.js';
import { renderConversation } from './renderer.js';
import { syncSidebarHeights } from './sidebar.js';

export function openSettings() {
  var dom = getDom();
  dom.apiKeyInput.value = getApiKey();
  dom.apiBaseInput.value = getApiBase();
  dom.modelInput.value = getModel();
  dom.systemPromptInput.value = getSystemPrompt();
  dom.modalOverlay.classList.add('visible');
}

export function closeSettings() {
  getDom().modalOverlay.classList.remove('visible');
}

export function saveSettings() {
  var dom = getDom();
  setApiKey(dom.apiKeyInput.value.trim());
  setApiBase(dom.apiBaseInput.value.trim());
  setModel(dom.modelInput.value.trim() || 'deepseek-chat');
  setSystemPrompt(dom.systemPromptInput.value.trim());
  persistSettings();
  closeSettings();
  showToast('已保存 ✓');
}

export function resetSettings() {
  var dom = getDom();
  dom.apiKeyInput.value = '';
  dom.apiBaseInput.value = 'https://api.deepseek.com/v1/chat/completions';
  dom.modelInput.value = 'deepseek-chat';
  dom.systemPromptInput.value = '你是一个有帮助的AI助手，请用中文回答用户的问题。';
}

export function clearConversation() {
  if (!confirm('清空所有对话和批注？')) return;
  var cards = getCards();
  for (var k in cards) { if (cards[k].el) cards[k].el.remove(); }
  clearAllMessages();
  clearAllCards();
  var dom = getDom();
  dom.sidebarLeftInner.innerHTML = '';
  dom.sidebarRightInner.innerHTML = '';
  var hintL = dom.sidebarLeft.querySelector('.sidebar-hint');
  var hintR = dom.sidebarRight.querySelector('.sidebar-hint');
  if (hintL) hintL.style.display = '';
  if (hintR) hintR.style.display = '';
  syncSidebarHeights();
  renderConversation();
  showToast('已清空');
}

export function autoResize() {
  var input = getDom().userInput;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}
