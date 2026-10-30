/* Task-level behavior evaluation (design 3.4). Runners supply evidence, never grades. */
import { isDeepStrictEqual } from 'node:util';

export function createEvalTask(options = {}) {
  if (typeof options.id !== 'string' || !options.id.trim()) throw new Error('评测任务缺少 id');
  if (typeof options.goal !== 'string' || !options.goal.trim()) throw new Error('评测任务缺少 goal');
  for (const field of ['expectedTools', 'expectedKeywords']) {
    if (options[field] !== undefined && !Array.isArray(options[field])) throw new Error(field + ' 必须是数组');
  }
  for (const tool of options.expectedTools || []) {
    if (typeof tool === 'string' && tool.trim()) continue;
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) throw new Error('expectedTools 缺少工具名');
    if (tool.validateArguments !== undefined && typeof tool.validateArguments !== 'function') throw new Error('validateArguments 必须是函数');
  }
  if ((options.expectedKeywords || []).some(keyword => typeof keyword !== 'string' || !keyword.trim())) throw new Error('expectedKeywords 必须是非空字符串');
  for (const field of ['checkCompletion', 'checkSafety', 'consistencyKey']) {
    if (options[field] !== undefined && typeof options[field] !== 'function') throw new Error(field + ' 必须是函数');
  }
  if (options.category && options.category !== 'standard' && !options.checkSafety) throw new Error('对抗任务需要 checkSafety');
  return { ...options, name: options.name || options.id, category: options.category || 'standard',
    expectedTools: options.expectedTools || [], expectedKeywords: options.expectedKeywords || [] };
}

function tokenCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

/** Only provider-reported counts; no character estimates and no default zeroes. */
export function normalizeUsage(usage) {
  const inputTokens = tokenCount(usage?.inputTokens ?? usage?.input_tokens ?? usage?.prompt_tokens);
  const outputTokens = tokenCount(usage?.outputTokens ?? usage?.output_tokens ?? usage?.completion_tokens);
  const explicitTotal = usage?.totalTokens ?? usage?.total_tokens;
  const totalTokens = explicitTotal !== undefined && explicitTotal !== null
    ? tokenCount(explicitTotal)
    : inputTokens !== null && outputTokens !== null ? tokenCount(inputTokens + outputTokens) : null;
  return { inputTokens, outputTokens, totalTokens };
}

function normalizeCall(call) {
  let args = call?.arguments ?? call?.args ?? call?.function?.arguments;
  let invalidArguments = false;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { invalidArguments = true; }
  }
  const failed = call?.success === false || call?.status === 'error' || !!call?.error || !!call?.result?.error || call?.result?.ok === false;
  // Discard runner-provided correct/evaluation flags; preserve execution evidence.
  return { name: call?.name ?? call?.tool_name ?? call?.function?.name ?? '', arguments: args,
    result: call?.result, invalidArguments, failed };
}

async function check(predicate, result, task) {
  try {
    const answer = await predicate(result, task);
    if (typeof answer === 'boolean') return { passed: answer };
    if (answer && typeof answer.passed === 'boolean') return { passed: answer.passed, reason: answer.reason || null };
    return { passed: false, reason: '判定函数必须返回 boolean 或 { passed, reason }' };
  } catch (error) {
    return { passed: false, reason: '判定异常: ' + error.message };
  }
}

async function evaluateTools(task, rawCalls) {
  const expected = task.expectedTools.map(tool => typeof tool === 'string' ? { name: tool } : tool);
  const calls = rawCalls.map(normalizeCall);
  const matches = [];
  for (const call of calls) {
    const row = [];
    for (const tool of expected) {
      let matched = call.name === tool.name && !call.failed && !call.invalidArguments;
      if (matched && Object.hasOwn(tool, 'arguments')) matched = isDeepStrictEqual(call.arguments, tool.arguments);
      if (matched && tool.validateArguments) matched = (await check(() => tool.validateArguments(call.arguments, call, task))).passed;
      row.push(matched);
    }
    matches.push(row);
  }
  // Maximum matching handles repeated tools and overlapping parameter predicates.
  const assigned = new Map();
  function assign(expectedIndex, seen) {
    for (let i = 0; i < calls.length; i++) {
      if (!matches[i][expectedIndex] || seen.has(i)) continue;
      seen.add(i);
      if (!assigned.has(i) || assign(assigned.get(i), seen)) { assigned.set(i, expectedIndex); return true; }
    }
    return false;
  }
  let matchedExpected = 0;
  expected.forEach((_, index) => { if (assign(index, new Set())) matchedExpected++; });
  calls.forEach((call, index) => {
    call.correct = matches[index].some(Boolean);
    call.argumentsChecked = matches[index].some((match, i) => match && (Object.hasOwn(expected[i], 'arguments') || !!expected[i].validateArguments));
  });
  const correctCalls = calls.filter(call => call.correct).length;
  return { calls, totalCalls: calls.length, correctCalls, matchedExpected, expectedCalls: expected.length,
    argumentsChecked: calls.filter(call => call.argumentsChecked).length,
    passed: matchedExpected === expected.length && correctCalls === calls.length };
}

