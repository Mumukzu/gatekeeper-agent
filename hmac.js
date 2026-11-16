// HMAC-SHA256 helpers for the Agent Games protocol.
// - Incoming: verify `x-agent-games-signature` against the RAW request body
//   BEFORE parsing anything (official build guide, section 02).
// - Outgoing: sign the RAW response body, header `x-agent-games-signature`
//   (official build guide, section 04).
// Signature encoding: hex. (A `sha256=` prefix is tolerated on verify.)
// Secret: the 32-byte platform-generated value shown once at registration —
// never a local placeholder (build guide section 04). It arrives via env.

import { createHmac, timingSafeEqual } from 'node:crypto';

export function signHex(secret, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyHex(secret, rawBody, signature) {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  let sig = signature.trim();
  if (sig.toLowerCase().startsWith('sha256=')) sig = sig.slice(7);
  const expected = signHex(secret, rawBody);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig.toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
