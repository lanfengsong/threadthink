import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  provider: 'mock', persona: '你是 ThreadThink 助手，请用中文回答用户的问题。',
  maxToolRounds: 5, maxConsecutiveFailures: 2,
  rag: Object.freeze({ chunkSize: 1000, overlap: 100, topK: 3 }),
  contextBudgets: Object.freeze({}), providerOptions: Object.freeze({}), plugins: Object.freeze([]),
});

function plain(value) { return value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
export function mergeConfig(...layers) {
  var merged = {};
  for (var layer of layers) {
    if (!plain(layer)) throw new TypeError('配置必须是对象');
    for (var [key, value] of Object.entries(layer)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('配置包含无效属性: ' + key);
      if (value === undefined) continue;
      merged[key] = plain(value) ? mergeConfig(plain(merged[key]) ? merged[key] : {}, value) : Array.isArray(value) ? [...value] : value;
    }
  }
  return merged;
}

export function validateConfig(config) {
  if (typeof config.provider !== 'string' && typeof config.provider?.chat !== 'function') throw new TypeError('provider 必须是名称或 adapter');
  for (var key of ['maxToolRounds', 'maxConsecutiveFailures']) {
    if (!Number.isInteger(config[key]) || config[key] < (key === 'maxToolRounds' ? 0 : 1)) throw new TypeError(key + ' 必须是有效整数');
  }
  if (typeof config.persona !== 'string') throw new TypeError('persona 必须是字符串');
  if (!plain(config.rag)) throw new TypeError('rag 必须是对象');
  var { chunkSize, overlap, topK } = config.rag;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || !Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize || !Number.isInteger(topK) || topK < 1) throw new TypeError('RAG chunkSize/overlap/topK 配置无效');
  if (!plain(config.contextBudgets)) throw new TypeError('contextBudgets 必须是对象');
  for (var value of Object.values(config.contextBudgets)) if (!Number.isInteger(value) || value < 0) throw new TypeError('上下文预算必须是非负整数');
  if (!Array.isArray(config.plugins)) throw new TypeError('plugins 必须是数组');
  return config;
}

/** Explicit config > selected profile > file base > defaults; environment precedes explicit overrides. */
export async function loadConfig(options = {}) {
  var cwd = resolve(options.cwd || process.cwd());
  var file = resolve(cwd, options.path || 'threadthink.config.json');
  var stored = {};
  try { stored = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || options.path) throw error; }
  if (!plain(stored)) throw new TypeError('配置文件必须是 JSON 对象');
  var { profiles = {}, profile: defaultProfile, ...base } = stored;
  var profile = options.profile || defaultProfile;
  if (profile && (!Object.hasOwn(profiles, profile) || !plain(profiles[profile]))) throw new Error('未知配置 profile: ' + profile);
  var env = options.env || process.env;
  var environment = {};
  if (env.TT_PROVIDER) environment.provider = env.TT_PROVIDER;
  if (env.TT_MODEL) environment.providerOptions = { model: env.TT_MODEL };
  if (env.TT_API_BASE) environment.providerOptions = { ...environment.providerOptions, apiBase: env.TT_API_BASE };
  if (env.TT_API_KEY) environment.providerOptions = { ...environment.providerOptions, apiKey: env.TT_API_KEY };
  var config = validateConfig(mergeConfig(DEFAULT_CONFIG, base, profile ? profiles[profile] : {}, environment, options.overrides || {}));
  return { ...config, configDir: dirname(file), ...(profile ? { profile } : {}) };
}