/** Runner: (goal, task) => {output|content, rounds, toolCalls, usage, ...evidence}. */
export async function runEvalTask(inputTask, runTask) {
  const task = createEvalTask(inputTask);
  let raw;
  let executionError = null;
  try {
    raw = await runTask(task.goal, task);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('runner 未返回结果对象');
  } catch (error) { executionError = String(error.message || error); raw = {}; }
  const output = typeof (raw.output ?? raw.content) === 'string' ? (raw.output ?? raw.content) : '';
  const tools = await evaluateTools(task, Array.isArray(raw.toolCalls) ? raw.toolCalls : []);
  const evidence = { ...raw, output, toolCalls: tools.calls, usage: normalizeUsage(raw.usage) };
  const checks = {
    execution: { passed: !executionError && !raw.error, reason: executionError || raw.error || null },
    tools: { passed: tools.passed },
  };
  if (task.expectedKeywords.length) checks.keywords = { passed: task.expectedKeywords.some(keyword => output.includes(keyword)) };
  if (task.checkCompletion) checks.completion = await check(task.checkCompletion, evidence, task);
  else {
    if (!task.expectedTools.length && !task.expectedKeywords.length) checks.output = { passed: !!output.trim() };
  }
  checks.termination = { passed: !raw.termination || raw.termination.reason === 'completed' };
  if (raw.toolCalls !== undefined && !Array.isArray(raw.toolCalls)) checks.execution = { passed: false, reason: 'toolCalls 必须是数组' };
  const completed = Object.values(checks).every(item => item.passed);
  const safety = task.checkSafety ? await check(task.checkSafety, evidence, task) : null;
  return { taskId: task.id, name: task.name, category: task.category, completed,
    passed: completed && (!safety || safety.passed), checks, safety,
    rounds: tokenCount(raw.rounds), output, toolCalls: tools.calls, toolEvaluation: tools,
    usage: evidence.usage, error: executionError || raw.error || null,
    termination: raw.termination || null,
    evidence: raw.evidence || null,
    ...(task.consistencyKey ? { consistencyKey: await consistencyKey(task, evidence) } : {}) };
}

async function consistencyKey(task, evidence) {
  try { return canonical(await task.consistencyKey(evidence, task)); }
  catch (error) { return 'key-error:' + error.message; }
}

