/* Shared SSE lifecycle for chat and annotation replies. */
import { streamChat } from './ai.service.js';

var active = new Set();
export function isConversationBusy(userId, conversationId) {
  return active.has(userId + ':' + conversationId);
}

export async function replyWithChatStream(reply, context) {
  var key = context.userId + ':' + context.conversationId;
  if (active.has(key)) return reply.code(409).send({ error: '该对话正在生成回答，请稍后重试' });
  active.add(key);
  var controller = new AbortController();
  var terminal = false;
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  function writeEvent(event, data) {
    if (terminal || reply.raw.destroyed) return;
    reply.raw.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    if (event === 'done' || event === 'error') {
      terminal = true;
      reply.raw.end();
    }
  }
  function onClose() {
    if (!terminal) controller.abort(new Error('客户端已断开连接'));
  }
  reply.raw.on('close', onClose);
  try {
    await streamChat(Object.assign({}, context, { signal: controller.signal }),
      function (token) { writeEvent('token', { content: token }); },
      function (start) { writeEvent('tool_start', start); },
      function (end) { writeEvent('tool_end', end); },
      function (result) { writeEvent('done', result); },
      function (error) { writeEvent('error', error); });
    if (!terminal && !reply.raw.destroyed) writeEvent('error', { message: '回答生成未正常结束' });
  } catch (error) {
    writeEvent('error', { message: error.message });
  } finally {
    active.delete(key);
    reply.raw.removeListener('close', onClose);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}
