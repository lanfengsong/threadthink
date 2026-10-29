/* ============================================================
   ThreadThink Server — Tool Registry
   ============================================================

   Tool execution receives request-scoped context explicitly. Do not use
   module-level user state: concurrent chat requests must remain isolated.
   ============================================================ */

import { webSearchTool } from './web-search.js';
import { fetchUrlTool } from './fetch-url.js';
import { calculatorTool } from './calculator.js';
import { docSearchTool } from './doc-search.js';

var _tools = {};

export function registerTool(name, definition, execute) {
  _tools[name] = { definition: definition, execute: execute };
}

registerTool('web_search', webSearchTool.definition, webSearchTool.execute);
registerTool('fetch_url', fetchUrlTool.definition, fetchUrlTool.execute);
registerTool('calculator', calculatorTool.definition, calculatorTool.execute);
registerTool('doc_search', docSearchTool.definition, function (args, context) {
  return docSearchTool.execute(args, context && context.userId);
});

export function getToolDefinitions() {
  var defs = [];
  for (var name in _tools) {
    if (_tools[name].definition) defs.push(_tools[name].definition);
  }
  return defs;
}

/**
 * 输出契约（design 3.3）：决定"模型看到什么"。
 * 工具 definition 可带 output.render(args, value) -> string；
 * 未提供时回退 JSON.stringify（向后兼容）。
 * 与 value 分离的意义：模型视角可重放、可格式化，UI 呈现（presentationMeta）
 * 另行处理，工具本体只产出纯数据。
 */
export function renderToolResult(name, args, value) {
  var tool = _tools[name];
  if (tool && tool.definition) {
    // 支持两种定义位置：definition.output 或 definition.function.output
    var output = tool.definition.output || (tool.definition.function && tool.definition.function.output);
    if (output && typeof output.render === 'function') return output.render(args, value);
  }
  return JSON.stringify(value);
}

export async function executeTool(name, args, context) {
  var tool = _tools[name];
  if (!tool) return { error: '未知工具: ' + name };
  try {
    var result = await tool.execute(args || {}, context || {});
    return result;
  } catch (e) {
    return { error: '工具执行异常: ' + e.message };
  }
}
