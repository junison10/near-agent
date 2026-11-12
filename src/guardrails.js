'use strict';

/**
 * Payment guardrails.
 *
 * NOTE: caps are in units of the payment asset (NEAR, USDC, USDT or wNEAR),
 * not in fiat. perTxCap / dailyCap are compared directly against
 * intent.amount, and todaysTotal must be summed in the same asset.
 * The asset label shown in check details comes from the payment
 * intent's own asset (falling back to settings.asset, then a legacy
 * settings.currency, then NEAR) — so a 5 USDC payment is labelled
 * "5 USDC", never "5 NEAR".
 *
 * @param {object} intent - { amount, asset, recipient, ... }
 * @param {object} [settings] - { perTxCap: 50, dailyCap: 200, asset: 'NEAR', allowlist: [] }
 * @param {number} [todaysTotal] - amount already sent today (same asset)
 * @returns {{ passed: boolean, checks: Array<{ rule: string, passed: boolean, detail: string }> }}
 */
function evaluateGuardrails(intent, settings = {}, todaysTotal = 0) {
  const {
    perTxCap = 50,
    dailyCap = 200,
    allowlist = [],
  } = settings || {};
  // Asset label: the payment's own asset wins; fall back to settings.
  const asset = (intent && intent.asset)
    || (settings && (settings.asset || settings.currency))
    || 'NEAR';

  const amount = intent ? intent.amount : null;
  const recipient = intent ? intent.recipient : null;
  const totalToday = Number(todaysTotal) || 0;

  const amountIsNumber = typeof amount === 'number' && Number.isFinite(amount);
  const amountIsPositive = amountIsNumber && amount > 0;
  const recipientIsPresent = typeof recipient === 'string' && recipient.trim().length > 0;

  const checks = [
    {
      rule: 'amount_present',
      passed: amountIsPositive,
      detail: amountIsPositive
        ? `Amount is present: ${amount} ${asset}`
        : 'Amount is missing or not a positive number',
    },
    {
      rule: 'recipient_present',
      passed: recipientIsPresent,
      detail: recipientIsPresent
        ? `Recipient is present: ${recipient}`
        : 'Recipient is missing',
    },
    {
      rule: 'amount_positive',
      passed: amountIsPositive,
      detail: amountIsPositive
        ? `Amount is positive: ${amount}`
        : `Amount must be greater than 0 (got ${amount === null || amount === undefined ? 'none' : amount})`,
    },
    {
      rule: 'per_tx_cap',
      passed: amountIsPositive && amount <= perTxCap,
      detail: !amountIsPositive
        ? 'Cannot check per-transaction cap: amount is missing or not positive'
        : amount <= perTxCap
          ? `Amount ${amount} is within the per-transaction cap of ${perTxCap} ${asset}`
          : `Amount ${amount} exceeds the per-transaction cap of ${perTxCap} ${asset}`,
    },
    {
      rule: 'daily_cap',
      passed: amountIsPositive && (totalToday + amount) <= dailyCap,
      detail: !amountIsPositive
        ? 'Cannot check daily cap: amount is missing or not positive'
        : (totalToday + amount) <= dailyCap
          ? `Daily total ${totalToday + amount} is within the daily cap of ${dailyCap} ${asset}`
          : `Daily total ${totalToday + amount} exceeds the daily cap of ${dailyCap} ${asset}`,
    },
    (() => {
      if (!Array.isArray(allowlist) || allowlist.length === 0) {
        return {
          rule: 'allowlist',
          passed: true,
          detail: 'allowlist empty — any recipient allowed',
        };
      }
      const allowed = allowlist.some(
        (entry) => typeof entry === 'string'
          && recipientIsPresent
          && entry.trim().toLowerCase() === recipient.trim().toLowerCase(),
      );
      return {
        rule: 'allowlist',
        passed: allowed,
        detail: allowed
          ? `Recipient ${recipient} is on the allowlist`
          : `Recipient ${recipient || '(none)'} is not on the allowlist`,
      };
    })(),
  ];

  return { passed: checks.every((c) => c.passed), checks };
}

module.exports = { evaluateGuardrails };
