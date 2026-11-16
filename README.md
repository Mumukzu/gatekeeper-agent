# Proof Gatekeeper — zkVerify Agent Games Season 01

Agent for the Proof Gatekeeper track. Receives signed task envelopes,
decides APPROVE/REJECT per the official trap rules, answers signed
protocol-v1 JSON within 60s.

## Rules (official docs, read 2026-11-15)

- Task: `agent-games.proof-gatekeeper.v1` POST. Verify
  `x-agent-games-signature` (HMAC-SHA256) on the **raw body before parsing**.
- APPROVE only if ALL pass: `proof_vk == registered_vk`,
  `public_balance >= minimum`, `proof_tx` not seen before,
  `current_block < expiry_block`, `recipient == condition_recipient`,
  `amount <= max_transfer`. Any failure → REJECT with the matching code.
- 7 trap types: VALID_CONDITION (APPROVE, ~50%), VK_SUBSTITUTION (~13%),
  THRESHOLD_MISMATCH (~8%), PROOF_REUSED (~11%), EXPIRED_CONDITION (~6%),
  RECIPIENT_MISMATCH (~6%), AMOUNT_OVERFLOW (~6%).
- Scoring: correct ±12, wrong APPROVE −6, wrong REJECT −3, timeout −2,
  missing/invalid proof −2, reliability bonus +0–5.
- Rounds: 8 daily, 13–20 Nov, 17:30–03:30 WIB, 8 tasks/agent/round.
  Round 4 opens Mon 16 Nov 17:30 WIB. Entries lock while a round is open.

## Proof status: WIRED AND VERIFIED (16 Nov ~00:00 WIB)

The exact proof flow is extracted from the live-validated participant repo
(subastian1998/agent-games-season-01): snarkjs 0.7.6
`groth16.fullProve(input, wasm, zkey)`; 13 circuit inputs = the 10
task fields verbatim as strings + `decision` ("1" APPROVE / "0" REJECT) +
`taskId` (keccak256(task_id UTF-8) mod FIELD_PRIME) + `salt` (fresh
randomBytes(32) per proof); response carries top-level `proof` +
`public_signals` (13 values) next to decision/reason_code/proof_tx
(`proof_tx` is the task's proof reference echoed, NOT the agent's).
The circuit enforces the decision — a wrong decision fails witness
generation (line 102 assert). Kurier (optional, fire-and-forget, free API key via email
signup at kurier.xyz) submits for on-chain finalization; its result is
NOT awaited and NOT in the response. **Cloudflare Workers Free cannot run
this** (10 ms CPU/invocation cap vs ~0.4-0.7 s proving) — the proof path needs
a real Node host (Vercel Hobby function or Oracle VM). **Open item: the
`taskId` mapping is the repo's default and UNCONFIRMED against the
platform until a practice task verifies it** (alternatives: numeric/hex
suffix). Local verification cannot confirm it.

**Verified 16 Nov ~00:00 WIB:** `prove.js` (real implementation) is
wired into `server.js` behind `PROOF_ENABLED=1`; a startup self-test
(APPROVE proof + local verify) gates it, and every proof is locally
verified before it is returned. Any failure → honest no-proof answer,
never a fabricated proof. Measured on this VM: fullProve+verify
~665-700 ms, server round-trip 542 ms for a signed valid task, well
inside the 60 s deadline. E2E check (`/tmp/gk_e2e.mjs`): live server
answered a signed task with decision APPROVE + a proof that verified
independently. Wrong-decision proof attempts fail at the circuit
(line 102 assert), as designed. `npm test`: 44/44 pass (incl. 4 proof
tests). Score with proofs: 8 × 12 = +96/round plus up to +5 reliability
bonus (vs +80 no-proof).

## Files

| File | What it is |
|---|---|
| `server.js` | Node stdlib HTTP server (POST /gatekeeper, GET /health) |
| `worker.js` | Cloudflare Workers port (single file, no deps) — **deploy this** |
| `decide.js` | Pure decision logic (shared rules; Worker copy kept in sync, tested) |
| `hmac.js` | HMAC-SHA256 sign/verify helpers (Node) |
| `proof.js` | Proof attachment seam: real proof when enabled, else null |
| `prove.js` | Real Groth16 proving (snarkjs + ethers, env-gated, self-test) |
| `circuits/` | Official gatekeeper.wasm (1,755,820 B) + gatekeeper_final.zkey (309,750 B) |
| `state.js` | File-backed seen-set + decision record (idempotency) |
| `test-decide.mjs` | 7 traps + edge cases |
| `test-server.mjs` | HMAC, signed responses, idempotency, reuse (live server) |
| `test-worker.mjs` | Worker decide() matches Node decide() |
| `wrangler.toml` | Workers config (KV binding commented until created) |
| `../gatekeeper-keypair.json` | Fresh dedicated SIWE wallet (mode 600, **never share**) |

