import { HttpClient, HttpResponse } from '../src/http';
import {
  PorscheAuth,
  CaptchaRequiredError,
  parseCaptchaImage,
} from '../src/auth/porscheAuth';

/** Baut eine Auth0-ACUL-Login-Seite mit eingebettetem Captcha (wie das echte Backend). */
function aculBodyWithCaptcha(image: string): string {
  const ctx = { screen: { name: 'login-id', captcha: { provider: 'auth0', image } } };
  const b64 = Buffer.from(JSON.stringify(ctx), 'utf8').toString('base64');
  return `<html><script>window.universal_login_context=JSON.parse(new TextDecoder('utf-8').decode(Uint8Array.from(atob("${b64}"),c=>c.charCodeAt(0))))</script></html>`;
}

/** Aufgezeichneter Request, wie ihn die {@link FakeHttpClient} ablegt. */
interface RecordedCall {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  followRedirects: boolean;
}

/**
 * Test-Doppel für {@link HttpClient}: gibt vorskriptierte Antworten der Reihe
 * nach zurück und zeichnet jeden Aufruf auf. KEINE echten Netzwerk-Calls.
 */
class FakeHttpClient implements HttpClient {
  public calls: RecordedCall[] = [];
  private idx = 0;

  constructor(private responses: HttpResponse[]) {}

  async request(opts: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects: boolean;
  }): Promise<HttpResponse> {
    this.calls.push({
      method: opts.method,
      url: opts.url,
      headers: opts.headers ?? {},
      body: opts.body,
      followRedirects: opts.followRedirects,
    });
    const res = this.responses[this.idx++];
    if (!res) {
      throw new Error(`FakeHttpClient: keine skriptierte Antwort für Aufruf #${this.idx}`);
    }
    return res;
  }
}

/** Bequemer Builder für eine {@link HttpResponse} mit Defaults. */
function resp(partial: Partial<HttpResponse> & { status: number }): HttpResponse {
  return {
    status: partial.status,
    headers: partial.headers ?? {},
    body: partial.body ?? '',
    url: partial.url ?? '',
  };
}

describe('PorscheAuth.login', () => {
  it('happy path: liefert Tokens und nutzt den korrekten Auth0-Flow', async () => {
    const fake = new FakeHttpClient([
      // 1. GET /authorize → finale URL trägt den Auth0-state
      resp({ status: 200, url: 'https://identity.porsche.com/u/login/identifier?state=ABC123' }),
      // 2. POST /u/login/identifier → ok
      resp({ status: 200 }),
      // 3. POST /u/login/password → 302 mit code in der location
      resp({
        status: 302,
        headers: { location: 'my-porsche-app://auth0/callback?code=THECODE&state=ABC123' },
      }),
      // 4. POST /oauth/token → JSON mit Tokens
      resp({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
      }),
    ]);

    const now = Math.floor(Date.now() / 1000);
    const auth = new PorscheAuth(fake);
    const tokens = await auth.login('user@example.com', 'secret');

    expect(tokens.accessToken).toBe('AT');
    expect(tokens.refreshToken).toBe('RT');
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(now + 3590);
    expect(tokens.expiresAt).toBeLessThanOrEqual(now + 3610);

    // Call 1: /authorize mit PKCE-Methode S256
    expect(fake.calls[0].method).toBe('GET');
    expect(fake.calls[0].url).toContain('https://identity.porsche.com/authorize');
    expect(fake.calls[0].url).toContain('code_challenge_method=S256');

    // Call 3: password-Schritt FOLGT Redirects (Auth0 leitet relativ zum Callback)
    expect(fake.calls[2].url).toContain('/u/login/password');
    expect(fake.calls[2].followRedirects).toBe(true);

    // Call 4: token-Schritt als JSON mit grant_type authorization_code
    expect(fake.calls[3].url).toContain('/oauth/token');
    expect(fake.calls[3].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(fake.calls[3].body!).grant_type).toBe('authorization_code');
  });

  it('captcha ohne Handler: 400 mit Captcha-Seite wirft CaptchaRequiredError', async () => {
    const fake = new FakeHttpClient([
      resp({ status: 200, url: 'https://identity.porsche.com/u/login/identifier?state=ABC123' }),
      resp({ status: 400, body: aculBodyWithCaptcha('data:image/svg+xml;base64,IMG') }),
    ]);
    const auth = new PorscheAuth(fake);
    await expect(auth.login('user@example.com', 'secret')).rejects.toBeInstanceOf(
      CaptchaRequiredError,
    );
  });

  it('captcha mit Handler: löst Captcha und sendet es im Identifier-Resubmit mit', async () => {
    const fake = new FakeHttpClient([
      resp({ status: 200, url: 'https://identity.porsche.com/u/login/identifier?state=ABC123' }),
      resp({ status: 400, body: aculBodyWithCaptcha('data:image/svg+xml;base64,IMG') }),
      resp({ status: 200 }), // Resubmit mit Captcha → ok
      resp({
        status: 302,
        headers: { location: 'my-porsche-app://auth0/callback?code=THECODE&state=ABC123' },
      }),
      resp({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
      }),
    ]);
    const onCaptcha = jest.fn(async (image: string) => {
      expect(image).toContain('data:image/svg+xml');
      return 'SOLVED';
    });
    const auth = new PorscheAuth(fake);
    const tokens = await auth.login('user@example.com', 'secret', onCaptcha);

    expect(tokens.accessToken).toBe('AT');
    expect(onCaptcha).toHaveBeenCalledTimes(1);
    // Resubmit (Call #3, Index 2) trägt das gelöste Captcha als Feld.
    expect(fake.calls[2].body).toContain('captcha=SOLVED');
  });
});

describe('parseCaptchaImage', () => {
  it('extrahiert das Captcha-Bild aus der ACUL-Seite', () => {
    const body = aculBodyWithCaptcha('data:image/svg+xml;base64,ABC');
    expect(parseCaptchaImage(body)).toBe('data:image/svg+xml;base64,ABC');
  });
  it('liefert null ohne Captcha', () => {
    expect(parseCaptchaImage('<html>kein context</html>')).toBeNull();
  });
});

describe('PorscheAuth.refresh', () => {
  it('behält den alten refreshToken, wenn die Antwort keinen neuen liefert', async () => {
    const fake = new FakeHttpClient([
      resp({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: 'AT2', expires_in: 3600 }),
      }),
    ]);
    const auth = new PorscheAuth(fake);
    const tokens = await auth.refresh('RT');

    expect(tokens.accessToken).toBe('AT2');
    expect(tokens.refreshToken).toBe('RT');

    // refresh-Grant als JSON
    expect(fake.calls[0].url).toContain('/oauth/token');
    expect(JSON.parse(fake.calls[0].body!).grant_type).toBe('refresh_token');
  });
});
