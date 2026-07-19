/* ============================================================
   ThreadThink — Events & Init (v2: auth + conversations)
   ============================================================ */

import { getDom } from './dom.js';
import { trackUserScroll } from './utils.js';
import { handleSend, handleAnnotateClick, refreshConversationList } from './handles.js';
import { handleSelection } from './selection.js';
import { openSettings, closeSettings, saveSettings, resetSettings, autoResize } from './settings.js';
import { clickAnnotation } from './cards.js';
import { renderConversation } from './renderer.js';
import { showToast } from './utils.js';
import { isLoggedIn, login, register, logout, getUser } from './auth.js';
import { setAuth } from './state.js';
import { refreshConversationList as refreshList } from './handles.js';

export function init() {
  var dom = getDom();

  // ---- Auth check ----
  if (isLoggedIn()) {
    var user = getUser();
    var token = localStorage.getItem('tt_token');
    setAuth(user, token);
    showApp(dom);
    refreshConversationList();
  } else {
    showLogin(dom);
  }

  // ---- Global events ----
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { dom.selectionToolbar.classList.remove('visible'); closeSettings(); }
  });
}

function showLogin(dom) {
  // Hide app, show login form
  document.querySelector('.app').style.display = 'none';
  var loginHtml =
    '<div class="auth-overlay" id="authOverlay">' +
      '<div class="auth-card">' +
        '<div class="auth-logo">ThreadThink</div>' +
        '<div class="auth-tabs">' +
          '<button class="auth-tab active" data-tab="login">登录</button>' +
          '<button class="auth-tab" data-tab="register">注册</button>' +
        '</div>' +
        '<form id="authForm" class="auth-form">' +
          '<input type="email" id="authEmail" placeholder="邮箱" required autocomplete="email">' +
          '<input type="password" id="authPassword" placeholder="密码（至少6位）" required minlength="6" autocomplete="current-password">' +
          '<button type="submit" class="btn-auth-submit" id="authSubmit">登录</button>' +
        '</form>' +
        '<p class="auth-error" id="authError"></p>' +
      '</div>' +
    '</div>';
  document.body.insertAdjacentHTML('beforeend', loginHtml);

  var tab = 'login';
  var overlay = document.getElementById('authOverlay');
  var form = document.getElementById('authForm');
  var errorEl = document.getElementById('authError');
  var submitBtn = document.getElementById('authSubmit');

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) { /* no-op, must login */ }
  });

  // Tab switching
  overlay.querySelectorAll('.auth-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      tab = this.dataset.tab;
      overlay.querySelectorAll('.auth-tab').forEach(function (b) { b.classList.remove('active'); });
      this.classList.add('active');
      submitBtn.textContent = tab === 'login' ? '登录' : '注册';
    });
  });

  // Form submit
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var email = document.getElementById('authEmail').value.trim();
    var password = document.getElementById('authPassword').value;
    errorEl.textContent = '';

    try {
      var user;
      if (tab === 'login') {
        user = await login(email, password);
      } else {
        user = await register(email, password);
      }
      var token = localStorage.getItem('tt_token');
      setAuth(user, token);
      overlay.remove();
      document.querySelector('.app').style.display = '';
      showApp(getDom());
      refreshConversationList();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

function showApp(dom) {
  // ---- User input events ----
  dom.btnSend.addEventListener('click', handleSend);
  dom.userInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  dom.userInput.addEventListener('input', autoResize);

  // ---- Selection events ----
  document.addEventListener('mouseup', function () { setTimeout(handleSelection, 0); });
  document.addEventListener('mousedown', function (e) {
    if (!e.target.closest('.selection-toolbar') && !e.target.closest('.message-body'))
      dom.selectionToolbar.classList.remove('visible');
  });

  dom.btnAnnotate.addEventListener('click', handleAnnotateClick);

  // ---- Annotation click delegation ----
  dom.conversation.addEventListener('click', function (e) {
    var annEl = e.target.closest('.annotated-text, .ann-badge');
    if (annEl && annEl.dataset.annId) { e.stopPropagation(); clickAnnotation(annEl.dataset.annId); }
  });

  // ---- Sidebar click delegation ----
  dom.sidebarLeftInner.addEventListener('click', function (e) {
    var pinnedCard = e.target.closest('.pinned-card');
    if (pinnedCard && pinnedCard.dataset.pinnedAnn) {
      if (e.target.closest('.btn-unpin') || e.target.closest('.pinned-title')) return;
      e.stopPropagation();
      clickAnnotation(pinnedCard.dataset.pinnedAnn);
    }
  });
  dom.sidebarRightInner.addEventListener('click', function (e) {
    var pinnedCard = e.target.closest('.pinned-card');
    if (pinnedCard && pinnedCard.dataset.pinnedAnn) {
      if (e.target.closest('.btn-unpin') || e.target.closest('.pinned-title')) return;
      e.stopPropagation();
      clickAnnotation(pinnedCard.dataset.pinnedAnn);
    }
  });

  // ---- Settings events ----
  dom.btnSettings.addEventListener('click', openSettings);
  dom.btnCloseModal.addEventListener('click', closeSettings);
  dom.modalOverlay.addEventListener('click', function (e) { if (e.target === dom.modalOverlay) closeSettings(); });
  dom.btnSaveSettings.addEventListener('click', saveSettings);
  dom.btnResetSettings.addEventListener('click', resetSettings);

  // ---- Clear conversation ----
  dom.btnClear.addEventListener('click', clearConversation);

  // ---- Scroll tracking ----
  dom.workspace.addEventListener('scroll', function () { trackUserScroll(dom.workspace); });

  // ---- Conversation list ----
  var convListEl = document.getElementById('conversationList');
  if (convListEl) {
    convListEl.addEventListener('click', function (e) {
      var item = e.target.closest('.conv-item');
      var delBtn = e.target.closest('.conv-delete');
      if (delBtn) {
        e.stopPropagation();
        var cid = delBtn.dataset.convId;
        if (confirm('删除这个对话？')) {
          import('./api.js').then(function (api) {
            api.deleteConversation(cid).then(function () {
              refreshConversationList();
            });
          });
        }
        return;
      }
      if (item) {
        var cid = item.dataset.convId;
        import('./handles.js').then(function (h) { h.switchConversation(cid); });
      }
    });
  }

  // ---- New conversation button ----
  var btnNewConv = document.getElementById('btnNewConv');
  if (btnNewConv) {
    btnNewConv.addEventListener('click', async function () {
      try {
        var { createConversation } = await import('./api.js');
        var conv = await createConversation();
        var { setCurrentConversation, addConversation, clearMessages } = await import('./state.js');
        setCurrentConversation(conv.id);
        addConversation(conv);
        clearMessages();
        renderConversation();
        refreshConversationList();
        var ui = getDom().userInput;
        if (ui) ui.focus();
      } catch (e) { showToast(e.message, true); }
    });
  }

  // ---- Logout button ----
  var btnLogout = document.getElementById('btnLogout');
  if (btnLogout) {
    btnLogout.addEventListener('click', function () {
      logout();
      var { clearAuth, clearMessages, clearAllCards, setConversations, setCurrentConversation } = import('./state.js').then(function (st) {
        st.clearAuth(); st.clearMessages(); st.clearAllCards(); st.setConversations([]); st.setCurrentConversation(null);
        window.location.reload();
      });
    });
  }

  // ---- Initial render ----
  renderConversation();
  dom.userInput.focus();
  requestAnimationFrame(function () { dom.workspace.scrollTop = 0; });
}

async function clearConversation() {
  if (!confirm('清空所有对话和批注？')) return;
  var st = await import('./state.js');
  var cards = st.getCards();
  for (var k in cards) { if (cards[k].el) cards[k].el.remove(); }
  st.clearMessages();
  st.clearAllCards();
  var dom = getDom();
  dom.sidebarLeftInner.innerHTML = '';
  dom.sidebarRightInner.innerHTML = '';
  var hintL = dom.sidebarLeft.querySelector('.sidebar-hint');
  var hintR = dom.sidebarRight.querySelector('.sidebar-hint');
  if (hintL) hintL.style.display = '';
  if (hintR) hintR.style.display = '';
  renderConversation();
  showToast('已清空');
}
