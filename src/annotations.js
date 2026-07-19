/* ============================================================
   ThreadThink — Annotation Tree Helpers
   ============================================================ */

import { getMessages } from './state.js';

export function findAnnotationById(id) {
  var messages = getMessages();
  for (var i = 0; i < messages.length; i++) {
    var anns = messages[i].annotations; if (!anns) continue;
    for (var j = 0; j < anns.length; j++) { var f = findAnnRec(anns[j], id); if (f) return f; }
  }
  return null;
}

export function findAnnRec(a, id) {
  if (a.id === id) return a;
  if (a.annotations) for (var i = 0; i < a.annotations.length; i++) { var f = findAnnRec(a.annotations[i], id); if (f) return f; }
  return null;
}

export function findParentMessage(annId) {
  var messages = getMessages();
  for (var i = 0; i < messages.length; i++) {
    var anns = messages[i].annotations; if (!anns) continue;
    for (var j = 0; j < anns.length; j++) { if (hasAnn(anns[j], annId)) return messages[i]; }
  }
  return null;
}

export function hasAnn(a, id) {
  if (a.id === id) return true;
  if (a.annotations) for (var i = 0; i < a.annotations.length; i++) { if (hasAnn(a.annotations[i], id)) return true; }
  return false;
}

export function buildAnnotationContext(msgId) {
  var messages = getMessages();
  var ctx = [];
  for (var i = 0; i < messages.length; i++) { ctx.push({ role: messages[i].role, content: messages[i].content }); if (messages[i].id === msgId) break; }
  return ctx;
}
