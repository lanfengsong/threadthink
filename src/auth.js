/* ============================================================
   ThreadThink — Auth Module
   ============================================================ */

var TOKEN_KEY = 'tt_token';
var USER_KEY = 'tt_user';

/** Get stored auth token */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/** Get stored user object */
export function getUser() {
  var raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** Check if user is logged in */
export function isLoggedIn() {
  return !!getToken();
}

/** Register a new account */
export async function register(email, password) {
  var resp = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password }),
  });
  var data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '注册失败');
  saveAuth(data.user, data.token);
  return data.user;
}

/** Login */
export async function login(email, password) {
  var resp = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password }),
  });
  var data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '登录失败');
  saveAuth(data.user, data.token);
  return data.user;
}

/** Logout */
export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Refresh JWT token */
export async function refreshToken() {
  var token = getToken();
  if (!token) return null;
  var resp = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (!resp.ok) return null;
  var data = await resp.json();
  localStorage.setItem(TOKEN_KEY, data.token);
  return data.token;
}

function saveAuth(user, token) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
