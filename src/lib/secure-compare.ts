/**
 * Timing-safe secret comparison — the one helper every key gate uses
 * (index.ts legacy RapidAPI gate, billing.ts RapidAPI tier, mcp.ts MCP_API_KEY
 * gate, submissions.ts ADMIN_KEY gate).
 *
 * Both sides are SHA-256 hashed first, so the values handed to
 * crypto.timingSafeEqual are always equal-length 32-byte digests: the length
 * guard below leaks nothing about the secret (digest length is public), and
 * there is no attacker-observable early exit on a matching prefix the way a
 * plain === has. On the Workers runtime crypto.timingSafeEqual is available
 * on the global crypto object; in Node it lives on node:crypto (not the
 * global), so the vitest node pool exercises the constant-time XOR fallback
 * below - both branches are constant-time by construction.
 */

async function sha256Bytes(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** True when candidate equals secret, compared in constant time. */
export async function secretMatches(candidate: string, secret: string | undefined): Promise<boolean> {
  if (!secret || !candidate) return false;
  const [a, b] = await Promise.all([sha256Bytes(candidate), sha256Bytes(secret)]);
  if (a.length !== b.length) return false; // defensive — digests are always 32 bytes
  // crypto.timingSafeEqual exists on the Workers runtime and on Node >= 17,
  // but workers-types declares it on SubtleCrypto — hence the narrow cast.
  const tse = (crypto as Crypto & { timingSafeEqual?: (x: Uint8Array, y: Uint8Array) => boolean })
    .timingSafeEqual;
  if (typeof tse === "function") return tse(a, b);
  // Fallback for runtimes without the extension: fixed 32 iterations, no data
  // branch — constant-time for equal-length digests.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** True when any candidate matches the secret (each compare timing-safe). */
export async function anySecretMatches(candidates: string[], secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const verdicts = await Promise.all(candidates.map((v) => secretMatches(v, secret)));
  return verdicts.some(Boolean);
}
