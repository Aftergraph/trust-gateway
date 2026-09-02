'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeDispatcher } = require('../src/gateway/dispatcher');

function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-dispatch-'));
  return dir;
}

// --- fs.read jail: path traversal blocked ---

test('fs.read: jail blocks ../ traversal relative path', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  await assert.rejects(
    () => dispatch('forge', 'fs.read:../../../../etc/passwd', null),
    /escapes_jail/
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('fs.read: jail blocks absolute path', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  await assert.rejects(
    () => dispatch('forge', 'fs.read:/etc/passwd', null),
    /escapes_jail/
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('fs.write: jail blocks ../ traversal', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  await assert.rejects(
    () => dispatch('forge', 'fs.write:../../escape.txt', { content: 'x' }),
    /escapes_jail/
  );
  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('fs.write: jail blocks absolute path', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  await assert.rejects(
    () => dispatch('forge', 'fs.write:/tmp/abs-out.txt', { content: 'x' }),
    /escapes_jail/
  );
  assert.equal(fs.existsSync('/tmp/abs-out.txt'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- fs.write / fs.read roundtrip inside jail ---

test('fs.write: then fs.read: roundtrips inside the bot jail', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  const w = await dispatch('forge', 'fs.write:notes/hello.md', { content: 'hello world' });
  assert.equal(w.wrote, 'notes/hello.md');
  assert.equal(w.bytes, Buffer.byteLength('hello world'));
  const r = await dispatch('forge', 'fs.read:notes/hello.md', null);
  assert.equal(r.path, 'notes/hello.md');
  assert.equal(r.content, 'hello world');
  // file physically lives under bots/forge/notes/hello.md
  assert.equal(
    fs.readFileSync(path.join(root, 'forge', 'notes', 'hello.md'), 'utf8'),
    'hello world'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('fs.read on missing file returns null content (not an escape)', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  const r = await dispatch('forge', 'fs.read:does/not/exist.md', null);
  assert.equal(r.content, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('bots are isolated: forge cannot see atlas files (namespaced roots)', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  await dispatch('forge', 'fs.write:secret.md', { content: 'forge only' });
  // atlas reads its own (empty) secret.md
  const r = await dispatch('atlas', 'fs.read:secret.md', null);
  assert.equal(r.content, null);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- write creates parent dirs lazily, per-bot ---

test('fs.write: creates nested parent dirs under the bot root', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  await dispatch('forge', 'fs.write:deep/nested/file.txt', { content: 'data' });
  assert.equal(fs.existsSync(path.join(root, 'forge', 'deep', 'nested', 'file.txt')), true);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- symlink escape attempt ---

test('fs.read: symlink pointing outside jail is rejected (escapes_jail)', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  // plant a legit file under the bot root we'll try to escape to read
  await dispatch('forge', 'fs.write:ok.txt', { content: 'inside' });
  // drop a symlink INSIDE the jail that points OUTSIDE to a temp file
  const outside = path.join(root, 'outside-target.txt');
  fs.writeFileSync(outside, 'SECRET OUTSIDE');
  const escapeLink = path.join(root, 'forge', 'escape-link');
  fs.symlinkSync(outside, escapeLink);
  await assert.rejects(
    () => dispatch('forge', 'fs.read:escape-link', null),
    /escapes_jail/
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('fs.write: symlink target outside jail is rejected', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  const outside = path.join(root, 'outside-write.txt');
  fs.writeFileSync(outside, 'preexisting');
  const escapeLink = path.join(root, 'forge', 'escape-write-link');
  fs.mkdirSync(path.join(root, 'forge'), { recursive: true });
  fs.symlinkSync(outside, escapeLink);
  // writing THROUGH the symlink should be blocked — the realpath leaves the jail
  await assert.rejects(
    () => dispatch('forge', 'fs.write:escape-write-link', { content: 'pwned' }),
    /escapes_jail/
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preexisting');
  fs.rmSync(root, { recursive: true, force: true });
});

// --- shell.run echo (default) mode ---

test('shell.run: default echo mode returns echoed:true and no execution', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  const r = await dispatch('forge', 'shell.run', { cmd: 'echo hi' });
  assert.deepEqual(r, { ran: 'echo hi', exitCode: 0, echoed: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('shell.run: echo mode ignores actual execution side effects', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  const r = await dispatch('forge', 'shell.run', { cmd: 'rm -rf /' });
  assert.equal(r.echoed, true);
  assert.equal(r.ran, 'rm -rf /');
  // nothing actually happened
  fs.rmSync(root, { recursive: true, force: true });
});

// --- shell.run exec mode (Linux only) ---

const isLinux = process.platform === 'linux';

test('shell.run: exec mode runs `echo hi` and returns stdout (Linux only)', { skip: !isLinux }, async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root, shellMode: 'exec' });
  const r = await dispatch('forge', 'shell.run', { cmd: 'echo hi' });
  assert.equal(r.echoed, false);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout.trim(), 'hi');
  fs.rmSync(root, { recursive: true, force: true });
});

// --- unknown tools ---

test('unknown tool returns {ok:true, done:true}', async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root });
  const r = await dispatch('forge', 'web.get:something', { url: 'x' });
  assert.deepEqual(r, { ok: true, done: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('shell.run: exec mode returns non-zero exitCode on bad command (Linux)', { skip: !isLinux }, async () => {
  const root = freshRoot();
  const dispatch = makeDispatcher({ botsDir: root, shellMode: 'exec' });
  const r = await dispatch('forge', 'shell.run', { cmd: 'exit 3' });
  assert.equal(r.exitCode, 3);
  fs.rmSync(root, { recursive: true, force: true });
});
