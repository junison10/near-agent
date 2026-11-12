'use strict';

const crypto = require('crypto');
const path = require('path');
const { createStore } = require('./store');
const { createApp } = require('./server');

const store = createStore(path.join(__dirname, '..', 'data'));

// Mode: mock by default. Live modes run ONLY when NEAR_MODE is set
// explicitly — merely having testnet credentials in .env never enables them.
const mode = (process.env.NEAR_MODE || 'mock').trim().toLowerCase();
const VALID_MODES = ['mock', 'oneclick', 'testnet'];
if (!VALID_MODES.includes(mode)) {
  throw new Error(`Invalid NEAR_MODE "${mode}" (expected one of: ${VALID_MODES.join(', ')})`);
}

/**
 * Minimal inline mock executor implementing the same contract as
 * src/nearClient.js (createNearClient). Used ONLY until the real
 * nearClient module lands; the server must still run in the meantime.
 */
function createInlineMockNearClient() {
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
      const hex = crypto.randomBytes(6).toString('hex');
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

let nearClient;
if (mode === 'mock') {
  try {
    const { createNearClient } = require('./nearClient');
    nearClient = createNearClient('mock');
  } catch {
    console.warn('src/nearClient.js not present yet — using the inline mock executor (no real calls)');
    nearClient = createInlineMockNearClient();
  }
} else {
  // Live modes require the real nearClient module; never silently mock them.
  const { createNearClient } = require('./nearClient');
  nearClient = createNearClient(mode, {
    accountId: process.env.NEAR_TESTNET_ACCOUNT_ID,
    privateKey: process.env.NEAR_TESTNET_PRIVATE_KEY,
    apiKey: process.env.NEAR_INTENTS_API_KEY,
    network: 'testnet',
  });
}

const app = createApp({ nearClient, store });

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`NEAR agent listening on http://localhost:${port} (mode: ${nearClient.mode})`);
});
