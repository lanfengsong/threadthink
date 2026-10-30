/* ThreadThink — Chat, persisted annotation threads and conversation loading */
import { getDom } from './dom.js';
import {
  getMessages, addMessage, setStreaming, isStreaming, getCurrentConversationId,
  setCurrentConversation, addConversation, getConversations, setConversations,
  clearMessages, setMessages, clearAllCards, getReplaySeq, setReplaySeq,
} from './state.js';
import { getColor } from './palette.js';
import { genId, showToast, scrollToBottom, autoScrollIfAllowed } from './utils.js';
import { renderMarkdown } from './markdown.js';
import { renderMessage, refreshMessage, renderConversation, updateStreamingBody, renderToolCalls } from './renderer.js';
import { syncSidebarHeights, rebuildSidebar } from './sidebar.js';
import { createFloatingCard, refreshAnnotationCards, canEditAnnotation, remapAnnotationCard } from './cards.js';
import { createChatStream, createAnnotationStream, createConversation, createAnnotation, updateAnnotation, fetchMessages, fetchConversations, fetchAnnotations } from './api.js';
import { selectionToAnchor, hashText, annotationText, offsetInElement, findAnnotationById, findParentMessage } from './annotations.js';

function readonlyView() {
  if (getReplaySeq() === null) return false;
  showToast('历史查看为只读，请返回当前对话后操作', true); return true;
}

function lock(value) {
  setStreaming(value);
  var button = getDom().btnSend;
  if (button) button.disabled = value || getReplaySeq() !== null;
}

function recordTool(target, event, done) {
  var name = event.tool_name || event.name || '工具';
  target.tools ||= [];
  var tool = done && target.tools.findLast(function (item) { return !item.done && item.name === name; });
  if (!tool) { tool = { name: name }; target.tools.push(tool); }
  tool.done = done;
  if (done) tool.result = event.result;
}

export async function handleSend() {
  var dom = getDom(), text = dom.userInput.value.trim();
  if (!text || isStreaming() || readonlyView()) return;
  lock(true);
  var convId = getCurrentConversationId(), assistant = null;
  try {
    if (!convId) {
      var conv = await createConversation(text.slice(0, 40)); convId = conv.id;
      setCurrentConversation(convId); addConversation(conv); await refreshConversationList();
    }
    dom.userInput.value = ''; dom.userInput.style.height = 'auto';
    var user = { id: genId(), role: 'user', content: text, annotations: [], _persisted: false };
    assistant = { id: genId(), role: 'assistant', content: '', annotations: [], _loading: true, _persisted: false, tools: [] };
    addMessage(user); addMessage(assistant);
    dom.conversation.appendChild(renderMessage(user));
    var assistantEl = renderMessage(assistant); dom.conversation.appendChild(assistantEl);
    dom.welcome.style.display = 'none'; syncSidebarHeights(); scrollToBottom(dom.workspace);
    function currentElement() {
      return Array.from(dom.conversation.querySelectorAll('.message')).find(function (el) { return el.dataset.msgId === assistant.id; });
    }
    function showTools() { var tools = currentElement()?.querySelector('.message-tools'); if (tools) renderToolCalls(assistant.tools, tools); }
    await createChatStream(convId, text, {
      onToken: function (token) {
        assistant.content += token;
        var body = currentElement()?.querySelector('.message-body');
        if (body) updateStreamingBody(body, assistant.content, assistant.annotations);
        syncSidebarHeights(); autoScrollIfAllowed(dom.workspace);
      },
      onToolStart: function (event) { recordTool(assistant, event, false); showTools(); },
      onToolEnd: function (event) { recordTool(assistant, event, true); showTools(); },
      onDone: function (data) {
        data ||= {};
        var previousId = assistant.id, previousUserId = user.id;
        if (data.messageId) { assistant.id = data.messageId; assistant._persisted = true; }
        if (data.userMessageId) { user.id = data.userMessageId; user._persisted = true; }
        assistant.seq = data.seq ?? data.messageSeq; assistant.traceId = data.traceId;
        user.seq = data.userMessageSeq ?? data.userSeq; user.traceId = data.traceId;
        assistant._loading = false;
        refreshMessage(user.id, previousUserId); refreshMessage(assistant.id, previousId);
        autoScrollIfAllowed(dom.workspace);
      },
      onError: function (error) {
        assistant._loading = false; assistant.content += '\n\n错误：' + error.message;
        refreshMessage(assistant.id); showToast(error.message, true);
      },
    });
  } catch (error) {
    if (assistant) { assistant._loading = false; assistant.content += '\n\n错误：' + error.message; refreshMessage(assistant.id); }
    showToast(error.message, true);
  } finally { await drainAnnotationQueue(); lock(false); dom.userInput.focus(); }
}

