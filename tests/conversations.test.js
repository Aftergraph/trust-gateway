'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Use a single test database file - set BEFORE importing anything that uses db
const uniqueId = `${process.pid}-${Date.now()}`;
process.env.TG_DB_FILE = path.join(os.tmpdir(), `test-gateway-${uniqueId}.db`);

// Clean up any existing test db
function cleanupDb() {
  const file = process.env.TG_DB_FILE;
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.existsSync(file + '-wal')) fs.unlinkSync(file + '-wal');
    if (fs.existsSync(file + '-shm')) fs.unlinkSync(file + '-shm');
  } catch {}
}

cleanupDb();

const { test, describe } = require('node:test');
const { ConversationStore } = require('../src/gateway/conversations');
const { db, resetDb } = require('../src/gateway/db');

// Init the db after importing
resetDb();

// Helper to clear all data (used between tests)
function clearData() {
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM conversations');
}

describe('ConversationStore', () => {
  // Cleanup after all tests
  test.after(() => {
    cleanupDb();
  });

  test('creates a conversation and returns correct shape', () => {
    const store = new ConversationStore('tenant-a');
    const conv = store.create('Test conversation');
    if (conv.id === undefined) throw new Error('id missing');
    if (conv.title !== 'Test conversation') throw new Error('title mismatch');
    if (typeof conv.created_at !== 'number') throw new Error('created_at missing');
    if (typeof conv.updated_at !== 'number') throw new Error('updated_at missing');
  });

  test('lists conversations for tenant', () => {
    clearData();
    const store = new ConversationStore('tenant-a');
    store.create('First');
    store.create('Second');
    const list = store.list();
    if (list.length !== 2) throw new Error(`expected 2 conversations, got ${list.length}`);
  });

  test('is tenant-scoped', () => {
    clearData();
    const storeA = new ConversationStore('tenant-a');
    const storeB = new ConversationStore('tenant-b');
    storeA.create('From A');
    const listA = storeA.list();
    const listB = storeB.list();
    if (listA.length !== 1) throw new Error(`storeA should have 1, got ${listA.length}`);
    if (listB.length !== 0) throw new Error(`storeB should have 0, got ${listB.length}`);
  });

  test('returns a conversation by id', () => {
    clearData();
    const store = new ConversationStore('tenant-a');
    const conv = store.create('Test');
    const found = store.get(conv.id);
    if (!found) throw new Error('conversation not found');
    if (found.title !== 'Test') throw new Error('title mismatch');
  });

  test('returns undefined for wrong tenant', () => {
    clearData();
    const storeA = new ConversationStore('tenant-a');
    const storeB = new ConversationStore('tenant-b');
    const conv = storeA.create('Test');
    const found = storeB.get(conv.id);
    if (found !== undefined) throw new Error('should be undefined');
  });

  test('appends and retrieves messages', () => {
    clearData();
    const store = new ConversationStore('tenant-a');
    const conv = store.create('Test');
    store.appendMessage(conv.id, 'user', 'Hello');
    store.appendMessage(conv.id, 'assistant', 'Hi there');
    const messages = store.getMessages(conv.id);
    if (messages.length !== 2) throw new Error(`expected 2 messages, got ${messages.length}`);
    if (messages[0].role !== 'user') throw new Error('first should be user');
    if (messages[1].role !== 'assistant') throw new Error('second should be assistant');
  });

  test('filters messages by since timestamp', () => {
    clearData();
    const store = new ConversationStore('tenant-a');
    const conv = store.create('Test');
    const msg1 = store.appendMessage(conv.id, 'user', 'Hello');
    const start = Date.now();
    while (Date.now() - start < 10) {}
    store.appendMessage(conv.id, 'assistant', 'Hi');
    const messages = store.getMessages(conv.id, msg1.ts);
    if (messages.length !== 1) throw new Error(`expected 1 message after since, got ${messages.length}`);
    if (messages[0].role !== 'assistant') throw new Error('should be assistant');
  });

  test('returns full history on load', () => {
    clearData();
    const store = new ConversationStore('tenant-a');
    const conv = store.create('Test');
    store.appendMessage(conv.id, 'user', 'Hello');
    const replay = store.replay(conv.id);
    if (!replay) throw new Error('replay returned null');
    if (replay.title !== 'Test') throw new Error('title mismatch');
    if (replay.messages.length !== 1) throw new Error(`expected 1 message in replay, got ${replay.messages.length}`);
  });

  test('persists data across db restart', () => {
    clearData();
    const store = new ConversationStore('tenant-a');
    const conv = store.create('Persistent');
    store.appendMessage(conv.id, 'user', 'Hello');
    resetDb();
    const store2 = new ConversationStore('tenant-a');
    const replay = store2.replay(conv.id);
    if (!replay) throw new Error('conversation lost after restart');
    if (replay.messages.length !== 1) throw new Error(`message lost after restart, got ${replay.messages.length} messages`);
  });

  test('deletes conversation and messages', () => {
    clearData();
    const store = new ConversationStore('tenant-a');
    const conv = store.create('Test');
    store.appendMessage(conv.id, 'user', 'Hello');
    store.delete(conv.id);
    const found = store.get(conv.id);
    if (found !== undefined) throw new Error('conversation should be deleted');
    const msgs = store.getMessages(conv.id);
    if (msgs.length !== 0) throw new Error(`messages should be deleted, got ${msgs.length}`);
  });
});
