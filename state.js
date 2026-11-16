// Persistent state for the Gatekeeper agent: the seen proof-reference set
// (PROOF_REUSED detection) and the per-task decision record (idempotency —
// the platform may retry after a network failure; a retried task_id must
// get the SAME decision, not a fresh PROOF_REUSED).
// File-backed JSON; the seen-set MUST survive restarts, otherwise a
// redeployed agent would approve a reused proof it already rejected.
// NOTE: on stateless serverless hosting this file does not persist — the
// deploy target must provide KV/database persistence instead (see README).

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class State {
  constructor(filePath) {
    this.filePath = filePath;
    this.seenProofTx = new Set();
    this.decisions = new Map();
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(data.seenProofTx)) this.seenProofTx = new Set(data.seenProofTx);
      if (data.decisions && typeof data.decisions === 'object') {
        this.decisions = new Map(Object.entries(data.decisions));
      }
    } catch (err) {
      console.error(`[state] could not load ${this.filePath}: ${err.message}; starting empty`);
    }
  }

  persist() {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      const data = JSON.stringify(
        { seenProofTx: [...this.seenProofTx], decisions: Object.fromEntries(this.decisions) },
        null,
        2,
      );
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      // Persistence failure must never fail a decision response; log it.
      console.error(`[state] persist failed: ${err.message}`);
    }
  }

  hasProofTx(proofTx) {
    return this.seenProofTx.has(proofTx);
  }

  addProofTx(proofTx) {
    this.seenProofTx.add(proofTx);
  }

  getDecision(taskId) {
    return this.decisions.get(taskId);
  }

  putDecision(taskId, response) {
    this.decisions.set(taskId, response);
  }
}