export async function handleAnnotateClick() {
  var dom = getDom(); dom.selectionToolbar.classList.remove('visible');
  if (readonlyView()) return;
  var selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  var range = selection.getRangeAt(0);
  var startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
  var body = startEl.closest('.message-body');
  if (!body || !body.contains(range.endContainer)) return;
  var msg = getMessages().find(function (item) { return item.id === body.closest('.message').dataset.msgId; });
  if (!msg || msg.role !== 'assistant') return;
  if (msg._persisted === false && !msg._loading) { showToast('消息尚未保存，暂不能创建批注；请重新生成回答', true); return; }
  var start = offsetInElement(body, range.startContainer, range.startOffset);
  var end = offsetInElement(body, range.endContainer, range.endOffset);
  var rendered = annotationText(body), selected = rendered.slice(start, end);
  if (!selected.trim()) return;
  var anchor = selectionToAnchor(range);
  var question = prompt('对选中内容的追问：\n\n"' + selected.slice(0, 80) + '"\n\n请输入你的问题：');
  selection.removeAllRanges();
  if (!question?.trim()) return;
  return createThread(msg, null, {
    selectedText: selected, question: question.trim(),
    blockId: anchor?.blockId || null, startOffset: anchor?.start ?? null,
    endOffset: anchor?.end ?? null, textHash: anchor?.textHash || hashText(selected),
    rawContext: rendered.slice(Math.max(0, start - 32), end + 32),
  });
}

export async function handleChildAnnotation(parentId) {
  var parent = findAnnotationById(parentId);
  if (!parent || readonlyView() || parent._draft || parent._legacy || parent._loading || parent._saving || parent._replyQueued || !parent.answer) return;
  if (!isStreaming() && !canEditAnnotation(parent)) return;
  var msg = findParentMessage(parentId);
  if (!msg || msg._persisted === false) return;
  var question = prompt('对这条批注回答继续追问：');
  if (!question?.trim()) return;
  var renderedAnswer = document.createElement('div'); renderedAnswer.innerHTML = renderMarkdown(parent.answer);
  var selected = window.getSelection(), selectedText = annotationText(renderedAnswer);
  if (selected && !selected.isCollapsed && selected.rangeCount) {
    var node = selected.anchorNode?.parentElement;
    var answer = node?.closest('[data-ann-content]');
    if (answer?.dataset.annContent === parent.id && answer.contains(selected.getRangeAt(0).endContainer)) selectedText = selected.toString();
  }
  return createThread(msg, parent, { selectedText: selectedText, question: question.trim(), rawContext: annotationText(renderedAnswer), textHash: hashText(selectedText) });
}

var queueOrder = 0;

