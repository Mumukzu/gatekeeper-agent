// Server integration tests: HMAC verification, signed responses, idempotency,
// PROOF_REUSED across requests, health endpoint.
// Run: npm test   (or: node --test test-server.mjs)
// Spawns the real server on an ephemeral port with a throwaway test secret.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const SECRET = 'test-secret-32-bytes-long-0123456789';
const TASK = {
  type: 'agent-games.proof-gatekeeper.v1',
  task_id: 'gk_test_1',
  mode: 'competition',
  input: {
    registered_vk: '0x7d3af291',
    proof_vk: '0x7d3af291',
    minimum: '1000',
    public_balance: '1460',
    expiry_block: 19842201,
    current_block: 19832000,
    recipient: '0xDe429f01',
    condition_recipient: '0xDe429f01',
    amount: '500',
    max_transfer: '1000',
    proof_tx: '0xa4c18ff1',
  },
};

function sign(body) {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

function verifyResponseSig(res, bodyText) {
  const sig = res.headers.get('x-agent-games-signature');
  assert.ok(sig, 'response must carry x-agent-games-signature');
  assert.equal(sig, sign(bodyText), 'response signature must verify');
}

let base;
let child;
let tmpDir;

test.before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gk-test-'));
  child = spawn('node', ['server.js'], {
    cwd: new URL('.', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: '0',
      AGENT_GAMES_HMAC_SECRET: SECRET,
      STATE_FILE: join(tmpDir, 'state.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for the listen line, then read the port from it.
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/listening on [\d.]+:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.stderr.on('data', (d) => {
      buf += d;
    });
  });
  base = `http://127.0.0.1:${port}`;
});

test.after(() => {
  child.kill();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function postTask(task, sigOverride) {
  const body = JSON.stringify(task);
  const headers = { 'content-type': 'application/json' };
  if (sigOverride !== null) {
    headers['x-agent-games-signature'] = sigOverride === undefined ? sign(body) : sigOverride;
  }
  const res = await fetch(`${base}/gatekeeper`, { method: 'POST', headers, body });
  const text = await res.text();
  return { res, text, json: text ? JSON.parse(text) : null };
}

test('GET /health -> 200, signed, status ok', async () => {
  const res = await fetch(`${base}/health`);
  const text = await res.text();
  assert.equal(res.status, 200);
  verifyResponseSig(res, text);
  assert.equal(JSON.parse(text).status, 'ok');
});

test('POST valid signed task -> 200 APPROVE, signed response', async () => {
  const { res, text, json } = await postTask(TASK);
  assert.equal(res.status, 200);
  verifyResponseSig(res, text);
  assert.deepEqual(json, {
    decision: 'APPROVE',
    reason_code: 'VALID_CONDITION',
    proof_tx: '0xa4c18ff1',
  });
});

test('POST same task_id again -> same decision (idempotent replay, no false REUSED)', async () => {
  const { res, json } = await postTask(TASK);
  assert.equal(res.status, 200);
  assert.equal(json.decision, 'APPROVE');
  assert.equal(json.reason_code, 'VALID_CONDITION');
});

test('POST same proof_tx, new task_id -> REJECT PROOF_REUSED', async () => {
  const task2 = { ...TASK, task_id: 'gk_test_2' };
  const { res, json } = await postTask(task2);
  assert.equal(res.status, 200);
  assert.deepEqual(json, {
    decision: 'REJECT',
    reason_code: 'PROOF_REUSED',
    proof_tx: '0xa4c18ff1',
  });
});

test('POST preflight -> 200 signed {ok:true, protocolVersion:"v1"}', async () => {
  const body = JSON.stringify({ type: 'agent-games.preflight.v1' });
  const res = await fetch(`${base}/gatekeeper`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-games-signature': sign(body),
    },
    body,
  });
  const text = await res.text();
  assert.equal(res.status, 200);
  verifyResponseSig(res, text);
  assert.deepEqual(JSON.parse(text), { ok: true, protocolVersion: 'v1' });
});

test('POST preflight with bad signature -> 401', async () => {
  const body = JSON.stringify({ type: 'agent-games.preflight.v1' });
  const res = await fetch(`${base}/gatekeeper`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-games-signature': 'deadbeef',
    },
    body,
  });
  assert.equal(res.status, 401);
});

test('POST trap task -> correct REJECT', async () => {
  const trap = {
    ...TASK,
    task_id: 'gk_test_3',
    input: { ...TASK.input, proof_vk: '0xa4c1b8ff', proof_tx: '0x9999' },
  };
  const { res, json } = await postTask(trap);
  assert.equal(res.status, 200);
  assert.deepEqual(json, {
    decision: 'REJECT',
    reason_code: 'VK_SUBSTITUTION',
    proof_tx: '0x9999',
  });
});

test('POST bad signature -> 401', async () => {
  const { res } = await postTask(TASK, 'deadbeef');
  assert.equal(res.status, 401);
});

test('POST unsigned -> 401', async () => {
  const { res } = await postTask(TASK, null);
  assert.equal(res.status, 401);
});

test('POST tampered body (valid sig for other body) -> 401', async () => {
  const body = JSON.stringify({ ...TASK, task_id: 'gk_test_tampered' });
  const res = await fetch(`${base}/gatekeeper`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-games-signature': sign(JSON.stringify(TASK)), // sig for a DIFFERENT body
    },
    body,
  });
  assert.equal(res.status, 401);
});

test('POST malformed JSON (signed) -> 400', async () => {
  const body = '{not json';
  const res = await fetch(`${base}/gatekeeper`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-games-signature': sign(body),
    },
    body,
  });
  assert.equal(res.status, 400);
});

test('unknown route -> 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});
