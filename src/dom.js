/* ============================================================
   ThreadThink — Lazy DOM References
   ============================================================ */

var _dom = null;

export function getDom() {
  if (_dom) return _dom;
  var $ = function (s) { return document.querySelector(s); };
  _dom = {
    workspace: $('#workspace'),
    conversation: $('#conversation'),
    welcome: $('#welcome'),
    sidebarLeft: $('#sidebarLeft'),
    sidebarRight: $('#sidebarRight'),
    sidebarLeftInner: $('#sidebarLeftInner'),
    sidebarRightInner: $('#sidebarRightInner'),
    sidebarLeftHint: $('#sidebarLeftHint'),
    sidebarRightHint: $('#sidebarRightHint'),
    userInput: $('#userInput'),
    btnSend: $('#btnSend'),
    selectionToolbar: $('#selectionToolbar'),
    btnAnnotate: $('#btnAnnotate'),
    modalOverlay: $('#modalOverlay'),
    btnSettings: $('#btnSettings'),
    btnCloseModal: $('#btnCloseModal'),
    btnSaveSettings: $('#btnSaveSettings'),
    btnResetSettings: $('#btnResetSettings'),
    btnClear: $('#btnClear'),
    apiKeyInput: $('#apiKeyInput'),
    apiBaseInput: $('#apiBaseInput'),
    modelInput: $('#modelInput'),
    systemPromptInput: $('#systemPromptInput'),
    toastContainer: $('#toastContainer'),
  };
  return _dom;
}

/** Reset DOM cache (after clear conversation) */
export function resetDom() { _dom = null; }
