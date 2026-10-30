/* Addressable history and recorded Agent traces. */
import './history.css';
import { getToken } from './auth.js';
import { getCurrentConversationId, getReplaySeq, setReplaySeq, setMessages, clearAllCards, isStreaming } from './state.js';
import { fromStoredAnnotation, assembleAnnoTree, switchConversation, refreshConversationList } from './handles.js';
import { renderConversation } from './renderer.js';
import { showToast } from './utils.js';

var dialog, selectedSeq = null, selectedConversation = null, loadVersion = 0;
var labels = { user_message: '用户消息', ai_message: 'AI 回答', annotation_created: '创建批注', annotation_updated: '更新批注',
  request: '请求', plan: '规划', tool_call: '工具调用', tool_result: '工具结果', observe: '观察', reflect: '反思',
  retry: '调整策略', done: '完成', error: '错误', fork: '分叉', rollback: '回退', context: '上下文',
  context_sections: '上下文分节', provider_response: '模型决策', provider_request: '模型请求', reflection: '反思' };

async function request(path, method, body) {
  var response = await fetch('/api/conversations/' + encodeURIComponent(selectedConversation) + path, {
    method: method || 'GET', headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  var data = await response.json();
  if (!response.ok) throw new Error(data.error || '读取历史失败');
  return data;
}

function button(label, callback) {
  var element = document.createElement('button');
  element.type = 'button'; element.textContent = label;
  element.addEventListener('click', function () { Promise.resolve().then(callback).catch(function (error) { showToast(error.message, true); }); });
  return element;
}

function ensureDialog() {
  if (dialog && dialog.isConnected) return dialog;
  dialog = document.createElement('dialog'); dialog.className = 'history-panel';
  dialog.setAttribute('aria-label', '对话历史与执行记录');
  var header = document.createElement('header');
  var title = document.createElement('h2'); title.textContent = '对话历史与执行记录'; header.appendChild(title);
  header.appendChild(button('关闭', function () { dialog.close(); })); dialog.appendChild(header);
  var explanation = document.createElement('p');
  explanation.textContent = '查看任一时刻的消息与批注，或展开执行记录检查工具输入和结果。回放使用已记录数据。'; dialog.appendChild(explanation);
  var actions = document.createElement('div'); actions.className = 'history-actions';
  actions.appendChild(button('查看所选时刻', viewSelected));
  actions.appendChild(button('从此处分叉', forkSelected));
  actions.appendChild(button('回退到此处', rollbackSelected));
  actions.appendChild(button('返回当前对话', returnToPresent));
  actions.appendChild(button('刷新记录', function () { return openHistory(); }));
  dialog.appendChild(actions);
  var state = document.createElement('p'); state.className = 'history-selection'; state.setAttribute('role', 'status'); dialog.appendChild(state);
  var list = document.createElement('ol'); list.className = 'history-timeline'; dialog.appendChild(list);
  document.body.appendChild(dialog);
  return dialog;
}

function status(text) { dialog.querySelector('.history-selection').textContent = text; }
function guard() {
  if (isStreaming()) throw new Error('请等待回答完成后操作历史');
  if (selectedConversation !== getCurrentConversationId()) throw new Error('对话已切换，请重新打开历史');
}

export async function openHistory(detail) {
  if (isStreaming()) return showToast('请等待回答完成后查看历史', true);
  var conversationId = getCurrentConversationId();
  if (!conversationId) return showToast('请先开始一段对话');
  selectedConversation = conversationId;
  var version = ++loadVersion;
  ensureDialog();
  if (!dialog.open) dialog.showModal();
  status('正在加载…');
  var data = await request('/events');
  if (version !== loadVersion || conversationId !== getCurrentConversationId()) return;
  var events = data.events || [];
  var selected = detail && detail.messageId ? events.find(function (event) {
    var message = event.payload.message || event.payload;
    return message.id === detail.messageId && (event.type === 'ai_message' || event.type === 'user_message');
  }) : null;
  selectedSeq = selected ? selected.seq : (detail && detail.seq != null ? detail.seq : data.headSeq);
  var list = dialog.querySelector('.history-timeline'); list.replaceChildren();
  events.forEach(function (event) {
    var item = document.createElement('li'); item.dataset.seq = event.seq;
    var choice = document.createElement('label'); choice.className = 'history-event-label';
    var radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'history-seq'; radio.value = event.seq; radio.checked = event.seq === selectedSeq;
    radio.addEventListener('change', function () { selectedSeq = event.seq; status('已选择记录 #' + event.seq); });
    choice.appendChild(radio);
    var label = document.createElement('span');
    label.textContent = '#' + event.seq + ' · ' + (labels[event.type] || event.type) + ' · ' + event.created_at; choice.appendChild(label); item.appendChild(choice);
    var details = document.createElement('details'), summary = document.createElement('summary');
    var payload = event.payload || {};
    summary.textContent = payload.tool || payload.tool_name || payload.message && payload.message.content && payload.message.content.slice(0, 70) || '查看记录内容';
    details.appendChild(summary);
    var pre = document.createElement('pre'); pre.textContent = JSON.stringify(payload, null, 2); details.appendChild(pre); item.appendChild(details);
    if (event.trace_id) item.appendChild(button('回放此执行记录', async function () {
      guard();
      var result = await request('/traces/' + encodeURIComponent(event.trace_id) + '/replay', 'POST', {});
      var output = document.createElement('pre'); output.textContent = JSON.stringify(result, null, 2); details.appendChild(output); details.open = true;
    }));
    list.appendChild(item);
  });
  status(events.length ? '已选择记录 #' + selectedSeq + '；共 ' + events.length + ' 条记录' : '此对话还没有记录');
  if (detail && detail.action === 'fork') await forkSelected();
}

export async function renderUpTo(seq) {
  guard();
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('请选择有效的历史记录');
  var conversationId = selectedConversation;
  var state = await request('/replay?upTo=' + seq);
  if (conversationId !== getCurrentConversationId()) return;
  var byMessage = {};
  (state.annotations || []).forEach(function (annotation) {
    (byMessage[annotation.message_id] = byMessage[annotation.message_id] || []).push(fromStoredAnnotation(annotation));
  });
  clearAllCards();
  setReplaySeq(seq);
  setMessages((state.messages || []).filter(function (message) { return (message.kind || 'chat') === 'chat'; }).map(function (message) {
    return Object.assign({}, message, { annotations: assembleAnnoTree(byMessage[message.id] || []), _loading: false });
  }));
  renderConversation();
  var banner = document.getElementById('historyBanner');
  if (!banner) {
    banner = document.createElement('div'); banner.id = 'historyBanner'; banner.className = 'history-banner';
    document.querySelector('.input-area').before(banner);
  }
  banner.replaceChildren(document.createTextNode('正在查看历史 #' + seq + '，可从此处分叉继续对话。 '), button('返回当前', returnToPresent));
  document.getElementById('userInput').disabled = true;
  document.getElementById('btnSend').disabled = true;
}

async function viewSelected() { await renderUpTo(selectedSeq); dialog.close(); }
async function forkSelected() {
  guard();
  if (selectedSeq == null) throw new Error('请选择历史记录');
  var result = await request('/fork', 'POST', { seq: selectedSeq });
  clearHistoryView(); dialog.close();
  await switchConversation(result.conversation.id); await refreshConversationList();
  showToast('已创建分叉，原对话保留');
}
async function rollbackSelected() {
  guard();
  if (selectedSeq == null) throw new Error('请选择历史记录');
  if (!confirm('回退到这条记录？后续内容会从当前对话中隐藏，仍可在历史记录中查看。')) return;
  await request('/rollback', 'POST', { seq: selectedSeq });
  await returnToPresent(); showToast('已回退，历史记录保留');
}
export function clearHistoryView() {
  setReplaySeq(null);
  var banner = document.getElementById('historyBanner'); if (banner) banner.remove();
  var input = document.getElementById('userInput'), send = document.getElementById('btnSend');
  if (input) input.disabled = false;
  if (send) send.disabled = isStreaming();
}
async function returnToPresent() {
  guard(); clearHistoryView(); if (dialog.open) dialog.close();
  await switchConversation(getCurrentConversationId());
}

export async function resetConversation() {
  if (isStreaming()) throw new Error('请等待当前回答完成');
  selectedConversation = getCurrentConversationId();
  if (selectedConversation) await request('/rollback', 'POST', { seq: 0 });
  clearHistoryView(); clearAllCards(); setMessages([]); renderConversation();
}

export function initHistory() {
  var trigger = document.getElementById('btnHistory');
  if (trigger) trigger.onclick = function () { openHistory().catch(function (error) { showToast(error.message, true); }); };
  document.addEventListener('threadthink:history', function (event) { openHistory(event.detail).catch(function (error) { showToast(error.message, true); }); });
  document.addEventListener('threadthink:conversation-changed', function () { if (getReplaySeq() == null) clearHistoryView(); });
}
