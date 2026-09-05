'use strict';
// v2q-(b) — Secrets-vault operator-panel (FS-I5 UI).
//
// Backend: GET /v2/secrets (vault-status + tenant-keys) og
// POST /v2/secrets/rotate-master (FS-J2). Dette panel lukker fullstack-seamen:
// operatøren kan nu SE vault-status og ROTERE master-key fra konsollen.
//
// Sikkerhedsinvarianter:
//  - SECRET VALUES VISES ALDRIG: backend GET er key-ONLY, og dette panel
//    renderer kun key-navne fra /v2/secrets — der er ingen value-hentning,
//    ingen input der sender values, intet der echoer hemmeligheder.
//  - rotate-master kalder POST med NY ngøgle fra operatøren; svaret viser
//    kun {rotatedCount} — aldrig nøglen selv (backend audit gør det samme).
//  - vault_disabled (404 fra backend når TG_SECRETS_VAULT=0) vises ærligt.
//  - XSS-sikker: textContent kun, aldrig raw HTML-injection (XSS-loven).

function registerSecretsPanel(window) {
  'use strict';

  if (window.TG_PANELS.some((p) => p.id === 'secrets')) return; // dedup-guard

  const { el, api } = window.TG;

  function render(host) {
    host.textContent = '';
    const box = el('div', 'panel-box');
    host.append(box);
    box.append(el('h2', 'panel-title', 'Secrets Vault'));

    const status = el('div', 'secrets-status');
    box.append(status);

    const listEl = el('div', 'secrets-list');
    box.append(listEl);

    const err = el('div', 'secrets-error');
    box.append(err);

    api('/v2/secrets').then((d) => {
      if (d && d.error === 'vault_disabled') {
        status.textContent = 'vault disabled (TG_SECRETS_VAULT=0)';
        return;
      }
      if (!d || !d.enabled) {
        status.textContent = 'vault disabled';
        return;
      }
      status.textContent = 'vault enabled' + (d.masterRotatedAt ? ' — sidst roteret ' + d.masterRotatedAt : '');
      const tenants = Array.isArray(d.tenants) ? d.tenants : [];
      for (const t of tenants) {
        const row = el('div', 'secrets-tenant');
        row.append(el('span', 'secrets-tenant-id', 'tenant: ' + t.tenant));
        const keys = Array.isArray(t.keys) ? t.keys : [];
        const keyWrap = el('div', 'secrets-tenant-keys');
        if (keys.length === 0) {
          keyWrap.append(el('span', 'secrets-empty', 'ingen keys'));
        } else {
          for (const k of keys) {
            keyWrap.append(el('span', 'secrets-key-name', k)); // NAMES ONLY — aldrig values
          }
        }
        row.append(keyWrap);
        listEl.append(row);
      }

      // Rotate-master (operator): input til NY nøgle + knap.
      const rotBox = el('div', 'secrets-rotate-box');
      rotBox.append(el('span', 'secrets-rotate-label', 'rotate master:'));
      const input = el('input', 'secrets-rotate-input');
      input.type = 'password';
      input.placeholder = 'ny master-key (min 16)';
      const btn = el('button', 'btn secrets-rotate', 'rotér');
      const rotErr = el('div', 'secrets-rotate-error');
      btn.addEventListener('click', () => {
        rotErr.textContent = '';
        const newKey = input.value || '';
        if (newKey.length < 16) {
          rotErr.textContent = 'nøgle for svag (min 16 tegn)';
          return;
        }
        api('/v2/secrets/rotate-master', {
          method: 'POST',
          body: JSON.stringify({ newMasterKey: newKey }),
        }).then((r) => {
          input.value = '';
          if (r && r.error) {
            rotErr.textContent = 'rotate fejl: ' + r.error;
            return;
          }
          if (r && r.ok) {
            status.textContent = 'vault enabled — master roteret (' + (r.rotatedCount || 0) + ' keys)';
            return;
          }
          rotErr.textContent = 'rotate fejl: ukendt svar';
        }).catch(() => {
          rotErr.textContent = 'rotate fejl: netværk';
        });
      });
      rotBox.append(input, btn, rotErr);
      box.append(rotBox);
    }).catch(() => {
      status.textContent = 'fejl ved hentning af vault-status';
    });
  }

  window.TG_PANELS.push({ id: 'secrets', title: 'Secrets', render });
}

if (typeof window !== 'undefined' && window.TG && window.TG_PANELS) {
  registerSecretsPanel(window);
}