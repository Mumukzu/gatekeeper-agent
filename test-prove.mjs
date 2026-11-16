// Proof tests (real Groth16, official circuit files in ./circuits/).
// Slow (~3s): fullProve ~0.7s per case. Skipped when circuits or
// snarkjs/ethers are absent. Run via `npm test` (--test-force-exit:
// snarkjs keeps the event loop alive after proving).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

process.env.PROOF_ENABLED = '1';

import { attachProof, initProof } from './prove.js';

const require = createRequire(import.meta.url);
const WASM = new URL('./circuits/gatekeeper.wasm', import.meta.url).pathname;
const ZKEY = new URL('./circuits/gatekeeper_final.zkey', import.meta.url).pathname;
const SKIP = !existsSync(WASM) || !existsSync(ZKEY);

const VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';

function envelope(overrides = {}) {
  return {
    task_id: 'gk_proof_test_1',
    input: {
      registered_vk: VK,
      proof_vk: VK,
      minimum: '1000',
      public_balance: '1460',
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: '0xDe429f01',
      condition_recipient: '0xDe429f01',
      amount: '500',
      max_transfer: '1000',
      proof_tx: '0xproof-test',
      ...overrides,
    },
  };
}

test('startup self-test passes (APPROVE proof + local verify)', { skip: SKIP }, async () => {
  assert.equal(await initProof(), true);
});

test('APPROVE proof verifies and carries decision=1 + keccak taskId', { skip: SKIP }, async () => {
  const snarkjs = require('snarkjs');
  const { ethers } = require('ethers');
  const env = envelope();
  const result = await attachProof(env, { decision: 'APPROVE', reason_code: 'VALID_CONDITION' });
  assert.ok(result, 'expected a proof');
  assert.equal(result.publicSignals.length, 13);
  assert.equal(result.publicSignals[11], '1');
  const expectedTaskId = (BigInt(ethers.keccak256(ethers.toUtf8Bytes('gk_proof_test_1'))) %
    21888242871839275222246405745257275088548364400416034343698204186575808495617n).toString();
  assert.equal(result.publicSignals[12], expectedTaskId);
  const vk = await snarkjs.zKey.exportVerificationKey(ZKEY);
  assert.equal(await snarkjs.groth16.verify(vk, result.publicSignals, result.proof), true);
});

test('REJECT proof verifies and carries decision=0', { skip: SKIP }, async () => {
  const snarkjs = require('snarkjs');
  const env = envelope({ public_balance: '500' }); // below minimum -> threshold trap
  const result = await attachProof(env, { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' });
  assert.ok(result, 'expected a proof');
  assert.equal(result.publicSignals[11], '0');
  const vk = await snarkjs.zKey.exportVerificationKey(ZKEY);
  assert.equal(await snarkjs.groth16.verify(vk, result.publicSignals, result.proof), true);
});

test('PROOF_REUSED never gets a proof', { skip: SKIP }, async () => {
  const env = envelope();
  assert.equal(await attachProof(env, { decision: 'REJECT', reason_code: 'PROOF_REUSED' }), null);
});
