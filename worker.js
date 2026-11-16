// Cloudflare Workers port of the Gatekeeper agent — SINGLE FILE, no deps.
// Deploy: paste into Dashboard -> Workers & Pages -> Create application ->
// Quick Edit, OR `wrangler deploy` (see wrangler.toml).
// Bindings required: HMAC_SECRET (secret, text) and SEEN (KV namespace).
// Endpoints: POST /gatekeeper (also POST / — the dashboard registers one
// URL, and either shape must work) and GET /health.
// Same protocol as server.js: verify x-agent-games-signature (HMAC-SHA256)
// on the RAW body before parsing; sign every response the same way.
// Same decision logic as decide.js (duplicated here so this file stays
// self-contained for dashboard paste; test-worker.mjs re-runs the key
// fixtures against this copy — keep the two in sync).
// Proof: honest no-proof stub (see proof.js in this repo). HMAC + decision
// is ~1-2 ms CPU, inside the Workers Free 10 ms/invocation cap.

export const REASON_CODES = Object.freeze({
  VALID: 'VALID_CONDITION',
  VK_SUBSTITUTION: 'VK_SUBSTITUTION',
  THRESHOLD_MISMATCH: 'THRESHOLD_MISMATCH',
  PROOF_REUSED: 'PROOF_REUSED',
  EXPIRED_CONDITION: 'EXPIRED_CONDITION',
  RECIPIENT_MISMATCH: 'RECIPIENT_MISMATCH',
  AMOUNT_OVERFLOW: 'AMOUNT_OVERFLOW',
  INVALID_TASK: 'INVALID_TASK',
});

const REQUIRED_FIELDS = [
  'registered_vk',
  'proof_vk',
  'minimum',
  'public_balance',
  'expiry_block',
  'current_block',
  'recipient',
  'condition_recipient',
  'amount',
  'max_transfer',
];

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function sameHex(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

// Priority (documented assumption): single-trap tasks; on multi-fault,
// VK -> reused -> threshold -> expired -> recipient -> amount.
// (Aligned with the live-validated participant repo's checklist order.)
export function decide(input, seen) {
  const reject = (reason_code) => ({ decision: 'REJECT', reason_code });
  if (!input || typeof input !== 'object') return reject(REASON_CODES.INVALID_TASK);
  for (const field of REQUIRED_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      return reject(REASON_CODES.INVALID_TASK);
    }
  }
  if (!sameHex(input.proof_vk, input.registered_vk)) return reject(REASON_CODES.VK_SUBSTITUTION);
  const proofTx = input.proof_tx;
  if (typeof proofTx === 'string' && proofTx !== '' && seen && seen.has(proofTx)) {
    return reject(REASON_CODES.PROOF_REUSED);
  }
  const minimum = toBigInt(input.minimum);
  const balance = toBigInt(input.public_balance);
  if (minimum === null || balance === null) return reject(REASON_CODES.INVALID_TASK);
  if (balance < minimum) return reject(REASON_CODES.THRESHOLD_MISMATCH);
  const expiry = toBigInt(input.expiry_block);
  const current = toBigInt(input.current_block);
  if (expiry === null || current === null) return reject(REASON_CODES.INVALID_TASK);
  if (current >= expiry) return reject(REASON_CODES.EXPIRED_CONDITION);
  if (!sameHex(input.recipient, input.condition_recipient)) {
    return reject(REASON_CODES.RECIPIENT_MISMATCH);
  }
  const amount = toBigInt(input.amount);
  const max = toBigInt(input.max_transfer);
  if (amount === null || max === null) return reject(REASON_CODES.INVALID_TASK);
  if (amount > max) return reject(REASON_CODES.AMOUNT_OVERFLOW);
  return { decision: 'APPROVE', reason_code: REASON_CODES.VALID };
}

async function importKey(secret) {
  const raw = new TextEncoder().encode(secret);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

function hexToBytes(hex) {
  const clean = hex.trim().toLowerCase().replace(/^sha256=/, '');
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) return null;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifySig(key, rawBody, signature) {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const sigBytes = hexToBytes(signature);
  if (!sigBytes) return false;
  return crypto.subtle.verify('HMAC', key, sigBytes, rawBody);
}

async function signBody(key, bodyText) {
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyText));
  return bytesToHex(sig);
}

function jsonResponse(status, obj, sig) {
  const body = JSON.stringify(obj);
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'x-agent-games-signature': sig ?? '',
    },
  });
}

