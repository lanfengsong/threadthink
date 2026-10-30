import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvalTask, runEvalTask, computeMetrics, consistencyScore, normalizeUsage,
  runEvalSuite, formatEvalReport } from '../src/services/eval.service.js';

function runnerFor(runs) {
  const queue = runs.slice();
  return async () => queue.length > 1 ? queue.shift() : queue[0];
}
const task = (options = {}) => createEvalTask({ id: 'task', goal: 'g', ...options });
const calc = expression => ({ name: 'calculator', arguments: { expression } });
const evaluate = (options, result) => runEvalTask(task(options), async () => result);

test('createEvalTask validates task definitions and keeps custom context', () => {
  assert.throws(() => createEvalTask({ goal: 'x' }), /id/);
  assert.throws(() => createEvalTask({ id: 't' }), /goal/);
  assert.throws(() => task({ expectedTools: [{}] }), /工具名/);
  assert.throws(() => task({ expectedTools: 'calculator' }), /数组/);
  assert.throws(() => task({ expectedKeywords: [''] }), /非空/);
  assert.throws(() => task({ checkCompletion: true }), /函数/);
  assert.throws(() => task({ category: 'prompt-injection' }), /checkSafety/);
  assert.equal(task().name, 'task');
  assert.deepEqual(task({ context: { selectedText: '引用' } }).context, { selectedText: '引用' });
});

test('completion preserves keyword-any and nonempty defaults', async () => {
  assert.equal((await evaluate({ expectedKeywords: ['答案', 'answer'] }, { output: '这是答案' })).completed, true);
  assert.equal((await evaluate({ expectedKeywords: ['答案'] }, { output: '不知道' })).completed, false);
  assert.equal((await evaluate({}, { output: '有内容' })).completed, true);
  assert.equal((await evaluate({}, { output: ' \n' })).completed, false);
});

test('tool names, never runner correct, determine tool correctness', async () => {
  const wrong = await evaluate({ expectedTools: ['calculator'] }, { output: '4', toolCalls: [{ name: 'fetch_url', correct: true }] });
  assert.equal(wrong.completed, false);
  assert.equal(wrong.toolCalls[0].correct, false);
  assert.equal(computeMetrics([wrong]).toolCorrectness, 0);
  const right = await evaluate({ expectedTools: ['calculator'] }, { output: '4', toolCalls: [{ name: 'calculator', correct: false }] });
  assert.equal(right.completed, true);
  assert.equal(right.toolCalls[0].argumentsChecked, false);
  assert.equal(computeMetrics([{ toolCalls: [{ correct: true }] }]).toolCorrectness, 0);
});

test('exact arguments reject wrong values, missing/extra keys and invalid JSON', async () => {
  const definition = { expectedTools: [calc('2+2')] };
  for (const args of [{ expression: '2+3' }, {}, { expression: '2+2', extra: true }, undefined, '{bad']) {
    const result = await evaluate(definition, { output: '4', toolCalls: [{ name: 'calculator', arguments: args, correct: true }] });
    assert.equal(result.completed, false, JSON.stringify(args));
  }
  const result = await evaluate(definition, { output: '4', toolCalls: [{ tool_name: 'calculator', arguments: '{"expression":"2+2"}', status: 'done' }] });
  assert.equal(result.completed, true);
  assert.equal(result.toolCalls[0].argumentsChecked, true);
});

test('nested exact arguments compare structurally with key order ignored', async () => {
  const result = await evaluate({ expectedTools: [{ name: 'a', arguments: { nested: { x: 1, y: [2, 3] } } }] },
    { toolCalls: [{ function: { name: 'a', arguments: '{"nested":{"y":[2,3],"x":1}}' } }] });
  assert.equal(result.completed, true);
});

test('all tool requirements and output criteria apply together', async () => {
  const definition = { expectedTools: [calc('2+2'), calc('4*3')], expectedKeywords: ['12'] };
  assert.equal((await evaluate(definition, { output: '12', toolCalls: [calc('2+2')] })).completed, false);
  assert.equal((await evaluate(definition, { output: '12', toolCalls: [calc('2+2'), calc('4*3')] })).completed, true);
  assert.equal((await evaluate(definition, { output: '4', toolCalls: [calc('2+2'), calc('4*3')] })).completed, false);
  assert.equal((await evaluate({ expectedKeywords: ['4'] }, { output: '4', toolCalls: [calc('2+2')] })).completed, false);
});

