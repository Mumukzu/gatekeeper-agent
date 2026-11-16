// Real Groth16 proof generation for the Gatekeeper track (snarkjs 0.7.6).
//
// Env-gated: PROOF_ENABLED=1, circuit files present, snarkjs + ethers
// installed. Lazy-loaded, so the server still starts (no-proof mode) when
// any of those is missing.
// On ANY failure: returns null — the decision is still returned without
// a proof (keeps the decision score, costs the -2 missing-proof penalty).
// Never crashes a response, never fabricates a proof.
// PROOF_REUSED never gets a proof (the platform excludes it from the
// reliability bonus, so there is nothing to prove).
//
// Flow (exact, from the live-validated participant repo
// subastian1998/agent-games-season-01, gatekeeper/prove.js):
// snarkjs.groth16.fullProve(input, wasm, zkey), ~0.4-0.7s; 13 inputs =
// 10 task fields verbatim as strings + decision ("1" APPROVE / "0"
// REJECT) + taskId (keccak256(task_id UTF-8) mod FIELD_PRIME) + salt
// (fresh randomBytes(32) per proof). Response carries top-level `proof`
// + `public_signals` (13 values). The circuit enforces the decision —
// a wrong decision fails witness generation (line 102 assert).
// Local verify (against the vk exported from the official zkey) runs on
// every proof before it is returned: a proof that does not verify
// locally is dropped, never sent.
// OPEN ITEM (repo's own): the taskId mapping (keccak) is the default and
// UNCONFIRMED against the platform until a practice task verifies it.
// Local verification cannot confirm it.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const WASM = process.env.PROOF_WASM || new URL('./circuits/gatekeeper.wasm', import.meta.url).pathname;
const ZKEY = process.env.PROOF_ZKEY || new URL('./circuits/gatekeeper_final.zkey', import.meta.url).pathname;

let deps = undefined; // { snarkjs, ethers } | null (tried, missing) | undefined (untried)
let vkPromise = null;
let available = null; // null = untested, true/false = self-test result

function loadDeps() {
  if (deps !== undefined) return deps;
  try {
    const require = createRequire(import.meta.url);
    deps = { snarkjs: require('snarkjs'), ethers: require('ethers') };
  } catch {
    deps = null;
  }
  return deps;
}

export function isProofEnabled() {
  return process.env.PROOF_ENABLED === '1';
}

function taskIdField(ethers, taskId) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(taskId));
  return (BigInt(hash) % FIELD_PRIME).toString();
}

function saltField() {
  return (BigInt('0x' + randomBytes(32).toString('hex')) % FIELD_PRIME).toString();
}

function buildInputs(ethers, envelope, decision) {
  const input = envelope.input;
  return {
    registeredVkHash: input.registered_vk,
    proofVkHash: input.proof_vk,
    minimum: String(input.minimum),
    publicBalance: String(input.public_balance),
    expiryBlock: String(input.expiry_block),
    currentBlock: String(input.current_block),
    recipient: input.recipient,
    conditionRecipient: input.condition_recipient,
    amount: String(input.amount),
    maxTransfer: String(input.max_transfer),
    decision: decision === 'APPROVE' ? '1' : '0',
    taskId: taskIdField(ethers, String(envelope.task_id ?? '')),
    salt: saltField(),
  };
}

async function getVk(snarkjs) {
  if (!vkPromise) vkPromise = snarkjs.zKey.exportVerificationKey(ZKEY);
  return vkPromise;
}

// Core prove + local verify. Returns { proof, publicSignals } or null.
// Never throws for proof errors.
async function proveOnce(envelope, decision) {
  const d = loadDeps();
  if (!d) return null;
  const { snarkjs, ethers } = d;
  try {
    const input = buildInputs(ethers, envelope, decision);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    const vk = await getVk(snarkjs);
    const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    if (!ok) {
      console.error('[proof] locally generated proof FAILED verification; dropping it');
      return null;
    }
    return { proof, publicSignals };
  } catch (err) {
    console.error(`[proof] generation failed for ${envelope.task_id}: ${String(err.message).slice(0, 200)}`);
    return null;
  }
}

const SELF_TEST_ENVELOPE = {
  task_id: 'gk_selftest_1',
  input: {
    registered_vk: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
    proof_vk: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
    minimum: '1000',
    public_balance: '1460',
    expiry_block: 8430000,
    current_block: 8420000,
    recipient: '0xDe429f01',
    condition_recipient: '0xDe429f01',
    amount: '500',
    max_transfer: '1000',
    proof_tx: '0xselftest',
  },
};

// One-time startup self-test: a valid APPROVE proof + local verify.
// Returns true only if proving works end-to-end on this machine.
export async function initProof() {
  if (available !== null) return available;
  available = false;
  if (!isProofEnabled()) return false;
  if (!existsSync(WASM) || !existsSync(ZKEY)) {
    console.error('[proof] circuit files missing; proofs disabled');
    return false;
  }
  if (!loadDeps()) {
    console.error('[proof] snarkjs/ethers not installed; proofs disabled');
    return false;
  }
  const t0 = Date.now();
  const result = await proveOnce(SELF_TEST_ENVELOPE, 'APPROVE');
  if (result) {
    available = true;
    console.log(`[proof] self-test PASS (${Date.now() - t0}ms); proofs enabled`);
    return true;
  }
  console.error('[proof] self-test FAILED (no proof produced); proofs disabled');
  return false;
}

// Returns { proof, publicSignals } or null (never throws for proof errors).
export async function attachProof(envelope, { decision, reason_code }) {
  if (!isProofEnabled()) return null;
  if (reason_code === 'PROOF_REUSED') return null;
  if (available === false) return null;
  if (available === null && !(await initProof())) return null;
  const t0 = Date.now();
  const result = await proveOnce(envelope, decision);
  if (result) console.log(`[proof] proved ${envelope.task_id} ${decision} in ${Date.now() - t0}ms`);
  return result;
}
