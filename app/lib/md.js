'use strict';
// A3 — letvægts markdown-renderer. 0 deps, ~160 linjer.
//
// XSS-LOVEN: ingen innerHTML nogensinde. Alt bygges med document.createElement
// + textContent — HTML i input forbliver ren tekst (testet).
//
// Understøttet: overskrifter (#..###), afsnit, kodeblokke ``` m. sprog-label +
// copy-knap, inline `code` / **bold** / *italic*, lister (- / 1.), tabeller
// (| a | b |), links [tekst](url) — kun http(s), target=_blank + rel=noopener.
//
// Returnerer en DocumentFragment-agtig node (append til host).

function codeBlock(lang, code) {
  const wrap = document.createElement('div');
  wrap.className = 'md-codeblock';
  if (lang) wrap.setAttribute('data-lang', lang);
  const pre = document.createElement('pre');
  pre.setAttribute('data-lang', lang || '');
  pre.textContent = code;
  const btn = document.createElement('button');
  btn.className = 'md-copy';
  btn.textContent = 'copy';
  btn.addEventListener('click', () => {
    // clipboard er progressiv forbedring — fejler stille i ikke-secure contexts
    try { if (navigator && navigator.clipboard) navigator.clipboard.writeText(code); } catch { /* no-op */ }
    btn.textContent = 'kopieret';
  });
  wrap.append(pre, btn);
  return wrap;
}

// Inline-parsing: `code`, **bold**, *italic*, [tekst](url) — i prioriteret
// rækkefølge, rekursivt fladtrykt til elementer.
function inlineText(parent, text) {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/;
  const m = text.match(re);
  if (!m) { parent.append(document.createTextNode(text)); return; }
  const before = text.slice(0, m.index);
  if (before) parent.append(document.createTextNode(before));
  const tok = m[0];
  const rest = text.slice(m.index + tok.length);
  let el;
  if (tok.startsWith('`')) {
    el = document.createElement('code'); el.textContent = tok.slice(1, -1);
  } else if (tok.startsWith('**')) {
    el = document.createElement('strong'); el.textContent = tok.slice(2, -2);
  } else if (tok.startsWith('*')) {
    el = document.createElement('em'); el.textContent = tok.slice(1, -1);
  } else {
    const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    const url = mm && mm[2] || '';
    if (/^https?:\/\//i.test(url)) {
      el = document.createElement('a');
      el.setAttribute('href', url);
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener');
      el.textContent = mm[1];
    } else {
      // usikkert skema (javascript: osv.) → drop linket, behold teksten
      el = document.createDocumentFragment ? null : document.createElement('span');
      if (!el) { parent.append(document.createTextNode(mm ? mm[1] : tok)); el = null; }
      else { el.textContent = mm ? mm[1] : tok; }
    }
  }
  if (el) parent.append(el);
  inlineText(parent, rest);
}

function fragment() {
  // DocumentFragment-shim: samme append/querySelector-flade som vores Node2-shim
  const f = document.createElement('div');
  f._isFragment = true;
  return f;
}

function render(md) {
  const frag = fragment();
  const lines = String(md || '').split('\n');
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    inlineText(p, para.join(' '));
    frag.append(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];

    // kodeblok
    if (line.startsWith('```')) {
      flushPara();
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
      i++; // skip closing fence
      frag.append(codeBlock(lang, codeLines.join('\n')));
      continue;
    }

    // tabel: header |---| + mindst én række
    if (/^\|.+\|$/.test(line.trim()) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      flushPara();
      const headers = line.trim().slice(1, -1).split('|').map((s) => s.trim());
      i += 2;
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      for (const h of headers) {
        const th = document.createElement('th');
        th.textContent = h;
        trh.append(th);
      }
      thead.append(trh);
      table.append(thead);
      const tbody = document.createElement('tbody');
      while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((s) => s.trim());
        const tr = document.createElement('tr');
        for (const c of cells) {
          const td = document.createElement('td');
          td.textContent = c;
          tr.append(td);
        }
        tbody.append(tr);
        i++;
      }
      table.append(tbody);
      frag.append(table);
      continue;
    }

    // overskrifter
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushPara();
      const el = document.createElement('h' + h[1].length);
      el.textContent = h[2];
      frag.append(el);
      i++;
      continue;
    }

    // lister
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      const ul = document.createElement('ul');
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        const li = document.createElement('li');
        inlineText(li, lines[i].replace(/^[-*]\s+/, ''));
        ul.append(li);
        i++;
      }
      frag.append(ul);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flushPara();
      const ol = document.createElement('ol');
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const li = document.createElement('li');
        inlineText(li, lines[i].replace(/^\d+\.\s+/, ''));
        ol.append(li);
        i++;
      }
      frag.append(ol);
      continue;
    }

    // tom linje → afsnitsskille
    if (!line.trim()) { flushPara(); i++; continue; }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return frag;
}

module.exports = { render };
