'use strict';

/**
 * Rule-based instruction parser (pure, sync) for NEAR payments.
 *
 * Handles English and Indonesian phrasing, e.g.
 *   "bayar 10 NEAR ke alice.near buat invoice #123"
 *   "pay 5 USDC to alice.near"
 *   "kirim 50 ke bob.testnet"
 *
 * Recipients are NEAR account ids: named accounts ending in .near/.testnet
 * (including subaccounts such as sub.alice.near) or 64-hex implicit accounts.
 * No email parsing.
 */

// Named NEAR account: dot-separated lowercase segments ending in .near/.testnet.
// Each segment starts with a letter/digit and may contain lowercase letters,
// digits, '_' and '-'. Matched case-insensitively; the result is lowercased
// (NEAR account ids are lowercase).
const NEAR_NAMED_RE = /\b[a-z0-9][a-z0-9_-]{0,62}(?:\.[a-z0-9][a-z0-9_-]{0,62})*\.(?:near|testnet)\b/i;
// Implicit account: exactly 64 hex characters.
const NEAR_IMPLICIT_RE = /\b[0-9a-f]{64}\b/i;

const ASSET_ALIASES = {
  NEAR: 'NEAR',
  USDC: 'USDC',
  USDT: 'USDT',
  WNEAR: 'wNEAR',
};
const ASSET_RE = /\b(NEAR|USDC|USDT|wNEAR)\b/i;
const INVOICE_RE = /invoice\s*#?\s*([A-Za-z0-9-]+)/i;
const HASH_INVOICE_RE = /#([A-Za-z0-9-]{2,})/;
const MEMO_RE = /(?:buat|for|untuk)\s+(.+)$/i;

/** True when `value` looks like a NEAR account id (named or implicit). */
function isValidNearAccount(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  if (NEAR_IMPLICIT_RE.test(v) && v.length === 64) return true;
  return NEAR_NAMED_RE.test(v) && NEAR_NAMED_RE.exec(v)[0].length === v.length;
}

function normalizeAsset(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toUpperCase();
  return ASSET_ALIASES[key] || null;
}