async function createThread(msg, parent, fields) {
  if (readonlyView()) return;
  if (!getCurrentConversationId()) { showToast('请先开始对话', true); return; }
  if (isStreaming()) {
    var draft = fromStoredAnnotation({ id: 'draft-' + genId(), parentId: parent?.id || null, ...fields });
    Object.assign(draft, { _draft: true, _saveState: 'pending', _pendingPayload: fields, _queueOrder: ++queueOrder });
    (parent ? (parent.annotations ||= []) : (msg.annotations ||= [])).push(draft);
    refreshMessage(msg.id); if (parent) refreshAnnotationCards(parent);
    createFloatingCard(draft, getColor(draft.colorIdx || 0));
    return;
  }
  lock(true);
  try {
    var saved = await createAnnotation({ messageId: msg.id, parentId: parent?.id || null, ...fields });
    if (!saved?.id) throw new Error('服务器未返回批注 ID');
    var ann = fromStoredAnnotation({
      message_id: msg.id, parent_id: parent?.id || null, selected_text: fields.selectedText,
      question: fields.question, block_id: fields.blockId, start_offset: fields.startOffset,
      end_offset: fields.endOffset, text_hash: fields.textHash, raw_context: fields.rawContext, ...saved,
    });
    ann._loading = true;
    (parent ? (parent.annotations ||= []) : (msg.annotations ||= [])).push(ann);
    refreshMessage(msg.id); if (parent) refreshAnnotationCards(parent);
    createFloatingCard(ann, getColor(ann.colorIdx || 0));
    await streamAnnotation(ann);
  } catch (error) { showToast('批注保存或回答失败: ' + error.message, true); }
  finally { await drainAnnotationQueue(); lock(false); }
}

export async function replyToAnnotation(ann) {
  if (readonlyView() || ann._draft || ann._legacy || ann._loading || ann._saving || ann._replyQueued) return;
  if (isStreaming()) {
    ann._replyQueued = true; ann._queueOrder = ++queueOrder; refreshAnnotationCards(ann); return;
  }
  if (!canEditAnnotation(ann)) return;
  lock(true);
  try { await streamAnnotation(ann); }
  finally { await drainAnnotationQueue(); lock(false); }
}

function allAnnotations() {
  function flatten(list) { return list.flatMap(function (ann) { return [ann, ...flatten(ann.annotations || [])]; }); }
  return getMessages().flatMap(function (msg) { return flatten(msg.annotations || []); });
}

/** Called only after the active stream has terminated; the UI lock stays held. */
async function drainAnnotationQueue() {
  var next;
  while ((next = allAnnotations().filter(function (ann) { return ann._saveState === 'pending' || ann._replyQueued; }).sort(function (a, b) { return a._queueOrder - b._queueOrder; })[0])) {
    if (next._replyQueued) { next._replyQueued = false; await streamAnnotation(next); }
    else await saveDraft(next);
  }
}

async function saveDraft(ann) {
  var msg = findParentMessage(ann.id), oldId = ann.id;
  ann._saveState = 'saving'; ann._error = null; refreshAnnotationCards(ann);
  try {
    if (!msg || msg._persisted === false) throw new Error('原回答未成功保存，草稿尚未保存；引文已保留');
    var parent = ann.parentId && findAnnotationById(ann.parentId);
    if (parent?._draft) throw new Error('父批注尚未保存');
    // The source block may have grown while this draft waited for its server ID.
    var fields = { ...ann._pendingPayload, ...(ann._resolvedAnchor || {}) };
    var saved = await createAnnotation({ messageId: msg.id, parentId: parent?.id || null, ...fields });
    if (!saved?.id) throw new Error('服务器未返回批注 ID');
    var children = ann.annotations;
    Object.assign(ann, fromStoredAnnotation({ ...fields, messageId: msg.id, parentId: parent?.id || null, ...saved }));
    ann.annotations = children; ann._draft = false; ann._saveState = null; delete ann._pendingPayload;
    // No await between changing the ID and rebuilding every dependent projection.
    refreshMessage(msg.id); remapAnnotationCard(oldId, ann);
    if (parent) refreshAnnotationCards(parent);
    await streamAnnotation(ann);
  } catch (error) {
    ann._saveState = 'failed'; ann._error = '批注未保存: ' + error.message;
    refreshAnnotationCards(ann); if (msg) refreshMessage(msg.id); showToast(ann._error, true);
  }
}

export async function retryDraftAnnotation(ann) {
  if (readonlyView() || !ann._draft || ann._saveState !== 'failed') return;
  ann._saveState = 'pending'; ann._queueOrder = ++queueOrder; ann._error = null; refreshAnnotationCards(ann);
  if (isStreaming()) return;
  lock(true);
  try { await drainAnnotationQueue(); }
  finally { lock(false); }
}

