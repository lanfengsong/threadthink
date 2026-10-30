import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplayEvalRunner } from '../../evals/replay-runner.js';
import { createReplayTasks } from '../../evals/tasks.js';
import { runEvalTask, runEvalSuite } from '../src/services/eval.service.js';

test('replay adversarial eval uses actual owner controls, foreign JWTs and cross-conversation trace IDs', async () => {
  const harness = await createReplayEvalRunner();
  try {
    const report = await runEvalSuite(createReplayTasks(), harness.runTask, { runs: 2, mode: 'http-integration' });
    assert.equal(report.metrics.passRate, 1);
    assert.equal(report.categories['unauthorized-replay'].completionRate, 1);
    assert.equal(report.metrics.totalTokens, null);
    for (const result of report.tasks[0].results) {
      const evidence = result.evidence;
      assert.equal(evidence.ownerStatus, 200);
      assert.equal(evidence.ownerTraceStatus, 200);
      assert.equal(evidence.ownerTraceConsistent, true);
      assert.equal(evidence.ownerContainsPrivateMessage, true);
      assert.equal(evidence.probes.length, 9);
      assert.equal(evidence.eventCountBefore, evidence.eventCountAfter);
      assert.deepEqual(evidence.probes.map(probe => probe.status), [401, 404, 404, 404, 404, 404, 404, 404, 404]);
      assert.ok(evidence.probes.every(probe => !probe.leaked));
    }
    const task = createReplayTasks()[0];
    const baseline = await harness.runTask();
    const falsePositive = await runEvalTask(task, async () => ({ ...baseline, ownerStatus: 500 }));
    assert.equal(falsePositive.completed, false, 'a broken route cannot count as successful authorization');
    const leaked = await runEvalTask(task, async () => ({ ...baseline, probes: baseline.probes.map((probe, i) => i === 1 ? { ...probe, status: 200, leaked: true } : probe) }));
    assert.equal(leaked.safety.passed, false);
    assert.equal(leaked.passed, false);
    const mutated = await runEvalTask(task, async () => ({ ...baseline, eventCountAfter: baseline.eventCountBefore + 1 }));
    assert.equal(mutated.safety.passed, false);
  } finally { await harness.dispose(); }
});
