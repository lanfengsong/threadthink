/* ============================================================
   ThreadThink — Central State Store (v2: backend-aware)
   ============================================================ */

var _state = {
  // Auth
  user: null,
  token: null,

  // Conversations
  conversations: [],
  currentConversationId: null,

  // Messages in current conversation
  messages: [],

  // Cards (annotations remain frontend-only for now)
  cards: {},
};

// ---- Auth ----

export function getUser()             { return _state.user; }
export function getToken()            { return _state.token; }
export function setAuth(user, token)  { _state.user = user; _state.token = token; }
export function clearAuth()           { _state.user = null; _state.token = null; }

// ---- Conversations ----

export function getConversations()          { return _state.conversations; }
export function getCurrentConversationId()  { return _state.currentConversationId; }

export function setConversations(list)      { _state.conversations = list; }
export function setCurrentConversation(id)  { _state.currentConversationId = id; }
export function addConversation(conv)       { _state.conversations.unshift(conv); }
export function removeConversation(id)      {
  _state.conversations = _state.conversations.filter(function (c) { return c.id !== id; });
  if (_state.currentConversationId === id) _state.currentConversationId = null;
}

// ---- Messages ----

export function getMessages()       { return _state.messages; }
export function setMessages(msgs)   { _state.messages = msgs; }
export function addMessage(msg)     { _state.messages.push(msg); }
export function clearMessages()     { _state.messages = []; }

// ---- Cards (unchanged) ----

export function getCards()          { return _state.cards; }
export function setCard(id, data)   { _state.cards[id] = data; }
export function deleteCard(id)      { delete _state.cards[id]; }
export function clearAllCards()     { _state.cards = {}; }

// ---- Streaming guard ----

var _streaming = false;

export function isStreaming()       { return _streaming; }
export function setStreaming(v)     { _streaming = v; }
