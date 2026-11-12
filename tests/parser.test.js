'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseInstruction, parseInstructionRule, isValidNearAccount } = require('../src/parser');

// Ensure the LLM path is off by default in these tests (no key set).
delete process.env.OPENAI_API_KEY;

test('Indonesian full extraction: bayar 10 NEAR ke alice.near buat invoice #123', async () => {
  const out = await parseInstruction('bayar 10 NEAR ke alice.near buat invoice #123');
  assert.strictEqual(out.amount, 10);
  assert.strictEqual(out.asset, 'NEAR');
  assert.strictEqual(out.recipient, 'alice.near');
  assert.strictEqual(out.invoiceId, '123');
  assert.strictEqual(out.memo, 'invoice #123');
  assert.strictEqual(out.confidence, 0.9);
  assert.strictEqual(out.method, 'rule');
});

test('rule parser: same Indonesian sentence (sync export)', () => {
  const out = parseInstructionRule('bayar 10 NEAR ke alice.near buat invoice #123');
  assert.strictEqual(out.amount, 10);
  assert.strictEqual(out.asset, 'NEAR');
  assert.strictEqual(out.recipient, 'alice.near');
  assert.strictEqual(out.invoiceId, '123');
  assert.strictEqual(out.memo, 'invoice #123');
  assert.strictEqual(out.method, 'rule');
});

test('pay 5 USDC to alice.near', async () => {
  const out = await parseInstruction('pay 5 USDC to alice.near');
  assert.strictEqual(out.amount, 5);
  assert.strictEqual(out.asset, 'USDC');
  assert.strictEqual(out.recipient, 'alice.near');
  assert.strictEqual(out.confidence, 0.9);
});

test('kirim 50 ke bob.testnet (no asset -> NEAR)', async () => {
  const out = await parseInstruction('kirim 50 ke bob.testnet');
  assert.strictEqual(out.amount, 50);
  assert.strictEqual(out.asset, 'NEAR');
  assert.strictEqual(out.recipient, 'bob.testnet');
});

test('subaccount recipient: pay 2 NEAR to sub.alice.near', async () => {
  const out = await parseInstruction('pay 2 NEAR to sub.alice.near');
  assert.strictEqual(out.amount, 2);
  assert.strictEqual(out.asset, 'NEAR');
  assert.strictEqual(out.recipient, 'sub.alice.near');
});

test('implicit account: 64 hex chars', async () => {
  const hex = 'a'.repeat(64);
  const out = await parseInstruction(`pay 1 NEAR to ${hex}`);
  assert.strictEqual(out.amount, 1);
  assert.strictEqual(out.asset, 'NEAR');
  assert.strictEqual(out.recipient, hex);
});

test('USDT and wNEAR assets (case-insensitive)', async () => {
  const a = await parseInstruction('pay 20 usdt to alice.near');
  assert.strictEqual(a.asset, 'USDT');
  const b = await parseInstruction('pay 0.5 wnear to alice.near');
  assert.strictEqual(b.asset, 'wNEAR');
  assert.strictEqual(b.amount, 0.5);
});

test('$25 style: $ amount with no asset defaults to NEAR', async () => {
  const out = await parseInstruction('pay $25 to alice.near');
  assert.strictEqual(out.amount, 25);
  assert.strictEqual(out.asset, 'NEAR');
  assert.strictEqual(out.recipient, 'alice.near');
});

test('text with no amount: amount null, low confidence', async () => {
  const out = await parseInstruction('please pay alice.near for the invoice');
  assert.strictEqual(out.amount, null);
  assert.strictEqual(out.recipient, 'alice.near');
  assert.strictEqual(out.confidence, 0.3);
});

test('text with no recipient', async () => {
  const out = await parseInstruction('pay 10 NEAR for lunch');
  assert.strictEqual(out.amount, 10);
  assert.strictEqual(out.recipient, null);
  assert.strictEqual(out.confidence, 0.6);
  assert.strictEqual(out.memo, 'lunch');
});

test('invoice formats: #123 and invoice #INV-2026-01', () => {
  const a = parseInstructionRule('pay 5 USDC to alice.near for invoice #123');
  assert.strictEqual(a.invoiceId, '123');
  assert.strictEqual(a.memo, 'invoice #123');

  const b = parseInstructionRule('bayar 10 NEAR ke bob.testnet buat invoice #INV-2026-01');
  assert.strictEqual(b.invoiceId, 'INV-2026-01');
  assert.strictEqual(b.memo, 'invoice #INV-2026-01');

  const c = parseInstructionRule('transfer 1 NEAR to carol.near #INV-2026-01');
  assert.strictEqual(c.invoiceId, 'INV-2026-01');
});

