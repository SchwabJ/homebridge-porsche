import { createHash } from 'crypto';
import { generatePkce } from '../src/auth/pkce';

function expectedChallenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

describe('generatePkce', () => {
  it('returns an object with verifier and challenge strings', () => {
    const pkce = generatePkce();
    expect(typeof pkce.verifier).toBe('string');
    expect(typeof pkce.challenge).toBe('string');
  });

  it('produces a verifier that is base64url with length > 40', () => {
    const { verifier } = generatePkce();
    expect(verifier.length).toBeGreaterThan(40);
    // base64url alphabet only: A-Z a-z 0-9 - _ (no padding, no + or /)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toContain('=');
    expect(verifier).not.toContain('+');
    expect(verifier).not.toContain('/');
  });

  it('produces a challenge that is base64url (no padding, no + or /)', () => {
    const { challenge } = generatePkce();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
  });

  it('computes challenge as base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkce();
    expect(challenge).toBe(expectedChallenge(verifier));
  });

  it('produces different verifiers on subsequent calls (randomness)', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});
