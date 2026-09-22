/**
 * Comparing a caller-supplied secret without leaking how close they got.
 *
 * Both HMAC digests are taken under a key generated for this process, so the
 * comparison runs over two fixed-length 32-byte values whatever the inputs
 * were. A plain loop over the raw strings would leak their length, and === on
 * a shared secret leaks the matching prefix through timing.
 */
const key = await crypto.subtle.generateKey(
  { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
);

const enc = new TextEncoder();

export async function secretsMatch(given: string | null, expected: string | undefined): Promise<boolean> {
  // A missing configured secret must never authorise anybody, so this is a
  // refusal rather than a comparison of two empty strings.
  if (!expected || given === null) return false;

  const [a, b] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(given)),
    crypto.subtle.sign("HMAC", key, enc.encode(expected)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] as number) ^ (vb[i] as number);
  return diff === 0;
}
