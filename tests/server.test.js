'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { createStore } = require('../src/store');
const { parseInstruction } = require('../src/parser');
const { evaluateGuardrails } = require('../src/guardrails');

/** Stub nearClient implementing the executor contract (no network). */
function stubNearClient(mode = 'mock', executeImpl) {
  return {
    mode,
    async getQuote({ amount, asset, recipient }) {
      return {
        amountIn: Number(amount),
        amountOut: Number(amount),
        assetIn: asset,
        assetOut: asset,
        rate: 1,
        timeEstimateSec: 30,
        depositAddress: null,
        mode,
      };
    },
    async executePayment({ amount, asset, recipient, memo, invoiceId }) {
      if (executeImpl) return executeImpl({ amount, asset, recipient, memo, invoiceId });
      return {
        status: 'COMPLETED',
        receiptId: 'MOCK-NEAR-abcdef123456',
        txHash: 'MOCK-TX-abcdef123456',
        explorerUrl: 'https://testnet.nearblocks.io/txns/MOCK-TX-abcdef123456',
        amount: Number(amount),
        asset,
        recipient,
        memo: memo || null,
        invoiceId: invoiceId || null,
        mode,
        depositAddress: null,
        amountIn: null,
        amountOut: null,
        timeEstimateSec: null,
        timestamp: new Date().toISOString(),
      };
    },
  };
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'near-agent-server-'));
  return createStore(dir);
}

async function startApp(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function setup(nearClient) {
  const store = tempStore();
  const app = createApp({
    nearClient: nearClient || stubNearClient('mock'),
    store,
    parseInstruction,
    evaluateGuardrails,
  });
  const srv = await startApp(app);
  return { store, ...srv };
}

async function req(base, method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body (e.g. static 404); leave json null
  }
  return { status: res.status, json, text };
}

test('health reports ok with the nearClient mode', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const { status, json } = await req(base, 'GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.mode, 'mock');
});

test('health reports oneclick mode when the client is oneclick', async (t) => {
  const { base, close } = await setup(stubNearClient('oneclick'));
  t.after(close);
  const { status, json } = await req(base, 'GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.mode, 'oneclick');
});

test('full flow: parse -> confirm -> receipt in history', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const parsed = await req(base, 'POST', '/api/parse', { text: 'pay 5 NEAR to alice.near' });
  assert.equal(parsed.status, 200, JSON.stringify(parsed.json));
  assert.ok(parsed.json.pendingId);
  assert.equal(parsed.json.requiresConfirmation, true);
  assert.equal(Number(parsed.json.intent.amount), 5);
  assert.equal(parsed.json.intent.asset, 'NEAR');
  assert.equal(parsed.json.intent.recipient, 'alice.near');

  const confirmed = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  const receipt = confirmed.json.receipt;
  assert.match(receipt.receiptId, /^MOCK-NEAR-/);
  assert.match(receipt.txHash, /^MOCK-TX-/);
  assert.equal(receipt.status, 'COMPLETED');
  assert.equal(receipt.amount, 5);
  assert.equal(receipt.asset, 'NEAR');
  assert.equal(receipt.recipient, 'alice.near');

  const history = await req(base, 'GET', '/api/history');
  assert.equal(history.json.transactions.length, 1);
  assert.equal(history.json.transactions[0].receiptId, receipt.receiptId);

  // Pending is consumed: confirming again is a 404.
  const again = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(again.status, 404);
});

test('confirm with unknown pendingId returns 404', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const res = await req(base, 'POST', '/api/confirm', { pendingId: 'no-such-id', confirmed: true });
  assert.equal(res.status, 404);
  assert.ok(res.json.error);
});

test('confirm cancelled deletes the pending record and pays nothing', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const parsed = await req(base, 'POST', '/api/parse', { text: 'pay 5 NEAR to alice.near' });
  assert.equal(parsed.status, 200);
  const cancelled = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: false });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.cancelled, true);
  const history = await req(base, 'GET', '/api/history');
  assert.deepEqual(history.json.transactions, []);
  const again = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(again.status, 404);
});

test('over-cap payment is blocked at parse and rejected at confirm (400)', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  // Default perTxCap is 50, so 9999 NEAR must be blocked.
  const parsed = await req(base, 'POST', '/api/parse', { text: 'pay 9999 NEAR to alice.near' });
  assert.equal(parsed.status, 200, JSON.stringify(parsed.json));
  assert.equal(parsed.json.guardrails.passed, false);
  const confirmed = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 400, JSON.stringify(confirmed.json));
  assert.ok(confirmed.json.error);
  assert.ok(confirmed.json.guardrails);
  const history = await req(base, 'GET', '/api/history');
  assert.deepEqual(history.json.transactions, []);
});

test('non-allowlisted recipient is blocked', async (t) => {
  const { base, close, store } = await setup();
  t.after(close);
  store.addAllowlist('bob.testnet');
  const parsed = await req(base, 'POST', '/api/parse', { text: 'pay 5 NEAR to alice.near' });
  assert.equal(parsed.status, 200, JSON.stringify(parsed.json));
  assert.equal(parsed.json.guardrails.passed, false);
  const confirmed = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 400, JSON.stringify(confirmed.json));
  const history = await req(base, 'GET', '/api/history');
  assert.deepEqual(history.json.transactions, []);
});

