/* ============================================================
   Tests: send and annotation DOM lifecycles
   ============================================================ */

import { afterEach, describe, expect, it, vi } from 'vitest';

var api = vi.hoisted(function () {
  return {
    createChatStream: vi.fn(),
    createConversation: vi.fn(),
    createAnnotation: vi.fn(),
    fetchAnnotations: vi.fn(),
    fetchConversations: vi.fn(),
    fetchMessages: vi.fn(),
  };
});

vi.mock('../../src/api.js', function () { return api; });

import { handleAnnotateClick, handleSend } from '../../src/handles.js';
import { resetDom } from '../../src/dom.js';
import {
  clearAllCards, clearMessages, isStreaming, setConversations, setCurrentConversation, setMessages, setStreaming,
} from '../../src/state.js';

function mountDom() {
  document.body.innerHTML =
    '<main id="workspace"><aside id="sidebarLeft"><div id="sidebarLeftInner"></div></aside>' +
    '<section id="conversation"><div id="welcome"></div></section>' +
    '<aside id="sidebarRight"><div id="sidebarRightInner"></div></aside></main>' +
    '<textarea id="userInput"></textarea><button id="btnSend"></button>' +
    '<div id="selectionToolbar"></div><div id="toastContainer"></div>';
  resetDom();
  clearAllCards();
  clearMessages();
  setConversations([]);
  setCurrentConversation(null);
  setStreaming(false);
  api.createChatStream.mockReset();
  api.createConversation.mockReset();
  api.createAnnotation.mockReset();
  api.fetchAnnotations.mockReset();
  api.fetchConversations.mockReset();
  api.fetchMessages.mockReset();
  api.fetchConversations.mockResolvedValue([]);
  api.createAnnotation.mockResolvedValue({});
  api.fetchAnnotations.mockResolvedValue({ annotations: [] });
}

afterEach(function () {
  mountDom();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('handleSend', function () {
  it('locks before auto-creating and releases after the awaited stream', async function () {
    mountDom();
    var resolveCreate;
    api.createConversation.mockImplementation(function () {
      return new Promise(function (resolve) { resolveCreate = resolve; });
    });
    api.createChatStream.mockResolvedValue(undefined);
    document.getElementById('userInput').value = 'first question';

    var first = handleSend();
    await Promise.resolve();
    var second = handleSend();

    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(document.getElementById('btnSend').disabled).toBe(true);
    expect(isStreaming()).toBe(true);

    resolveCreate({ id: 'c1', title: 'first question' });
    await first;
    await second;
    expect(api.createChatStream).toHaveBeenCalledTimes(1);
    expect(document.getElementById('btnSend').disabled).toBe(false);
    expect(isStreaming()).toBe(false);
  });

  it('renders terminal output and restores controls', async function () {
    mountDom();
    setCurrentConversation('c1');
    api.createChatStream.mockImplementation(async function (_, __, callbacks) {
      callbacks.onToken('hello');
      callbacks.onDone({ messageId: 'm1' });
    });
    document.getElementById('userInput').value = 'question';

    await handleSend();

    expect(document.querySelector('.assistant .message-body').textContent).toContain('hello');
    expect(document.querySelector('.typing-indicator')).toBeNull();
    expect(document.getElementById('btnSend').disabled).toBe(false);
    expect(isStreaming()).toBe(false);
  });

  it('shows a network failure in the assistant message and restores controls', async function () {
    mountDom();
    setCurrentConversation('c1');
    api.createChatStream.mockRejectedValue(new Error('network down'));
    document.getElementById('userInput').value = 'question';

    await handleSend();

    expect(document.querySelector('.assistant .message-body').textContent).toContain('network down');
    expect(document.getElementById('btnSend').disabled).toBe(false);
    expect(isStreaming()).toBe(false);
  });
});

describe('handleAnnotateClick', function () {
  it('accumulates streamed annotation text in floating and pinned displays', async function () {
    mountDom();
    setCurrentConversation('c1');
    api.createChatStream.mockImplementationOnce(async function (_, __, callbacks) {
      callbacks.onToken('answer');
      callbacks.onDone({});
    }).mockImplementationOnce(async function (_, __, callbacks) {
      callbacks.onToken('one');
      callbacks.onToken(' two');
      callbacks.onDone({});
    });
    document.getElementById('userInput').value = 'question';
    await handleSend();

    var text = document.querySelector('.assistant .message-body p').firstChild;
    var range = document.createRange();
    range.selectNodeContents(text);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('why'));

    handleAnnotateClick();
    await new Promise(function (resolve) { setTimeout(resolve, 0); });

    expect(document.querySelector('.ann-card-answer, [data-ann-content]')).not.toBeNull();
    expect(document.querySelector('[data-ann-content]').textContent).toContain('one two');
  });

  it('catches annotation stream rejection and displays the error', async function () {
    mountDom();
    setCurrentConversation('c1');
    api.createChatStream.mockImplementationOnce(async function (_, __, callbacks) {
      callbacks.onToken('answer');
      callbacks.onDone({});
    }).mockImplementationOnce(async function (_, __, callbacks) {
      callbacks.onToken('partial');
      callbacks.onError({ message: 'provider failed' });
      throw new Error('annotation down');
    });
    document.getElementById('userInput').value = 'question';
    await handleSend();

    var text = document.querySelector('.assistant .message-body p').firstChild;
    var range = document.createRange();
    range.selectNodeContents(text);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('why'));

    handleAnnotateClick();
    await new Promise(function (resolve) { setTimeout(resolve, 0); });

    expect(document.querySelector('[data-ann-content]').textContent).toContain('annotation down');
  });
});

