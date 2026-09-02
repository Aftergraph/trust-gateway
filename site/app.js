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