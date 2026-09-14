/* ============================================================
   ThreadThink Server — Auth Service
   ============================================================ */

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/connection.js';
import { config } from '../config.js';
import { encrypt } from './crypto.service.js';

var SALT_ROUNDS = 10;
var MIN_PASSWORD_LENGTH = 6;

export function register(email, password) {
  email = normalizeEmail(email);
  validateCredentials(email, password);
  var db = getDb();

  var existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    var err = new Error('邮箱已注册');
    err.statusCode = 409;
    throw err;
  }

  var id = uuid();
  var hash = bcrypt.hashSync(password, SALT_ROUNDS);

  db.prepare('INSERT INTO users (id, email, password) VALUES (?, ?, ?)').run(id, email, hash);
  db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(id);

  var user = { id: id, email: email };
  var token = signToken(user);

  return { user: user, token: token };
}

export function login(email, password) {
  email = normalizeEmail(email);
  validateCredentials(email, password);
  var db = getDb();

  var row = db.prepare('SELECT id, email, password FROM users WHERE email = ?').get(email);
  if (!row) {
    var err = new Error('邮箱或密码错误');
    err.statusCode = 401;
    throw err;
  }

  var valid = bcrypt.compareSync(password, row.password);
  if (!valid) {
    var err2 = new Error('邮箱或密码错误');
    err2.statusCode = 401;
    throw err2;
  }

  var user = { id: row.id, email: row.email };
  var token = signToken(user);

  return { user: user, token: token };
}

export function getUserSettings(userId) {
  var db = getDb();
  var settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  var user = db.prepare('SELECT email, api_base, model, created_at FROM users WHERE id = ?').get(userId);
  if (!user) {
    var err = new Error('用户不存在');
    err.statusCode = 401;
    throw err;
  }
  return {
    email: user.email,
    apiBase: user.api_base,
    model: user.model,
    hasApiKey: !!userHasApiKey(userId),
    systemPrompt: settings ? settings.system_prompt : '你是一个有帮助的AI助手，请用中文回答用户的问题。',
    createdAt: user.created_at,
  };
}

export function updateUserSettings(userId, data) {
  var db = getDb();
  ensureUserExists(userId);

  if (data.apiKey !== undefined) {
    var encKey = data.apiKey ? encrypt(data.apiKey) : null;
    db.prepare('UPDATE users SET api_key = ? WHERE id = ?').run(encKey, userId);
  }
  if (data.apiBase !== undefined) {
    if (typeof data.apiBase !== 'string' || data.apiBase.length > 2048) throw badInput('API 地址无效');
    db.prepare('UPDATE users SET api_base = ? WHERE id = ?').run(data.apiBase, userId);
  }
  if (data.model !== undefined) {
    if (typeof data.model !== 'string' || data.model.length > 200) throw badInput('模型名称无效');
    db.prepare('UPDATE users SET model = ? WHERE id = ?').run(data.model, userId);
  }
  if (data.systemPrompt !== undefined) {
    if (typeof data.systemPrompt !== 'string' || data.systemPrompt.length > 10000) throw badInput('系统提示词无效');
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, system_prompt) VALUES (?, ?)').run(userId, data.systemPrompt);
  }

  return getUserSettings(userId);
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : email;
}

function validateCredentials(email, password) {
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    throw badInput('请输入有效的邮箱');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw badInput('密码长度不能少于' + MIN_PASSWORD_LENGTH + '位');
  }
}

function badInput(message) {
  var err = new Error(message);
  err.statusCode = 400;
  return err;
}

function ensureUserExists(userId) {
  var row = getDb().prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!row) {
    var err = new Error('用户不存在');
    err.statusCode = 401;
    throw err;
  }
}

function userHasApiKey(userId) {
  var db = getDb();
  var row = db.prepare('SELECT api_key FROM users WHERE id = ?').get(userId);
  return !!(row && row.api_key);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

export function refreshToken(userId) {
  var db = getDb();
  var row = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!row) {
    var err = new Error('用户不存在');
    err.statusCode = 404;
    throw err;
  }
  return signToken({ id: row.id, email: row.email });
}
