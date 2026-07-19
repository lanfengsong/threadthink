/* ============================================================
   ThreadThink — Utils (v2)
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

/** Format a date string for display */
export function formatDate(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr + 'Z');
  var now = new Date();
  var diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return d.toLocaleDateString('zh-CN');
}

/** Extract a title from first user message */
export function extractTitle(content) {
  return content.slice(0, 40) + (content.length > 40 ? '...' : '');
}
