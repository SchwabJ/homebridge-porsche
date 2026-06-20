import { randomBytes, createHash } from 'crypto';

/**
 * Convert a Buffer to a base64url-encoded string.
 * base64url = base64 with `+` -> `-`, `/` -> `_`, and `=` padding removed.
 */
function base64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Generate a PKCE code verifier/challenge pair for the Auth0 (PPA) flow.
 *
 * - `verifier`: base64url-encoded 32 random bytes (length > 40, no padding).
 * - `challenge`: base64url(sha256(verifier)) per RFC 7636 (S256).
 */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}
