/* ============================================================
   ThreadThink — Settings Module (v2: backend-managed)
   ============================================================ */

import { getDom } from './dom.js';
import { fetchSettings, updateSettings as apiUpdateSettings } from './api.js';
import { getToken } from './auth.js';
import { showToast } from './utils.js';

/** Load settings from server and populate modal */
export async function openSettings() {
  var dom = getDom();
  if (!getToken()) return;

  try {
    var settings = await fetchSettings();
    dom.apiKeyInput.value = '';  // Don't show API key
    dom.apiBaseInput.value = settings.apiBase || 'https://api.deepseek.com/v1/chat/completions';
    dom.modelInput.value = settings.model || 'deepseek-chat';
    dom.systemPromptInput.value = settings.systemPrompt || '';
    dom.modalOverlay.classList.add('visible');
  } catch (e) {
    showToast('获取设置失败: ' + e.message, true);
  }
}

export function closeSettings() {
  getDom().modalOverlay.classList.remove('visible');
}

/** Save settings to server */
export async function saveSettings() {
  var dom = getDom();
  var data = {
    apiBase: dom.apiBaseInput.value.trim(),
    model: dom.modelInput.value.trim() || 'deepseek-chat',
    systemPrompt: dom.systemPromptInput.value.trim(),
  };
  var apiKey = dom.apiKeyInput.value.trim();
  if (apiKey) data.apiKey = apiKey;

  try {
    await apiUpdateSettings(data);
    closeSettings();
    showToast('已保存 ✓');
  } catch (e) {
    showToast('保存失败: ' + e.message, true);
  }
}

export function resetSettings() {
  var dom = getDom();
  dom.apiKeyInput.value = '';
  dom.apiBaseInput.value = 'https://api.deepseek.com/v1/chat/completions';
  dom.modelInput.value = 'deepseek-chat';
  dom.systemPromptInput.value = '你是一个有帮助的AI助手，请用中文回答用户的问题。';
}

export function autoResize() {
  var input = getDom().userInput;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}
