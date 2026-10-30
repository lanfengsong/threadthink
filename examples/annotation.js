import { ThreadThink } from 'threadthink';
import { mockProvider } from 'threadthink/testkit';

const app = new ThreadThink({ provider: mockProvider({ responses: ['RAG 会先检索文档，再生成回答。', '检索是从文档片段中找出相关内容。', '这是主线的下一次回答。'] }) });
try {
  const main = await app.chat('解释 RAG');
  const annotation = await app.annotate({
    selectedText: '检索文档', source: main.content, question: '这里的检索是什么意思？',
  });
  console.log('批注回答：', annotation.content);
  await app.chat('继续主线');
  console.log('主线消息：', app.session.messages().map(message => message.content));
  console.log('批注消息：', app.session.messages({ kind: 'annotation' }).map(message => message.content));
} finally { await app.dispose(); }
