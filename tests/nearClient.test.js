'use strict';

/**
 * Tests for src/nearClient.js — NO real network, NO real funds.
 * 1Click is tested with a fake fetchImpl; testnet is tested with a stubbed
 * near-api-js module injected via opts.nearApi.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createNearClient,
  MockNearClient,
  OneClickClient,
  TestnetClient,
  ONECLICK_BASE_URL,
} = require('../src/nearClient');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake fetch that records calls and delegates to a handler. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  };
}

/** Fake 1Click token list: wNEAR + USDC on near, USDC/USDT on eth. */
const FAKE_TOKENS = [
  { assetId: 'nep141:wrap.near', blockchain: 'near', symbol: 'wNEAR', decimals: 24, price: 3.55 },
  {
    assetId: 'nep141:fake-usdc-near',
    blockchain: 'near',
    symbol: 'USDC',
    decimals: 6,
    price: 1,
  },
  {
    assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
    blockchain: 'eth',
    symbol: 'USDC',
    decimals: 6,
    price: 1,
  },
  {
    assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near',
    blockchain: 'eth',
    symbol: 'USDT',
    decimals: 6,
    price: 1,
  },
];

function fakeQuote({ depositAddress } = {}) {
  const quote = {
    amountIn: '1000000000000000000000000',
    amountInFormatted: '1',
    amountInUsd: '3.55',
    minAmountIn: '995000000000000000000000',
    amountOut: '1000000000000000000000000',
    amountOutFormatted: '1',
    amountOutUsd: '3.55',
    minAmountOut: '990000000000000000000000',
    timeEstimate: 120,
    deadline: '2026-11-12T12:00:00.000Z',
  };
  if (depositAddress) quote.depositAddress = depositAddress;
  return { correlationId: '550e8400-e29b-41d4-a716-446655440000', timestamp: '2026-11-12T10:00:00.000Z', signature: 'sig', quote };
}

/** Fake fetch that emulates the 1Click API for NEAR -> NEAR quotes. */
function oneClickFakeFetch({ quoteDepositAddress } = {}) {
  return fakeFetch((url, init) => {
    if (url === `${ONECLICK_BASE_URL}/v0/tokens` && init.method === 'GET') {
      return jsonResponse(FAKE_TOKENS);
    }
    if (url === `${ONECLICK_BASE_URL}/v0/quote` && init.method === 'POST') {
      const body = JSON.parse(init.body);
      const dry = body.dry === true;
      return jsonResponse(fakeQuote({ depositAddress: dry ? undefined : quoteDepositAddress || 'alice.near' }));
    }
    if (url.startsWith(`${ONECLICK_BASE_URL}/v0/status`) && init.method === 'GET') {
      const u = new URL(url);
      return jsonResponse({
        status: 'PENDING_DEPOSIT',
        updatedAt: '2026-11-12T10:05:00.000Z',
        swapDetails: {},
        depositAddressFromQuery: u.searchParams.get('depositAddress'),
      });
    }
    return jsonResponse({ error: 'not found' }, { ok: false, status: 404 });
  });
}

/** Stub near-api-js module (v7 API shape) for TestnetClient tests. */
function stubNearApi({ txHash = 'STUBTXHASH1234567890abcdef', hashField = 'transaction' } = {}) {
  const calls = { parseNearAmount: [], providerUrls: [], accountArgs: [], transfers: [] };
  class JsonRpcProvider {
    constructor({ url }) {
      calls.providerUrls.push(url);
      this.url = url;
    }
  }
  class Account {
    constructor(accountId, provider, privateKey) {
      calls.accountArgs.push({ accountId, provider, privateKey });
      this.accountId = accountId;
    }

    async transfer({ receiverId, amount }) {
      calls.transfers.push({ receiverId, amount });
      if (hashField === 'transaction') {
        return { transaction: { hash: txHash }, transaction_outcome: { id: txHash } };
      }
      // Hash only discoverable via transaction_outcome.id.
      return { transaction: {}, transaction_outcome: { id: txHash } };
    }
  }
  function parseNearAmount(s) {
    calls.parseNearAmount.push(s);
    // 1 NEAR = 10^24 yocto; test amounts are small decimals, use BigInt math.
    const [i, f = ''] = String(s).split('.');
    return (BigInt(i || '0') * 10n ** 24n + BigInt((f + '0'.repeat(24)).slice(0, 24) || '0')).toString();
  }
  return { stub: { JsonRpcProvider, Account, parseNearAmount }, calls };
}

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