test('repeated expectations require separate calls and allow overlapping validators', async () => {
  assert.equal((await evaluate({ expectedTools: [calc('2+2'), calc('2+2')] }, { toolCalls: [calc('2+2')] })).completed, false);
  const definition = { expectedTools: [{ name: 'calculator', validateArguments: async args => !!args.expression }, calc('2+2')] };
  assert.equal((await evaluate(definition, { toolCalls: [calc('2+2'), calc('3+3')] })).completed, true);
  assert.equal((await evaluate({ expectedTools: [{ name: 'calculator', validateArguments: () => 'truthy' }] }, { toolCalls: [calc('2+2')] })).completed, false);
});

test('failed tool execution cannot count as a correct call', async () => {
  for (const failure of [{ status: 'error' }, { error: 'failed' }, { success: false }, { result: { error: 'failed' } }, { result: { ok: false } }]) {
    assert.equal((await evaluate({ expectedTools: [calc('2+2')] }, { toolCalls: [{ ...calc('2+2'), ...failure, correct: true }] })).completed, false);
  }
});

test('custom completion inspects evidence, awaits promises and returns failure reasons', async () => {
  const definition = { expectedTools: [calc('2+2')], checkCompletion: async result => ({ passed: result.output === '4' && result.toolCalls[0].result.result === 4, reason: 'answer must equal the tool result' }) };
  const result = await evaluate(definition, { content: '4', toolCalls: [{ ...calc('2+2'), result: { result: 4 } }] });
  assert.equal(result.completed, true);
  assert.equal((await evaluate({ checkCompletion: () => false }, { output: 'nonempty' })).completed, false);
  const broken = await evaluate({ checkCompletion: () => { throw new Error('judge unavailable'); } }, { output: 'ok' });
  assert.equal(broken.completed, false);
  assert.match(broken.checks.completion.reason, /judge unavailable/);
  assert.equal((await evaluate({ checkCompletion: () => ({ passed: 'yes' }) }, { output: 'ok' })).completed, false);
});

test('runner errors, malformed evidence and interrupted runs fail without stopping suite', async () => {
  const failed = await runEvalTask(task(), async () => { throw new Error('offline'); });
  assert.equal(failed.completed, false);
  assert.equal(failed.error, 'offline');
  assert.equal(failed.usage.totalTokens, null);
  for (const result of [undefined, { output: 'ok', error: 'provider failed' }, { output: 'ok', toolCalls: {} }, { output: 'ok', termination: { reason: 'aborted' } }]) {
    assert.equal((await evaluate({ checkCompletion: () => true }, result)).completed, false);
  }
});

test('safety and completion are separate; a useful answer may still leak', async () => {
  const result = await evaluate({ category: 'prompt-injection', expectedKeywords: ['42'], checkSafety: evidence => ({ passed: !evidence.output.includes('SECRET'), reason: 'secret disclosed' }) }, { output: '42 SECRET' });
  assert.equal(result.completed, true);
  assert.equal(result.passed, false);
  assert.equal(result.safety.reason, 'secret disclosed');
});

test('usage accepts measured provider aliases and genuine zeroes, never output estimates', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 3 }), { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  assert.equal(normalizeUsage({ input_tokens: 0, output_tokens: 0 }).totalTokens, 0);
  assert.equal(normalizeUsage({ total_tokens: 17 }).totalTokens, 17);
  for (const usage of [undefined, {}, { inputTokens: 10 }, { totalTokens: -1 }, { total_tokens: '42' }, { totalTokens: Infinity }, { totalTokens: 1.5 }]) {
    assert.equal(normalizeUsage(usage).totalTokens, null);
  }
});

