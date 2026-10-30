#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runEvalSuite, formatEvalReport } from '../server/src/services/eval.service.js';
import { createBehaviorTasks, createReplayTasks, INJECTION_MARKER, PRIVATE_CANARY } from './tasks.js';
import { createMockEvalRunner } from './mock-runner.js';

let replay;
try {
  const { values } = parseArgs({ options: {
    runs: { type: 'string', default: '3' }, json: { type: 'boolean', default: false },
    output: { type: 'string' }, 'no-replay': { type: 'boolean', default: false },
    'negative-control': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: node evals/run-mock.js [--runs 3] [--json] [--output report.json] [--no-replay] [--negative-control]\nDefault: real orchestration with scripted providers + actual Fastify replay authorization. No API key or external network.\n--negative-control deliberately leaks a fixture canary; the report must fail with exit code 1.');
  } else {
    const runs = Number(values.runs);
    if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
    const tasks = createBehaviorTasks();
    const notes = [
      'Provider responses and retrieval/URL tools are scripted fixtures; calculator, context assembly, tool validation and orchestration execute real code.',
      'Mock success does not demonstrate the injection resistance or safety of a real provider.',
      'No provider token usage was measured by the default mock; unknown usage stays null. Output characters and context budgets are not token counts.',
      'Consistency is exact behavior stability (1/distinct outcomes) plus pairwise agreement; stable failures remain failures.',
    ];
    if (!values['no-replay']) {
      const { createReplayEvalRunner } = await import('./replay-runner.js');
      replay = await createReplayEvalRunner();
      tasks.push(...createReplayTasks());
      notes.push('Unauthorized replay probes use the actual Fastify authorization routes and a temporary SQLite DB; they do not call a live model.');
    } else notes.push('Replay authorization was explicitly skipped (--no-replay); this report covers only the scripted provider scenarios.');
    const mockRunner = createMockEvalRunner({ responses: values['negative-control']
      ? { 'injection-rag': [{ content: INJECTION_MARKER + ' ' + PRIVATE_CANARY }] } : {} });
    if (values['negative-control']) notes.push('Negative control enabled: a scripted canary leak is expected to fail.');
    const report = await runEvalSuite(tasks, (goal, task) => task.category === 'unauthorized-replay'
      ? replay.runTask(goal, task) : mockRunner(goal, task), { runs, mode: 'mock', notes });
    const json = JSON.stringify(report, null, 2) + '\n';
    if (values.output) await writeFile(resolve(values.output), json);
    console.log(values.json ? json.trimEnd() : formatEvalReport(report));
    if (report.tasks.some(task => task.results.some(result => !result.passed))) process.exitCode = 1;
  }
} catch (error) {
  console.error('Evaluation failed: ' + error.message);
  process.exitCode = 2;
} finally {
  await replay?.dispose();
}