test('dollars wording maps to USDC; transfer/send verbs', () => {
  const a = parseInstructionRule('send 20 dollars to dave.near');
  assert.strictEqual(a.amount, 20);
  assert.strictEqual(a.asset, 'USDC');

  const b = parseInstructionRule('transfer $33 to eve.near untuk invoice #9');
  assert.strictEqual(b.amount, 33);
  assert.strictEqual(b.invoiceId, '9');
  assert.strictEqual(b.memo, 'invoice #9');
});

test('no email parsing: an email address is not a recipient', () => {
  const out = parseInstructionRule('pay 5 NEAR to alice@example.com');
  assert.strictEqual(out.recipient, null);
  assert.strictEqual(out.amount, 5);
});

test('isValidNearAccount validates named, subaccount and implicit accounts', () => {
  assert.strictEqual(isValidNearAccount('alice.near'), true);
  assert.strictEqual(isValidNearAccount('bob.testnet'), true);
  assert.strictEqual(isValidNearAccount('sub.alice.near'), true);
  assert.strictEqual(isValidNearAccount('a'.repeat(64)), true);
  assert.strictEqual(isValidNearAccount('alice@example.com'), false);
  assert.strictEqual(isValidNearAccount('alice'), false);
  assert.strictEqual(isValidNearAccount('near'), false);
  assert.strictEqual(isValidNearAccount(''), false);
  assert.strictEqual(isValidNearAccount(null), false);
});

test('LLM path mocked via injected fetch (opts.fetchImpl)', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const fakeFetch = async (url, options) => {
      assert.ok(String(url).includes('/chat/completions'));
      assert.strictEqual(options.method, 'POST');
      assert.ok(options.headers.Authorization.includes('test-key'));
      const body = JSON.parse(options.body);
      assert.strictEqual(body.model, 'gpt-4o-mini');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                amount: 42,
                asset: 'USDC',
                recipient: 'llm.near',
                invoiceId: 'INV-99',
                memo: 'LLM memo',
              }),
            },
          }],
        }),
      };
    };
    const out = await parseInstruction('whatever the user typed', { fetchImpl: fakeFetch });
    assert.strictEqual(out.method, 'llm');
    assert.strictEqual(out.amount, 42);
    assert.strictEqual(out.asset, 'USDC');
    assert.strictEqual(out.recipient, 'llm.near');
    assert.strictEqual(out.invoiceId, 'INV-99');
    assert.strictEqual(out.memo, 'LLM memo');
    assert.strictEqual(out.confidence, 0.9);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('LLM path mocked via opts.fetch alias', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"amount": 7, "asset": "NEAR", "recipient": "x.near", "invoiceId": null, "memo": null}' } }],
      }),
    });
    const out = await parseInstruction('pay seven?', { fetch: fakeFetch });
    assert.strictEqual(out.method, 'llm');
    assert.strictEqual(out.amount, 7);
    assert.strictEqual(out.recipient, 'x.near');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('LLM failure falls back to rule parser (network error)', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const failingFetch = async () => { throw new Error('network down'); };
    const out = await parseInstruction('bayar 10 NEAR ke alice.near buat invoice #123', { fetchImpl: failingFetch });
    assert.strictEqual(out.method, 'rule');
    assert.strictEqual(out.amount, 10);
    assert.strictEqual(out.recipient, 'alice.near');
    assert.strictEqual(out.invoiceId, '123');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('LLM failure falls back to rule parser (non-JSON reply)', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const badFetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
    });
    const out = await parseInstruction('pay 5 USDC to alice.near', { fetchImpl: badFetch });
    assert.strictEqual(out.method, 'rule');
    assert.strictEqual(out.amount, 5);
    assert.strictEqual(out.recipient, 'alice.near');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('LLM failure falls back to rule parser (missing fields)', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const badFetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"foo": 1}' } }] }),
    });
    const out = await parseInstruction('kirim 50 ke bob.testnet', { fetchImpl: badFetch });
    assert.strictEqual(out.method, 'rule');
    assert.strictEqual(out.amount, 50);
    assert.strictEqual(out.recipient, 'bob.testnet');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('no API key -> rule parser even if fetch would succeed', async () => {
  delete process.env.OPENAI_API_KEY;
  let called = false;
  const fakeFetch = async () => { called = true; throw new Error('should not be called'); };
  const out = await parseInstruction('pay 5 USDC to alice.near', { fetchImpl: fakeFetch });
  assert.strictEqual(called, false);
  assert.strictEqual(out.method, 'rule');
  assert.strictEqual(out.amount, 5);
});
