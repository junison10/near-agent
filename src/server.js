'use strict';

const path = require('path');
const express = require('express');

// NEAR account validation (same rules as src/parser.js). The parser module
// is the source of truth when available; this copy is the fallback so the
// server still validates when the parser cannot be loaded.
let isValidNearAccount = null;
try {
  const parser = require('./parser');
  if (typeof parser.isValidNearAccount === 'function') {
    isValidNearAccount = parser.isValidNearAccount;
  }
} catch {
  // fall through to the local copy below
}
if (!isValidNearAccount) {
  const NEAR_NAMED_RE = /\b[a-z0-9][a-z0-9_-]{0,62}(?:\.[a-z0-9][a-z0-9_-]{0,62})*\.(?:near|testnet)\b/i;
  const NEAR_IMPLICIT_RE = /\b[0-9a-f]{64}\b/i;
  isValidNearAccount = (value) => {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    if (!v) return false;
    if (NEAR_IMPLICIT_RE.test(v) && v.length === 64) return true;
    const m = NEAR_NAMED_RE.exec(v);
    return !!m && m[0].length === v.length;
  };
}

const VALID_ASSETS = ['NEAR', 'USDC', 'USDT', 'wNEAR'];

function normalizeAsset(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toUpperCase();
  if (key === 'WNEAR') return 'wNEAR';
  if (VALID_ASSETS.includes(key)) return key;
  return null;
}