test('mock: getQuote returns a 1:1 quote for the same asset', async () => {
  const client = new MockNearClient();
  assert.equal(client.mode, 'mock');
  const q = await client.getQuote({ amount: 2.5, asset: 'NEAR', recipient: 'bob.near' });
  assert.equal(q.mode, 'mock');
  assert.equal(q.amountIn, '2.5');
  assert.equal(q.amountOut, '2.5');
  assert.equal(q.assetIn, 'NEAR');
  assert.equal(q.assetOut, 'NEAR');
  assert.equal(q.rate, 1);
  assert.equal(q.timeEstimateSec, 30);
  assert.equal(q.depositAddress, null);
});

test('mock: getQuote applies the cross-asset rate table when assetOut is given', async () => {
  const client = new MockNearClient();
  const q = await client.getQuote({ amount: 2, asset: 'NEAR', assetOut: 'USDC', recipient: 'bob.near' });
  assert.equal(q.rate, 2.5);
  assert.equal(q.amountOut, '5');
  const back = await client.getQuote({ amount: 5, asset: 'USDC', assetOut: 'NEAR', recipient: 'bob.near' });
  assert.equal(back.rate, 0.4);
  assert.equal(back.amountOut, '2');
});

test('mock: executePayment returns COMPLETED with MOCK- ids and explorer URL', async () => {
  const client = new MockNearClient();
  const r = await client.executePayment({
    amount: 1.5,
    asset: 'NEAR',
    recipient: 'bob.near',
    memo: 'invoice 7',
    invoiceId: 'INV-7',
  });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.mode, 'mock');
  assert.match(r.receiptId, /^MOCK-NEAR-[0-9A-F]{12}$/);
  assert.match(r.txHash, /^MOCK-TX-[0-9A-F]{12}$/);
  assert.equal(r.explorerUrl, `https://testnet.nearblocks.io/txns/${r.txHash}`);
  assert.equal(r.amount, 1.5);
  assert.equal(r.asset, 'NEAR');
  assert.equal(r.recipient, 'bob.near');
  assert.equal(r.memo, 'invoice 7');
  assert.equal(r.invoiceId, 'INV-7');
  assert.equal(r.amountIn, '1.5');
  assert.equal(r.amountOut, '1.5');
  assert.equal(r.timeEstimateSec, 30);
  assert.ok(Date.parse(r.timestamp));
});

test('mock: rejects a non-positive amount', async () => {
  const client = new MockNearClient();
  await assert.rejects(client.getQuote({ amount: 0, asset: 'NEAR', recipient: 'bob.near' }), /positive/);
  await assert.rejects(client.executePayment({ amount: -1, asset: 'NEAR', recipient: 'bob.near' }), /positive/);
});

// ---------------------------------------------------------------------------
// 1Click client (fake fetch)
// ---------------------------------------------------------------------------

test('oneclick: getQuote builds the correct POST body with smallest-unit amount', async () => {
  const fetchImpl = oneClickFakeFetch();
  const client = new OneClickClient({ fetchImpl });
  assert.equal(client.mode, 'oneclick');
  const q = await client.getQuote({ amount: 1, asset: 'NEAR', recipient: 'bob.near' });

  // Tokens were fetched once, then the quote.
  const tokenCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/v0/tokens'));
  assert.equal(tokenCalls.length, 1);
  const quoteCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/v0/quote'));
  assert.equal(quoteCalls.length, 1);
  const body = JSON.parse(quoteCalls[0].init.body);
  assert.equal(body.dry, true);
  assert.equal(body.swapType, 'EXACT_INPUT');
  assert.equal(body.depositType, 'ORIGIN_CHAIN');
  assert.equal(body.originAsset, 'nep141:wrap.near');
  assert.equal(body.destinationAsset, 'nep141:wrap.near');
  // 1 NEAR at 24 decimals.
  assert.equal(body.amount, '1000000000000000000000000');
  assert.equal(body.recipient, 'bob.near');
  assert.equal(body.recipientType, 'DESTINATION_CHAIN');
  assert.equal(body.refundTo, 'bob.near');
  assert.equal(body.refundType, 'ORIGIN_CHAIN');
  assert.equal(body.slippageTolerance, 100);
  assert.equal(body.quoteWaitingTimeMs, 3000);
  assert.ok(Date.parse(body.deadline));

  assert.equal(q.mode, 'oneclick');
  assert.equal(q.amountIn, '1');
  assert.equal(q.amountOut, '1');
  assert.equal(q.assetIn, 'NEAR');
  assert.equal(q.assetOut, 'NEAR');
  assert.equal(q.rate, 1);
  assert.equal(q.timeEstimateSec, 120);
  assert.equal(q.depositAddress, null); // dry quote: no deposit address
});

test('oneclick: resolves USDC to the NEAR-chain entry, not the eth entry', async () => {
  const fetchImpl = oneClickFakeFetch();
  const client = new OneClickClient({ fetchImpl });
  await client.getQuote({ amount: 10, asset: 'USDC', recipient: 'bob.near' });
  const quoteCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/v0/quote'));
  const body = JSON.parse(quoteCalls[0].init.body);
  assert.equal(body.originAsset, 'nep141:fake-usdc-near');
  assert.equal(body.amount, '10000000'); // 10 USDC at 6 decimals
});

test('oneclick: unauthenticated call sends no Authorization header', async () => {
  const fetchImpl = oneClickFakeFetch();
  const client = new OneClickClient({ fetchImpl });
  await client.getQuote({ amount: 1, asset: 'NEAR', recipient: 'bob.near' });
  for (const c of fetchImpl.calls) {
    assert.equal(c.init.headers.Authorization, undefined);
  }
});

test('oneclick: authenticated call sends Authorization: Bearer <jwt>', async () => {
  const fetchImpl = oneClickFakeFetch();
  const client = new OneClickClient({ fetchImpl, jwt: 'test-jwt-123' });
  await client.getQuote({ amount: 1, asset: 'NEAR', recipient: 'bob.near' });
  for (const c of fetchImpl.calls) {
    assert.equal(c.init.headers.Authorization, 'Bearer test-jwt-123');
  }
});

test('oneclick: getTokens result is cached across quotes', async () => {
  const fetchImpl = oneClickFakeFetch();
  const client = new OneClickClient({ fetchImpl });
  await client.getQuote({ amount: 1, asset: 'NEAR', recipient: 'bob.near' });
  await client.getQuote({ amount: 2, asset: 'NEAR', recipient: 'bob.near' });
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/v0/tokens')).length, 1);
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/v0/quote')).length, 2);
});

test('oneclick: executePayment returns AWAITING_DEPOSIT with the deposit address', async () => {
  const fetchImpl = oneClickFakeFetch({ quoteDepositAddress: 'alice.near' });
  const client = new OneClickClient({ fetchImpl });
  const r = await client.executePayment({
    amount: 1,
    asset: 'NEAR',
    recipient: 'bob.near',
    memo: 'pay invoice',
    invoiceId: 'INV-9',
  });
  const quoteCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/v0/quote'));
  assert.equal(JSON.parse(quoteCalls[0].init.body).dry, false);
  assert.equal(r.status, 'AWAITING_DEPOSIT');
  assert.equal(r.mode, 'oneclick');
  assert.equal(r.receiptId, 'alice.near');
  assert.equal(r.depositAddress, 'alice.near');
  assert.equal(r.txHash, null);
  assert.equal(r.explorerUrl, null);
  assert.equal(r.amount, 1);
  assert.equal(r.asset, 'NEAR');
  assert.equal(r.recipient, 'bob.near');
  assert.equal(r.memo, 'pay invoice');
  assert.equal(r.invoiceId, 'INV-9');
  assert.equal(r.amountIn, '1');
  assert.equal(r.amountOut, '1');
  assert.equal(r.timeEstimateSec, 120);
  assert.ok(Date.parse(r.timestamp));
});

test('oneclick: getStatus calls GET /v0/status with the deposit address', async () => {
  const fetchImpl = oneClickFakeFetch();
  const client = new OneClickClient({ fetchImpl });
  const s = await client.getStatus('alice.near');
  const statusCalls = fetchImpl.calls.filter((c) => c.url.includes('/v0/status'));
  assert.equal(statusCalls.length, 1);
  assert.equal(statusCalls[0].init.method, 'GET');
  const u = new URL(statusCalls[0].url);
  assert.equal(u.searchParams.get('depositAddress'), 'alice.near');
  assert.equal(s.status, 'PENDING_DEPOSIT');
  assert.equal(s.depositAddress, 'alice.near');
  assert.equal(s.depositAddressFromQuery, 'alice.near');
  assert.ok(s.updatedAt);
});

test('oneclick: getStatus forwards depositMemo when given', async () => {
  const fetchImpl = oneClickFakeFetch();
  const client = new OneClickClient({ fetchImpl });
  await client.getStatus('alice.near', 'memo-42');
  const u = new URL(fetchImpl.calls[0].url);
  assert.equal(u.searchParams.get('depositMemo'), 'memo-42');
});

test('oneclick: unknown asset throws a clear error naming the asset', async () => {
  const fetchImpl = oneClickFakeFetch();
  const client = new OneClickClient({ fetchImpl });
  await assert.rejects(
    client.getQuote({ amount: 1, asset: 'NOPECOIN', recipient: 'bob.near' }),
    /cannot resolve asset "NOPECOIN"/,
  );
  await assert.rejects(
    client.executePayment({ amount: 1, asset: 'NOPECOIN', recipient: 'bob.near' }),
    /cannot resolve asset "NOPECOIN"/,
  );
});

test('oneclick: HTTP errors propagate with status', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith('/v0/tokens')) return jsonResponse(FAKE_TOKENS);
    return jsonResponse({ message: 'amount too small' }, { ok: false, status: 400 });
  });
  const client = new OneClickClient({ fetchImpl });
  await assert.rejects(
    client.getQuote({ amount: 0.000001, asset: 'NEAR', recipient: 'bob.near' }),
    /1Click POST \/v0\/quote failed \(400\)/,
  );
});

// ---------------------------------------------------------------------------
// Testnet client (stubbed near-api-js)
// ---------------------------------------------------------------------------

test('testnet: constructor throws without accountId/privateKey', () => {
  const savedAccount = process.env.NEAR_TESTNET_ACCOUNT_ID;
  const savedKey = process.env.NEAR_TESTNET_PRIVATE_KEY;
  delete process.env.NEAR_TESTNET_ACCOUNT_ID;
  delete process.env.NEAR_TESTNET_PRIVATE_KEY;
  try {
    assert.throws(() => new TestnetClient({}), /requires accountId and privateKey/);
    assert.throws(
      () => new TestnetClient({ accountId: 'a.testnet' }),
      /requires accountId and privateKey/,
    );
  } finally {
    if (savedAccount !== undefined) process.env.NEAR_TESTNET_ACCOUNT_ID = savedAccount;
    if (savedKey !== undefined) process.env.NEAR_TESTNET_PRIVATE_KEY = savedKey;
  }
});

test('testnet: getQuote returns a 1:1 NEAR quote', async () => {
  const { stub } = stubNearApi();
  const client = new TestnetClient({
    accountId: 'alice.testnet',
    privateKey: 'ed25519:fake',
    nearApi: stub,
  });
  assert.equal(client.mode, 'testnet');
  const q = await client.getQuote({ amount: 3, asset: 'NEAR', recipient: 'bob.testnet' });
  assert.equal(q.rate, 1);
  assert.equal(q.amountIn, '3');
  assert.equal(q.amountOut, '3');
  assert.equal(q.assetIn, 'NEAR');
  assert.equal(q.timeEstimateSec, 2);
  assert.equal(q.mode, 'testnet');
});

test('testnet: executePayment returns COMPLETED with the stubbed tx hash and explorer URL', async () => {
  const { stub, calls } = stubNearApi({ txHash: 'AbC123hash' });
  const client = new TestnetClient({
    accountId: 'alice.testnet',
    privateKey: 'ed25519:fake',
    nearApi: stub,
  });
  const r = await client.executePayment({
    amount: 1.5,
    asset: 'NEAR',
    recipient: 'bob.testnet',
    memo: 'test pay',
    invoiceId: 'INV-1',
  });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.mode, 'testnet');
  assert.equal(r.receiptId, 'AbC123hash');
  assert.equal(r.txHash, 'AbC123hash');
  assert.equal(r.explorerUrl, 'https://testnet.nearblocks.io/txns/AbC123hash');
  assert.equal(r.amount, 1.5);
  assert.equal(r.asset, 'NEAR');
  assert.equal(r.recipient, 'bob.testnet');
  assert.equal(r.memo, 'test pay');
  assert.equal(r.invoiceId, 'INV-1');
  assert.ok(Date.parse(r.timestamp));
  // Provider pointed at testnet RPC; account built from the given credentials.
  assert.deepEqual(calls.providerUrls, ['https://rpc.testnet.near.org']);
  assert.equal(calls.accountArgs[0].accountId, 'alice.testnet');
  assert.equal(calls.accountArgs[0].privateKey, 'ed25519:fake');
  // parseNearAmount('1.5') -> 1.5 NEAR in yoctoNEAR; transfer got a BigInt.
  assert.deepEqual(calls.parseNearAmount, ['1.5']);
  assert.equal(calls.transfers.length, 1);
  assert.equal(calls.transfers[0].receiverId, 'bob.testnet');
  assert.equal(typeof calls.transfers[0].amount, 'bigint');
  assert.equal(calls.transfers[0].amount, 1500000000000000000000000n);
});

test('testnet: tx hash falls back to transaction_outcome.id', async () => {
  const { stub } = stubNearApi({ txHash: 'FallbackHash999', hashField: 'outcome' });
  const client = new TestnetClient({
    accountId: 'alice.testnet',
    privateKey: 'ed25519:fake',
    nearApi: stub,
  });
  const r = await client.executePayment({ amount: 0.5, asset: 'NEAR', recipient: 'bob.testnet' });
  assert.equal(r.txHash, 'FallbackHash999');
  assert.equal(r.explorerUrl, 'https://testnet.nearblocks.io/txns/FallbackHash999');
});

test('testnet: non-NEAR asset throws the clear v1 error', async () => {
  const { stub } = stubNearApi();
  const client = new TestnetClient({
    accountId: 'alice.testnet',
    privateKey: 'ed25519:fake',
    nearApi: stub,
  });
  await assert.rejects(
    client.executePayment({ amount: 1, asset: 'USDC', recipient: 'bob.testnet' }),
    /only NEAR supported on testnet in v1, use mock or 1Click/,
  );
  await assert.rejects(
    client.getQuote({ amount: 1, asset: 'USDT', recipient: 'bob.testnet' }),
    /only NEAR supported on testnet in v1/,
  );
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

test('factory: returns the right client per mode and throws on unknown mode', () => {
  assert.ok(createNearClient('mock') instanceof MockNearClient);
  assert.equal(createNearClient('mock').mode, 'mock');
  const oc = createNearClient('oneclick', { fetchImpl: oneClickFakeFetch() });
  assert.ok(oc instanceof OneClickClient);
  assert.equal(oc.mode, 'oneclick');
  const { stub } = stubNearApi();
  const tn = createNearClient('testnet', {
    accountId: 'alice.testnet',
    privateKey: 'ed25519:fake',
    nearApi: stub,
  });
  assert.ok(tn instanceof TestnetClient);
  assert.equal(tn.mode, 'testnet');
  assert.throws(() => createNearClient('mainnet'), /Unknown NEAR client mode: "mainnet"/);
  assert.throws(() => createNearClient('bogus'), /Unknown NEAR client mode/);
});