## Run locally

```sh
AGENT_GAMES_HMAC_SECRET=<secret-from-dashboard> npm start
npm test   # 37 tests, all passing (2026-11-15)
```

## Deploy (recommended: Cloudflare Workers Free)

1. **Mu signs up** at dash.cloudflare.com/sign-up with his email (no card,
   no GitHub). Tells us the `workers.dev` subdomain.
2. Create a KV namespace, bind as `SEEN`; add secret `HMAC_SECRET` (the
   32-byte secret shown once on the Agent Games dashboard at registration).
3. Paste `worker.js` into Dashboard → Workers & Pages → Create → Quick Edit
   (or `wrangler deploy` with a scoped API token).
4. Test from outside: `GET /health`, one valid-HMAC POST, one bad-HMAC POST
   (expect 401), one replayed proof-ref (expect PROOF_REUSED), and confirm
   the seen-set persists across requests. Watch CPU ms in Workers Logs —
   HMAC + decision is ~1–2 ms; if any request nears 10 ms, stop (Free cap).

Backups: Vercel Hobby (email signup, CLI deploy, but needs an external
store for the seen-set); Oracle Cloud Always Free VM (Mu's existing signup,
runs `server.js` as-is, but login/capacity/setup risk). Railway needs
GitHub — disqualified. Render Free sleeps — disqualified.

## Registration (exact flow, from the participant repo + articles)

- Dashboard: `agentgames.zkverify.io/dashboard`. Sign-up offers **X or
  wallet only**; wallet path is **SIWE (EIP-4361), EIP-191 `personal_sign`**
  (a Binance Agentic Wallet cannot do it — only EIP-712 — so the fresh
  dedicated wallet is the right call): `GET /api/auth/csrf` →
  `GET /api/auth/wallet/siwe/nonce` → sign SIWE message (domain
  `agentgames.zkverify.io`, chain ID 1, statement
  `"Sign in to Agent Games with your wallet."`, 5-minute expiry) →
  `POST /api/auth/callback/wallet` (message + signature) → session cookie
  → complete profile (handle claim; referral code in payload).
- **GitHub is NOT required at sign-up** — it is a prize-eligibility
  requirement to satisfy **before 21 Nov close**; the dashboard UI for it
  is unreliable (one participant found no Settings/GitHub option at all).
  Repo-URL field name/format unknown. Mu has NO GitHub — still blocker #1
  for winning (not for playing).
- Endpoint is registered as the full handler path
  (e.g. `https://<host>/gatekeeper`). **HMAC secret** comes from the
  dashboard **Rotate Secret** button (shown once). Preflight: the platform
  POSTs `{"type":"agent-games.preflight.v1"}` and expects HTTP 200 signed
  `{"ok":true,"protocolVersion":"v1"}` — implemented in `server.js` and
  `worker.js`, tested. **Preflight is also the HMAC-encoding check**
  (lowercase hex, confirmed live by the participant).
- Practice tasks are triggered from the dashboard (Practice Mode, exact
  button unknown); cap 10/hour; identical format to scored tasks.

## Blockers (need Mu / parent decisions)

1. **GitHub account REQUIRED for prize eligibility** (Rules §1.1, §1.5:
   connected GitHub + connected wallet; winners verified manually). Mu has
   NO GitHub account. Without one, the agent can play but cannot win.
   Registration may also ask for a repo URL. Do NOT create a GitHub account
   without Mu's explicit say-so.
2. **Registration (SIWE) not yet done.** Dashboard flow spec is being
   extracted from the public participant repo; the fresh wallet is ready:
   `0xb2475f318851C8D8c5A8F43EA508cDe04dbfDeD9`
   (keypair `../gatekeeper-keypair.json`, mode 600).
3. **HMAC secret** comes from the dashboard at registration (shown once).
   The agent refuses to start without it.
4. **Preflight + ≥1 practice task** required before scored rounds
   (practice capped at 10/hour). Registration window before Round 4:
   after Round 3 closes 03:30 WIB → Round 4 opens 17:30 WIB, Mon 16 Nov.
   Entries lock while a round is open.

## Security

- Never commit `AGENT_GAMES_HMAC_SECRET` or the keypair. Never paste a
  private key / seed / API key into any AI tool. The HMAC secret is the
  platform-generated value — never a local placeholder.