/** Try to load a sibling module export; return null when absent. */
function tryRequireExport(modulePath, exportName) {
  try {
    const mod = require(modulePath);
    if (typeof mod === 'function' && exportName === 'default') return mod;
    if (mod && typeof mod[exportName] === 'function') return mod[exportName];
    if (typeof mod === 'function') return mod;
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalize the many plausible guardrail result shapes to {allowed, reasons, ...original}.
 * Supported: {allowed}, {blocked}, {pass}, {ok}, {violations[]}, {reasons[]}.
 */
function normalizeGuardrails(result) {
  if (result === true) return { allowed: true, reasons: [] };
  if (result === false) return { allowed: false, reasons: ['Blocked by guardrails'] };
  if (!result || typeof result !== 'object') {
    return { allowed: false, reasons: ['Guardrail evaluation returned no result'] };
  }
  if (typeof result.allowed === 'boolean') {
    return { ...result, reasons: result.reasons || result.violations || [] };
  }
  if (typeof result.passed === 'boolean') {
    const reasons =
      result.reasons ||
      result.violations ||
      (Array.isArray(result.checks)
        ? result.checks.filter((c) => c.passed === false).map((c) => c.detail || c.rule)
        : []);
    return { ...result, allowed: result.passed, reasons };
  }
  if (typeof result.blocked === 'boolean') {
    return { ...result, allowed: !result.blocked, reasons: result.reasons || result.violations || [] };
  }
  if (typeof result.pass === 'boolean') {
    return { ...result, allowed: result.pass, reasons: result.reasons || result.violations || [] };
  }
  if (typeof result.ok === 'boolean') {
    return { ...result, allowed: result.ok, reasons: result.reasons || result.violations || [] };
  }
  if (Array.isArray(result.violations)) {
    return { ...result, allowed: result.violations.length === 0, reasons: result.violations };
  }
  if (Array.isArray(result.reasons)) {
    return { ...result, allowed: result.reasons.length === 0 };
  }
  return { ...result, allowed: true, reasons: [] };
}

function guardrailsPass(guardrails) {
  return normalizeGuardrails(guardrails).allowed === true;
}

/** Call evaluateGuardrails tolerating (intent, settings, todayTotal) and (intent, context) signatures. */
function runGuardrails(evaluateGuardrails, intent, settings, todayTotal) {
  const context = { settings, todayTotal, allowlist: settings.allowlist || [] };
  if (evaluateGuardrails.length >= 3) {
    return evaluateGuardrails(intent, settings, todayTotal);
  }
  if (evaluateGuardrails.length === 2) {
    return evaluateGuardrails(intent, context);
  }
  // length 0/1: pass the full calling convention anyway; extra args are ignored.
  return evaluateGuardrails(intent, settings, todayTotal);
}

/**
 * Build the Express app. parseInstruction / evaluateGuardrails may be injected;
 * otherwise they are lazily required from sibling modules (./parser, ./guardrails).
 *
 * nearClient must follow the executor contract:
 *   { mode: 'mock'|'oneclick'|'testnet',
 *     getQuote({ amount, asset, recipient }) -> quote,
 *     executePayment({ amount, asset, recipient, memo, invoiceId }) -> receipt }
 */
function createApp({ nearClient, store, parseInstruction, evaluateGuardrails } = {}) {
  if (!nearClient) throw new Error('createApp requires a nearClient');
  if (!store) throw new Error('createApp requires a store');

  const parseFn =
    parseInstruction ||
    tryRequireExport('./parser', 'parseInstruction') ||
    tryRequireExport('./parser', 'parse') ||
    null;
  const guardrailsFn =
    evaluateGuardrails ||
    tryRequireExport('./guardrails', 'evaluateGuardrails') ||
    tryRequireExport('./guardrails', 'evaluate') ||
    null;

  const app = express();
  app.use(express.json());
  app.use('/', express.static(path.join(__dirname, '..', 'public')));

  const mode = nearClient.mode || 'mock';

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', mode });
  });

  app.post('/api/parse', async (req, res) => {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (!parseFn) {
      return res.status(500).json({ error: 'Parser module is not available' });
    }
    if (!guardrailsFn) {
      return res.status(500).json({ error: 'Guardrails module is not available' });
    }
    let parsed;
    try {
      // parseInstruction may be sync (rule parser) or async (LLM path).
      parsed = await parseFn(text);
    } catch (err) {
      return res.status(400).json({ error: `Could not parse instruction: ${err.message}` });
    }
    // Parser may return the intent directly or wrapped as {intent}.
    const intent = parsed && parsed.intent ? parsed.intent : parsed;
    if (!intent || typeof intent !== 'object') {
      return res.status(400).json({ error: 'Could not parse instruction into an intent' });
    }
    const settings = store.getSettings();
    const todayTotal = store.getTodayTotal();
    let guardrails;
    try {
      guardrails = normalizeGuardrails(runGuardrails(guardrailsFn, intent, settings, todayTotal));
    } catch (err) {
      return res.status(500).json({ error: `Guardrail evaluation failed: ${err.message}` });
    }
    const pending = store.savePending({
      intent,
      guardrails,
      createdAt: new Date().toISOString(),
    });
    return res.json({ pendingId: pending.id, intent, guardrails, requiresConfirmation: true });
  });

  app.post('/api/confirm', async (req, res) => {
    const { pendingId, confirmed } = req.body || {};
    if (!pendingId) {
      return res.status(400).json({ error: 'pendingId is required' });
    }
    const pending = store.getPending(pendingId);
    if (!pending) {
      return res.status(404).json({ error: 'Pending payment not found' });
    }
    if (confirmed === false) {
      store.deletePending(pendingId);
      return res.json({ cancelled: true });
    }
    if (confirmed !== true) {
      return res.status(400).json({ error: 'confirmed must be true or false' });
    }

    // Re-check guardrails against current settings / today's total.
    if (guardrailsFn) {
      const settings = store.getSettings();
      const todayTotal = store.getTodayTotal();
      let guardrails;
      try {
        guardrails = normalizeGuardrails(runGuardrails(guardrailsFn, pending.intent, settings, todayTotal));
      } catch (err) {
        return res.status(500).json({ error: `Guardrail evaluation failed: ${err.message}` });
      }
      if (!guardrailsPass(guardrails)) {
        return res.status(400).json({
          error: 'Guardrails no longer pass',
          guardrails,
        });
      }
    }

    const intent = pending.intent || {};
    const amount = Number(intent.amount);
    const asset = intent.asset || store.getSettings().asset || 'NEAR';
    const recipient = intent.recipient || null;
    try {
      const receipt = await nearClient.executePayment({
        amount,
        asset,
        recipient,
        memo: intent.memo || null,
        invoiceId: intent.invoiceId || null,
      });
      if (!receipt || typeof receipt !== 'object') {
        throw new Error('Executor returned no receipt');
      }
      // Store the receipt in history, whatever its status (COMPLETED or
      // AWAITING_DEPOSIT). Only COMPLETED counts toward the daily cap
      // (see store.getTodayTotal).
      store.addTransaction({ ...receipt });
      store.deletePending(pendingId);
      return res.json({ receipt });
    } catch (err) {
      // Keep the pending record so the user can retry after fixing the cause.
      return res.status(500).json({ error: `Payment failed: ${err.message}` });
    }
  });

  app.get('/api/history', (_req, res) => {
    const transactions = [...store.getHistory()].sort((a, b) =>
      String(b.timestamp || '').localeCompare(String(a.timestamp || '')),
    );
    res.json({ transactions });
  });

  app.get('/api/settings', (_req, res) => {
    res.json(store.getSettings());
  });

  app.put('/api/settings', (req, res) => {
    const { perTxCap, dailyCap, asset, currency } = req.body || {};
    const patch = {};
    if (perTxCap !== undefined) {
      if (typeof perTxCap !== 'number' || !(perTxCap > 0)) {
        return res.status(400).json({ error: 'perTxCap must be a number greater than 0' });
      }
      patch.perTxCap = perTxCap;
    }
    if (dailyCap !== undefined) {
      if (typeof dailyCap !== 'number' || !(dailyCap > 0)) {
        return res.status(400).json({ error: 'dailyCap must be a number greater than 0' });
      }
      patch.dailyCap = dailyCap;
    }
    // Default payment asset. `asset` is the field name; `currency` is
    // accepted as a legacy alias.
    const rawAsset = asset !== undefined ? asset : currency;
    if (rawAsset !== undefined) {
      const normalized = normalizeAsset(rawAsset);
      if (!normalized) {
        return res.status(400).json({ error: `asset must be one of: ${VALID_ASSETS.join(', ')}` });
      }
      patch.asset = normalized;
    }
    res.json(store.updateSettings(patch));
  });

  app.post('/api/allowlist', (req, res) => {
    const { account, email } = req.body || {};
    const value = account !== undefined ? account : email;
    if (!value || typeof value !== 'string' || !isValidNearAccount(value.trim())) {
      return res.status(400).json({ error: 'A valid NEAR account id is required (e.g. alice.near)' });
    }
    res.json({ allowlist: store.addAllowlist(value) });
  });

  app.delete('/api/allowlist', (req, res) => {
    const { account, email } = req.body || {};
    const value = account !== undefined ? account : email;
    if (!value || typeof value !== 'string' || !isValidNearAccount(value.trim())) {
      return res.status(400).json({ error: 'A valid NEAR account id is required (e.g. alice.near)' });
    }
    res.json({ allowlist: store.removeAllowlist(value) });
  });

  app.get('/api/quote', async (req, res) => {
    const amount = Number(req.query.amount);
    const asset = normalizeAsset(req.query.asset || 'NEAR');
    const recipient = typeof req.query.recipient === 'string' ? req.query.recipient.trim() : '';
    if (!Number.isFinite(amount) || !(amount > 0)) {
      return res.status(400).json({ error: 'amount must be a number greater than 0' });
    }
    if (!asset) {
      return res.status(400).json({ error: `asset must be one of: ${VALID_ASSETS.join(', ')}` });
    }
    if (!recipient || !isValidNearAccount(recipient)) {
      return res.status(400).json({ error: 'recipient must be a valid NEAR account id (e.g. alice.near)' });
    }
    if (typeof nearClient.getQuote !== 'function') {
      return res.status(500).json({ error: 'Quote is not available from this executor' });
    }
    try {
      const quote = await nearClient.getQuote({ amount, asset, recipient });
      return res.json(quote);
    } catch (err) {
      return res.status(500).json({ error: `Quote failed: ${err.message}` });
    }
  });

  // ---- Demo / seed mode (mock mode ONLY — never in oneclick/testnet) ----
  // Lets the demo video be shot from static screenshots: one call puts the
  // app into the exact state the demo script needs (caps, allowlist, history).
  function requireMock(_req, res) {
    if (mode !== 'mock') {
      res.status(403).json({ error: 'Demo seed/reset is only available in mock mode' });
      return false;
    }
    return true;
  }

  const DEMO_TRANSACTIONS = [
    {
      receiptId: 'MOCK-NEAR-DEMO000001',
      txHash: 'MOCK-TX-DEMO000001',
      explorerUrl: 'https://testnet.nearblocks.io/txns/MOCK-TX-DEMO000001',
      status: 'COMPLETED',
      amount: 5,
      asset: 'NEAR',
      recipient: 'alice.near',
      invoiceId: '123',
      memo: 'invoice #123',
      mode: 'mock',
      timestamp: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    },
    {
      receiptId: 'MOCK-NEAR-DEMO000002',
      txHash: 'MOCK-TX-DEMO000002',
      explorerUrl: 'https://testnet.nearblocks.io/txns/MOCK-TX-DEMO000002',
      status: 'COMPLETED',
      amount: 10,
      asset: 'NEAR',
      recipient: 'bob.testnet',
      invoiceId: 'INV-2026-01',
      memo: 'hosting',
      mode: 'mock',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    },
    {
      receiptId: 'MOCK-NEAR-DEMO000003',
      txHash: 'MOCK-TX-DEMO000003',
      explorerUrl: 'https://testnet.nearblocks.io/txns/MOCK-TX-DEMO000003',
      status: 'COMPLETED',
      amount: 2,
      asset: 'NEAR',
      recipient: 'alice.near',
      invoiceId: null,
      memo: 'refund test',
      mode: 'mock',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    },
  ];

  app.post('/api/demo/seed', (req, res) => {
    if (!requireMock(req, res)) return;
    store.resetSettings();
    store.updateSettings({ perTxCap: 50, dailyCap: 200, asset: 'NEAR' });
    store.addAllowlist('alice.near');
    store.addAllowlist('bob.testnet');
    store.clearHistory();
    store.clearPending();
    for (const tx of DEMO_TRANSACTIONS) store.addTransaction({ ...tx });
    res.json({ seeded: true, settings: store.getSettings(), transactions: store.getHistory() });
  });

  app.post('/api/demo/reset', (req, res) => {
    if (!requireMock(req, res)) return;
    store.clearHistory();
    store.clearPending();
    store.resetSettings();
    res.json({ reset: true, settings: store.getSettings(), transactions: [] });
  });

  return app;
}

module.exports = { createApp, normalizeGuardrails, isValidNearAccount, VALID_ASSETS };
