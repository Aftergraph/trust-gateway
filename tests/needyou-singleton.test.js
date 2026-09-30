'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { getNeedsYouStore } = require('../src/gateway/needsyou');

test('NeedsYou singleton returns one writer per gateway instance', () => {
  const gw = {};
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-needyou-singleton-')), 'needyou.json');
  const a = getNeedsYouStore(gw, { file });
  const b = getNeedsYouStore(gw, { file: path.join(os.tmpdir(), 'ignored-other-path.json') });
  assert.equal(a, b);
  const item = a.create({ tenantId: 'main', type: 'approval', subject: 'one writer' });
  assert.equal(b.get(item.id).subject, 'one writer');
});