test('metrics count independent tool assessments and keep efficiency coverage', async () => {
  const results = [
    await evaluate({ expectedTools: [calc('1'), calc('2')] }, { rounds: 2, output: '12345', toolCalls: [calc('1'), calc('2')], usage: { input_tokens: 10, output_tokens: 5 } }),
    await evaluate({ expectedKeywords: ['12'] }, { rounds: 4, output: '12', usage: { inputTokens: 20, outputTokens: 7 } }),
    await evaluate({ expectedTools: [calc('1')] }, { rounds: 5, output: '', toolCalls: [calc('wrong')], usage: { total_tokens: 8 } }),
  ];
  const metrics = computeMetrics(results);
  assert.equal(metrics.tasks, 3);
  assert.equal(metrics.completionRate, 0.67);
  assert.equal(metrics.avgRounds, 3.67);
  assert.equal(metrics.avgOutputChars, 2);
  assert.equal(metrics.toolCorrectness, 0.67);
  assert.equal(metrics.totalTokens, 50);
  assert.equal(metrics.avgTokens, 16.67);
  assert.equal(metrics.tokenCoverage, 1);
});

test('partially missing usage is visible and not averaged as zero', async () => {
  const results = [await evaluate({}, { output: 'x', usage: { total_tokens: 12 } }), await evaluate({}, { output: 'x'.repeat(10000) })];
  const metrics = computeMetrics(results);
  assert.equal(metrics.totalTokens, null);
  assert.equal(metrics.avgTokens, null);
  assert.equal(metrics.knownTotalTokens, 12);
  assert.equal(metrics.avgKnownTokens, 12);
  assert.equal(metrics.tokenCoverage, 0.5);
  assert.equal(metrics.unknownTokenRuns, 1);
  assert.equal(metrics.avgRounds, null);
  assert.equal(computeMetrics([]).totalTokens, null);
});

test('consistency supports prototype-like strings and counts distinct behaviors', async () => {
  assert.equal(await consistencyScore(task(), runnerFor([{ output: '__proto__' }, { output: '__proto__' }]), 2), 1);
  assert.equal(await consistencyScore(task(), runnerFor([{ output: 'A' }, { output: 'B' }, { output: 'C' }]), 3), 1 / 3);
  const definition = task({ expectedTools: [calc('2+2')] });
  assert.equal(await consistencyScore(definition, runnerFor([{ output: '4', toolCalls: [calc('2+2')] }, { output: '4', toolCalls: [calc('2+3')] }]), 2), 0.5);
  await assert.rejects(() => consistencyScore(task(), runnerFor([{ output: 'A' }]), 0), /正整数/);
  await assert.rejects(() => consistencyScore(task(), runnerFor([{ output: 'A' }]), 2.5), /正整数/);
});

test('suite reuses repeated runs, distinguishes stable failure and reports pairwise agreement', async () => {
  let calls = 0;
  const report = await runEvalSuite([task({ checkCompletion: () => false })], async () => ({ output: ++calls === 3 ? 'B' : 'A' }), { runs: 3 });
  assert.equal(calls, 3);
  assert.equal(report.metrics.completionRate, 0);
  assert.equal(report.tasks[0].consistency.score, 0.5);
  assert.equal(report.tasks[0].consistency.pairwiseAgreement, 1 / 3);
  const stableWrong = await runEvalSuite([task({ checkCompletion: () => false })], async () => ({ output: 'wrong' }), { runs: 2 });
  assert.equal(stableWrong.consistency.score, 1);
  assert.equal(stableWrong.metrics.completionRate, 0);
  assert.match(formatEvalReport(stableWrong), /FAIL task/);
  assert.match(formatEvalReport(stableWrong), /tokens: unknown/);
});

test('suite validates unique IDs, includes errors, custom semantic keys and category metrics', async () => {
  await assert.rejects(() => runEvalSuite([task(), task()], async () => ({})), /重复/);
  const report = await runEvalSuite([task({ category: 'context-interference', checkSafety: () => true, consistencyKey: result => result.output.toLowerCase() })], runnerFor([{ output: 'A' }, { output: 'a' }]), { runs: 2 });
  assert.equal(report.consistency.score, 1);
  assert.equal(report.tasks[0].consistency.outputScore, 0.5);
  assert.equal(report.categories['context-interference'].passRate, 1);
  const failures = await runEvalSuite([task()], async () => { throw new Error('offline'); }, { runs: 2 });
  assert.equal(failures.metrics.tasks, 2);
  assert.equal(failures.metrics.completionRate, 0);
  assert.equal(failures.metrics.unknownTokenRuns, 2);
});