function parseNumber(raw) {
  // Decimal separator may be '.' or ',' (e.g. "25,50" -> 25.5).
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function extractAmountAsset(text, recipient) {
  let amount = null;
  let asset = null;

  // 1. $ amount, optional asset code right after it ("$25", "$25 USDC").
  //    The "$" is just a number marker here; with no asset code the
  //    default asset (NEAR) applies.
  let m = /\$\s*(\d+(?:[.,]\d{1,6})?)\s?(NEAR|USDC|USDT|wNEAR)?/i.exec(text);
  if (m) {
    amount = parseNumber(m[1]);
    if (m[2]) asset = normalizeAsset(m[2]);
  }

  // 2. Number + explicit asset code ("100 USDC", "5 NEAR", "0.5 wNEAR").
  if (amount === null) {
    m = /(\d+(?:[.,]\d{1,6})?)\s?(NEAR|USDC|USDT|wNEAR)/i.exec(text);
    if (m) {
      amount = parseNumber(m[1]);
      asset = normalizeAsset(m[2]);
    }
  }

  // 3. Number + "dollars"/"usd" word ("100 dollars") -> USDC, the closest
  //    dollar-pegged asset on NEAR.
  if (amount === null) {
    m = /(\d+(?:[.,]\d{1,6})?)\s?(dollars?|usd)/i.exec(text);
    if (m) {
      amount = parseNumber(m[1]);
      asset = 'USDC';
    }
  }

  // 4. Bare number right after a payment verb ("kirim 50 ke ...",
  //    "bayar 25 ...", "pay 50 ..."). This avoids mistaking an
  //    invoice number (after '#') for the amount.
  if (amount === null) {
    m = /(?:bayar|transfer|kirim|pay|send)\s+\$?\s*(\d+(?:[.,]\d{1,6})?)\b/i.exec(text);
    if (m) {
      amount = parseNumber(m[1]);
    }
  }

  // Explicit asset code anywhere in the text (outside the recipient
  // itself, so ".near" in "alice.near" is never read as an asset)
  // wins over the default.
  if (amount !== null && asset === null) {
    const stripped = recipient ? text.replace(recipient, ' ') : text;
    const am = ASSET_RE.exec(stripped);
    if (am) asset = normalizeAsset(am[1]);
  }

  return { amount, asset: asset || 'NEAR' };
}

function extractRecipient(text) {
  const named = NEAR_NAMED_RE.exec(text);
  if (named) return named[0].toLowerCase();
  const implicit = NEAR_IMPLICIT_RE.exec(text);
  if (implicit) return implicit[0].toLowerCase();
  return null;
}

function parseInstructionRule(text) {
  const input = typeof text === 'string' ? text : String(text == null ? '' : text);

  const recipient = extractRecipient(input);
  const { amount, asset } = extractAmountAsset(input, recipient);

  let invoiceId = null;
  const invoiceMatch = INVOICE_RE.exec(input);
  if (invoiceMatch) {
    invoiceId = invoiceMatch[1];
  } else {
    const hashMatch = HASH_INVOICE_RE.exec(input);
    if (hashMatch) invoiceId = hashMatch[1];
  }

  // Memo: text after "buat" / "for" / "untuk", trimmed.
  let memo = null;
  const memoMatch = MEMO_RE.exec(input);
  if (memoMatch) {
    const cleaned = memoMatch[1].trim().replace(/[.\s]+$/, '').trim();
    if (cleaned) memo = cleaned;
  }

  let confidence;
  if (amount !== null && recipient !== null) confidence = 0.9;
  else if (amount !== null) confidence = 0.6;
  else confidence = 0.3;

  return {
    amount,
    asset,
    recipient,
    invoiceId,
    memo,
    confidence,
    method: 'rule',
  };
}

const SYSTEM_PROMPT = [
  'You parse a payment instruction into strict JSON.',
  'Respond with ONLY a JSON object with exactly these keys:',
  'amount (number or null), asset (one of NEAR, USDC, USDT, wNEAR, or null),',
  'recipient (NEAR account id string, e.g. alice.near, bob.testnet, or a 64-hex',
  'implicit account, or null), invoiceId (string or null),',
  'memo (string or null).',
  'Do not add any other keys, explanation, or markdown.',
].join(' ');

function normalizeLlmResult(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM reply is not a JSON object');
  }
  // Missing fields -> fall through to the rule parser.
  if (!('amount' in parsed) || !('recipient' in parsed)) {
    throw new Error('LLM reply is missing required fields');
  }
  let amount = null;
  if (parsed.amount !== null && parsed.amount !== undefined && parsed.amount !== '') {
    amount = typeof parsed.amount === 'number' ? parsed.amount : Number(parsed.amount);
    if (!Number.isFinite(amount)) amount = null;
  }
  // Accept `asset`, with a legacy `currency` key as fallback.
  let asset = 'NEAR';
  const rawAsset = parsed.asset !== undefined ? parsed.asset : parsed.currency;
  if (typeof rawAsset === 'string') {
    asset = normalizeAsset(rawAsset) || 'NEAR';
  }
  const recipient = typeof parsed.recipient === 'string' && parsed.recipient.trim()
    ? parsed.recipient.trim().toLowerCase()
    : null;
  const invoiceId = parsed.invoiceId === null || parsed.invoiceId === undefined
    ? null
    : String(parsed.invoiceId);
  const memo = typeof parsed.memo === 'string' && parsed.memo.trim()
    ? parsed.memo.trim()
    : null;

  let confidence;
  if (amount !== null && recipient !== null) confidence = 0.9;
  else if (amount !== null) confidence = 0.6;
  else confidence = 0.3;

  return { amount, asset, recipient, invoiceId, memo, confidence, method: 'llm' };
}

function extractJsonFromContent(content) {
  const raw = String(content).trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Tolerate ```json fences around the object.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1].trim());
    const braced = raw.match(/\{[\s\S]*\}/);
    if (braced) return JSON.parse(braced[0]);
    throw new Error('LLM reply is not valid JSON');
  }
}

/**
 * Parse a payment instruction.
 * LLM path only when OPENAI_API_KEY is set (and opts.llm !== false);
 * any LLM error falls through to the rule parser.
 * Tests may inject a fake fetch via opts.fetchImpl or opts.fetch.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.llm] - set false to force the rule parser
 * @param {Function} [opts.fetchImpl] - fetch implementation (tests)
 * @param {Function} [opts.fetch] - alias for fetchImpl (tests)
 * @returns {Promise<{amount:number|null,asset:string,recipient:string|null,invoiceId:string|null,memo:string|null,confidence:number,method:'llm'|'rule'}>}
 */
async function parseInstruction(text, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const fetchImpl = opts.fetchImpl || opts.fetch || globalThis.fetch;

  if (opts.llm !== false && apiKey && typeof fetchImpl === 'function') {
    try {
      const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: String(text) },
            ],
          }),
          signal: controller.signal,
        });
        if (!res || !res.ok) throw new Error(`LLM request failed: ${res ? res.status : 'no response'}`);
        const data = typeof res.json === 'function' ? await res.json() : res;
        const content = data && data.choices && data.choices[0]
          && data.choices[0].message && data.choices[0].message.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('LLM reply has no content');
        }
        return normalizeLlmResult(extractJsonFromContent(content));
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Fall through to the rule parser on any LLM error.
    }
  }

  return parseInstructionRule(text);
}

module.exports = { parseInstruction, parseInstructionRule, isValidNearAccount, NEAR_NAMED_RE, NEAR_IMPLICIT_RE };
