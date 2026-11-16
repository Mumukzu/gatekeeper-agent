// Decision-logic tests: the 7 trap types + edge cases.
// Run: npm test   (or: node --test test-decide.mjs)
// Fixtures mirror the official sample task on
// https://agentgames.zkverify.io/events/proof-gatekeeper (read 2026-11-15).

import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, REASON_CODES } from './decide.js';

const BASE = Object.freeze({
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
});

const emptySeen = { has: () => false };
const withSeen = (tx) => ({ has: (p) => p === tx });

test('valid condition -> APPROVE VALID_CONDITION', () => {
  assert.deepEqual(decide({ ...BASE }, emptySeen), {
    decision: 'APPROVE',
    reason_code: 'VALID_CONDITION',
  });
});

test('official sample (VK mismatch) -> REJECT VK_SUBSTITUTION', () => {
  // The event page's own sample: proof_vk 0xa4c1...b8ff != registered_vk
  // 0x7d3a...f291, expected response REJECT / VK_SUBSTITUTION.
  assert.deepEqual(
    decide({ ...BASE, proof_vk: '0xa4c1b8ff' }, emptySeen),
    { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' },
  );
});

test('threshold: balance below minimum -> THRESHOLD_MISMATCH', () => {
  assert.deepEqual(decide({ ...BASE, public_balance: '999' }, emptySeen), {
    decision: 'REJECT',
    reason_code: 'THRESHOLD_MISMATCH',
  });
});

test('threshold edge: balance == minimum is VALID', () => {
  assert.equal(decide({ ...BASE, public_balance: '1000' }, emptySeen).decision, 'APPROVE');
});

test('proof reused -> PROOF_REUSED', () => {
  assert.deepEqual(decide({ ...BASE }, withSeen('0xa4c18ff1')), {
    decision: 'REJECT',
    reason_code: 'PROOF_REUSED',
  });
});

test('expired: current == expiry -> EXPIRED_CONDITION (strict)', () => {
  assert.deepEqual(decide({ ...BASE, current_block: 19842201 }, emptySeen), {
    decision: 'REJECT',
    reason_code: 'EXPIRED_CONDITION',
  });
});

test('expiry edge: current == expiry - 1 is VALID', () => {
  assert.equal(decide({ ...BASE, current_block: 19842200 }, emptySeen).decision, 'APPROVE');
});

test('recipient mismatch -> RECIPIENT_MISMATCH', () => {
  assert.deepEqual(
    decide({ ...BASE, recipient: '0xBaddcafe' }, emptySeen),
    { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' },
  );
});

test('recipient compare is case-insensitive', () => {
  assert.equal(
    decide(
      { ...BASE, recipient: '0xde429f01', condition_recipient: '0xDE429F01' },
      emptySeen,
    ).decision,
    'APPROVE',
  );
});

test('amount overflow -> AMOUNT_OVERFLOW', () => {
  assert.deepEqual(decide({ ...BASE, amount: '1001' }, emptySeen), {
    decision: 'REJECT',
    reason_code: 'AMOUNT_OVERFLOW',
  });
});

test('amount edge: amount == max_transfer is VALID', () => {
  assert.equal(decide({ ...BASE, amount: '1000' }, emptySeen).decision, 'APPROVE');
});

test('multi-fault priority: VK checked before threshold', () => {
  assert.equal(
    decide({ ...BASE, proof_vk: '0xdead', public_balance: '1' }, emptySeen).reason_code,
    'VK_SUBSTITUTION',
  );
});

test('multi-fault priority: REUSED checked before threshold (repo order)', () => {
  assert.equal(
    decide({ ...BASE, public_balance: '1' }, withSeen('0xa4c18ff1')).reason_code,
    'PROOF_REUSED',
  );
});

test('missing field -> REJECT INVALID_TASK (fail closed)', () => {
  const { amount, ...noAmount } = BASE;
  assert.deepEqual(decide(noAmount, emptySeen), {
    decision: 'REJECT',
    reason_code: 'INVALID_TASK',
  });
  assert.deepEqual(decide(null, emptySeen), {
    decision: 'REJECT',
    reason_code: 'INVALID_TASK',
  });
});

test('non-numeric numbers -> REJECT INVALID_TASK', () => {
  assert.equal(decide({ ...BASE, minimum: 'abc' }, emptySeen).reason_code, 'INVALID_TASK');
});

test('huge BigInt values compare correctly', () => {
  const big = { ...BASE, minimum: '1000000000000000000000000000000', public_balance: '999999999999999999999999999999' };
  assert.equal(decide(big, emptySeen).reason_code, 'THRESHOLD_MISMATCH');
  const bigOk = { ...big, public_balance: '1000000000000000000000000000000' };
  assert.equal(decide(bigOk, emptySeen).decision, 'APPROVE');
});

test('all reason codes are the official ones (plus INVALID_TASK fallback)', () => {
  assert.deepEqual(Object.keys(REASON_CODES).sort(), [
    'AMOUNT_OVERFLOW',
    'EXPIRED_CONDITION',
    'INVALID_TASK',
    'PROOF_REUSED',
    'RECIPIENT_MISMATCH',
    'THRESHOLD_MISMATCH',
    'VALID',
    'VK_SUBSTITUTION',
  ]);
});
