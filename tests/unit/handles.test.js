import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

var api = vi.hoisted(function () {
  return Object.fromEntries(['createChatStream', 'createAnnotationStream', 'createConversation', 'createAnnotation', 'updateAnnotation', 'fetchAnnotations', 'fetchConversations', 'fetchMessages'].map(function (name) { return [name, vi.fn()]; }));
});
vi.mock('../../src/api.js', function () { return api; });
import { handleAnnotateClick, handleSend, switchConversation, handleChildAnnotation, fromStoredAnnotation, assembleAnnoTree, mergeLegacyAnnotations } from '../../src/handles.js';
import { createFloatingCard, pinCard, editAnnQuestion } from '../../src/cards.js';
import { renderConversation } from '../../src/renderer.js';
import { getColor } from '../../src/palette.js';
import { resetDom } from '../../src/dom.js';
import { clearAllCards, clearMessages, getMessages, getCards, isStreaming, setConversations, setCurrentConversation, getCurrentConversationId, setMessages, setStreaming, setReplaySeq } from '../../src/state.js';

function mountDom() {
  clearAllCards();
  document.body.innerHTML =
    '<main id="workspace"><aside id="sidebarLeft"><div id="sidebarLeftInner"></div></aside>' +
    '<section id="conversation"><div id="welcome"></div></section>' +
    '<aside id="sidebarRight"><div id="sidebarRightInner"></div></aside></main>' +
    '<textarea id="userInput"></textarea><button id="btnSend"></button>' +
    '<div id="selectionToolbar"><button id="btnAnnotate"></button></div><div id="toastContainer"></div>';
  resetDom(); clearMessages(); setConversations([]); setCurrentConversation(null); setStreaming(false); setReplaySeq(null);
  Object.values(api).forEach(function (fn) { fn.mockReset(); });
  api.fetchConversations.mockResolvedValue([]);
  api.createAnnotation.mockImplementation(async function (data) { return { ...data, id: 'saved-ann', parent_id: data.parentId, status: 'active' }; });
  api.updateAnnotation.mockImplementation(async function (id, data) { return { id: id, ...data }; });
  api.fetchAnnotations.mockResolvedValue({ annotations: [] });
  api.createAnnotationStream.mockImplementation(async function (id, callbacks) {
    callbacks.onToken('one'); callbacks.onToken(' two'); callbacks.onDone({ messageId: 'reply', traceId: 'ann-trace', messageSeq: 20 });
  });
}
beforeEach(mountDom);
afterEach(function () { clearAllCards(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function selectAnswer() {
  var text = document.querySelector('.assistant .message-body p').firstChild;
  var range = document.createRange(); range.selectNodeContents(text);
  var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  vi.stubGlobal('prompt', vi.fn().mockReturnValue('why'));
}
async function sendAnswer(done = { messageId: 'server-ai', userMessageId: 'server-user', messageSeq: 12, userMessageSeq: 11, traceId: 'trace' }) {
  setCurrentConversation('c1');
  api.createChatStream.mockImplementation(async function (_, __, callbacks) { callbacks.onToken('answer'); callbacks.onDone(done); });
  document.getElementById('userInput').value = 'question'; await handleSend();
}
function openRoot(overrides = {}) {
  setCurrentConversation('c1');
  var ann = fromStoredAnnotation({ id: 'root', selected_text: 'answer', question: 'why', answer: 'parent answer', status: 'active', ...overrides });
  setMessages([{ id: 'm1', role: 'assistant', content: 'answer', annotations: [ann], _persisted: true, seq: 5, traceId: 'trace' }]);
  renderConversation(); createFloatingCard(ann, getColor(0)); return ann;
}
async function flush() { await new Promise(function (resolve) { setTimeout(resolve, 0); }); }
function controlledChat() {
  setCurrentConversation('c1');
  var control = {};
  api.createChatStream.mockImplementation(function (_, __, callbacks) {
    control.callbacks = callbacks;
    return new Promise(function (resolve) { control.finish = resolve; });
  });
  document.getElementById('userInput').value = 'question'; control.task = handleSend();
  return control;
}

describe('handleSend', function () {
  it('locks before auto-creation and releases after the awaited stream', async function () {
    var resolveCreate; api.createConversation.mockImplementation(function () { return new Promise(function (resolve) { resolveCreate = resolve; }); });
    api.createChatStream.mockResolvedValue(undefined);
    document.getElementById('userInput').value = 'first question';
    var first = handleSend(); await Promise.resolve(); var second = handleSend();
    expect(api.createConversation).toHaveBeenCalledTimes(1); expect(isStreaming()).toBe(true);
    expect(document.getElementById('btnSend').disabled).toBe(true);
    resolveCreate({ id: 'c1' }); await first; await second;
    expect(api.createChatStream).toHaveBeenCalledTimes(1); expect(isStreaming()).toBe(false);
    expect(document.getElementById('btnSend').disabled).toBe(false);
  });

  it('replaces optimistic IDs in state and DOM and preserves history metadata', async function () {
    await sendAnswer();
    expect(getMessages().map(function (msg) { return msg.id; })).toEqual(['server-user', 'server-ai']);
    expect(getMessages()[1]).toMatchObject({ seq: 12, traceId: 'trace', _persisted: true });
    expect(getMessages()[0]).toMatchObject({ seq: 11, traceId: 'trace' });
    expect(document.querySelector('.assistant').dataset.msgId).toBe('server-ai');
    expect(document.querySelector('.user').dataset.msgId).toBe('server-user');
    expect(document.querySelector('.typing-indicator')).toBeNull();
  });

  it('preserves tool cards across tokens and terminal redraw and escapes malicious names', async function () {
    setCurrentConversation('c1');
    var name = '<img src=x onerror="boom()">';
    api.createChatStream.mockImplementation(async function (_, __, callbacks) {
      callbacks.onToolStart({ tool_name: name }); callbacks.onToken('answer');
      expect(document.querySelector('.message-tools .tool-call')).not.toBeNull();
      callbacks.onToolEnd({ tool_name: name, result: '<script>bad()</script>' }); callbacks.onDone({ messageId: 'm1' });
    });
    document.getElementById('userInput').value = 'tools'; await handleSend();
    expect(document.querySelectorAll('.tool-call')).toHaveLength(1);
    expect(document.querySelector('.tool-call').textContent).toContain(name);
    expect(document.querySelector('.tool-call img, .tool-call script')).toBeNull();
  });

  it('network failure keeps the message unpersisted and unlocks controls', async function () {
    setCurrentConversation('c1'); api.createChatStream.mockRejectedValue(new Error('network down'));
    document.getElementById('userInput').value = 'question'; await handleSend();
    expect(document.querySelector('.assistant .message-body').textContent).toContain('network down');
    expect(getMessages()[1]._persisted).toBe(false); expect(isStreaming()).toBe(false);
  });
});

describe('persisted annotation creation', function () {
  it('waits for persistence then uses one canonical ID for marks, cards, state and isolated reply', async function () {
    await sendAnswer(); selectAnswer();
    var finishSave; api.createAnnotation.mockImplementation(function () { return new Promise(function (resolve) { finishSave = resolve; }); });
    var pending = handleAnnotateClick();
    expect(api.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'server-ai', parentId: null, selectedText: 'answer', question: 'why' }));
    expect(getMessages()[1].annotations).toEqual([]); expect(document.querySelector('.ann-card')).toBeNull();
    expect(document.querySelector('mark')).toBeNull(); expect(api.createAnnotationStream).not.toHaveBeenCalled();
    finishSave({ id: 'saved-id', status: 'active' }); await pending;
    expect(getMessages()[1].annotations[0].id).toBe('saved-id');
    expect(document.querySelector('mark').dataset.annId).toBe('saved-id');
    expect(Object.keys(getCards())).toEqual(['saved-id']);
    expect(document.querySelector('[data-ann-content="saved-id"]').textContent).toBe('one two');
    expect(api.createChatStream).toHaveBeenCalledTimes(1);
    expect(api.createAnnotationStream).toHaveBeenCalledWith('saved-id', expect.any(Object));
    expect(getMessages()).toHaveLength(2); expect(isStreaming()).toBe(false);
  });

  it('failed save creates no ghost annotation, highlight, card or reply', async function () {
    await sendAnswer(); selectAnswer(); api.createAnnotation.mockRejectedValue(new Error('save down'));
    await handleAnnotateClick();
    expect(getMessages()[1].annotations).toEqual([]); expect(document.querySelector('mark, .ann-card')).toBeNull();
    expect(api.createAnnotationStream).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('save down');
  });

  it('requires a saved source or active generation, and blocks creation in replay', async function () {
    await sendAnswer({}); selectAnswer(); await handleAnnotateClick();
    expect(api.createAnnotation).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('消息尚未保存');
    getMessages()[1]._persisted = true;
    setReplaySeq(0); await handleAnnotateClick(); expect(api.createAnnotation).not.toHaveBeenCalled();
  });

  it('stream failure keeps the saved thread with a retry entry and visible error', async function () {
    await sendAnswer(); selectAnswer(); api.createAnnotationStream.mockRejectedValue(new Error('annotation down'));
    await handleAnnotateClick();
    expect(getMessages()[1].annotations).toHaveLength(1);
    expect(document.querySelector('.annotation-error').textContent).toContain('annotation down');
    expect(document.querySelector('.btn-annotation-reply').disabled).toBe(false); expect(isStreaming()).toBe(false);
  });

  it('a child points to its parent annotation while retaining the root message ID', async function () {
    var parent = openRoot(); vi.stubGlobal('prompt', vi.fn().mockReturnValue('follow up'));
    await handleChildAnnotation(parent.id);
    expect(api.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1', parentId: 'root', selectedText: 'parent answer', question: 'follow up' }));
    expect(parent.annotations[0]).toMatchObject({ id: 'saved-ann', parentId: 'root', answer: 'one two' });
    expect(document.querySelector('#card-root .btn-annotation-open-child')).not.toBeNull();
    expect(api.createChatStream).not.toHaveBeenCalled();
  });

  it('regenerating a parent marks missing child quotes outdated and persists the descendant', async function () {
    var parent = openRoot();
    var child = fromStoredAnnotation({ id: 'child', parent_id: parent.id, selected_text: 'parent answer', question: 'child?', answer: 'child answer', status: 'active' });
    parent.annotations.push(child); renderConversation();
    createFloatingCard(parent, getColor(0));
    document.querySelector('#card-root .btn-annotation-reply').click(); await flush();
    expect(parent.answer).toBe('one two'); expect(child.status).toBe('outdated');
    expect(api.updateAnnotation).toHaveBeenCalledWith('child', { status: 'outdated' });
    expect(document.querySelector('#card-root .btn-annotation-open-child').textContent).toContain('内容已变更');
    document.querySelector('#card-root .btn-annotation-open-child').click();
    expect(document.querySelector('#card-child .ann-card-quote').textContent).toContain('parent answer');
  });

  it('child errors and tool output also appear in pinned cards', async function () {
    var ann = openRoot(); pinCard(ann.id, 'left');
    api.createAnnotationStream.mockImplementation(async function (_, callbacks) {
      callbacks.onToolStart({ tool_name: '<svg onload=bad()>' }); callbacks.onToken('partial');
      expect(document.querySelector('.pinned-card [data-ann-content]').textContent).toBe('partial');
      callbacks.onError({ message: 'provider failed' });
    });
    document.querySelector('.pinned-card .btn-annotation-reply').click(); await flush();
    expect(document.querySelector('.pinned-card .annotation-error').textContent).toContain('provider failed');
    expect(document.querySelector('.pinned-card [data-ann-content]').textContent).toBe('parent answer');
    expect(document.querySelector('.pinned-card svg')).toBeNull();
  });
});

describe('annotation drafts queued during streaming', function () {
  it('preserves streaming highlights and atomically remaps a pinned draft after server persistence', async function () {
    var chat = controlledChat(); chat.callbacks.onToken('quote'); selectAnswer(); await handleAnnotateClick();
    var ann = getMessages()[1].annotations[0], draftId = ann.id;
    expect(ann._draft).toBe(true); expect(api.createAnnotation).not.toHaveBeenCalled();
    expect(document.querySelector('.annotation-status').textContent).toContain('未保存');
    pinCard(draftId, 'left');
    chat.callbacks.onToken(' extended');
    expect(document.querySelector('.assistant .message-body mark').textContent).toBe('quote');
    expect(document.querySelector('.assistant .message-body').textContent).toContain('extended');
    chat.callbacks.onDone({ messageId: 'server-ai', userMessageId: 'server-user', messageSeq: 4 });
    chat.finish(); await chat.task;
    expect(api.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'server-ai', selectedText: 'quote', blockId: document.querySelector('.assistant .message-body p').dataset.blockId, startOffset: 0, endOffset: 5 }));
    expect(ann).toMatchObject({ id: 'saved-ann', _draft: false, answer: 'one two' });
    expect(Object.keys(getCards())).toEqual(['saved-ann']); expect(getCards()['saved-ann'].pinned).toBe('left');
    expect(document.querySelector('.pinned-card').dataset.pinnedAnn).toBe('saved-ann');
    expect(document.querySelector('mark').dataset.annId).toBe('saved-ann');
    expect(document.querySelector('[data-ann-id="' + draftId + '"]')).toBeNull();
    expect(api.createChatStream).toHaveBeenCalledTimes(1); expect(api.createAnnotationStream).toHaveBeenCalledWith('saved-ann', expect.any(Object));
    expect(isStreaming()).toBe(false);
  });

  it('drains multiple drafts sequentially after done while keeping the UI lock', async function () {
    var events = [], count = 0;
    api.createAnnotation.mockImplementation(async function () { var id = 'ann-' + (++count); events.push('save:' + id); expect(isStreaming()).toBe(true); return { id: id }; });
    api.createAnnotationStream.mockImplementation(async function (id, callbacks) { events.push('reply:' + id); expect(isStreaming()).toBe(true); callbacks.onToken(id); callbacks.onDone({}); });
    var chat = controlledChat(); chat.callbacks.onToken('quote'); selectAnswer(); await handleAnnotateClick();
    selectAnswer(); await handleAnnotateClick();
    expect(getMessages()[1].annotations).toHaveLength(2); expect(events).toEqual([]);
    chat.callbacks.onDone({ messageId: 'server-ai' }); chat.finish(); await chat.task;
    expect(events).toEqual(['save:ann-1', 'reply:ann-1', 'save:ann-2', 'reply:ann-2']);
    expect(getMessages()[1].annotations.map(function (ann) { return ann.id; })).toEqual(['ann-1', 'ann-2']);
    expect(isStreaming()).toBe(false);
  });

  it('retains an unsaved draft and its quote when the source generation fails', async function () {
    var chat = controlledChat(); chat.callbacks.onToken('quote'); selectAnswer(); await handleAnnotateClick();
    var ann = getMessages()[1].annotations[0];
    chat.callbacks.onError({ message: 'provider failed' }); chat.finish(); await chat.task;
    expect(ann).toMatchObject({ _draft: true, _saveState: 'failed', selectedText: 'quote' });
    expect(api.createAnnotation).not.toHaveBeenCalled(); expect(api.createAnnotationStream).not.toHaveBeenCalled();
    expect(document.querySelector('.ann-card-quote').textContent).toContain('quote');
    expect(document.querySelector('.annotation-error').textContent).toContain('原回答未成功保存');
    expect(document.querySelector('.annotation-status').textContent).toContain('未保存');
  });

  it('failed queued saves stay explicit and retry remaps the same draft exactly once', async function () {
    api.createAnnotation.mockRejectedValueOnce(new Error('database down')).mockResolvedValueOnce({ id: 'retry-saved', status: 'active' });
    var chat = controlledChat(); chat.callbacks.onToken('quote'); selectAnswer(); await handleAnnotateClick();
    var ann = getMessages()[1].annotations[0], draftId = ann.id;
    chat.callbacks.onDone({ messageId: 'server-ai' }); chat.finish(); await chat.task;
    expect(ann).toMatchObject({ id: draftId, _draft: true, _saveState: 'failed' });
    expect(document.querySelector('.annotation-error').textContent).toContain('database down');
    expect(api.createAnnotationStream).not.toHaveBeenCalled();
    document.querySelector('.btn-annotation-save').click(); await flush();
    expect(ann).toMatchObject({ id: 'retry-saved', _draft: false, answer: 'one two' });
    expect(getMessages()[1].annotations).toHaveLength(1); expect(getCards()[draftId]).toBeUndefined();
    expect(api.createAnnotationStream).toHaveBeenCalledTimes(1);
  });

  it('queues replies and new quotes on already-persisted messages during another stream', async function () {
    var root = openRoot(), chat = controlledChat(); chat.callbacks.onToken('new answer');
    document.querySelector('#card-root .btn-annotation-reply').click();
    selectAnswer(); await handleAnnotateClick();
    expect(root._replyQueued).toBe(true); expect(api.createAnnotationStream).not.toHaveBeenCalled();
    chat.callbacks.onDone({ messageId: 'new-ai' }); chat.finish(); await chat.task;
    expect(api.createAnnotationStream.mock.calls.map(function (call) { return call[0]; })).toEqual(['root', 'saved-ann']);
    expect(api.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm1', selectedText: 'answer' }));
    expect(root._replyQueued).toBe(false);
  });
});

describe('card persistence and controls', function () {
  it('persists question edits once even when Enter is followed by blur', async function () {
    var ann = openRoot(), question = document.querySelector('.ann-card-question');
    editAnnQuestion(ann, question, 'floating');
    var input = question.querySelector('input'); input.value = 'new question';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new window.Event('blur')); await flush();
    expect(api.updateAnnotation).toHaveBeenCalledTimes(1); expect(api.updateAnnotation).toHaveBeenCalledWith('root', { question: 'new question' });
    expect(ann.question).toBe('new question'); expect(document.querySelector('.ann-card-question').textContent).toContain('new question');
  });

  it('question save failures keep the persisted question and surface the error', async function () {
    var ann = openRoot(); api.updateAnnotation.mockRejectedValue(new Error('write failed'));
    var question = document.querySelector('.ann-card-question'); editAnnQuestion(ann, question, 'floating');
    var input = question.querySelector('input'); input.value = 'unsaved'; input.dispatchEvent(new window.Event('blur')); await flush();
    expect(ann.question).toBe('why'); expect(document.querySelector('.ann-card-question').textContent).toContain('why');
    expect(document.body.textContent).toContain('write failed');
  });

  it('resolved and reopened statuses persist from floating and pinned controls', async function () {
    var ann = openRoot(); document.querySelector('.btn-annotation-status').click(); await flush();
    expect(api.updateAnnotation).toHaveBeenLastCalledWith('root', { status: 'resolved' }); expect(ann.status).toBe('resolved');
    expect(document.querySelector('.annotation-status').textContent).toContain('已解决');
    pinCard(ann.id, 'left'); document.querySelector('.pinned-card .btn-annotation-status').click(); await flush();
    expect(api.updateAnnotation).toHaveBeenLastCalledWith('root', { status: 'active' }); expect(ann.status).toBe('active');
  });

  it('history mode blocks question edits, send and state mutations; fork emits root metadata', async function () {
    var ann = openRoot(); setReplaySeq(5);
    document.querySelector('.ann-card-question').click(); document.querySelector('.btn-annotation-status').click();
    document.getElementById('userInput').value = 'blocked'; await handleSend();
    expect(api.updateAnnotation).not.toHaveBeenCalled(); expect(api.createChatStream).not.toHaveBeenCalled();
    expect(document.querySelector('.ann-card-question input')).toBeNull();
    var detail; document.addEventListener('threadthink:history', function (event) { detail = event.detail; }, { once: true });
    document.querySelector('.btn-annotation-fork').click();
    expect(detail).toEqual({ action: 'fork', messageId: 'm1', seq: 5, traceId: 'trace' });
    expect(ann.question).toBe('why');
  });
});

