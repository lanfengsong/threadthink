import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve as resolveModule } from 'import-meta-resolve';

/** Load trusted local/npm plugins; loading JavaScript grants the host process' privileges. */
export async function loadPlugin(spec, registry, options = {}) {
  var cwd = resolve(options.cwd || process.cwd());
  var descriptor = typeof spec === 'string' ? { path: spec } : spec;
  if (!descriptor || typeof descriptor.path !== 'string') throw new TypeError('插件配置需要 path');
  var entry;
  var manifest;
  var local = isAbsolute(descriptor.path) || descriptor.path.startsWith('.') || descriptor.path.startsWith('file:');
  if (local) {
    entry = descriptor.path.startsWith('file:') ? fileURLToPath(descriptor.path) : resolve(cwd, descriptor.path);
    if ((await stat(entry)).isDirectory()) {
      var root = entry;
      manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
      if (typeof manifest.name !== 'string' || !manifest.name || manifest.apiVersion !== 1) throw new Error('插件 manifest 需要 name 与 apiVersion: 1');
      entry = resolve(root, manifest.main || 'index.js');
      var path = relative(root, entry);
      if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new Error('插件 main 必须位于插件目录内');
    }
  } else {
    var url = resolveModule(descriptor.path, pathToFileURL(resolve(cwd, '__threadthink_resolve__.mjs')).href);
    if (!url.startsWith('file:')) throw new Error('插件必须是本地文件或已安装 npm 包');
    entry = fileURLToPath(url);
  }
  var module = await import(pathToFileURL(entry).href);
  var plugin = module.default || module;
  var removers = [];
  var cleanup;
  var disposed = false;
  function registerTool(tool) { var unregister = registry.registerTool(tool); removers.push(unregister); return unregister; }
  async function dispose() {
    if (disposed) return;
    disposed = true;
    var errors = [];
    for (var unregister of removers.reverse()) try { await unregister(); } catch (error) { errors.push(error); }
    try {
      if (typeof cleanup === 'function') await cleanup();
      else if (typeof cleanup?.dispose === 'function') await cleanup.dispose();
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '插件释放失败');
  }
  try {
    if (typeof plugin === 'function') cleanup = await plugin({ registerTool, config: descriptor.options || {}, manifest });
    else if (typeof plugin.setup === 'function') {
      cleanup = await plugin.setup({ registerTool, config: descriptor.options || {}, manifest });
      if (!cleanup && typeof plugin.dispose === 'function') cleanup = () => plugin.dispose();
    } else {
      var definitions = Array.isArray(plugin) ? plugin : plugin.tools || [plugin];
      for (var tool of definitions) registerTool(tool);
      if (plugin.tools && typeof plugin.dispose === 'function') cleanup = () => plugin.dispose();
    }
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], '插件加载与回滚失败'); }
    throw error;
  }
  return { name: manifest?.name || descriptor.path, dispose };
}

export async function loadPluginsFromDirectory(directory, registry, options = {}) {
  var root = resolve(options.cwd || process.cwd(), directory);
  var entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  var plugins = [];
  try {
    for (var entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) plugins.push(await loadPlugin(resolve(root, entry.name), registry, options));
    }
    return plugins;
  } catch (error) {
    await Promise.allSettled(plugins.map(plugin => plugin.dispose()));
    throw error;
  }
}
