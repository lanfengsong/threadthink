#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ThreadThink, loadConfig, mergeConfig, Session } from '../core/index.js';

const help = `ThreadThink — headless Agent CLI

  tt chat "解释一下 RAG"         对话（默认 mock，无需凭据）
  tt tools list                列出已启用工具
  tt session status            查看本地事件派生的会话状态

选项：
  --config <file>              JSON 配置文件（默认 threadthink.config.json）
  --profile <name>             选择配置 profile
  --provider <name> | --mock   覆盖 provider
  --model <name>               覆盖模型名
  --set '<json>'               叠加配置 patch
  --session <file>             会话文件（默认 .threadthink/session.json）
  --no-session                不读取或保存会话
  --json                      输出结构化 JSON
  --help                      显示帮助
`;

function parse(args) {
  var flags = {}, positional = [];
  var values = new Set(['config', 'profile', 'provider', 'model', 'set', 'session']);
  for (var i = 0; i < args.length; i++) {
    var value = args[i];
    if (value === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!value.startsWith('--')) { positional.push(value); continue; }
    var key = value.slice(2);
    if (values.has(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('缺少选项值: ' + value);
      flags[key] = args[++i];
    } else if (['json', 'help', 'mock', 'no-session'].includes(key)) flags[key] = true;
    else throw new Error('未知选项: ' + value);
  }
  return { flags, positional };
}
async function readSession(path) {
  try {
    var snapshot = JSON.parse(await readFile(path, 'utf8'));
    if (snapshot.version !== 1) throw new Error('不支持的会话版本');
    return new Session(snapshot).toJSON();
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function saveSession(path, session) {
  var temp = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, JSON.stringify(session, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function main() {
  var { flags, positional } = parse(process.argv.slice(2));
  if (flags.help || !positional.length) { process.stdout.write(help); return; }
  var [command, subcommand] = positional;
  if (command === 'plugin' && subcommand === 'install') throw new Error('插件安装管理器尚未实现；请使用 npm 安装后在 plugins 配置中添加包名');
  if (command !== 'chat' && !(command === 'tools' && subcommand === 'list') && !(command === 'session' && subcommand === 'status')) throw new Error('未知命令。使用 tt --help 查看用法');
  var path = resolve(flags.session || '.threadthink/session.json');
  if (command === 'session') {
    var status = new Session(flags['no-session'] ? undefined : await readSession(path)).status();
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    return;
  }
  var patch = flags.set ? JSON.parse(flags.set) : {};
  var overrides = mergeConfig(patch,
    flags.mock ? { provider: 'mock' } : flags.provider ? { provider: flags.provider } : {},
    flags.model ? { providerOptions: { model: flags.model } } : {});
  var config = await loadConfig({ path: flags.config, profile: flags.profile, overrides });
  var lock;
  var app;
  var controller = new AbortController();
  var onInterrupt = () => controller.abort(new Error('用户取消'));
  try {
    if (command === 'chat' && !flags['no-session']) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try { lock = await open(path + '.lock', 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('会话正被使用（若进程异常退出，请确认无进程后删除 ' + path + '.lock）'); throw error; }
    }
    app = new ThreadThink({ ...config, session: command === 'chat' && !flags['no-session'] ? await readSession(path) : undefined });
    await app.ready;
    if (command === 'tools') {
      var definitions = app.tools.getMcpToolDefinitions();
      process.stdout.write(flags.json ? JSON.stringify(definitions, null, 2) + '\n' : definitions.map(tool => tool.name + '\t' + tool.description).join('\n') + '\n');
      return;
    }
    var message = positional.slice(1).join(' ');
    if (!message && !process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
      for await (var chunk of process.stdin) message += chunk;
    }
    if (!message.trim()) throw new Error('请提供问题文本或通过 stdin 输入');
    process.once('SIGINT', onInterrupt);
    var result;
    try {
      result = await app.chat(message.trim(), { signal: controller.signal, onToken: flags.json ? undefined : text => process.stdout.write(text) });
    } finally {
      if (!flags['no-session']) await saveSession(path, app.session.toJSON());
    }
    process.stdout.write(flags.json ? JSON.stringify(result, null, 2) + '\n' : '\n');
    if (['aborted', 'blocked', 'refusal', 'max_tokens'].includes(result.termination.reason)) process.exitCode = result.termination.reason === 'aborted' ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    try { await app?.dispose(); }
    finally { if (lock) { await lock.close(); await unlink(path + '.lock'); } }
  }
}

main().catch(error => { process.stderr.write('tt: ' + error.message + '\n'); process.exitCode = 1; });