test('AWAITING_DEPOSIT receipt is stored in history and pending is consumed', async (t) => {
  const depositClient = stubNearClient('oneclick', ({ amount, asset, recipient, memo, invoiceId }) => ({
    status: 'AWAITING_DEPOSIT',
    receiptId: 'MOCK-NEAR-deposit12345',
    txHash: null,
    explorerUrl: null,
    amount: Number(amount),
    asset,
    recipient,
    memo: memo || null,
    invoiceId: invoiceId || null,
    mode: 'oneclick',
    depositAddress: 'alice.near',
    amountIn: Number(amount),
    amountOut: Number(amount),
    timeEstimateSec: 120,
    timestamp: new Date().toISOString(),
  }));
  const { base, close } = await setup(depositClient);
  t.after(close);
  const parsed = await req(base, 'POST', '/api/parse', { text: 'pay 5 NEAR to alice.near' });
  assert.equal(parsed.status, 200);
  const confirmed = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  assert.equal(confirmed.json.receipt.status, 'AWAITING_DEPOSIT');
  assert.equal(confirmed.json.receipt.depositAddress, 'alice.near');
  const history = await req(base, 'GET', '/api/history');
  assert.equal(history.json.transactions.length, 1);
  assert.equal(history.json.transactions[0].status, 'AWAITING_DEPOSIT');
  assert.equal(history.json.transactions[0].receiptId, 'MOCK-NEAR-deposit12345');
  // AWAITING_DEPOSIT does not count toward today's COMPLETED total.
  const again = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(again.status, 404);
});

test('executor error returns 500 and keeps the pending record (retryable)', async (t) => {
  const failingClient = stubNearClient('mock', () => { throw new Error('intents API down'); });
  const { base, close } = await setup(failingClient);
  t.after(close);
  const parsed = await req(base, 'POST', '/api/parse', { text: 'pay 5 NEAR to alice.near' });
  assert.equal(parsed.status, 200);
  const confirmed = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 500, JSON.stringify(confirmed.json));
  assert.ok(confirmed.json.error);
  const history = await req(base, 'GET', '/api/history');
  assert.deepEqual(history.json.transactions, []);
  // Pending is still there: cancelling it now works.
  const cancelled = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: false });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.cancelled, true);
});

test('settings get/put validates caps and asset; allowlist add/remove validates NEAR accounts', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const initial = await req(base, 'GET', '/api/settings');
  assert.equal(initial.json.perTxCap, 50);
  assert.equal(initial.json.asset, 'NEAR');

  const bad = await req(base, 'PUT', '/api/settings', { perTxCap: 0 });
  assert.equal(bad.status, 400);
  const bad2 = await req(base, 'PUT', '/api/settings', { dailyCap: -5 });
  assert.equal(bad2.status, 400);
  const bad3 = await req(base, 'PUT', '/api/settings', { asset: 'BTC' });
  assert.equal(bad3.status, 400);

  const updated = await req(base, 'PUT', '/api/settings', { perTxCap: 100, asset: 'USDC' });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.perTxCap, 100);
  assert.equal(updated.json.asset, 'USDC');

  const badAccount = await req(base, 'POST', '/api/allowlist', { account: 'not-an-account' });
  assert.equal(badAccount.status, 400);
  const badEmail = await req(base, 'POST', '/api/allowlist', { account: 'alice@example.com' });
  assert.equal(badEmail.status, 400);
  const added = await req(base, 'POST', '/api/allowlist', { account: 'Alice.near' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.json.allowlist, ['alice.near']);
  const removed = await req(base, 'DELETE', '/api/allowlist', { account: 'alice.near' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.allowlist, []);
});

test('parse without text returns 400', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const res = await req(base, 'POST', '/api/parse', {});
  assert.equal(res.status, 400);
});

test('quote passthrough and 400 on bad input', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const ok = await req(base, 'GET', '/api/quote?amount=5&asset=NEAR&recipient=alice.near');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.amountIn, 5);
  assert.equal(ok.json.assetOut, 'NEAR');
  assert.equal(ok.json.mode, 'mock');

  const badAmount = await req(base, 'GET', '/api/quote?amount=0&asset=NEAR&recipient=alice.near');
  assert.equal(badAmount.status, 400);
  const badAsset = await req(base, 'GET', '/api/quote?amount=5&asset=BTC&recipient=alice.near');
  assert.equal(badAsset.status, 400);
  const badRecipient = await req(base, 'GET', '/api/quote?amount=5&asset=NEAR&recipient=alice@example.com');
  assert.equal(badRecipient.status, 400);
  const missing = await req(base, 'GET', '/api/quote?asset=NEAR&recipient=alice.near');
  assert.equal(missing.status, 400);
});

test('demo seed/reset are forbidden outside mock mode', async (t) => {
  const { base, close } = await setup(stubNearClient('oneclick'));
  t.after(close);
  const seed = await req(base, 'POST', '/api/demo/seed', {});
  assert.equal(seed.status, 403);
  const reset = await req(base, 'POST', '/api/demo/reset', {});
  assert.equal(reset.status, 403);
});
