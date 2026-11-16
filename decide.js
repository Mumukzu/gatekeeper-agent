// Pure decision logic for the Proof Gatekeeper track.
// Rules source: https://agentgames.zkverify.io/events/proof-gatekeeper
// (Trap encyclopedia + score model), read 2026-11-15.
//
// APPROVE only when EVERY check passes. Any failure -> REJECT with the
// matching reason_code. Fail closed: unknown/malformed input is REJECTed,
// never approved.
//
// Priority order when several fields fail at once (documented assumption):
// tasks are designed with ONE intended trap each, so multi-fault ordering
// should rarely matter. Order used — aligned with the live-validated
// participant repo (subastian1998/agent-games-season-01, README "7-trap
// checklist (first failing trap wins)"):
//   VK_SUBSTITUTION -> PROOF_REUSED -> THRESHOLD_MISMATCH ->
//   EXPIRED_CONDITION -> RECIPIENT_MISMATCH -> AMOUNT_OVERFLOW
// Rationale: check the proof's identity first (VK), then uniqueness
// (reuse), then its content (threshold), then validity window (expiry),
// then payment details (recipient, amount).
//
// Edge-case rules (from the official docs / participant articles):
//   - public_balance == minimum  -> VALID (threshold is >=)
//   - amount == max_transfer     -> VALID (cap is <=)
//   - current_block == expiry_block -> EXPIRED (valid only while current < expiry)
//   - addresses / VKs compared case-insensitively (hex)

export const REASON_CODES = Object.freeze({
  VALID: 'VALID_CONDITION',
  VK_SUBSTITUTION: 'VK_SUBSTITUTION',
  THRESHOLD_MISMATCH: 'THRESHOLD_MISMATCH',
  PROOF_REUSED: 'PROOF_REUSED',
  EXPIRED_CONDITION: 'EXPIRED_CONDITION',
  RECIPIENT_MISMATCH: 'RECIPIENT_MISMATCH',
  AMOUNT_OVERFLOW: 'AMOUNT_OVERFLOW',
  INVALID_TASK: 'INVALID_TASK', // fail-closed fallback, not one of the 7 official codes
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

/**
 * Decide a Gatekeeper task.
 * @param {object} input - the task's `input` object.
 * @param {object} seen - object with a `has(proofTx)` method (the seen proof-reference set).
 * @returns {{decision: 'APPROVE'|'REJECT', reason_code: string}}
 */
export function decide(input, seen) {
  const reject = (reason_code) => ({ decision: 'REJECT', reason_code });
  const approve = () => ({ decision: 'APPROVE', reason_code: REASON_CODES.VALID });

  if (!input || typeof input !== 'object') return reject(REASON_CODES.INVALID_TASK);
  for (const field of REQUIRED_FIELDS) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      return reject(REASON_CODES.INVALID_TASK);
    }
  }

  // 1. Verification key must match the registered condition VK.
  if (!sameHex(input.proof_vk, input.registered_vk)) {
    return reject(REASON_CODES.VK_SUBSTITUTION);
  }

  // 2. Proof reference must not have been seen before.
  const proofTx = input.proof_tx;
  if (typeof proofTx === 'string' && proofTx !== '' && seen && seen.has(proofTx)) {
    return reject(REASON_CODES.PROOF_REUSED);
  }

  // 3. Public balance must meet the minimum threshold.
  const minimum = toBigInt(input.minimum);
  const balance = toBigInt(input.public_balance);
  if (minimum === null || balance === null) return reject(REASON_CODES.INVALID_TASK);
  if (balance < minimum) return reject(REASON_CODES.THRESHOLD_MISMATCH);

  // 4. Condition must not be expired (strict: valid while current < expiry).
  const expiry = toBigInt(input.expiry_block);
  const current = toBigInt(input.current_block);
  if (expiry === null || current === null) return reject(REASON_CODES.INVALID_TASK);
  if (current >= expiry) return reject(REASON_CODES.EXPIRED_CONDITION);

  // 5. Recipient must match the condition recipient.
  if (!sameHex(input.recipient, input.condition_recipient)) {
    return reject(REASON_CODES.RECIPIENT_MISMATCH);
  }

  // 6. Amount must not exceed the single-transfer cap.
  const amount = toBigInt(input.amount);
  const max = toBigInt(input.max_transfer);
  if (amount === null || max === null) return reject(REASON_CODES.INVALID_TASK);
  if (amount > max) return reject(REASON_CODES.AMOUNT_OVERFLOW);

  return approve();
}
