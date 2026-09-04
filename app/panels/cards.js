'use strict';
// Panel: Adaptive Cards (wave B) — declarative card renderer.
//
// Contract (see docs/v2/PLATFORM-ABI.md):
//   register (window.TG_PANELS = window.TG_PANELS || []).push({id,title,render});
//   render(container, TG?) — TG defaults to window.TG ({api,el,token,authed,refresh,onAudit}).
//   XSS policy: every server/bot-derived string goes into textContent ONLY.
//   No innerHTML anywhere in this file.

const CARD_TYPES = ['card', 'table', 'form', 'chart', 'timeline', 'approval', 'progress', 'artifact'];

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Schema validation (duplicate here for client-side validation)
function validateCardDocument(doc) {
  const errors = [];

  if (!doc || typeof doc !== 'object') {
    errors.push('document must be an object');
    return { ok: false, errors };
  }

  if (typeof doc.type !== 'string' || !CARD_TYPES.includes(doc.type)) {
    errors.push('invalid type: ' + String(doc.type));
  }

  if (typeof doc.title !== 'string' || doc.title.length === 0) {
    errors.push('title must be a non-empty string');
  }

  if (doc.type === 'card') {
    if (typeof doc.content !== 'string') errors.push('card.content must be a string');
  } else if (doc.type === 'table') {
    if (!Array.isArray(doc.columns)) errors.push('table.columns must be an array');
    if (!Array.isArray(doc.rows)) errors.push('table.rows must be an array');
    if (!Array.isArray(doc.rows)) {
      doc.rows.forEach((row, i) => {
        if (!Array.isArray(row)) errors.push('table.rows[' + i + '] must be an array');
      });
    }
  } else if (doc.type === 'form') {
    if (!Array.isArray(doc.fields)) errors.push('form.fields must be an array');
    if (!Array.isArray(doc.fields)) {
      doc.fields.forEach((field, i) => {
        if (typeof field.name !== 'string') errors.push('form.fields[' + i + '].name must be a string');
        if (typeof field.label !== 'string') errors.push('form.fields[' + i + '].label must be a string');
        if (!['text', 'number', 'email', 'password', 'select', 'textarea'].includes(field.type)) {
          errors.push('form.fields[' + i + '].type must be a valid form field type');
        }
      });
    }
  } else if (doc.type === 'chart') {
    if (!Array.isArray(doc.series)) errors.push('chart.series must be an array');
    if (!Array.isArray(doc.series)) {
      doc.series.forEach((s, i) => {
        if (typeof s.label !== 'string') errors.push('chart.series[' + i + '].label must be a string');
        if (typeof s.value !== 'number') errors.push('chart.series[' + i + '].value must be a number');
      });
    }
  } else if (doc.type === 'timeline') {
    if (!Array.isArray(doc.events)) errors.push('timeline.events must be an array');
    if (!Array.isArray(doc.events)) {
      doc.events.forEach((e, i) => {
        if (typeof e.date !== 'string') errors.push('timeline.events[' + i + '].date must be a string');
        if (typeof e.title !== 'string') errors.push('timeline.events[' + i + '].title must be a string');
      });
    }
  } else if (doc.type === 'approval') {
    if (typeof doc.status !== 'string') errors.push('approval.status must be a string');
    if (!['pending', 'approved', 'denied'].includes(doc.status)) {
      errors.push('approval.status must be pending, approved, or denied');
    }
    if (typeof doc.reason !== 'string') errors.push('approval.reason must be a string');
  } else if (doc.type === 'progress') {
    if (typeof doc.percentage !== 'number') errors.push('progress.percentage must be a number');
    if (doc.percentage < 0 || doc.percentage > 100) {
      errors.push('progress.percentage must be between 0 and 100');
    }
    if (typeof doc.label !== 'string') errors.push('progress.label must be a string');
  } else if (doc.type === 'artifact') {
    if (typeof doc.kind !== 'string') errors.push('artifact.kind must be a string');
    if (typeof doc.title !== 'string') errors.push('artifact.title must be a string');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true };
}

