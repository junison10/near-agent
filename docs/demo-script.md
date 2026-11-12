# Demo script — NEAR Agent (< 3:00, X + YouTube)

Total runtime target: **~2:00–2:20**. Format: **slideshow + voiceover** — static
screenshots of the running app, one per shot, with the narration below read
over them, assembled with ffmpeg. No screen recording needed. Take the
screenshots at 1080p (browser window maximised, 1920×1080) so each slide
fills the frame; make sure the mock-mode badge and the warning banner are
visible in shot 1.

**Before screenshots:** start the server (`npm start`, port 3001), then seed
the demo state with one call (mock mode only):

```sh
curl -X POST http://localhost:3001/api/demo/seed
```

That sets per-transaction cap **50**, daily cap **200**, asset **NEAR**,
allowlist `alice.near` + `bob.testnet`, and 3 sample completed payments
in history. Keep the server in mock mode for the screenshots (no
credentials needed). To wipe the demo data afterwards:
`curl -X POST http://localhost:3001/api/demo/reset`.

## Screenshot list (one file per shot — take these in order)

| # | File | State on screen | How to reach it |
|---|---|---|---|
| 1 | `shot-01-empty.png` | Empty chat, header + badges + warning banner | Fresh load of http://localhost:3001 after `POST /api/demo/reset` |
| 2 | `shot-02-parsed.png` | Confirmation card for the 5 USDC payment, intent fields visible | Type `pay 5 USDC to alice.near for invoice #123`, Send |
| 3a | `shot-03a-guardrails-pass.png` | Same card, guardrail list all green, Confirm enabled | Same as shot 2 (scroll card to center) |
| 3b | `shot-03b-blocked-cap.png` | Blocked card: 100 NEAR, per-tx-cap check failed, Confirm greyed out | Type `pay 100 NEAR to alice.near for invoice #124`, Send; then Cancel it |
| 3c | `shot-03c-blocked-allowlist.png` | Blocked card: 5 NEAR to eve.near, allowlist check failed, Confirm greyed out | Type `pay 5 NEAR to eve.near`, Send; then Cancel it |
| 4 | `shot-04-receipt.png` | Receipt card: COMPLETED, 5 USDC, receipt + tx IDs | On the shot-2 card, click **Confirm & pay** |
| 5 | `shot-05-history.png` | Right panel: history list + settings + allowlist | Scroll the side panel into view (seeded history already there) |
| 6 | `shot-06-wrap.png` | Full app / chat view | Scroll back to the top of the chat |

Narration is read over the matching slide; hold each slide for the full
duration of its shot (see timings below).

---

## 0:00–0:19 — Intro + problem

**Slide:** `shot-01-empty.png` — the app homepage, full window.

**Say (exact lines):**

> "Paying someone on-chain should be as easy as telling someone to pay
> them. But today it's still copy the wallet address, open the wallet, type
> the amount — and hope you didn't mistype anything. This is NEAR Agent:
> you just type what you want, in plain language, and it handles the rest
> — safely, on NEAR."

**Screenshot:** fresh load of the app after `POST /api/demo/reset` (empty
chat). Let the viewer read the header
("NEAR Agent — bayar pakai bahasa natural di NEAR, via NEAR Intents") and
the "mode: mock" badge.

## 0:19–0:36 — Type a payment, watch it parse

**Slide:** `shot-02-parsed.png` — chat area with the confirmation card.

**Say:**

> "Let's pay a supplier. I type: pay five U-S-D-C to alice dot near for
> invoice one-two-three — and hit Send."

**Screenshot:** type `pay 5 USDC to alice.near for invoice #123` by hand
and hit Send. Wait for the confirmation card to appear, then capture the
screen.

**Say (as the card appears):**

> "The agent parsed it: five U-S-D-C, to alice dot near, invoice
> one-two-three. That's the intent card — everything it understood, before
> any money moves."

## 0:36–0:51 — Guardrails panel, all green

**Slide:** `shot-03a-guardrails-pass.png` — the same card, guardrail list
in view.

**Say:**

