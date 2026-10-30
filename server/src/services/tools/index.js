/* Request context is explicit; registries can be isolated per SDK/application. */
import { createToolRegistry } from './registry.js';
import { webSearchTool } from './web-search.js';
import { fetchUrlTool } from './fetch-url.js';
import { calculatorTool } from './calculator.js';
import { docSearchTool } from './doc-search.js';

export { createToolRegistry } from './registry.js';

export function createDefaultToolRegistry(options) {
  var registry = createToolRegistry(options);
  for (var tool of [webSearchTool, fetchUrlTool, calculatorTool]) registry.registerTool(tool);
  registry.registerTool({
    definition: docSearchTool.definition,
    execute: function (args, context) { return docSearchTool.execute(args, context.userId, context); },
  });
  return registry;
}

export var defaultToolRegistry = createDefaultToolRegistry();
export var registerTool = defaultToolRegistry.registerTool;
export var unregisterTool = defaultToolRegistry.unregisterTool;
export var getToolDefinitions = defaultToolRegistry.getToolDefinitions;
export var getMcpToolDefinitions = defaultToolRegistry.getMcpToolDefinitions;
export var executeTool = defaultToolRegistry.executeTool;
export var renderToolResult = defaultToolRegistry.renderToolResult;
export var getToolPresentationMeta = defaultToolRegistry.getToolPresentationMeta;