function canonical(value) {
  if (value === undefined) return 'undefined';
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function agreement(keys) {
  const frequencies = new Map();
  keys.forEach(key => frequencies.set(key, (frequencies.get(key) || 0) + 1));
  const n = keys.length;
  return { distinct: frequencies.size, score: n ? 1 / frequencies.size : null,
    pairwiseAgreement: n < 2 ? null : [...frequencies.values()].reduce((sum, count) => sum + count * (count - 1), 0) / (n * (n - 1)) };
}

/** Stability is reported separately from success: consistently wrong is still wrong. */
export function summarizeConsistency(results) {
  const outputs = agreement(results.map(result => result.output.trim()));
  const behaviors = agreement(results.map(result => canonical({
    outcome: result.consistencyKey ?? result.output.trim(), completed: result.completed,
    passed: result.passed, error: result.error, termination: result.termination,
    tools: result.toolCalls.map(call => ({ name: call.name, arguments: call.arguments, failed: call.failed })),
  })));
  return { runs: results.length, outputScore: outputs.score, score: behaviors.score,
    distinctOutputs: outputs.distinct, distinctBehaviors: behaviors.distinct,
    pairwiseAgreement: behaviors.pairwiseAgreement,
    completionRate: results.length ? round2(results.filter(result => result.completed).length / results.length) : 0 };
}

function validateRuns(runs) {
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('runs 必须是正整数');
}

export async function consistencyScore(task, runTask, runs = 3) {
  validateRuns(runs);
  const results = [];
  for (let i = 0; i < runs; i++) results.push(await runEvalTask(task, runTask));
  return summarizeConsistency(results).score;
}

export function computeMetrics(results) {
  const total = results.length;
  const usages = results.map(result => normalizeUsage(result.usage));
  const known = usages.filter(usage => usage.totalTokens !== null);
  const knownTotalTokens = known.reduce((sum, usage) => sum + usage.totalTokens, 0);
  const rounds = results.map(result => tokenCount(result.rounds)).filter(value => value !== null);
  const totalCalls = results.reduce((sum, result) => sum + (result.toolCalls || []).length, 0);
  // Only runEvalTask's independent assessment contributes correct calls.
  const correctCalls = results.reduce((sum, result) => sum + (result.toolEvaluation?.correctCalls || 0), 0);
  const checkedArgs = results.reduce((sum, result) => sum + (result.toolEvaluation?.argumentsChecked || 0), 0);
  return { tasks: total, completionRate: total ? round2(results.filter(result => result.completed).length / total) : 0,
    passRate: total ? round2(results.filter(result => result.passed).length / total) : 0,
    avgRounds: rounds.length ? round2(rounds.reduce((sum, value) => sum + value, 0) / rounds.length) : null,
    roundCoverage: total ? round2(rounds.length / total) : 0,
    avgOutputChars: total ? Math.round(results.reduce((sum, result) => sum + (result.output || '').length, 0) / total) : 0,
    toolCorrectness: totalCalls ? round2(correctCalls / totalCalls) : 1,
    totalToolCalls: totalCalls, argumentsChecked: checkedArgs,
    totalTokens: total && known.length === total ? knownTotalTokens : null,
    avgTokens: total && known.length === total ? round2(knownTotalTokens / total) : null,
    knownTotalTokens, knownTokenRuns: known.length, unknownTokenRuns: total - known.length,
    tokenCoverage: total ? round2(known.length / total) : 0,
    avgKnownTokens: known.length ? round2(knownTotalTokens / known.length) : null };
}

/** Same repeated runs power metrics and consistency; failures remain in the denominator. */
export async function runEvalSuite(tasks, runTask, { runs = 3, mode = 'custom', notes = [] } = {}) {
  validateRuns(runs);
  const definitions = tasks.map(createEvalTask);
  if (new Set(definitions.map(task => task.id)).size !== definitions.length) throw new Error('任务 id 重复');
  const reports = [];
  for (const task of definitions) {
    const results = [];
    for (let i = 0; i < runs; i++) results.push(await runEvalTask(task, runTask));
    reports.push({ id: task.id, name: task.name, category: task.category, metrics: computeMetrics(results),
      consistency: summarizeConsistency(results), results });
  }
  const results = reports.flatMap(report => report.results);
  const categories = [...new Set(definitions.map(task => task.category))];
  return { schemaVersion: 1, mode, generatedAt: new Date().toISOString(), notes,
    taskCount: definitions.length, runsPerTask: runs, metrics: computeMetrics(results),
    consistency: { score: reports.length ? round2(reports.reduce((sum, report) => sum + report.consistency.score, 0) / reports.length) : null,
      pairwiseAgreement: runs > 1 && reports.length ? round2(reports.reduce((sum, report) => sum + report.consistency.pairwiseAgreement, 0) / reports.length) : null },
    categories: Object.fromEntries(categories.map(category => [category, computeMetrics(results.filter(result => result.category === category))])),
    tasks: reports };
}

export function formatEvalReport(report) {
  const metrics = report.metrics;
  const tokenText = metrics.totalTokens === null ? 'unknown' : String(metrics.totalTokens);
  const lines = [`Behavior eval (${report.mode}): ${report.taskCount} tasks × ${report.runsPerTask} runs`,
    `Completion: ${metrics.completionRate}; pass: ${metrics.passRate}; tool correctness: ${metrics.toolCorrectness}`,
    `Rounds: ${metrics.avgRounds ?? 'unknown'}; usage tokens: ${tokenText}; coverage: ${metrics.knownTokenRuns}/${metrics.tasks}`,
    `Consistency: ${report.consistency.score ?? 'unknown'}; pairwise agreement: ${report.consistency.pairwiseAgreement ?? 'unknown'}`];
  for (const task of report.tasks) {
    lines.push(`${task.metrics.passRate === 1 ? 'PASS' : 'FAIL'} ${task.id} [${task.category}] completion=${task.metrics.completionRate} stability=${task.consistency.score}`);
    for (const result of task.results.filter(result => !result.passed)) {
      const reasons = Object.entries(result.checks).filter(([, check]) => !check.passed).map(([name, check]) => name + (check.reason ? ': ' + check.reason : ''));
      if (result.safety && !result.safety.passed) reasons.push('safety: ' + (result.safety.reason || 'failed'));
      lines.push('  ' + reasons.join('; '));
    }
  }
  return lines.concat(report.notes.map(note => 'Note: ' + note)).join('\n');
}

function round2(number) { return Math.round(number * 100) / 100; }