> "Before I can pay, it checks the guardrails: amount present, under my
> fifty-unit per-transaction cap, under my daily cap, and the recipient is
> on my allowlist. All green — so Confirm is enabled. But watch what
> happens when a payment breaks the rules."

**Screenshot:** the shot-2 confirmation card with the guardrail list
visible (scroll the card to the center).

## 0:51–1:03 — Over-cap attempt blocked

**Slide:** `shot-03b-blocked-cap.png` — blocked card, per-tx-cap failed.

**Say:**

> "One hundred NEAR is over my fifty-unit cap, so this check fails — and
> look, the Confirm button is greyed out. The agent refuses to pay. No
> override, no silent retry. Cancel it, and nothing happened."

**Screenshot:** type `pay 100 NEAR to alice.near for invoice #124` and hit
Send; capture the new card showing the failed per-tx-cap check and the
disabled Confirm button. Then click **Cancel** on it (the receipt area says
"Payment cancelled — no funds moved").

## 1:03–1:14 — Non-allowlist attempt blocked

**Slide:** `shot-03c-blocked-allowlist.png` — blocked card, allowlist failed.

**Say:**

> "Same story for a stranger: eve dot near is not on my allowlist, so the
> allowlist check fails and this payment is blocked too. Only people I added
> can ever be paid."

**Screenshot:** type `pay 5 NEAR to eve.near` and hit Send; capture the
new card showing the failed allowlist check and the disabled Confirm
button. Then click **Cancel** on it.

## 1:14–1:33 — Confirm → execute → receipt

**Slide:** `shot-04-receipt.png` — the receipt card. (The first (5 USDC)
confirmation card from shot 2 — scroll back up to it.)

**Say:**

> "Back to the good payment. Everything passes, so I press Confirm — and
> this is the only moment money moves."

**Screenshot:** click **Confirm & pay** on the 5 USDC card; wait for the
receipt card, then capture the screen.

**Say:**

> "Done. The agent executed it through NEAR Intents and here's the
> receipt: status completed, five U-S-D-C to alice dot near, with a receipt
> ID and a transaction hash. Mock mode here, so no real funds moved."

**Note:** in mock mode the IDs read `MOCK-NEAR-…` / `MOCK-TX-…`. The
receipt links to testnet.nearblocks.io. If a real testnet transfer is ever
shot instead, say "testnet" in the narration instead of "mock".

## 1:33–1:48 — History + settings / allowlist tour

**Slide:** `shot-05-history.png` — the side panel: history list, settings,
allowlist.

**Say:**

> "Every payment lands in the history — newest first, with status, amount,
> and IDs. That's the audit log. And here are the controls: the
> per-transaction and daily caps, the asset, and the allowlist. Change any
> of them and the next payment respects it immediately."

**Screenshot:** scroll the right-hand panel into view; the seeded history
(the 5 USDC payment at the top, plus the three demo payments) and the
settings/allowlist are already there from `POST /api/demo/seed`.

## 1:48–2:00 — Wrap-up + track callout

**Slide:** `shot-06-wrap.png` — full app / chat view.

**Say:**

> "NEAR Agent: natural language in, guardrailed NEAR payment out — parse,
> check, confirm, receipt. Built for the NEAR Hackathon: Build Beyond
> Boundaries, in the Agent Economy track. Link and code in the description.
> Thanks for watching."

**Screenshot:** scroll back to the top of the chat. Stop the voiceover at
or before 2:20.

---

## Checklist before screenshots

- [ ] Server running (`npm start`, port 3001), app open at http://localhost:3001
- [ ] Demo state seeded: `curl -X POST http://localhost:3001/api/demo/seed`
      (caps 50/200, allowlist alice.near + bob.testnet,
      3 sample payments in history)
- [ ] `alice.near` on the allowlist (done by the seed call); `eve.near` NOT
      on the allowlist (used for the blocked shot)
- [ ] Know which mode you're in — mock mode simulates execution with no
      credentials; oneclick/testnet modes need credentials and move real funds
- [ ] No real credentials, passwords, or API keys visible on screen at any point
- [ ] After screenshots: `curl -X POST http://localhost:3001/api/demo/reset`
      to wipe demo data before the real submission
