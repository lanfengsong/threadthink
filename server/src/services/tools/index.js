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
