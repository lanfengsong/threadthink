import { describe, it, expect, vi, afterEach } from 'vitest';
import { openHistory, renderUpTo, clearHistoryView } from '../../src/history.js';
import { setCurrentConversation, getMessages, getReplaySeq, setStreaming } from '../../src/state.js';
import { switchConversation } from '../../src/handles.js';

vi.mock('../../src/auth.js', function () { return { getToken: function () { return 'test-token'; } }; });
vi.mock('../../src/renderer.js', function () { return { renderConversation: vi.fn() }; });
vi.mock('../../src/handles.js', function () { return {
  fromStoredAnnotation: function (row) { return { id: row.id, selectedText: row.selected_text, status: row.status }; },
  assembleAnnoTree: function (rows) { return rows; },
  switchConversation: vi.fn(async function () {}), refreshConversationList: vi.fn(async function () {}),
}; });
vi.mock('../../src/utils.js', function () { return { showToast: vi.fn() }; });

function mount() {
  document.body.innerHTML = '<div class="input-area"><textarea id="userInput"></textarea><button id="btnSend"></button></div>';
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  setCurrentConversation('c1'); setStreaming(false); clearHistoryView();
}
function response(value) { return Promise.resolve(new Response(JSON.stringify(value))); }
var events = [{ seq: 3, type: 'ai_message', payload: { id: 'm1', content: '<img src=x onerror=alert(1)>' }, created_at: '2026-10-30', trace_id: 't1' }];
afterEach(function () { clearHistoryView(); vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.innerHTML = ''; });

describe('addressable history controls', function () {
  it('renders recorded content as text and selects message event', async function () {
    mount(); var fetch = vi.fn(function () { return response({ events: events, headSeq: 3 }); }); vi.stubGlobal('fetch', fetch);
    await openHistory({ messageId: 'm1' });
    expect(document.querySelector('input[name="history-seq"]').checked).toBe(true);
    expect(document.querySelector('pre').textContent).toContain('<img');
    expect(document.querySelector('img')).toBeNull();
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
  });

  it('replays messages and annotations together and prevents editing history', async function () {
    mount();
    vi.stubGlobal('fetch', vi.fn(function (url) {
      if (url.endsWith('/events')) return response({ events: events, headSeq: 3 });
      return response({ messages: [{ id: 'm1', role: 'assistant', content: 'old', kind: 'chat' }, { id: 'meta', role: 'assistant', content: 'branch', kind: 'annotation' }],
        annotations: [{ id: 'a1', message_id: 'm1', selected_text: 'old', status: 'outdated' }] });
    }));
    await openHistory(); await renderUpTo(3);
    expect(getReplaySeq()).toBe(3); expect(getMessages()).toHaveLength(1);
    expect(getMessages()[0].annotations[0].status).toBe('outdated');
    expect(document.getElementById('userInput').disabled).toBe(true);
    clearHistoryView();
    expect(getReplaySeq()).toBeNull(); expect(document.getElementById('userInput').disabled).toBe(false);
  });

  it('forks from the selected message and loads the new conversation', async function () {
    mount(); var fetch = vi.fn(function (url, options) {
      return response(options.method === 'POST' ? { conversation: { id: 'fork1' } } : { events: events, headSeq: 3 });
    }); vi.stubGlobal('fetch', fetch);
    await openHistory({ action: 'fork', messageId: 'm1' });
    expect(fetch.mock.calls[1][0]).toContain('/c1/fork');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ seq: 3 });
    expect(switchConversation).toHaveBeenCalledWith('fork1');
  });

  it('rejects stale or concurrent replay actions', async function () {
    mount(); vi.stubGlobal('fetch', vi.fn(function () { return response({ events: events, headSeq: 3 }); }));
    await openHistory(); setCurrentConversation('c2');
    await expect(renderUpTo(3)).rejects.toThrow('对话已切换');
    setCurrentConversation('c1'); setStreaming(true);
    await expect(renderUpTo(3)).rejects.toThrow('回答完成');
    setStreaming(false);
  });
});
