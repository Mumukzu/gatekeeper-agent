// Proof attachment for Gatekeeper responses.
//
// Real Groth16 proof when PROOF_ENABLED=1 and the circuit files + deps
// are present (see prove.js); otherwise null — an honest no-proof
// answer, never a fabricated proof.
// A correct decision without a proof scores +12 then -2 and earns no
// reliability bonus; PROOF_REUSED tasks carry no proof by rule.
// Cloudflare Workers (worker.js) cannot run proofs (10 ms CPU cap vs
// ~0.4-0.7 s proving) and always answers without one.

export { attachProof, initProof, isProofEnabled } from './prove.js';
