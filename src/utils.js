/* ============================================================
   ThreadThink — Utilities
   ============================================================ */

var _nextId = 1;

export function genId() {
  return 'm' + (_nextId++);
}

export function resetIdCounter() { _nextId = 1; }

export function escapeHTML(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

var _userScrolledAway = false;

/** Track whether user has scrolled away from the bottom */
export function trackUserScroll(workspace) {
  var atBottom = workspace.scrollTop + workspace.clientHeight >= workspace.scrollHeight - 20;
  if (!atBottom) _userScrolledAway = true;
  else _userScrolledAway = false;
}

export function scrollToBottom(workspace) {
  if (!workspace) return;
  var conv = workspace.querySelector('.conversation');
  if (conv && conv.scrollHeight <= workspace.clientHeight) return;
  workspace.scrollTop = workspace.scrollHeight;
  _userScrolledAway = false;
}

/** Only scroll to bottom if user hasn't scrolled away manually */
export function autoScrollIfAllowed(workspace) {
  if (!_userScrolledAway) scrollToBottom(workspace);
}

export function showToast(m, e) {
  var container = document.getElementById('toastContainer');
  if (!container) return;
  var t = document.createElement('div');
  t.className = 'toast' + (e ? ' error' : '');
  t.textContent = m;
  container.appendChild(t);
  setTimeout(function () { t.remove(); }, 3000);
}
