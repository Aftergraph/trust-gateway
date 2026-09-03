'use strict';
// FS-A1 mount — human auth surface (the layer ABOVE bots; bots stay bearer
// tokens from BOT_TOKENS). One mount file, four routes:
//
//   POST /v2/auth/register {email, password, display_name?}  (pw ≥10 chars, 5/min/IP)
//   POST /v2/auth/login    {email, password}                 (10/min/IP)
//   POST /v2/auth/logout                                     (session cookie)
//   GET  /v2/auth/me                                         (session cookie)
//
// Sessions ride an httpOnly SameSite=Lax cookie `tg_session` (Secure added
// when the request is behind https). Login responses are ALWAYS generic —
// 'invalid credentials' whether the email is unknown or the password is
// wrong (no account enumeration), and a dummy scrypt burn keeps timing flat.
// Every outcome is audited: user_registered / user_login_ok /
// user_login_failed / user_logout.

const path = require('node:path');
const { send, readBody } = require('../server');
const { timingBurn } = require('../users');
const { getUsers } = require('../users-db');     // FS-A5: env-gated DB variant
const { getSessions } = require('../sessions-db'); // FS-A5: env-gated DB variant

const COOKIE = 'tg_session';
const COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60; // mirrors the 7d sliding TTL
const DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');
const RATE = { register: { max: 5, windowMs: 60_000 }, login: { max: 10, windowMs: 60_000 } };

function getStores(gw) {
  if (!gw._authStores) {
    gw._authStores = {
      // FS-A5: env-gated SQLite variants (TG_USERS_DB / TG_SESSIONS_DB = 1);
      // env unset → legacy JSON stores, byte-identical, WeakMap-cached per gw.
      users: getUsers(gw, {
        file: process.env.TG_USERS_FILE || path.join(DATA_DIR, 'users.json'),
      }),
      sessions: getSessions(gw, {
        file: process.env.TG_SESSIONS_FILE || path.join(DATA_DIR, 'sessions.json'),
      }),
      rl: new Map(), // rate limiter: `${route}|${ip}` -> [timestamps]
    };
  }
  return gw._authStores;
}

function rateLimited(stores, route, ip) {
  const cfg = RATE[route];
  if (!cfg) return false;
  const key = route + '|' + (ip || 'unknown');
  const now = Date.now();
  const arr = (stores.rl.get(key) || []).filter((t) => now - t < cfg.windowMs);
  if (arr.length >= cfg.max) {
    stores.rl.set(key, arr);
    return true;
  }
  arr.push(now);
  stores.rl.set(key, arr);
  return false;
}

function ipOf(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isSecure(req) {
  return !!(req.socket && req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
}

function getCookie(req, name) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function setSessionCookie(req, res, token) {
  const bits = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${COOKIE_MAX_AGE_S}`];
  if (isSecure(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(req, res) {
  const bits = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

module.exports = {
  name: 'v2-auth',
  method: '*',
  path: /^\/v2\/auth\/(register|login|logout|me)$/,
  auth: 'none', // session-based; each route below enforces its own access
  handle: async (gw, req, res, ctx) => {
    const action = ctx.params.matches[1];

    let stores;
    try {
      stores = getStores(gw);
    } catch (e) {
      // Corrupt users/sessions file: fail closed, never serve half a login.
      return send(res, 503, { error: 'auth_store_unavailable' });
    }
    const { users, sessions } = stores;

    if (req.method === 'POST' && action === 'register') {
      if (rateLimited(stores, 'register', ipOf(req))) return send(res, 429, { error: 'rate_limited' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'invalid_json' });
      }
      const out = users.create({
        email: typeof body.email === 'string' ? body.email : '',
        password: typeof body.password === 'string' ? body.password : '',
        display_name: body.display_name == null ? null : body.display_name,
      });
      if (!out.ok) {
        const status = out.error === 'email_taken' ? 409 : 400;
        return send(res, status, { error: out.error });
      }
      gw._audit({ type: 'user_registered', userId: out.user.id, role: out.user.role });
      const token = sessions.create(out.user.id);
      setSessionCookie(req, res, token);
      return send(res, 201, { user: out.user, bot: null });
    }

    if (req.method === 'POST' && action === 'login') {
      if (rateLimited(stores, 'login', ipOf(req))) return send(res, 429, { error: 'rate_limited' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'invalid_json' });
      }
      const email = typeof body.email === 'string' ? body.email : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const user = users.getByEmail(email);
      let ok = false;
      if (user && !user.disabled) ok = users.verifyPassword(user, password);
      else timingBurn(password); // same scrypt cost as a real check
      if (!ok) {
        const reason = user && user.disabled ? 'account_disabled' : 'invalid_credentials';
        gw._audit({ type: 'user_login_failed', reason });
        return send(res, 401, { error: 'invalid credentials' }); // generic, always
      }
      gw._audit({ type: 'user_login_ok', userId: user.id });
      const token = sessions.create(user.id);
      setSessionCookie(req, res, token);
      return send(res, 200, { user: users.project(user), bot: null });
    }

    if (req.method === 'POST' && action === 'logout') {
      const token = getCookie(req, COOKIE);
      if (token) {
        const s = sessions.get(token);
        if (s) {
          sessions.revoke(token);
          gw._audit({ type: 'user_logout', userId: s.userId });
        }
      }
      clearSessionCookie(req, res);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && action === 'me') {
      const token = getCookie(req, COOKIE);
      const s = token ? sessions.get(token) : null;
      const user = s ? users.getById(s.userId) : null;
      if (!user || user.disabled) {
        clearSessionCookie(req, res);
        return send(res, 401, { error: 'unauthorized' });
      }
      return send(res, 200, { user: users.project(user), bot: null });
    }

    return send(res, 405, { error: 'method_not_allowed' });
  },
};
