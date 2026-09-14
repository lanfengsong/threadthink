/* ============================================================
   Tests: browser auth storage helpers
   ============================================================ */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getToken, getUser, isLoggedIn, login, logout, refreshToken } from '../../src/auth.js';

describe('auth storage and API helpers', function () {
  afterEach(function () {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('stores login credentials and clears them on logout', async function () {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      user: { id: 'u1', email: 'alice@example.com' }, token: 'jwt-1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await login('alice@example.com', 'password123');
    expect(getToken()).toBe('jwt-1');
    expect(getUser()).toEqual({ id: 'u1', email: 'alice@example.com' });
    expect(isLoggedIn()).toBe(true);

    logout();
    expect(getToken()).toBeNull();
    expect(getUser()).toBeNull();
    expect(isLoggedIn()).toBe(false);
  });

  it('refreshes the stored token', async function () {
    localStorage.setItem('tt_token', 'old-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ token: 'new-token' }), { status: 200 }
    )));

    await expect(refreshToken()).resolves.toBe('new-token');
    expect(getToken()).toBe('new-token');
  });
});
