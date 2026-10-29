/* ============================================================
   ThreadThink Server — Behavior Eval Framework (design 3.4)

   任务级评测：任务集 → 执行（runner 注入，与模型解耦）→
   四维指标（完成率 / 效率 / 工具调用正确率 / 一致性）→ 报告。

   用途：量化"Agent 行为质量"——完成了吗、快吗、用对工具吗、
   稳定吗。对抗评测（提示注入等）为框架预留（runner 注入）。
   ============================================================ */

/** 评测任务：目标 + 预期工具 + 预期回答关键字（任一命中即完成）。 */
export function createEvalTask(options) {
  var task = options || {};
  if (typeof task.id !== 'string' || !task.id) throw new Error('评测任务缺少 id');
  if (typeof task.goal !== 'string' || !task.goal.trim()) throw new Error('评测任务缺少 goal');
  return {
    id: task.id,
    name: task.name || task.id,
    goal: task.goal,
    expectedTools: Array.isArray(task.expectedTools) ? task.expectedTools : [],
    expectedKeywords: Array.isArray(task.expectedKeywords) ? task.expectedKeywords : [],
  };
}

/**
 * 执行单个任务。
 * @param {Object} task 评测任务
 * @param {Function} runTask (goal, ctx) => Promise<{ rounds, toolCalls: [{name, correct}], output }>
 *        由调用方注入（测试用固定响应；生产接真实模型）。
 * @returns 执行结果 { taskId, completed, rounds, toolCalls, output }
 */
export async function runEvalTask(task, runTask) {
  var result = await runTask(task.goal, task);
  var output = (result && result.output) || '';
  var completed;
  if (task.expectedKeywords.length > 0) {
    completed = task.expectedKeywords.some(function (k) { return output.indexOf(k) !== -1; });
  } else if (task.expectedTools.length > 0) {
    // 无关键字：期望使用某工具（任一正确调用即视为完成）
    completed = (result.toolCalls || []).some(function (tc) { return tc.correct; });
  } else {
    completed = !!output.trim();
  }
  return {
    taskId: task.id,
    completed: completed,
    rounds: (result && result.rounds) || 0,
    toolCalls: (result && result.toolCalls) || [],
    output: output,
  };
}

/** 一致性（design 3.4）：同一任务执行 n 次，输出稳定度（1/不同输出数）。 */
export async function consistencyScore(task, runTask, runs) {
  var count = runs || 3;
  var outputs = {};
  for (var i = 0; i < count; i++) {
    var r = await runTask(task.goal, task);
    var key = ((r && r.output) || '').trim();
    outputs[key] = true;
  }
  var distinct = Object.keys(outputs).length;
  return distinct === 0 ? 0 : 1 / distinct;
}

/** 四维指标汇总（design 3.4）：完成率 / 效率 / 工具正确率 / （一致性单独算）。 */
export function computeMetrics(results) {
  var total = results.length;
  if (total === 0) {
    return { tasks: 0, completionRate: 0, avgRounds: 0, avgOutputChars: 0, toolCorrectness: 1 };
  }
  var completed = results.filter(function (r) { return r.completed; }).length;
  var avgRounds = results.reduce(function (s, r) { return s + (r.rounds || 0); }, 0) / total;
  var avgOutputChars = results.reduce(function (s, r) { return s + (r.output || '').length; }, 0) / total;
  var correctCalls = 0, totalCalls = 0;
  results.forEach(function (r) {
    (r.toolCalls || []).forEach(function (tc) {
      totalCalls++;
      if (tc.correct) correctCalls++;
    });
  });
  return {
    tasks: total,
    completionRate: round2(completed / total),
    avgRounds: round2(avgRounds),
    avgOutputChars: Math.round(avgOutputChars),
    toolCorrectness: totalCalls > 0 ? round2(correctCalls / totalCalls) : 1,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }