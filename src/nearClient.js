'use strict';

/**
 * NEAR execution layer for the NEAR Agent hackathon project.
 *
 * Mirrors the shape of paypal-agent's src/paypalClient.js: a real client class
 * + a Mock class with an identical interface, with fetch / near-api-js injected
 * for tests.
 *
 * Three modes (see createNearClient at the bottom):
 *   - 'mock'     : no network, deterministic fake quotes, COMPLETED payments.
 *   - 'oneclick' : real NEAR Intents 1Click API (https://1click.chaindefuser.com).
 *                  Flow: query tokens -> request a quote -> send your deposit
 *                  to the quote's depositAddress -> 1Click executes -> poll
 *                  status. The agent CANNOT complete a 1Click payment alone:
 *                  executePayment() only reserves the quote and returns
 *                  AWAITING_DEPOSIT with the deposit address; the payer must
 *                  send `amountIn` of the origin asset to that address, then
 *                  getStatus(depositAddress) is polled until SUCCESS/FAILED.
 *                  There is NO testnet version of Intents — use small amounts
 *                  live. A JWT is OPTIONAL (authenticated fee schedule vs
 *                  +0.25% unauthenticated fee); unauthenticated calls work.
 *   - 'testnet'  : real native NEAR transfers on NEAR testnet via near-api-js.
 *                  v1 supports NEAR only.
 *
 * No secrets are ever logged. Private keys / JWTs are read from env or opts
 * only, and never appear in error messages or returned objects.
 */

const crypto = require('crypto');

const ONECLICK_BASE_URL = 'https://1click.chaindefuser.com';

const NEAR_TESTNET_CONFIG = {
  networkId: 'testnet',
  nodeUrl: 'https://rpc.testnet.near.org',
  walletUrl: 'https://testnet.mynearwallet.com',
  helperUrl: 'https://helper.testnet.near.org',
  explorerUrl: 'https://testnet.nearblocks.io',
};

const TESTNET_V1_ASSET_ERROR =
  'only NEAR supported on testnet in v1, use mock or 1Click';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function randomHexUpper(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex').toUpperCase();
}

function isoNow() {
  return new Date().toISOString();
}

function assertPositiveAmount(amount) {
  const n = Number(amount);
  if (amount === undefined || amount === null || amount === '' || !Number.isFinite(n) || n <= 0) {
    throw new Error(`amount must be a positive number, got: ${String(amount)}`);
  }
  return n;
}

function assertRecipient(recipient) {
  if (!recipient || typeof recipient !== 'string') {
    throw new Error('recipient is required');
  }
  return recipient;
}

function normalizeSymbol(asset) {
  if (!asset || typeof asset !== 'string') {
    throw new Error(`asset is required, got: ${String(asset)}`);
  }
  return asset.trim().toUpperCase();
}

/** Convert a human-readable decimal amount to smallest units (integer string) with BigInt math. */
function toSmallestUnits(amount, decimals) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  const [intPart, fracPart = ''] = s.split('.');
  if (fracPart.length > decimals) {
    throw new Error(`Amount ${amount} has more decimal places than supported (${decimals})`);
  }
  const frac = fracPart.padEnd(decimals, '0');
  return (BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0')).toString();
}

/** Convert a smallest-units integer string back to a human-readable decimal string. */
function fromSmallestUnits(amountStr, decimals) {
  const v = BigInt(amountStr);
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  const frac = v % base;
  if (frac === 0n) return int.toString();
  return `${int}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

/** Pretty-print a Number amount for mock quotes (trims float noise). */
function formatMockAmount(n) {
  return String(parseFloat(Number(n).toFixed(12)));
}

// ---------------------------------------------------------------------------
// Mock client — no network, no real money.
// ---------------------------------------------------------------------------

/** Deterministic mock cross-asset rates (per 1 unit of assetIn). Same-asset = 1. */
const MOCK_RATES = {
  'NEAR->USDC': 2.5,
  'NEAR->USDT': 2.5,
  'USDC->NEAR': 0.4,
  'USDT->NEAR': 0.4,
  'USDC->USDT': 1,
  'USDT->USDC': 1,
};

function mockRate(assetIn, assetOut) {
  if (assetIn === assetOut) return 1;
  return MOCK_RATES[`${assetIn}->${assetOut}`] ?? 1;
}

class MockNearClient {
  constructor(_opts = {}) {
    this.mode = 'mock';
  }

  async getQuote({ amount, asset, assetOut, recipient } = {}) {
    const n = assertPositiveAmount(amount);
    const assetIn = normalizeSymbol(asset);
    const assetOutSym = assetOut ? normalizeSymbol(assetOut) : assetIn;
    assertRecipient(recipient);
    const rate = mockRate(assetIn, assetOutSym);
    return {
      amountIn: formatMockAmount(n),
      amountOut: formatMockAmount(n * rate),
      assetIn,
      assetOut: assetOutSym,
      rate,
      timeEstimateSec: 30,
      depositAddress: null,
      mode: 'mock',
    };
  }

  async executePayment({ amount, asset, assetOut, recipient, memo, invoiceId } = {}) {
    const n = assertPositiveAmount(amount);
    const assetSym = normalizeSymbol(asset);
    const assetOutSym = assetOut ? normalizeSymbol(assetOut) : assetSym;
    assertRecipient(recipient);
    const rate = mockRate(assetSym, assetOutSym);
    const txHash = `MOCK-TX-${randomHexUpper(6)}`;
    return {
      status: 'COMPLETED',
      receiptId: `MOCK-NEAR-${randomHexUpper(6)}`,
      txHash,
      explorerUrl: `https://testnet.nearblocks.io/txns/${txHash}`,
      amount: n,
      asset: assetSym,
      recipient,
      memo: memo ?? null,
      invoiceId: invoiceId ?? null,
      mode: 'mock',
      depositAddress: null,
      amountIn: formatMockAmount(n),
      amountOut: formatMockAmount(n * rate),
      timeEstimateSec: 30,
      timestamp: isoNow(),
    };
  }
}

// ---------------------------------------------------------------------------
// 1Click client — real NEAR Intents 1Click API (plain fetch REST, no SDK).
//
// Endpoints/fields verified 12 Nov 2026 against:
//   - https://docs.near-intents.org/ (index: curl examples for /v0/tokens,
//     /v0/quote; SDK snippet)
//   - https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction
//     ("There is no testnet version of NEAR Intents", JWT = authenticated fee
//     schedule vs +0.25% unauthenticated fee; flow: query tokens, request a
//     quote, send your deposit, track it to completion)
//   - https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request
//     (quote params table; status values PENDING_DEPOSIT / KNOWN_DEPOSIT_TX /
//     PROCESSING / SUCCESS / INCOMPLETE_DEPOSIT / REFUNDED / FAILED)
//   - https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
//     (POST /v0/quote request/response shapes; dry=true omits depositAddress,
//     timeWhenInactive, deadline; response quote: amountIn, amountInFormatted,
//     amountOut, amountOutFormatted, minAmountIn/Out, timeEstimate,
//     depositAddress, depositMemo, deadline)
//   - https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status
//     (GET /v0/status?depositAddress=...&depositMemo=...; response: status,
//     updatedAt, swapDetails, quoteResponse)
//   - @defuse-protocol/one-click-sdk-typescript@0.1.26 dist/index.js + .d.ts
//     (OpenAPI.BASE = 'https://1click.chaindefuser.com'; getTokens GET
//     /v0/tokens -> TokenResponse[] {assetId, blockchain, symbol, decimals,
//     price, priceUpdatedAt, contractAddress?}; getQuote POST /v0/quote;
//     getExecutionStatus GET /v0/status?depositAddress&depositMemo;
//     Authorization: Bearer <TOKEN> when a token is set)
//   - Live GET https://1click.chaindefuser.com/v0/tokens (12 Nov 2026):
//     wNEAR = nep141:wrap.near, 24 decimals, blockchain 'near';
//     USDC (near) = nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1,
//     6 decimals, blockchain 'near'. (These are live snapshots only — the
//     code NEVER hard-codes them; it resolves from /v0/tokens at runtime.)
// ---------------------------------------------------------------------------

class OneClickClient {
  constructor({ fetchImpl, jwt, slippageTolerance = 100, quoteWaitingTimeMs = 3000 } = {}) {
    this.mode = 'oneclick';
    this.baseUrl = ONECLICK_BASE_URL;
    this.jwt = jwt || process.env.ONECLICK_JWT || null;
    this.slippageTolerance = slippageTolerance;
    this.quoteWaitingTimeMs = quoteWaitingTimeMs;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('OneClickClient requires a fetch implementation');
    }
    this._tokensCache = null;
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    // JWT is OPTIONAL: omit Authorization entirely when unauthenticated
    // (those calls pay the +0.25% unauthenticated fee instead).
    if (this.jwt) headers.Authorization = `Bearer ${this.jwt}`;
    return headers;
  }

  async _request(path, { method = 'GET', body } = {}) {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this._headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`1Click ${method} ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  /** GET /v0/tokens — cached for the life of the client. Returns TokenResponse[]. */
  async getTokens() {
    if (this._tokensCache) return this._tokensCache;
    const data = await this._request('/v0/tokens');
    const list = Array.isArray(data) ? data : data.tokens;
    if (!Array.isArray(list)) {
      throw new Error('1Click /v0/tokens returned an unexpected shape (expected an array)');
    }
    this._tokensCache = list;
    return list;
  }

  /**
   * Resolve an app asset symbol (NEAR / USDC / USDT / wNEAR) to a 1Click
   * asset id from GET /v0/tokens. NEVER invents a contract id.
   * NEAR maps to the NEAR-chain wNEAR entry (nep141:wrap.near); other symbols
   * prefer the blockchain 'near' entry so the NEAR recipient can receive the
   * payout, falling back to the first entry with that symbol on any chain.
   */
  async resolveAsset(symbol) {
    const sym = normalizeSymbol(symbol);
    const lookup = sym === 'NEAR' ? 'WNEAR' : sym;
    const tokens = await this.getTokens();
    const matches = tokens.filter(
      (t) => typeof t.symbol === 'string' && t.symbol.toUpperCase() === lookup,
    );
    if (matches.length === 0) {
      throw new Error(
        `1Click: cannot resolve asset "${sym}" — no token with that symbol in GET /v0/tokens`,
      );
    }
    const onNear = matches.find((t) => t.blockchain === 'near');
    const token = onNear || matches[0];
    if (!token.assetId || typeof token.decimals !== 'number') {
      throw new Error(`1Click: token entry for "${sym}" is missing assetId/decimals`);
    }
    return { assetId: token.assetId, decimals: token.decimals, symbol: token.symbol, blockchain: token.blockchain };
  }

  /**
   * POST /v0/quote. dry=true is a preview (no depositAddress in response);
   * dry=false commits the quote and returns a depositAddress.
   */
  async _requestQuote({ amount, asset, assetOut, recipient, dry }) {
    const n = assertPositiveAmount(amount);
    const assetIn = normalizeSymbol(asset);
    const assetOutSym = assetOut ? normalizeSymbol(assetOut) : assetIn;
    assertRecipient(recipient);
    const origin = await this.resolveAsset(assetIn);
    const destination = await this.resolveAsset(assetOutSym);
    const amountSmallest = toSmallestUnits(n, origin.decimals);
    const body = {
      dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: this.slippageTolerance,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: destination.assetId,
      amount: amountSmallest,
      refundTo: recipient,
      refundType: 'ORIGIN_CHAIN',
      recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      depositMode: 'SIMPLE',
      quoteWaitingTimeMs: this.quoteWaitingTimeMs,
    };
    const data = await this._request('/v0/quote', { method: 'POST', body });
    const quote = data && data.quote;
    if (!quote || typeof quote.amountIn !== 'string' || typeof quote.amountOut !== 'string') {
      throw new Error('1Click /v0/quote returned an unexpected shape (expected quote.amountIn/amountOut)');
    }
    return { data, quote, origin, destination, assetIn, assetOut: assetOutSym };
  }

  _quoteToView({ quote, origin, destination, assetIn, assetOut }) {
    const amountIn = quote.amountInFormatted ?? fromSmallestUnits(quote.amountIn, origin.decimals);
    const amountOut = quote.amountOutFormatted ?? fromSmallestUnits(quote.amountOut, destination.decimals);
    const inNum = Number(amountIn);
    const outNum = Number(amountOut);
    const rate = inNum > 0 && Number.isFinite(outNum) ? outNum / inNum : null;
    return {
      amountIn,
      amountOut,
      assetIn,
      assetOut,
      rate,
      timeEstimateSec: typeof quote.timeEstimate === 'number' ? quote.timeEstimate : null,
      depositAddress: quote.depositAddress ?? null,
      mode: 'oneclick',
    };
  }

  async getQuote({ amount, asset, assetOut, recipient } = {}) {
    const result = await this._requestQuote({ amount, asset, assetOut, recipient, dry: true });
    return this._quoteToView(result);
  }

  /**
   * Request a fresh (dry=false) quote and return AWAITING_DEPOSIT.
   *
   * 1Click executes ONLY after the deposit is sent: the payer must transfer
   * `amountIn` of the origin asset to `depositAddress` on the origin chain
   * before the quote deadline. The agent cannot complete this step alone.
   * Poll getStatus(depositAddress) until SUCCESS / REFUNDED / FAILED.
   */
  async executePayment({ amount, asset, assetOut, recipient, memo, invoiceId } = {}) {
    const result = await this._requestQuote({ amount, asset, assetOut, recipient, dry: false });
    const { quote } = result;
    const view = this._quoteToView(result);
    if (!quote.depositAddress) {
      throw new Error('1Click quote did not return a depositAddress — cannot proceed with the deposit');
    }
    return {
      status: 'AWAITING_DEPOSIT',
      receiptId: quote.depositAddress,
      txHash: null,
      explorerUrl: null,
      amount: Number(view.amountIn),
      asset: view.assetIn,
      recipient,
      memo: memo ?? null,
      invoiceId: invoiceId ?? null,
      mode: 'oneclick',
      depositAddress: quote.depositAddress,
      amountIn: view.amountIn,
      amountOut: view.amountOut,
      timeEstimateSec: view.timeEstimateSec,
      timestamp: isoNow(),
    };
  }

  /**
   * GET /v0/status?depositAddress=... (&depositMemo=... when the quote had one).
   * Status values: PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS,
   * INCOMPLETE_DEPOSIT, REFUNDED, FAILED.
   */
  async getStatus(depositAddress, depositMemo) {
    if (!depositAddress || typeof depositAddress !== 'string') {
      throw new Error('getStatus requires a depositAddress');
    }
    const params = new URLSearchParams({ depositAddress });
    if (depositMemo) params.set('depositMemo', depositMemo);
    const raw = await this._request(`/v0/status?${params.toString()}`);
    return { ...raw, status: raw.status ?? null, depositAddress };
  }
}

// ---------------------------------------------------------------------------
// Testnet client — real native NEAR transfers via near-api-js (v7 API).
//
// near-api-js 7.5.3 (verified against its README + lib/index.d.ts):
//   import { Account, JsonRpcProvider, parseNearAmount } from 'near-api-js';
//   const provider = new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' });
//   const account = new Account(accountId, provider, privateKey); // KeyPairString, e.g. 'ed25519:...'
//   const outcome = await account.transfer({ receiverId, amount: BigInt(yocto) });
//   // outcome: RpcTransactionResponse; tx hash = outcome.transaction.hash
//   // (fallback: outcome.transaction_outcome.id)
//   parseNearAmount('1.5') === '1500000000000000000000000' (string yoctoNEAR)
//
// The near-api-js module is required lazily (or injected via opts.nearApi)
// so unit tests can stub it and never touch the real testnet RPC.
// ---------------------------------------------------------------------------

class TestnetClient {
  constructor({ accountId, privateKey, nearApi } = {}) {
    this.mode = 'testnet';
    this.accountId = accountId || process.env.NEAR_TESTNET_ACCOUNT_ID || null;
    this.privateKey = privateKey || process.env.NEAR_TESTNET_PRIVATE_KEY || null;
    if (!this.accountId || !this.privateKey) {
      throw new Error(
        'TestnetClient requires accountId and privateKey ' +
          '(env NEAR_TESTNET_ACCOUNT_ID / NEAR_TESTNET_PRIVATE_KEY)',
      );
    }
    this._nearApi = nearApi || null; // injected stub for tests; else lazy require
    this._account = null;
  }

  _getNearApi() {
    if (!this._nearApi) {
      // Lazy require: keeps `require('./nearClient')` working in environments
      // (and tests) where near-api-js is not installed.
      // eslint-disable-next-line global-require
      this._nearApi = require('near-api-js');
    }
    return this._nearApi;
  }

  _getAccount() {
    if (this._account) return this._account;
    const naj = this._getNearApi();
    const provider = new naj.JsonRpcProvider({ url: NEAR_TESTNET_CONFIG.nodeUrl });
    this._account = new naj.Account(this.accountId, provider, this.privateKey);
    return this._account;
  }

  _assertNearAsset(asset) {
    const sym = normalizeSymbol(asset);
    if (sym !== 'NEAR') {
      throw new Error(`${TESTNET_V1_ASSET_ERROR} (got ${sym})`);
    }
    return sym;
  }

  async getQuote({ amount, asset, recipient } = {}) {
    const n = assertPositiveAmount(amount);
    this._assertNearAsset(asset);
    assertRecipient(recipient);
    return {
      amountIn: formatMockAmount(n),
      amountOut: formatMockAmount(n),
      assetIn: 'NEAR',
      assetOut: 'NEAR',
      rate: 1,
      timeEstimateSec: 2,
      depositAddress: null,
      mode: 'testnet',
    };
  }

  async executePayment({ amount, asset, recipient, memo, invoiceId } = {}) {
    const n = assertPositiveAmount(amount);
    const assetSym = this._assertNearAsset(asset);
    assertRecipient(recipient);
    const naj = this._getNearApi();
    const yoctoStr =
      typeof naj.parseNearAmount === 'function'
        ? naj.parseNearAmount(String(n))
        : toSmallestUnits(n, 24);
    const account = this._getAccount();
    const outcome = await account.transfer({
      receiverId: recipient,
      amount: BigInt(yoctoStr),
    });
    const txHash =
      (outcome && outcome.transaction && outcome.transaction.hash) ||
      (outcome && outcome.transaction_outcome && outcome.transaction_outcome.id) ||
      null;
    if (!txHash) {
      throw new Error('Testnet transfer succeeded but no transaction hash was returned');
    }
    return {
      status: 'COMPLETED',
      receiptId: txHash,
      txHash,
      explorerUrl: `${NEAR_TESTNET_CONFIG.explorerUrl}/txns/${txHash}`,
      amount: n,
      asset: assetSym,
      recipient,
      memo: memo ?? null,
      invoiceId: invoiceId ?? null,
      mode: 'testnet',
      depositAddress: null,
      amountIn: formatMockAmount(n),
      amountOut: formatMockAmount(n),
      timeEstimateSec: 2,
      timestamp: isoNow(),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createNearClient(mode, opts = {}) {
  switch (mode) {
    case 'mock':
      return new MockNearClient(opts);
    case 'oneclick':
      return new OneClickClient(opts);
    case 'testnet':
      return new TestnetClient(opts);
    default:
      throw new Error(`Unknown NEAR client mode: "${mode}" (expected 'mock', 'oneclick' or 'testnet')`);
  }
}

module.exports = {
  createNearClient,
  MockNearClient,
  OneClickClient,
  TestnetClient,
  ONECLICK_BASE_URL,
  NEAR_TESTNET_CONFIG,
};
