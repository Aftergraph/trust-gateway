'use strict';
// D3 wiring: theme init + command palette med panel-navigation.
(function () {
  if (!window.TG_CMDK || !window.TG_THEME) return;
  window.TG_THEME.init();
  window.TG_CMDK.init();
  // registrér panel-navigation (TG_PANELS udfyldes af panel-filerne; registrér
  // når DOM klar — panel-scripts loader før denne, så listen er komplet)
  function registerPanels() {
    const panels = (window.TG_PANELS || []);
    for (const p of panels) {
      window.TG_CMDK.register({
        id: 'goto-' + p.id,
        label: 'Gå til ' + (p.title || p.id),
        run: () => {
          // core tab-router: simuler klik på tab-knappen hvis til stede
          const btn = document.querySelector('[data-panel="' + p.id + '"]') ||
            document.getElementById('tab-' + p.id);
          if (btn && btn.click) btn.click();
        },
      });
    }
    window.TG_CMDK.register({
      id: 'toggle-theme',
      label: 'Skift tema (dark/light)',
      run: () => window.TG_THEME.toggle(),
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerPanels);
  } else {
    registerPanels();
  }
  // eksponér theme-toggle som global for palette og keyboard-genvej
  window.TG_THEME_toggle = window.TG_THEME.toggle;
})();
