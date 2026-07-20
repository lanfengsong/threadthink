/* ============================================================
   ThreadThink Server — Tool Registry
   ============================================================ */

import { webSearchTool } from './web-search.js';
import { fetchUrlTool } from './fetch-url.js';
import { calculatorTool } from './calculator.js';
import { docSearchTool } from './doc-search.js';

var _tools = {};

export function registerTool(name, definition, execute) {
  _tools[name] = { definition: definition, execute: execute };
}

// Register built-in tools
registerTool('web_search', webSearchTool.definition, webSearchTool.execute);
registerTool('fetch_url', fetchUrlTool.definition, fetchUrlTool.execute);
registerTool('calculator', calculatorTool.definition, calculatorTool.execute);
registerTool('doc_search', docSearchTool.definition, function (args) {
  return docSearchTool.execute(args, _userId);
});

var _userId = null;

/** Set the current user ID for tool execution context */
export function setToolUserId(userId) {
  _userId = userId;
}

/** Get tool definitions in OpenAI format */
export function getToolDefinitions() {
  var defs = [];
  for (var name in _tools) {
    if (_tools[name].definition) defs.push(_tools[name].definition);
  }
  return defs;
}

/** Execute a tool by name and return its result */
export async function executeTool(name, args) {
  var tool = _tools[name];
  if (!tool) return { error: '未知工具: ' + name };
  try {
    var result = await tool.execute(args);
    return result;
  } catch (e) {
    return { error: '工具执行异常: ' + e.message };
  }
}
