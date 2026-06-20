import * as fs from 'fs';

export interface StoredTokens {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

/**
 * Persist the auth tokens to disk with owner-only permissions (0o600).
 *
 * The mode option on writeFileSync only applies when the file is newly
 * created, so we additionally chmod to tighten permissions on a file that
 * already existed.
 */
export function saveTokens(path: string, tokens: StoredTokens): void {
  fs.writeFileSync(path, JSON.stringify(tokens), { mode: 0o600 });
  fs.chmodSync(path, 0o600);
}

/**
 * Read the persisted tokens. Returns null if the file does not exist or its
 * contents are not valid JSON – never throws on those expected cases.
 */
export function loadTokens(path: string): StoredTokens | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}
