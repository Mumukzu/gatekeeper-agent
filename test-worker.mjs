// Spot-checks that worker.js's decide() copy matches the Node decide.js.
// The Worker file is self-contained for dashboard paste, so its decision
// logic is duplicated there; this test re-runs the key fixtures against
// the Worker copy so a drift is caught. Run: npm test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decide as decideWorker } from './worker.js';
import { decide as decideNode } from './decide.js';

const BASE = {
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
};

const CASES = [
  ['valid', { ...BASE }, false],
  ['vk substitution', { ...BASE, proof_vk: '0xa4c1b8ff' }, false],
  ['threshold fail', { ...BASE, public_balance: '999' }, false],
  ['threshold edge', { ...BASE, public_balance: '1000' }, false],
  ['reused', { ...BASE }, true],
  ['expired edge', { ...BASE, current_block: 19842201 }, false],
  ['expiry edge ok', { ...BASE, current_block: 19842200 }, false],
  ['recipient mismatch', { ...BASE, recipient: '0xBaddcafe' }, false],
  ['amount overflow', { ...BASE, amount: '1001' }, false],
  ['amount edge', { ...BASE, amount: '1000' }, false],
  ['missing field', { minimum: '1' }, false],
];

for (const [name, input, seenHit] of CASES) {
  test(`worker decide matches node decide: ${name}`, () => {
    const seen = { has: () => seenHit };
    assert.deepEqual(decideWorker(input, seen), decideNode(input, seen));
  });
}
