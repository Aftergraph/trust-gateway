'use strict';
// §20 — Fælles SSE-klient for konsollen.
//
// EventSource kan ikke sætte Authorization-headers, og token i query-param
// (?token=) lækker i proxy-logs/browserhistorik. Derfor: ticket-exchange —
// POST /v2/events/ticket med bearer-header → 30s single-use nonce → stream
// åbnes med ?ticket=<nonce> (værdiløs efter én brug).
//
// Resiliens (arkitektur-review 2026-09-06):
//  - 401/403 ved ticket-mint = auth-udløb → stream STOPPER permanent
//    (onAuthExpired) — aldrig uendelig reconnect-thrash.
//  - Netværksfejl → backoff-genstart (ny ticket + ny EventSource), max 5
//    hurtige forsøg, derefter 30s pause. Server-restart overleves.
//  - close() lukker stream + dræber reconnect; AbortController føres med.
window.TG_EVENTS = (function () {
  if (typeof window === 'undefined') return null;
  if (window.TG_EVENTS) return window.TG_EVENTS; // singleton (delt på tværs af paneler)

  const listeners = new Set();      // onAudit(entry)
  const authListeners = new Set();  // onAuthExpired()
  const statusListeners = new Set(); // onStatus('open'|'reconnect'|'auth-expired')
  let es = null;
  let dead = false;                 // close() kaldt — ingen genstart
  let retries = 0;
  let reopenTimer = null;
  let abortTicket = null;           // AbortController for ticket-mint-fetch

  function notifyAudit(entry) {
    for (const fn of listeners) {
      try { fn(entry); } catch (e) { /* panel-handler må aldrig dræbe streamen */ }
    }
  }

  function notifyAuth() {
    for (const fn of authListeners) {
      try { fn(); } catch (e) { /* ignore */ }
    }
  }

  function notifyStatus(s) {
    for (const fn of statusListeners) {
      try { fn(s); } catch (e) { /* ignore */ }
    }
  }

  async function mintTicket() {
    abortTicket = new AbortController();
    const res = await window.TG.api('/v2/events/ticket', {
      method: 'POST',
      body: '{}',
      signal: abortTicket.signal,
    });
    return res.ticket; // TG.api kaster allerede 401/403 med status-felt
  }

  function openStream() {
    if (dead) return;
    if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }
    mintTicket().then((ticket) => {
      es = new EventSource('/v2/events?ticket=' + encodeURIComponent(ticket));
      es.onopen = () => notifyStatus('open');
      es.addEventListener('audit', (ev) => {
        let entry = null;
        try { entry = JSON.parse(ev.data); } catch (e) { return; }
        notifyAudit(entry);
      });
      es.onerror = () => {
        // EventSource genforbinder selv — men vores ticket er single-use, så
        // en automatisk genforbindelse ville få 401. Luk + mønt ny ticket.
        if (es) { es.close(); es = null; }
        notifyStatus('reconnect');
        retries += 1;
        const delay = retries <= 5 ? 3000 : 30000;
        reopenTimer = setTimeout(() => { openStream(); }, delay);
      };
      retries = 0; // stream åbnede — nulstil backoff
    }).catch((err) => {
      const status = err && err.status;
      if (status === 401 || status === 403) {
        dead = true; // auth-udløb: stop permanent, bed brugeren genautentificere
        notifyAuth();
        return;
      }
      // netværksfejl ved mint (gateway nede) — backoff som ved stream-fejl
      retries += 1;
      const delay = retries <= 5 ? 3000 : 30000;
      reopenTimer = setTimeout(() => { openStream(); }, delay);
    });
  }

  return {
    // starter streamen (idempotent); kræver at window.TG.api findes.
    open() {
      if (dead) return this;
      if (es || reopenTimer) return this;
      retries = 0;
      openStream();
      return this;
    },
    onAudit(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn); // unsubscribe-handler
    },
    onAuthExpired(fn) {
      authListeners.add(fn);
      return () => authListeners.delete(fn);
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    close() {
      dead = true;
      if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }
      if (es) { es.close(); es = null; }
      if (abortTicket) { abortTicket.abort(); abortTicket = null; }
      listeners.clear();
      authListeners.clear();
    },
    isOpen: () => !!es || !!reopenTimer,
    isDead: () => dead,
  };
})();