// KV-backed seen-set + decision record. Falls back to in-memory maps when
// no KV binding exists (module-level so state persists across requests
// within one isolate; still lost on recycle — bind KV for production).
const memSeen = new Set();
const memDecisions = new Map();
function makeStore(env) {
  const kv = env.SEEN;
  return {
    async hasProofTx(proofTx) {
      if (kv) return (await kv.get(`proof:${proofTx}`)) !== null;
      return memSeen.has(proofTx);
    },
    async addProofTx(proofTx) {
      if (kv) await kv.put(`proof:${proofTx}`, '1');
      else memSeen.add(proofTx);
    },
    async getDecision(taskId) {
      if (kv) {
        const raw = await kv.get(`task:${taskId}`);
        return raw ? JSON.parse(raw) : null;
      }
      return memDecisions.get(taskId) ?? null;
    },
    async putDecision(taskId, response) {
      if (kv) await kv.put(`task:${taskId}`, JSON.stringify(response));
      else memDecisions.set(taskId, response);
    },
  };
}

const HEALTH_BODY = Object.freeze({
  status: 'ok',
  protocol: 'agent-games.proof-gatekeeper.v1',
  agent: 'gatekeeper',
  version: '0.1.0',
});

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const key = await importKey(env.HMAC_SECRET);
    const sign = (bodyText) => signBody(key, bodyText);

    if (request.method === 'GET' && url.pathname === '/health') {
      const body = JSON.stringify(HEALTH_BODY);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-agent-games-signature': await sign(body),
        },
      });
    }

    if (
      request.method === 'POST' &&
      (url.pathname === '/gatekeeper' || url.pathname === '/')
    ) {
      // Raw body FIRST; verify HMAC before parsing anything.
      const raw = await request.arrayBuffer();
      const signature = request.headers.get('x-agent-games-signature');
      if (!(await verifySig(key, raw, signature))) {
        const body = JSON.stringify({ error: 'invalid_signature' });
        return new Response(body, {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'x-agent-games-signature': await sign(body),
          },
        });
      }

      let envelope;
      try {
        envelope = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        const body = JSON.stringify({ error: 'invalid_json' });
        return new Response(body, {
          status: 400,
          headers: {
            'content-type': 'application/json',
            'x-agent-games-signature': await sign(body),
          },
        });
      }
      if (!envelope || typeof envelope !== 'object') {
        const body = JSON.stringify({ error: 'invalid_envelope' });
        return new Response(body, {
          status: 400,
          headers: {
            'content-type': 'application/json',
            'x-agent-games-signature': await sign(body),
          },
        });
      }

      // Preflight (exact contract, participant repo server.js L215-219):
      // {"type":"agent-games.preflight.v1"} -> 200 signed
      // {"ok":true,"protocolVersion":"v1"}. Answered before task routing.
      if (envelope.type === 'agent-games.preflight.v1') {
        const body = JSON.stringify({ ok: true, protocolVersion: 'v1' });
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-agent-games-signature': await sign(body),
          },
        });
      }

      if (typeof envelope.input !== 'object') {
        const body = JSON.stringify({ error: 'invalid_envelope' });
        return new Response(body, {
          status: 400,
          headers: {
            'content-type': 'application/json',
            'x-agent-games-signature': await sign(body),
          },
        });
      }
      if (envelope.type && envelope.type !== 'agent-games.proof-gatekeeper.v1') {
        const body = JSON.stringify({ error: 'unsupported_type' });
        return new Response(body, {
          status: 400,
          headers: {
            'content-type': 'application/json',
            'x-agent-games-signature': await sign(body),
          },
        });
      }

      const store = makeStore(env);
      const taskId = typeof envelope.task_id === 'string' ? envelope.task_id : null;
      const input = envelope.input;

      if (taskId) {
        const stored = await store.getDecision(taskId);
        if (stored) {
          const body = JSON.stringify(stored);
          return new Response(body, {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-agent-games-signature': await sign(body),
            },
          });
        }
      }

      // decide() is synchronous, but the KV seen-check is async — resolve
      // it FIRST and pass a sync predicate. Passing the raw async
      // hasProofTx made every task with a proof_tx look "reused"
      // (a Promise is truthy), so all real tasks were wrongly rejected.
      const proofTxForReuse =
        typeof input.proof_tx === 'string' && input.proof_tx !== '' ? input.proof_tx : null;
      const isReused = proofTxForReuse ? await store.hasProofTx(proofTxForReuse) : false;
      const seen = { has: () => isReused };
      const { decision, reason_code } = decide(input, seen);
      const response = {
        decision,
        reason_code,
        proof_tx: typeof input.proof_tx === 'string' ? input.proof_tx : null,
      };

      if (typeof input.proof_tx === 'string' && input.proof_tx !== '') {
        await store.addProofTx(input.proof_tx);
      }
      if (taskId) await store.putDecision(taskId, response);

      const body = JSON.stringify(response);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-agent-games-signature': await sign(body),
        },
      });
    }

    const body = JSON.stringify({ error: 'not_found' });
    return new Response(body, {
      status: 404,
      headers: {
        'content-type': 'application/json',
        'x-agent-games-signature': await sign(body),
      },
    });
  },
};