// Rendering (textContent-only XSS policy)
function renderCardDocument(doc) {
  const root = el('div', 'tg-card-root');

  const header = el('div', 'tg-card-header');
  header.appendChild(el('h3', 'tg-card-title', doc.title));
  root.appendChild(header);

  const body = el('div', 'tg-card-body');

  if (doc.type === 'card') {
    body.appendChild(el('p', 'tg-card-content', doc.content));
  } else if (doc.type === 'table') {
    const table = el('table', 'tg-card-table');
    const thead = el('thead', '');
    const trHead = el('tr', '');
    (doc.columns || []).forEach((col) => {
      trHead.appendChild(el('th', '', col));
    });
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = el('tbody', '');
    (doc.rows || []).forEach((row) => {
      const tr = el('tr', '');
      (row || []).forEach((cell) => {
        tr.appendChild(el('td', '', String(cell)));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  } else if (doc.type === 'form') {
    const form = el('form', 'tg-card-form');
    (doc.fields || []).forEach((field) => {
      const label = el('label', 'tg-form-label', field.label + ': ');
      let input;
      if (field.type === 'textarea') {
        input = el('textarea', 'tg-form-input');
      } else {
        input = el('input', 'tg-form-input');
        input.type = field.type || 'text';
      }
      input.name = field.name;
      label.appendChild(input);
      form.appendChild(label);
      form.appendChild(el('br', ''));
    });
    const submit = el('button', 'tg-form-submit', 'Submit');
    form.appendChild(submit);
    body.appendChild(form);
  } else if (doc.type === 'chart') {
    const chart = el('div', 'tg-card-chart');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '300');
    svg.setAttribute('height', '200');
    svg.setAttribute('viewBox', '0 0 300 200');

    const maxY = Math.max(1, ...(doc.series || []).map((s) => s.value || 0));
    const barWidth = Math.max(20, (280 / Math.max(1, (doc.series || []).length)) - 10);
    const gap = 10;
    let x = 20;

    (doc.series || []).forEach((s, i) => {
      const barHeight = ((s.value || 0) / maxY) * 150;
      const y = 180 - barHeight;

      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bar.setAttribute('x', String(x));
      bar.setAttribute('y', String(y));
      bar.setAttribute('width', String(barWidth));
      bar.setAttribute('height', String(barHeight));
      bar.setAttribute('fill', 'hsl(' + ((i * 360) / Math.max(1, (doc.series || []).length)) + ', 70%, 50%)');
      svg.appendChild(bar);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(x + barWidth / 2));
      text.setAttribute('y', '195');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '10');
      text.setAttribute('fill', '#c9d1d9');
      text.textContent = String(s.label || '');
      svg.appendChild(text);

      x += barWidth + gap;
    });

    chart.appendChild(svg);
    body.appendChild(chart);
  } else if (doc.type === 'timeline') {
    const timeline = el('div', 'tg-card-timeline');
    (doc.events || []).forEach((e) => {
      const eventRow = el('div', 'tg-timeline-event');
      const date = el('span', 'tg-timeline-date', e.date);
      const title = el('span', 'tg-timeline-title', e.title);
      eventRow.appendChild(date);
      eventRow.appendChild(el('span', 'tg-timeline-sep', ' — '));
      eventRow.appendChild(title);
      timeline.appendChild(eventRow);
    });
    body.appendChild(timeline);
  } else if (doc.type === 'approval') {
    const approval = el('div', 'tg-card-approval');
    const statusBadge = el('span', 'tg-approval-status tg-approval-' + doc.status, doc.status);
    const reason = el('p', 'tg-approval-reason', 'Reason: ' + doc.reason);
    approval.appendChild(statusBadge);
    approval.appendChild(reason);
    body.appendChild(approval);
  } else if (doc.type === 'progress') {
    const progress = el('div', 'tg-card-progress');
    const bar = el('div', 'tg-progress-bar');
    const fill = el('div', 'tg-progress-fill');
    fill.style.width = doc.percentage + '%';
    bar.appendChild(fill);
    progress.appendChild(bar);
    progress.appendChild(el('span', 'tg-progress-label', doc.label + ' — ' + doc.percentage + '%'));
    body.appendChild(progress);
  } else if (doc.type === 'artifact') {
    const artifact = el('div', 'tg-card-artifact');
    artifact.appendChild(el('span', 'tg-artifact-kind', doc.kind));
    artifact.appendChild(el('span', 'tg-artifact-sep', ' · '));
    artifact.appendChild(el('span', 'tg-artifact-title', doc.title));
    body.appendChild(artifact);
  }

  root.appendChild(body);
  return root;
}

(function () {
  function render(container, TG) {
    const tg = TG || (typeof window !== 'undefined' ? window.TG : null);
    if (!tg || typeof tg.api !== 'function') return null;

    const root = el('div', 'tg-cards-panel');

    const selector = el('select', 'tg-cards-selector');
    CARD_TYPES.forEach((t) => {
      const opt = el('option', null, t);
      opt.value = t;
      selector.appendChild(opt);
    });

    const pasteArea = el('textarea', 'tg-cards-paste');
    pasteArea.placeholder = 'Paste card JSON here…';

    const validateBtn = el('button', 'tg-cards-btn', 'Validate & Render');
    const output = el('div', 'tg-cards-output');
    const error = el('div', 'tg-cards-error');

    root.appendChild(selector);
    root.appendChild(pasteArea);
    root.appendChild(validateBtn);
    root.appendChild(output);
    root.appendChild(error);

    validateBtn.addEventListener('click', async () => {
      error.textContent = '';
      output.textContent = '';

      let doc;
      try {
        doc = JSON.parse(pasteArea.value);
      } catch {
        error.textContent = 'Invalid JSON';
        return;
      }

      const localValidate = validateCardDocument(doc);
      if (!localValidate.ok) {
        error.textContent = 'Validation failed: ' + localValidate.errors.join('; ');
        return;
      }

      const resp = await tg.api('/v2/cards/validate', {
        method: 'POST',
        body: JSON.stringify(doc)
      });

      if (!resp.ok) {
        error.textContent = 'Server validation failed: ' + (resp.errors ? resp.errors.join('; ') : 'unknown');
        return;
      }

      const node = renderCardDocument(doc);
      output.appendChild(node);
    });

    selector.addEventListener('change', () => {
      const examples = {
        card: { type: 'card', title: 'Welcome', content: 'Hello, this is a card.' },
        table: { type: 'table', title: 'Data', columns: ['Name', 'Value'], rows: [['A', 1], ['B', 2]] },
        form: { type: 'form', title: 'Contact', fields: [{ name: 'name', label: 'Name', type: 'text' }, { name: 'email', label: 'Email', type: 'email' }] },
        chart: { type: 'chart', title: 'Sales', series: [{ label: 'Q1', value: 30 }, { label: 'Q2', value: 50 }, { label: 'Q3', value: 40 }] },
        timeline: { type: 'timeline', title: 'Roadmap', events: [{ date: '2026-09-01', title: 'Launch v1' }, { date: '2026-10-01', title: 'Release v2' }] },
        approval: { type: 'approval', title: 'Approval Status', status: 'pending', reason: 'Awaiting review' },
        progress: { type: 'progress', title: 'Deployment', label: 'Deployed', percentage: 75 },
        artifact: { type: 'artifact', title: 'Artifact Reference', kind: 'report', title: 'Q3 Report' }
      };
      pasteArea.value = JSON.stringify(examples[selector.value] || {}, null, 2);
      output.textContent = '';
      error.textContent = '';
    });

    if (container && typeof container.appendChild === 'function') {
      container.appendChild(root);
    }
    return root;
  }

  (window.TG_PANELS = window.TG_PANELS || []).push({
    id: 'cards',
    title: 'Adaptive Cards',
    render
  });
})();