async function streamAnnotation(ann) {
  var previousAnswer = ann.answer;
  ann._loading = true; ann._error = null; ann.answer = ''; ann.tools = [];
  refreshAnnotationCards(ann);
  function showAnswer() {
    document.querySelectorAll('[data-ann-content]').forEach(function (el) {
      if (el.dataset.annContent === ann.id) el.innerHTML = renderMarkdown(ann.answer);
    });
  }
  try {
    await createAnnotationStream(ann.id, {
      onToken: function (token) { ann.answer += token; showAnswer(); },
      onToolStart: function (event) { recordTool(ann, event, false); refreshAnnotationCards(ann); },
      onToolEnd: function (event) { recordTool(ann, event, true); refreshAnnotationCards(ann); },
      onDone: function (data) {
        ann.traceId = data?.traceId; ann.seq = data?.seq ?? data?.messageSeq; ann.replyMessageId = data?.messageId;
        ann._loading = false;
      },
      onError: function (error) { ann._error = '回答失败: ' + error.message; showToast(ann._error, true); },
    });
  } catch (error) { ann._error = '回答失败: ' + error.message; showToast(ann._error, true); }
  finally {
    ann._loading = false;
    if (ann._error) { ann.answer = previousAnswer; }
    refreshAnnotationCards(ann);
    var root = findParentMessage(ann.id);
    if (root) refreshMessage(root.id); // Also derives descendant states after committed regeneration.
    var parent = ann.parentId && findAnnotationById(ann.parentId); if (parent) refreshAnnotationCards(parent);
    await persistAnchorStates();
    syncSidebarHeights(); rebuildSidebar('left'); rebuildSidebar('right');
  }
}

export async function switchConversation(convId) {
  if (isStreaming()) { showToast('请等待回复或加载完成后切换对话', true); return; }
  lock(true);
  setCurrentConversation(convId); setReplaySeq(null); clearAllCards(); clearMessages(); renderConversation();
  try {
    var [messages, annData] = await Promise.all([
      fetchMessages(convId),
      fetchAnnotations(convId).catch(function (error) { showToast('批注加载失败: ' + error.message, true); return { annotations: [] }; }),
    ]);
    var byMessage = new Map();
    (annData.annotations || []).forEach(function (row) {
      if (!byMessage.has(row.message_id)) byMessage.set(row.message_id, []);
      byMessage.get(row.message_id).push(fromStoredAnnotation(row));
    });
    setMessages(messages.map(function (msg) {
      var table = assembleAnnoTree(byMessage.get(msg.id) || []);
      return { ...msg, annotations: mergeLegacyAnnotations(table, msg.annotations), _loading: false, _persisted: true, seq: msg.seq ?? msg.event_seq, traceId: msg.traceId ?? msg.trace_id };
    }));
    renderConversation();
    await persistAnchorStates();
    document.dispatchEvent(new window.CustomEvent('threadthink:conversation-changed'));
  } catch (error) { showToast('加载对话失败: ' + error.message, true); }
  finally { await drainAnnotationQueue(); lock(false); }
}

/** Anchor recovery is persisted only from the live loading lifecycle, never while rendering history. */
async function persistAnchorStates() {
  if (getReplaySeq() !== null) return;
  function flatten(annotations) {
    return annotations.flatMap(function (ann) { return [ann, ...flatten(ann.annotations || [])]; });
  }
  await Promise.all(getMessages().flatMap(function (msg) {
    return flatten(msg.annotations || []).filter(function (ann) { return !ann._legacy && !ann._draft && (ann.status !== ann._storedStatus || ann._anchorPatch); }).map(async function (ann) {
      var patch = { ...(ann._anchorPatch || {}) };
      if (ann.status !== ann._storedStatus) patch.status = ann.status;
      try {
        await updateAnnotation(ann.id, patch);
        Object.assign(ann, patch); ann._storedStatus = ann.status; ann._anchorPatch = null;
      } catch (error) { showToast('批注定位状态保存失败: ' + error.message, true); }
    });
  }));
}

