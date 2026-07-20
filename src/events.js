/* ============================================================
   ThreadThink — Events & Init (v2: auth + conversations)
   ============================================================ */

import { getDom } from './dom.js';
import { trackUserScroll, showToast } from './utils.js';
import { handleSend, handleAnnotateClick, refreshConversationList, switchConversation } from './handles.js';
import { handleSelection } from './selection.js';
import { openSettings, closeSettings, saveSettings, resetSettings, autoResize } from './settings.js';
import { clickAnnotation } from './cards.js';
import { renderConversation } from './renderer.js';
import { isLoggedIn, login, register, logout, getUser } from './auth.js';
import { setAuth, clearAuth, clearMessages, clearAllCards, setConversations, setCurrentConversation, addConversation, getCards } from './state.js';
import { deleteConversation, createConversation as apiCreateConversation } from './api.js';
import { fetchDocuments, uploadFile, deleteDocument, renderDocumentList } from './documents.js';

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

  overlay.querySelectorAll('.auth-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      tab = this.dataset.tab;
      overlay.querySelectorAll('.auth-tab').forEach(function (b) { b.classList.remove('active'); });
      this.classList.add('active');
      submitBtn.textContent = tab === 'login' ? '登录' : '注册';
    });
  });

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
          deleteConversation(cid).then(function () { refreshConversationList(); });
        }
        return;
      }
      if (item) {
        switchConversation(item.dataset.convId);
      }
    });
  }

  // ---- New conversation button ----
  var btnNewConv = document.getElementById('btnNewConv');
  if (btnNewConv) {
    btnNewConv.addEventListener('click', async function () {
      try {
        var conv = await apiCreateConversation();
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
      clearAuth();
      clearMessages();
      clearAllCards();
      setConversations([]);
      setCurrentConversation(null);
      window.location.reload();
    });
  }

  // ---- Initial render ----
  renderConversation();
  dom.userInput.focus();
  requestAnimationFrame(function () { dom.workspace.scrollTop = 0; });

  // ---- Document management ----
  loadDocuments();
  setupDocumentEvents();
}

// Need a wrapper for addConversation to avoid name collision with import
// Already imported statically above as addConversation

function setupDocumentEvents() {
  var btnUploadDoc = document.getElementById('btnUploadDoc');
  var fileInput = document.getElementById('fileInput');
  var docListEl = document.getElementById('documentList');

  if (btnUploadDoc && fileInput) {
    btnUploadDoc.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', async function () {
      var files = fileInput.files;
      if (!files || files.length === 0) return;
      for (var i = 0; i < files.length; i++) {
        try {
          showToast('正在上传: ' + files[i].name + '...');
          await uploadFile(files[i]);
          showToast('已上传: ' + files[i].name);
        } catch (e) {
          showToast('上传失败: ' + e.message, true);
        }
      }
      fileInput.value = '';
      loadDocuments();
    });
  }

  if (docListEl) {
    docListEl.addEventListener('dragover', function (e) { e.preventDefault(); docListEl.classList.add('doc-dragover'); });
    docListEl.addEventListener('dragleave', function () { docListEl.classList.remove('doc-dragover'); });
    docListEl.addEventListener('drop', async function (e) {
      e.preventDefault();
      docListEl.classList.remove('doc-dragover');
      var files = e.dataTransfer.files;
      for (var i = 0; i < files.length; i++) {
        try {
          showToast('正在上传: ' + files[i].name + '...');
          await uploadFile(files[i]);
          showToast('已上传: ' + files[i].name);
        } catch (err) {
          showToast('上传失败: ' + err.message, true);
        }
      }
      loadDocuments();
    });

    docListEl.addEventListener('click', async function (e) {
      var delBtn = e.target.closest('.doc-delete');
      if (delBtn) {
        e.stopPropagation();
        var docId = delBtn.dataset.docId;
        if (confirm('删除这个文档？相关的向量数据也会被删除。')) {
          try {
            await deleteDocument(docId);
            showToast('已删除');
            loadDocuments();
          } catch (err) {
            showToast('删除失败: ' + err.message, true);
          }
        }
      }
    });
  }
}

function clearConversation() {
  if (!confirm('清空所有对话和批注？')) return;
  var cards = getCards();
  for (var k in cards) { if (cards[k].el) cards[k].el.remove(); }
  clearMessages();
  clearAllCards();
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

async function loadDocuments() {
  try {
    var docs = await fetchDocuments();
    renderDocumentList(docs);
  } catch (e) {
    // silent — user may not be logged in yet
  }
}
