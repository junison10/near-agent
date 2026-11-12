'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateGuardrails } = require('../src/guardrails');

const SETTINGS = { perTxCap: 50, dailyCap: 200, asset: 'NEAR', allowlist: [] };

function resultFor(intent, settings = SETTINGS, todaysTotal = 0) {
  return evaluateGuardrails(intent, settings, todaysTotal);
}

function check(result, rule) {
  const found = result.checks.find((c) => c.rule === rule);
  assert.ok(found, `missing check ${rule}`);
  return found;
}

test('happy path passes, checks in order', () => {
  const r = resultFor({ amount: 10, asset: 'NEAR', recipient: 'alice.near' });
  assert.strictEqual(r.passed, true);
  assert.deepStrictEqual(
    r.checks.map((c) => c.rule),
    ['amount_present', 'recipient_present', 'amount_positive', 'per_tx_cap', 'daily_cap', 'allowlist'],
  );
  for (const c of r.checks) {
    assert.strictEqual(c.passed, true, c.rule);
    assert.strictEqual(typeof c.detail, 'string');
    assert.ok(c.detail.length > 0, c.rule);
  }
});

test('over perTxCap fails', () => {
  const r = resultFor({ amount: 51, recipient: 'alice.near' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'per_tx_cap').passed, false);
  assert.strictEqual(check(r, 'amount_present').passed, true);
});

test('exactly at perTxCap passes', () => {
  const r = resultFor({ amount: 50, recipient: 'alice.near' });
  assert.strictEqual(r.passed, true);
});

test('daily cap exceeded fails (todaysTotal near cap)', () => {
  const r = resultFor({ amount: 10, recipient: 'alice.near' }, SETTINGS, 195);
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'daily_cap').passed, false);
  assert.strictEqual(check(r, 'per_tx_cap').passed, true);
});

test('daily cap exactly reached passes', () => {
  const r = resultFor({ amount: 10, recipient: 'alice.near' }, SETTINGS, 190);
  assert.strictEqual(r.passed, true);
});

test('recipient not in non-empty allowlist fails', () => {
  const settings = { ...SETTINGS, allowlist: ['alice.near', 'bob.testnet'] };
  const r = resultFor({ amount: 10, recipient: 'mallory.near' }, settings);
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'allowlist').passed, false);
});

test('empty allowlist passes (any recipient allowed)', () => {
  const r = resultFor({ amount: 10, recipient: 'anyone.near' }, SETTINGS);
  assert.strictEqual(r.passed, true);
  assert.strictEqual(check(r, 'allowlist').passed, true);
  assert.strictEqual(check(r, 'allowlist').detail, 'allowlist empty — any recipient allowed');
});

test('case-insensitive allowlist match passes', () => {
  const settings = { ...SETTINGS, allowlist: ['Alice.near'] };
  const r = resultFor({ amount: 10, recipient: 'alice.near' }, settings);
  assert.strictEqual(r.passed, true);
  assert.strictEqual(check(r, 'allowlist').passed, true);

  const r2 = resultFor({ amount: 10, recipient: 'ALICE.NEAR' }, settings);
  assert.strictEqual(r2.passed, true);
});

test('missing amount fails', () => {
  const r = resultFor({ amount: null, recipient: 'alice.near' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'amount_present').passed, false);
  assert.strictEqual(check(r, 'amount_positive').passed, false);

  const r2 = resultFor({ recipient: 'alice.near' });
  assert.strictEqual(r2.passed, false);
});

test('missing recipient fails', () => {
  const r = resultFor({ amount: 10, recipient: null });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'recipient_present').passed, false);
});

test('amount 0 fails', () => {
  const r = resultFor({ amount: 0, recipient: 'alice.near' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'amount_positive').passed, false);
  assert.strictEqual(check(r, 'amount_present').passed, false);
});

test('negative amount fails', () => {
  const r = resultFor({ amount: -5, recipient: 'alice.near' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'amount_positive').passed, false);
});

test('check details name the payment asset', () => {
  const r = resultFor(
    { amount: 10, asset: 'USDC', recipient: 'alice.near' },
    { perTxCap: 50, dailyCap: 200, asset: 'USDC', allowlist: [] },
  );
  assert.strictEqual(r.passed, true);
  assert.ok(check(r, 'per_tx_cap').detail.includes('USDC'));
});

test('check details use the payment asset even when the settings default differs', () => {
  // Regression: a 5 USDC payment was labelled "5 NEAR" because the label
  // came from the settings default instead of the payment itself.
  const r = resultFor(
    { amount: 5, asset: 'USDC', recipient: 'alice.near' },
    { perTxCap: 50, dailyCap: 200, asset: 'NEAR', allowlist: [] },
  );
  assert.strictEqual(r.passed, true);
  assert.ok(check(r, 'amount_present').detail.includes('5 USDC'));
  assert.ok(check(r, 'per_tx_cap').detail.includes('cap of 50 USDC'));
  assert.ok(check(r, 'daily_cap').detail.includes('cap of 200 USDC'));
  assert.ok(!check(r, 'amount_present').detail.includes('NEAR'));
  assert.ok(!check(r, 'per_tx_cap').detail.includes('NEAR'));
});