export function fromStoredAnnotation(row) {
  return {
    id: row.id, messageId: row.message_id ?? row.messageId,
    selectedText: row.selected_text ?? row.selectedText ?? '', question: row.question || '', answer: row.answer || '',
    annotations: [], _loading: false, colorIdx: row.id ? parseInt(hashText(row.id).slice(0, 8), 16) % 6 : 0,
    rawContext: row.raw_context ?? row.rawContext ?? '', blockId: row.block_id ?? row.blockId ?? null,
    startOffset: row.start_offset ?? row.startOffset ?? null, endOffset: row.end_offset ?? row.endOffset ?? null,
    textHash: row.text_hash ?? row.textHash ?? null, parentId: row.parent_id ?? row.parentId ?? null,
    status: row.status === 'open' ? 'active' : row.status || 'active',
    _storedStatus: row.status === 'open' ? 'active' : row.status || 'active',
    traceId: row.trace_id ?? row.traceId, seq: row.seq ?? row.event_seq,
    replyMessageId: row.reply_message_id ?? row.replyMessageId, tools: row.tools || [],
  };
}

export function assembleAnnoTree(list) {
  var byId = new Map(list.map(function (ann) { return [ann.id, ann]; })), roots = [];
  byId.forEach(function (ann) { ann.annotations = []; });
  byId.forEach(function (ann) {
    var parent = byId.get(ann.parentId), ancestor = parent, seen = new Set([ann.id]);
    while (ancestor && !seen.has(ancestor.id)) { seen.add(ancestor.id); ancestor = byId.get(ancestor.parentId); }
    if (parent && !ancestor) parent.annotations.push(ann);
    else roots.push(ann);
  });
  return roots;
}

/** Legacy JSON is read-only. DB migration owns writes; prefer table rows and suppress duplicates. */
export function mergeLegacyAnnotations(table, stored) {
  var legacy;
  try { legacy = typeof stored === 'string' ? JSON.parse(stored) : stored; } catch (_) { legacy = []; }
  if (!Array.isArray(legacy)) return table;
  var ids = new Map(), signatures = new Map();
  function signature(ann, parentId) { return JSON.stringify([parentId || null, ann.selectedText || '', ann.question || '']); }
  function collect(anns, parentId) {
    anns.forEach(function (ann) { ids.set(ann.id, ann); signatures.set(signature(ann, parentId), ann); collect(ann.annotations || [], ann.id); });
  }
  collect(table);
  function convert(anns, parentId) {
    return anns.flatMap(function (ann) {
      if (!ann || typeof ann !== 'object' || !ann.id) return [];
      var duplicate = ids.get(ann.id) || signatures.get(signature(ann, parentId));
      if (duplicate) {
        // A migrated parent must not hide children that only exist in old JSON.
        duplicate.annotations.push(...convert(Array.isArray(ann.annotations) ? ann.annotations : [], duplicate.id));
        return [];
      }
      var restored = { ...fromStoredAnnotation(ann), _legacy: true, parentId: parentId || null };
      ids.set(ann.id, restored); signatures.set(signature(ann, parentId), restored);
      restored.annotations = convert(Array.isArray(ann.annotations) ? ann.annotations : [], ann.id);
      return [restored];
    });
  }
  return table.concat(convert(legacy));
}

export async function refreshConversationList() {
  try { setConversations(await fetchConversations()); renderConversationList(); }
  catch (_) { /* conversation list is secondary to current content */ }
}

function renderConversationList() {
  var list = document.getElementById('conversationList'); if (!list) return;
  list.replaceChildren();
  getConversations().forEach(function (conv) {
    var item = document.createElement('div'); item.className = 'conv-item' + (conv.id === getCurrentConversationId() ? ' active' : ''); item.dataset.convId = conv.id;
    var title = document.createElement('span'); title.className = 'conv-title'; title.textContent = conv.title || '新对话';
    var remove = document.createElement('button'); remove.className = 'conv-delete'; remove.dataset.convId = conv.id; remove.textContent = '×';
    item.append(title, remove); list.appendChild(item);
  });
}