describe('conversation restoration', function () {
  it('restores parent adjacency, states, metadata and read-only legacy deduplication', async function () {
    api.fetchMessages.mockResolvedValue([{ id: 'm1', role: 'assistant', content: '内容', trace_id: 'trace', seq: 10, annotations: JSON.stringify([{ id: 'root', question: 'duplicate' }, { id: 'legacy', selectedText: '内容', question: 'legacy' }]) }]);
    api.fetchAnnotations.mockResolvedValue({ annotations: [
      { id: 'root', message_id: 'm1', question: 'root', selected_text: '内容', status: 'resolved' },
      { id: 'child', message_id: 'm1', question: 'child', parent_id: 'root', selected_text: 'parent answer' },
    ] });
    await switchConversation('c1');
    var msg = getMessages()[0]; expect(msg).toMatchObject({ seq: 10, traceId: 'trace' }); expect(msg.annotations).toHaveLength(2);
    expect(msg.annotations[0]).toMatchObject({ id: 'root', status: 'resolved' }); expect(msg.annotations[0].annotations[0].id).toBe('child');
    expect(msg.annotations[1]._legacy).toBe(true);
    expect(api.updateAnnotation).toHaveBeenCalledWith('child', { status: 'outdated' });
  });

  it('persists missing or ambiguous anchors as outdated and keeps a visible entry', async function () {
    api.fetchMessages.mockResolvedValue([{ id: 'm', role: 'assistant', content: 'q q', annotations: 'bad json' }]);
    api.fetchAnnotations.mockResolvedValue({ annotations: [{ id: 'a', message_id: 'm', selected_text: 'q', question: 'why', status: 'active' }] });
    await switchConversation('c1');
    expect(api.updateAnnotation).toHaveBeenCalledWith('a', { status: 'outdated' });
    expect(document.querySelector('.btn-open-annotation').textContent).toContain('内容已变更');
    expect(document.querySelector('mark')).toBeNull();
  });

  it('clears floating and pinned cards when switching and rejects switches during a stream', async function () {
    openRoot(); setStreaming(true); await switchConversation('blocked');
    expect(getCurrentConversationId()).toBe('c1'); expect(api.fetchMessages).not.toHaveBeenCalled();
    setStreaming(false); api.fetchMessages.mockResolvedValue([]); await switchConversation('c2');
    expect(getCurrentConversationId()).toBe('c2'); expect(document.querySelector('.ann-card, .pinned-card')).toBeNull(); expect(getCards()).toEqual({});
  });

  it('annotation load failure does not prevent message loading', async function () {
    api.fetchMessages.mockResolvedValue([{ id: 'm1', role: 'assistant', content: '内容', annotations: '[]' }]);
    api.fetchAnnotations.mockRejectedValue(new Error('down')); await switchConversation('c1');
    expect(getMessages()).toHaveLength(1); expect(getMessages()[0].annotations).toEqual([]);
  });

  it('cyclic or duplicate legacy metadata does not create recursive annotation trees', function () {
    var tree = assembleAnnoTree([fromStoredAnnotation({ id: 'a', parent_id: 'b' }), fromStoredAnnotation({ id: 'b', parent_id: 'a' })]);
    expect(tree).toHaveLength(2); expect(tree.every(function (ann) { return !ann.annotations.length; })).toBe(true);
    var table = [fromStoredAnnotation({ id: 'new-id', selected_text: 'quote', question: 'q' })];
    expect(mergeLegacyAnnotations(table, JSON.stringify([{ id: 'old-id', selectedText: 'quote', question: 'q', annotations: [{ id: 'legacy-child', selectedText: 'answer', question: 'child' }] }]))).toHaveLength(1);
    expect(table[0].annotations[0]).toMatchObject({ id: 'legacy-child', _legacy: true, parentId: 'new-id' });
  });
});
