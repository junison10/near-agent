# NEAR Agent

Natural-language payments on NEAR via **NEAR Intents** — type
`pay 5 USDC to alice.near`, the agent parses it, runs guardrail checks,
asks for confirmation, then executes and returns a receipt.

Built for the **NEAR Hackathon: Build Beyond Boundaries**
(Track: **Agent Economy** — "Give AI a wallet"; secondary: **AI Security &
Defense** via the guardrails / policy engine). Solo entrant: `junison10`.

Adapted from the [PayPal Agent](https://github.com/junison10/paypal-agent) architecture: same
parse → guardrails → confirm → receipt flow, same JSON-file store, same
test patterns — with NEAR account ids, NEAR assets, and the NEAR Intents
executor contract instead of PayPal.

## How it works

1. **Parse** — `src/parser.js` extracts `{ amount, asset, recipient,
   invoiceId, memo }` from English/Indonesian text (rule-based; an LLM path
   via `OPENAI_API_KEY` is optional and always falls back to the rule parser).
   Recipients are NEAR account ids (`alice.near`, `bob.testnet`,
   `sub.alice.near`, or 64-hex implicit accounts). Assets: NEAR, USDC, USDT,
   wNEAR (default NEAR).
2. **Guardrails** — `src/guardrails.js` checks amount present/positive,
   per-transaction cap, daily cap, and the allowlist. Caps are in units of
   the payment asset.
3. **Confirm** — nothing executes until the user presses Confirm. The
   guardrails are re-checked at confirm time.
4. **Execute** — `src/nearClient.js` (executor) runs the payment via NEAR
   Intents / testnet and returns a receipt
   (`COMPLETED` or `AWAITING_DEPOSIT`); the receipt is stored in history.

## Run

```bash
cp .env.example .env   # optional; mock mode needs nothing
npm install
npm start              # http://localhost:3001 (mock mode by default)
npm test               # node --test, no network
```

Modes (`NEAR_MODE`, default `mock` — live modes run only when explicitly set):

| Mode | Executor |
| --- | --- |
| `mock` | Simulated receipts (`MOCK-NEAR-…`, `MOCK-TX-…`), no network |
| `oneclick` | NEAR Intents 1Click API (optional `ONECLICK_JWT`; unauthenticated works, +0.25% fee) |
| `testnet` | Direct NEAR testnet (`NEAR_TESTNET_ACCOUNT_ID` + `NEAR_TESTNET_PRIVATE_KEY`) |

## API

- `GET /api/health` → `{ status: 'ok', mode }`
- `POST /api/parse { text }` → `{ pendingId, intent, guardrails, requiresConfirmation: true }`
- `POST /api/confirm { pendingId, confirmed }` → `{ receipt }` (or `{ cancelled: true }`)
- `GET /api/history`, `GET /api/settings`, `PUT /api/settings { perTxCap, dailyCap, asset }`
- `POST /api/allowlist { account }`, `DELETE /api/allowlist { account }` (NEAR accounts only)
- `GET /api/quote?amount=&asset=&recipient=`
- `POST /api/demo/seed`, `POST /api/demo/reset` — mock mode only

## Files

- `src/parser.js`, `src/guardrails.js`, `src/store.js`, `src/server.js`, `src/index.js`
- `src/nearClient.js` — the executor: mock / 1Click / testnet modes behind one
  interface (`getQuote`, `executePayment`, `getStatus` for 1Click)
- `public/` — vanilla JS UI (chat + settings + allowlist + history)
- `tests/` — `node --test`, no network (stub clients / fake fetch only)

## Hackathon submission (NEAR: Build Beyond Boundaries)

- **Deadline:** Fri 14 Nov 2026, 23:59 UTC = **Sun 15 Nov 2026, 06:59 WIB**.
- **Track:** Agent Economy (primary); AI Security & Defense (secondary — the
  guardrails/policy engine). The form lets you select every track the project fits.
- **To submit:** public GitHub repo + public demo post on X (tag
  `@NEARProtocol`, `#NEARHackathon`, video or screenshots) + the form at
  nearhackathon.com (name, description, team lead/email/size, track, NEAR
  payout address, repo + demo links). Still needed from the entrant: a NEAR
  account address for the payout, the demo video/post, and the GitHub upload.
- **Live-mode notes:** mock mode demos the full flow with no credentials.
  `testnet` mode needs a funded testnet account (`NEAR_TESTNET_ACCOUNT_ID` +
  `NEAR_TESTNET_PRIVATE_KEY`, NEAR only in v1). `oneclick` mode returns a real
  quote + deposit address and `AWAITING_DEPOSIT` — the deposit must be sent to
  that address before 1Click executes; there is no testnet Intents, so use
  small amounts live.
