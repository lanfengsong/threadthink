import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvalTask, runEvalTask, computeMetrics, consistencyScore } from '../src/services/eval.service.js';

function runnerFor(runs) {
  var queue = runs.slice();
  return async function () { return queue.length > 1 ? queue.shift() : queue[0]; };
}

test('createEvalTask 校验必填字段', function () {
  assert.throws(function () { createEvalTask({ goal: 'x' }); }, /id/);
  assert.throws(function () { createEvalTask({ id: 't' }); }, /goal/);
  var t = createEvalTask({ id: 't1', goal: 'g', expectedTools: ['a'], expectedKeywords: ['k'] });
  assert.equal(t.name, 't1');
  assert.deepEqual(t.expectedTools, ['a']);
});

test('完成判定：关键字命中 / 工具正确调用 / 无预期时输出非空', async function () {
  var byKeyword = createEvalTask({ id: 'k', goal: 'g', expectedKeywords: ['答案'] });
  assert.equal((await runEvalTask(byKeyword, runnerFor([{ rounds: 1, toolCalls: [], output: '这是答案' }]))).completed, true);
  assert.equal((await runEvalTask(byKeyword, runnerFor([{ rounds: 1, toolCalls: [], output: '不知道' }]))).completed, false);

  var byTool = createEvalTask({ id: 'tool', goal: 'g', expectedTools: ['calculator'] });
  assert.equal((await runEvalTask(byTool, runnerFor([{ rounds: 2, toolCalls: [{ name: 'calculator', correct: true }], output: '4' }]))).completed, true);
  assert.equal((await runEvalTask(byTool, runnerFor([{ rounds: 2, toolCalls: [{ name: 'fetch_url', correct: false }], output: '4' }]))).completed, false);

  var plain = createEvalTask({ id: 'p', goal: 'g' });
  assert.equal((await runEvalTask(plain, runnerFor([{ rounds: 1, toolCalls: [], output: '有内容' }]))).completed, true);
  assert.equal((await runEvalTask(plain, runnerFor([{ rounds: 1, toolCalls: [], output: '' }]))).completed, false);
});

test('computeMetrics：完成率 / 平均轮数 / 平均输出 / 工具正确率', function () {
  var metrics = computeMetrics([
    { taskId: 'a', completed: true, rounds: 2, toolCalls: [{ name: 'calculator', correct: true }, { name: 'doc_search', correct: true }], output: '12345' },
    { taskId: 'b', completed: true, rounds: 4, toolCalls: [{ name: 'calculator', correct: false }], output: '12' },
    { taskId: 'c', completed: false, rounds: 5, toolCalls: [], output: '' },
  ]);
  assert.equal(metrics.tasks, 3);
  assert.equal(metrics.completionRate, 0.67); // 2/3
  assert.equal(metrics.avgRounds, 3.67);      // (2+4+5)/3
  assert.equal(metrics.avgOutputChars, 2);    // (5+2+0)/3 ≈ 2.33 → 2
  assert.equal(metrics.toolCorrectness, 0.67); // 2/3
});

test('consistencyScore：输出稳定度（1/不同输出数）', async function () {
  var stable = createEvalTask({ id: 's', goal: 'g' });
  var stableScore = await consistencyScore(stable, runnerFor([{ rounds: 1, output: 'A' }, { rounds: 1, output: 'A' }, { rounds: 1, output: 'A' }]), 3);
  assert.equal(stableScore, 1);

  var flaky = createEvalTask({ id: 'f', goal: 'g' });
  var flakyScore = await consistencyScore(flaky, runnerFor([{ rounds: 1, output: 'A' }, { rounds: 1, output: 'B' }, { rounds: 1, output: 'C' }]), 3);
  assert.equal(flakyScore, 1 / 3);
});