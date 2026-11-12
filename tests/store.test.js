'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'near-agent-store-'));
  return { dir, store: createStore(dir) };
}

test('store creates data dir and files with defaults', () => {
  const { dir, store } = tempStore();
  assert.deepEqual(store.getSettings(), { perTxCap: 50, dailyCap: 200, asset: 'NEAR', allowlist: [] });
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  assert.ok(fs.existsSync(path.join(dir, 'history.json')));
  assert.ok(fs.existsSync(path.join(dir, 'pending.json')));
  assert.deepEqual(store.getHistory(), []);
  assert.equal(store.getTodayTotal(), 0);
});

test('store updateSettings merges and persists across instances', () => {
  const { dir, store } = tempStore();
  const updated = store.updateSettings({ perTxCap: 100, asset: 'USDC' });
  assert.equal(updated.perTxCap, 100);
  assert.equal(updated.asset, 'USDC');
  assert.equal(updated.dailyCap, 200);
  const reopened = createStore(dir);
  assert.equal(reopened.getSettings().perTxCap, 100);
  assert.equal(reopened.getSettings().asset, 'USDC');
});

test('store allowlist add/remove is case-insensitive and deduped', () => {
  const { store } = tempStore();
  assert.deepEqual(store.addAllowlist('Alice.near'), ['alice.near']);
  assert.deepEqual(store.addAllowlist('alice.near'), ['alice.near']);
  assert.deepEqual(store.getAllowlist(), ['alice.near']);
  assert.deepEqual(store.removeAllowlist('ALICE.near'), []);
  assert.deepEqual(store.getAllowlist(), []);
});

test('store history and getTodayTotal count only today COMPLETED transactions', () => {
  const { store } = tempStore();
  const today = new Date().toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  store.addTransaction({ amount: 5, asset: 'NEAR', status: 'COMPLETED', timestamp: today });
  store.addTransaction({ amount: 100, asset: 'NEAR', status: 'COMPLETED', timestamp: yesterday });
  store.addTransaction({ amount: 50, asset: 'NEAR', status: 'PENDING', timestamp: today });
  store.addTransaction({ amount: 7, asset: 'NEAR', status: 'AWAITING_DEPOSIT', timestamp: today });
  assert.equal(store.getTodayTotal(), 5);
  const history = store.getHistory();
  assert.equal(history.length, 4);
  assert.ok(history.every((tx) => typeof tx.id === 'string' && tx.id.length > 0));
});

test('store pending save/get/delete round-trips', () => {
  const { store } = tempStore();
  const saved = store.savePending({ intent: { amount: 10 }, guardrails: { allowed: true } });
  assert.ok(saved.id);
  assert.deepEqual(store.getPending(saved.id).intent, { amount: 10 });
  assert.equal(store.getPending('no-such-id'), null);
  assert.equal(store.deletePending(saved.id), true);
  assert.equal(store.getPending(saved.id), null);
});
