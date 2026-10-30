import { ThreadThink } from 'threadthink';
import { mockProvider } from 'threadthink/testkit';

const provider = mockProvider({ responses: [messages => {
  const source = messages.find(message => message.content.startsWith('【相关资料】'));
  return source ? '已收到检索资料，mock 示例完成（不代表真实模型回答质量）。' : '没有相关资料。';
}] });
const app = new ThreadThink({ provider, rag: { chunkSize: 100, overlap: 10, topK: 2 } });
try {
  await app.addDocument('ThreadThink 的批注是支线讨论。SDK 和 CLI 共享同一个 Agent 编排。', { filename: 'guide.txt' });
  console.log(await app.rag.search('ThreadThink 批注'));
  console.log((await app.chat('ThreadThink 如何隔离批注？')).content);
} finally { await app.dispose(); }
