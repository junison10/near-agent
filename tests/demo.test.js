'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore } = require('../src/store');
const { createApp } = require('../src/server');
const { parseInstruction } = require('../src/parser');
const { evaluateGuardrails } = require('../src/guardrails');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'near-agent-demo-'));
}

/** Stub mock nearClient implementing the executor contract (no network). */
function stubMockNearClient() {
  return {
    mode: 'mock',
    async getQuote({ amount, asset, recipient }) {
      return {
        amountIn: Number(amount),
        amountOut: Number(amount),
        assetIn: asset,
        assetOut: asset,
        rate: 1,
        timeEstimateSec: 30,
        depositAddress: null,
        mode: 'mock',
      };
    },
    async executePayment({ amount, asset, recipient, memo, invoiceId }) {
      const hex = 'abcdef123456';
      const txHash = `MOCK-TX-${hex}`;
      return {
        status: 'COMPLETED',
        receiptId: `MOCK-NEAR-${hex}`,
        txHash,
        explorerUrl: `https://testnet.nearblocks.io/txns/${txHash}`,
        amount: Number(amount),
        asset,
        recipient,
        memo: memo || null,
        invoiceId: invoiceId || null,
        mode: 'mock',
        depositAddress: null,
        amountIn: null,
        amountOut: null,
        timeEstimateSec: null,
        timestamp: new Date().toISOString(),
      };
    },
  };
}

async function post(port, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, json: await res.json() };
}

function startServer() {
  const dir = tmpDir();
  const app = createApp({
    nearClient: stubMockNearClient(),
    store: createStore(dir),
    parseInstruction,
    evaluateGuardrails,
  });
  const server = app.listen(0);
  return { server, port: server.address().port };
}

test('full mock E2E: valid payment -> receipt', async (t) => {
  const { server, port } = startServer();
  t.after(() => server.close());

  const parsed = await post(port, '/api/parse', { text: 'bayar 10 NEAR ke alice.near buat invoice #123' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.json.guardrails.passed, true);
  assert.equal(parsed.json.intent.amount, 10);
  assert.equal(parsed.json.intent.asset, 'NEAR');
  assert.equal(parsed.json.intent.recipient, 'alice.near');

  const confirmed = await post(port, '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 200);
  const receipt = confirmed.json.receipt;
  assert.equal(receipt.status, 'COMPLETED');
  assert.match(receipt.receiptId, /^MOCK-NEAR-/);
  assert.match(receipt.txHash, /^MOCK-TX-/);
  assert.ok(receipt.explorerUrl.includes('testnet.nearblocks.io/txns/'));
  assert.equal(receipt.amount, 10);
  assert.equal(receipt.asset, 'NEAR');
  assert.equal(receipt.recipient, 'alice.near');
  assert.equal(receipt.invoiceId, '123');

  const history = await fetch(`http://127.0.0.1:${port}/api/history`).then((r) => r.json());
  assert.equal(history.transactions.length, 1);
  assert.equal(history.transactions[0].receiptId, receipt.receiptId);
});

test('over-cap payment is blocked at parse', async (t) => {
  const { server, port } = startServer();
  t.after(() => server.close());

  const parsed = await post(port, '/api/parse', { text: 'pay 9999 NEAR to alice.near' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.json.guardrails.passed, false);
  const failed = parsed.json.guardrails.checks.find((c) => c.rule === 'per_tx_cap');
  assert.ok(failed && failed.passed === false);

  const confirmed = await post(port, '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 400);
});

test('non-allowlist payment is blocked at parse', async (t) => {
  const { server, port } = startServer();
  t.after(() => server.close());

  const seed = await post(port, '/api/demo/seed');
  assert.equal(seed.status, 200);
  assert.ok(seed.json.settings.allowlist.includes('alice.near'));

  const parsed = await post(port, '/api/parse', { text: 'pay 5 NEAR to mallory.near' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.json.guardrails.passed, false);
  const failed = parsed.json.guardrails.checks.find((c) => c.rule === 'allowlist');
  assert.ok(failed && failed.passed === false);

  const confirmed = await post(port, '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 400);
});

test('demo seed populates settings, allowlist and history (mock mode)', async (t) => {
  const { server, port } = startServer();
  t.after(() => server.close());

  const seed = await post(port, '/api/demo/seed');
  assert.equal(seed.status, 200);
  assert.equal(seed.json.seeded, true);
  assert.equal(seed.json.settings.perTxCap, 50);
  assert.equal(seed.json.settings.dailyCap, 200);
  assert.equal(seed.json.settings.asset, 'NEAR');
  assert.ok(seed.json.settings.allowlist.includes('alice.near'));
  assert.ok(seed.json.settings.allowlist.includes('bob.testnet'));
  assert.equal(seed.json.transactions.length, 3);
  assert.equal(seed.json.transactions[0].status, 'COMPLETED');
  assert.match(seed.json.transactions[0].receiptId, /^MOCK-NEAR-/);

  // The seeded state actually gates payments: 100 NEAR is now over the 50 cap.
  const parsed = await post(port, '/api/parse', { text: 'bayar 100 NEAR ke alice.near buat invoice #124' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.json.guardrails.passed, false);

  const reset = await post(port, '/api/demo/reset');
  assert.equal(reset.status, 200);
  assert.equal(reset.json.reset, true);
  assert.equal(reset.json.settings.perTxCap, 50);
  assert.equal(reset.json.settings.asset, 'NEAR');
  assert.deepEqual(reset.json.transactions, []);
});
