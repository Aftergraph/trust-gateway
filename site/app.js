// Trust Gateway marketing site — minimal, textContent-only (XSS policy:
// no innerHTML assignment anywhere in site or app/ JS). Today the page is
// fully static; this file exists so the static mount contract is stable and
// future enhancement must follow the textContent rule.
'use strict';

(function () {
  // Mark the section currently in view in the header nav (visual only).
  var nav = document.querySelectorAll('header nav a');
  var targets = [];
  for (var i = 0; i < nav.length; i++) {
    var id = (nav[i].getAttribute('href') || '').replace(/^#/, '');
    var el = id ? document.getElementById(id) : null;
    if (el) targets.push({ link: nav[i], el: el });
  }

  function setActive() {
    var y = window.scrollY + 120;
    var current = null;
    for (var j = 0; j < targets.length; j++) {
      if (targets[j].el.offsetTop <= y) current = targets[j];
    }
    for (var k = 0; k < targets.length; k++) {
      var on = targets[k] === current;
      // textContent-only DOM writes — never innerHTML.
      if (on) {
        targets[k].link.style.color = '';
        targets[k].link.style.fontWeight = '700';
      } else {
        targets[k].link.style.color = '';
        targets[k].link.style.fontWeight = '';
      }
    }
  }

  window.addEventListener('scroll', setActive, { passive: true });
  setActive();
})();

// ── Live public chain data (textContent-only DOM writes, never innerHTML) ──
// Two consumers, both optional per page:
//   #chain-stamp            — footer stamp on every page (seal state + count)
//   #chain-state/-count/-head — the full status.html panel
// Source: GET /healthz — the one unauthenticated endpoint. It returns
// { ok, chain: { ok, length, head } }; nothing sensitive is in it, and this
// code renders nothing beyond those fields. If the gateway is unreachable,
// the fields keep their "unavailable" text — never a fake green light.
(function () {
  var stampEl = document.getElementById('chain-stamp');
  var stateEl = document.getElementById('chain-state');
  var countEl = document.getElementById('chain-count');
  var headEl = document.getElementById('chain-head');
  if (!stampEl && !stateEl) return;

  var UNAVAILABLE = 'unavailable';

  function sealWord(chain) {
    if (!chain) return UNAVAILABLE;
    return chain.ok ? 'sealed · verified' : 'verification FAILED';
  }
  function headWord(chain) {
    if (!chain || !chain.ok || typeof chain.head !== 'string' || !chain.head) return UNAVAILABLE;
    return chain.head.slice(0, 12) + '…';
  }

  function render(data) {
    var chain = data && data.chain ? data.chain : null;
    if (stampEl) {
      stampEl.textContent = chain && chain.ok
        ? 'chain sealed · ' + chain.length + ' entries'
        : 'chain: ' + sealWord(chain);
    }
    if (stateEl) stateEl.textContent = sealWord(chain);
    if (countEl) countEl.textContent = chain && chain.ok ? String(chain.length) : UNAVAILABLE;
    if (headEl) headEl.textContent = headWord(chain);
  }

  fetch('/healthz', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(render)
    .catch(function () { render(null); });
})();