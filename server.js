// Proof Gatekeeper agent server — Node.js stdlib for the HTTP/decide
// path; optional snarkjs + ethers deps for Groth16 proofs (prove.js).
// Without them (or PROOF_ENABLED unset) it serves honest no-proof
// decisions, exactly like the participant repo's fallback.
//
// Endpoints:
//   POST /gatekeeper  — signed task envelope -> signed {decision, reason_code, proof_tx}
//   GET  /health      — signed protocol-v1 JSON (preflight target)
//
// Protocol (official build guide + event page, read 2026-11-15):
// - Verify `x-agent-games-signature` (HMAC-SHA256 hex) against the RAW
//   request body BEFORE parsing. Missing/bad signature -> 401.
// - Decisions are deterministic and instant (no external calls); the
//   60s hard deadline is trivially met. Fail closed: malformed or
//   uncertain tasks are REJECTed, never approved.
// - Every response is signed with `x-agent-games-signature` over the raw
//   response body, using the platform-generated secret (shown once at
//   registration; passed via AGENT_GAMES_HMAC_SECRET env — never commit it).
//
// HEALTH_BODY is PROVISIONAL: the exact preflight contract ("signed
// protocol-v1 JSON") is being extracted from the public participant repo;
// adjust the constant when that lands. Everything else is final.

import { createServer } from 'node:http';
import { signHex, verifyHex } from './hmac.js';
import { decide } from './decide.js';
import { attachProof, initProof } from './proof.js';
import { State } from './state.js';

const TASK_TYPE = 'agent-games.proof-gatekeeper.v1';
const MAX_BODY_BYTES = 1_048_576; // 1 MiB — tasks are a few KB

// PROVISIONAL — see header note. Shape to confirm against the participant repo.
const HEALTH_BODY = Object.freeze({
  status: 'ok',
  protocol: 'agent-games.proof-gatekeeper.v1',
  agent: 'gatekeeper',
  version: '0.1.0',
});

const SECRET = process.env.AGENT_GAMES_HMAC_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error(
    'FATAL: AGENT_GAMES_HMAC_SECRET is missing or too short.\n' +
      'Set it to the 32-byte platform-generated secret shown once at registration.\n' +
      'Never commit it; never use a local placeholder in production.',
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const STATE_FILE =
  process.env.STATE_FILE || new URL('./data/state.json', import.meta.url).pathname;

const state = new State(STATE_FILE);

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-agent-games-signature': signHex(SECRET, body),
    'content-length': body.length,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function logLine(req, status, ms, extra = '') {
  const ts = new Date().toISOString();
  console.log(`${ts} ${req.method} ${req.url} -> ${status} ${ms}ms${extra}`);
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  try {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, HEALTH_BODY);
      logLine(req, 200, Date.now() - started);
      return;
    }

    if (req.method === 'POST' && req.url === '/gatekeeper') {
      const raw = await readBody(req);

      // 1. Verify HMAC on the RAW body before parsing anything.
      const signature = req.headers['x-agent-games-signature'];
      if (!verifyHex(SECRET, raw, signature)) {
        sendJson(res, 401, { error: 'invalid_signature' });
        logLine(req, 401, Date.now() - started);
        return;
      }

      // 2. Parse.
      let envelope;
      try {
        envelope = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'invalid_json' });
        logLine(req, 400, Date.now() - started);
        return;
      }
      if (!envelope || typeof envelope !== 'object') {
        sendJson(res, 400, { error: 'invalid_envelope' });
        logLine(req, 400, Date.now() - started);
        return;
      }

      // Preflight (exact contract, from the public participant repo
      // subastian1998/agent-games-season-01 server.js L215-219, L530-534,
      // confirmed live 15 Nov 09:08 UTC): the platform POSTs
      // {"type":"agent-games.preflight.v1"} to the registered endpoint and
      // expects HTTP 200 + signed {"ok":true,"protocolVersion":"v1"}.
      // Answered BEFORE any task routing. A missing HMAC secret makes
      // responses unsigned, which is exactly the observed preflight failure.
      if (envelope.type === 'agent-games.preflight.v1') {
        sendJson(res, 200, { ok: true, protocolVersion: 'v1' });
        logLine(req, 200, Date.now() - started, ' preflight');
        return;
      }

      if (typeof envelope.input !== 'object') {
        sendJson(res, 400, { error: 'invalid_envelope' });
        logLine(req, 400, Date.now() - started);
        return;
      }
      if (envelope.type && envelope.type !== TASK_TYPE) {
        sendJson(res, 400, { error: 'unsupported_type' });
        logLine(req, 400, Date.now() - started);
        return;
      }

      const taskId = typeof envelope.task_id === 'string' ? envelope.task_id : null;
      const input = envelope.input;

      // 3. Idempotency: a retried task_id gets the SAME decision.
      if (taskId && state.getDecision(taskId)) {
        sendJson(res, 200, state.getDecision(taskId));
        logLine(req, 200, Date.now() - started, ` task=${taskId} replay`);
        return;
      }

      // 4. Decide (fail closed) + real Groth16 proof when enabled
      // (attachProof returns null in no-proof mode, on any proof
      // failure, and for PROOF_REUSED — the decision still goes out).
      const seen = { has: (proofTx) => state.hasProofTx(proofTx) };
      const { decision, reason_code } = decide(input, seen);
      const proofData = await attachProof(envelope, { decision, reason_code });
      const response = {
        decision,
        reason_code,
        proof_tx: typeof input.proof_tx === 'string' ? input.proof_tx : null,
      };
      if (proofData) {
        response.proof = proofData.proof;
        response.public_signals = proofData.publicSignals;
      }

      // 5. Record proof reference + decision, persist (best-effort).
      if (typeof input.proof_tx === 'string' && input.proof_tx !== '') {
        state.addProofTx(input.proof_tx);
      }
      if (taskId) state.putDecision(taskId, response);
      state.persist();

      sendJson(res, 200, response);
      logLine(
        req,
        200,
        Date.now() - started,
        ` task=${taskId ?? '?'} ${decision} ${reason_code}${proofData ? ' +proof' : ''}`,
      );
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
    logLine(req, 404, Date.now() - started);
  } catch (err) {
    console.error(`[server] ${req.method} ${req.url} failed: ${err.message}`);
    try {
      sendJson(res, 500, { error: 'internal' });
    } catch {
      /* response already gone */
    }
    logLine(req, 500, Date.now() - started);
  }
});

// Decisions are instant; keep the socket budget inside the 60s platform deadline.
server.headersTimeout = 65_000;
server.requestTimeout = 60_000;

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : PORT;
  console.log(`gatekeeper-agent listening on ${HOST}:${boundPort} (state: ${STATE_FILE})`);
  // Proof self-test runs once at startup (non-blocking); if it fails the
  // server keeps serving no-proof decisions.
  initProof().catch((err) => console.error(`[proof] init failed: ${err.message}`));
});
