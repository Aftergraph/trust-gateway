'use strict';
// Trust Gateway v2 — client auth shell (FS-A3).
// Loads after app.js. Cookie-session first for user-layer calls; the bearer
// token stays API-only (app.js continues to use it for operator routes).
// XSS policy: textContent-only DOM writes. Never interpolate server data
// into markup attributes — every dynamic string goes through textContent.
// A 401 from /v2/auth/me is silent (no console noise, no thrown errors
// surfacing to the user) — it simply means "not signed in".
(function () {
  var params = new URLSearchParams(location.search);
  var hasCookieSession = false; // set true only by a 200 from /v2/auth/me

  function bearerToken() {
    try { return (window.TG && typeof window.TG.token === 'function') ? (window.TG.token() || '') : ''; }
    catch (e) { return ''; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // ── user-layer fetch: cookie preferred, bearer fallback (API-only) ──────
  // When a cookie session exists it wins; the Authorization header is only
  // attached when there is no cookie session, so the bearer token keeps
  // working for pure API callers but never shadows the cookie.
  function userApi(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
    if (!hasCookieSession) {
      var tok = bearerToken();
      if (tok) headers.authorization = 'Bearer ' + tok;
    }
    var init = Object.assign({}, opts, { headers: headers, credentials: 'include' });
    return fetch(path, init);
  }

  function authMe() {
    return userApi('/v2/auth/me', { method: 'GET' }).then(function (res) {
      if (res.status === 200) {
        hasCookieSession = true;
        return res.json().catch(function () { return {}; });
      }
      if (res.status === 401) {
        // silent: not signed in — no console output, no user-facing error
        hasCookieSession = false;
        return null;
      }
      hasCookieSession = false;
      return null;
    }).catch(function () {
      // network failure / endpoint not deployed: stay silent, affordance only
      hasCookieSession = false;
      return null;
    });
  }

  // ── header affordance: Sign in ↔ user chip (display_name + logout) ─────
  function renderAuthChip(me) {
    var slot = document.getElementById('authChip');
    if (!slot) return;
    slot.textContent = '';
    if (me && me.display_name) {
      var chip = el('span', 'user-chip');
      chip.append(el('span', 'user-chip-name', String(me.display_name)));
      var out = el('button', 'btn user-chip-logout', 'logout');
      out.addEventListener('click', function () { logout(); });
      chip.appendChild(out);
      slot.appendChild(chip);
    } else {
      var signin = el('button', 'btn signin-btn', 'Sign in');
      signin.addEventListener('click', function () { openOverlay('login'); });
      slot.appendChild(signin);
    }
  }

  function refreshConsoleState() {
    try {
      if (window.TG && typeof window.TG.refresh === 'function') window.TG.refresh();
    } catch (e) { /* console not ready — nothing to refresh */ }
    window.dispatchEvent(new CustomEvent('tg-auth-changed', { detail: { cookie: hasCookieSession } }));
  }

  function logout() {
    userApi('/v2/auth/logout', { method: 'POST', body: '{}' }).catch(function () {});
    hasCookieSession = false;
    renderAuthChip(null);
    refreshConsoleState();
  }

  // ── minimal login/signup overlay (Modal surface, --tg-* tokens) ─────────
  var overlay = null;
  var mode = 'login'; // 'login' | 'signup'

  function field(labelText, inputId, type) {
    var label = el('label', 'auth-field');
    label.setAttribute('for', inputId);
    label.append(el('span', 'auth-field-label', labelText));
    var input = el('input', 'auth-input');
    input.id = inputId;
    input.type = type || 'text';
    input.autocomplete = mode === 'signup' && type === 'password' ? 'new-password' : 'current-password';
    label.appendChild(input);
    return label;
  }

  function ensureOverlay() {
    if (overlay) return overlay;
    var wrap = el('div', 'modal auth-modal');
    wrap.id = 'authOverlay';
    var box = el('div', 'auth-box');

    var title = el('h3', 'auth-title', 'Sign in');
    var tabs = el('div', 'auth-tabs');
    var loginTab = el('button', 'auth-tab', 'Sign in');
    var signupTab = el('button', 'auth-tab', 'Create account');

    var form = el('form', 'auth-form');
    var displayField = field('Display name', 'authDisplay', 'text');
    var userField = field('Username', 'authUser', 'text');
    var passField = field('Password', 'authPass', 'password');
    var submit = el('button', 'btn auth-submit', 'Sign in');
    var msg = el('div', 'auth-msg', '');
    form.append(displayField, userField, passField, submit, msg);

    function syncMode() {
      var signup = mode === 'signup';
      title.textContent = signup ? 'Create account' : 'Sign in';
      submit.textContent = signup ? 'Create account' : 'Sign in';
      displayField.style.display = signup ? '' : 'none';
      loginTab.classList.toggle('auth-tab-active', !signup);
      signupTab.classList.toggle('auth-tab-active', signup);
      msg.textContent = '';
    }
    loginTab.addEventListener('click', function () { mode = 'login'; syncMode(); });
    signupTab.addEventListener('click', function () { mode = 'signup'; syncMode(); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.textContent = '';
      var username = document.getElementById('authUser').value.trim();
      var password = document.getElementById('authPass').value;
      var display = document.getElementById('authDisplay').value.trim();
      if (!username || !password) { msg.textContent = 'username and password required'; return; }
      var path = mode === 'signup' ? '/v2/auth/signup' : '/v2/auth/login';
      var body = mode === 'signup'
        ? { username: username, password: password, display_name: display || username }
        : { username: username, password: password };
      submit.disabled = true;
      userApi(path, { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
        submit.disabled = false;
        if (res.status === 200 || res.status === 201) {
          // success: the session lives in an HttpOnly cookie — store NOTHING
          // sensitive client-side (no localStorage, no token echo).
          return authMe().then(function (me) {
            closeOverlay();
            renderAuthChip(me);
            refreshConsoleState();
          });
        }
        if (res.status === 401 || res.status === 403) {
          msg.textContent = 'invalid credentials'; // silent elsewhere; inline hint only
          return null;
        }
        msg.textContent = 'sign-in unavailable (' + res.status + ')';
        return null;
      }).catch(function () {
        submit.disabled = false;
        msg.textContent = 'network error';
      });
    });

    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeOverlay(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay && overlay.wrap.classList.contains('view-show')) closeOverlay();
    });

    box.append(title, tabs, form);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    tabs.append(loginTab, signupTab);
    overlay = { wrap: wrap, syncMode: syncMode };
    return overlay;
  }

  function openOverlay(startMode) {
    mode = (startMode === 'signup') ? 'signup' : 'login';
    var o = ensureOverlay();
    o.syncMode();
    o.wrap.classList.add('view-show');
    var first = document.getElementById(mode === 'signup' ? 'authDisplay' : 'authUser');
    if (first) first.focus();
  }

  function closeOverlay() {
    if (overlay) overlay.wrap.classList.remove('view-show');
  }

  // ── boot: who am I? then ?auth=signup deep-link ─────────────────────────
  authMe().then(function (me) {
    renderAuthChip(me);
    refreshConsoleState();
    if (me) return; // already signed in — deep-link is moot
    if (params.get('auth') === 'signup') openOverlay('signup');
    else if (!bearerToken()) {
      // 401 AND no bearer token: offer the login overlay (silent, low-key)
      openOverlay('login');
    }
  });
})();
