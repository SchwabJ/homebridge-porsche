import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { saveTokens, loadTokens, StoredTokens } from '../src/auth/tokenStore';

function randomTokenPath(): string {
  const name = `taycan-tokens-${process.pid}-${process.hrtime.bigint()}.json`;
  return path.join(os.tmpdir(), name);
}

describe('tokenStore', () => {
  let tokenPath: string;

  beforeEach(() => {
    tokenPath = randomTokenPath();
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tokenPath);
    } catch {
      /* file may not exist – ignore */
    }
  });

  it('round-trips the stored token object', () => {
    const tokens: StoredTokens = {
      refreshToken: 'abc',
      accessToken: 'xyz',
      expiresAt: 123,
    };
    saveTokens(tokenPath, tokens);
    expect(loadTokens(tokenPath)).toEqual(tokens);
  });

  it('returns null for a non-existent path (no throw)', () => {
    const missing = randomTokenPath();
    expect(loadTokens(missing)).toBeNull();
  });

  it('writes the file with mode 0o600', () => {
    saveTokens(tokenPath, { refreshToken: 'abc' });
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('tightens permissions to 0o600 even if the file already existed', () => {
    fs.writeFileSync(tokenPath, '{}', { mode: 0o644 });
    fs.chmodSync(tokenPath, 0o644);
    saveTokens(tokenPath, { refreshToken: 'abc' });
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('returns null on corrupt JSON (no throw)', () => {
    fs.writeFileSync(tokenPath, '{ this is not valid json', { mode: 0o600 });
    expect(loadTokens(tokenPath)).toBeNull();
  });
});
