/* ============================================================
   ThreadThink — Central State Store
   ============================================================ */

var _state = {
  apiKey:     localStorage.getItem('tt_api_key') || '',
  apiBase:    localStorage.getItem('tt_api_base') || '',
  model:      localStorage.getItem('tt_model') || 'deepseek-chat',
  systemPrompt: localStorage.getItem('tt_system') || '你是一个有帮助的AI助手，请用中文回答用户的问题。',
  messages:   [],
  cards:      {},     // { annId: { el, pinned:'left'|'right'|false } }
  nextId:     1,
  isStreaming: false,
};

// ---- Read access ----

export function getMessages()        { return _state.messages; }
export function getCards()          { return _state.cards; }
export function getApiKey()         { return _state.apiKey; }
export function getApiBase()        { return _state.apiBase; }
export function getModel()          { return _state.model; }
export function getSystemPrompt()   { return _state.systemPrompt; }
export function isStreaming()       { return _state.isStreaming; }

// ---- Mutations ----

export function addMessage(msg)     { _state.messages.push(msg); }
export function setStreaming(v)     { _state.isStreaming = v; }

export function setApiKey(k)        { _state.apiKey = k; }
export function setApiBase(b)       { _state.apiBase = b; }
export function setModel(m)         { _state.model = m; }
export function setSystemPrompt(p)  { _state.systemPrompt = p; }

export function setCard(annId, data)    { _state.cards[annId] = data; }
export function deleteCard(annId)       { delete _state.cards[annId]; }
export function clearAllCards()         { _state.cards = {}; }
export function clearAllMessages()      { _state.messages = []; }

export function getNextId()         { return _state.nextId++; }
export function resetNextId()       { _state.nextId = 1; }

export function persistSettings() {
  localStorage.setItem('tt_api_key', _state.apiKey);
  localStorage.setItem('tt_api_base', _state.apiBase);
  localStorage.setItem('tt_model', _state.model);
  localStorage.setItem('tt_system', _state.systemPrompt);
}
