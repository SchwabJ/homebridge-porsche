import { randomBytes } from 'crypto';
import { HttpClient, HttpResponse } from '../http';
import { generatePkce } from './pkce';

// --- Verifizierte Auth0/PPA-Konstanten (NICHT raten) -----------------------

const AUTH_HOST = 'https://identity.porsche.com';
const AUTHORIZE_URL = `${AUTH_HOST}/authorize`;
const TOKEN_URL = `${AUTH_HOST}/oauth/token`;
const IDENTIFIER_URL = `${AUTH_HOST}/u/login/identifier`;
const PASSWORD_URL = `${AUTH_HOST}/u/login/password`;

const CLIENT_ID = 'XhygisuebbrqQ80byOuU5VncxLIm8E6H';
const REDIRECT_URI = 'my-porsche-app://auth0/callback';
const AUDIENCE = 'https://api.porsche.com';
const SCOPE =
  'openid profile email offline_access mbb ssodb badge vin dealers cars charging manageCharging plugAndCharge climatisation manageClimatisation pid:user_profile.porscheid:read pid:user_profile.vehicles:read';
const USER_AGENT = 'My Porsche/2.1.0 (iPhone; iOS 17.0; Scale/3.00)';

/** Regex, der den Auth0-`state` aus einer Redirect-URL zieht. */
const STATE_REGEX = /[?&]state=([A-Za-z0-9_-]+)/;

// --- Fehlerklassen ----------------------------------------------------------

/** Allgemeiner Auth-Fehler (z. B. unerwartete Antwort, fehlender state/code). */
export class AuthenticationError extends Error {}

/**
 * Auth0 verlangt ein Captcha / Bot-Detection hat zugeschlagen – der Flow kann
 * nicht headless fortgesetzt werden und braucht manuelle Interaktion.
 */
export class CaptchaRequiredError extends Error {}

/**
 * Zieht das Captcha-Bild (data-URI) aus einer Auth0-ACUL-Login-Seite.
 * Die Seite bettet ihren Kontext als base64 ein (`…atob("<base64>")…`); darin
 * liegt `screen.captcha.image`. Liefert `null`, wenn kein Captcha vorhanden ist.
 */
export function parseCaptchaImage(body: string): string | null {
  const m = body.match(/atob\("([^"]+)"\)/);
  if (!m) {
    return null;
  }
  try {
    const ctx = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as {
      screen?: { captcha?: { image?: unknown } };
    };
    const image = ctx.screen?.captcha?.image;
    return typeof image === 'string' ? image : null;
  } catch {
    return null;
  }
}

/** Liest den `code`-Parameter sicher aus einer (auch Custom-Scheme-)Callback-URL. */
function extractAuthCode(url: string): string | null {
  try {
    return new URL(url).searchParams.get('code');
  } catch {
    return null;
  }
}

// --- Tokens -----------------------------------------------------------------

/** Ergebnis eines erfolgreichen Logins/Refreshs. */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Ablaufzeitpunkt als Unix-Sekunden (`now + expires_in`). */
  expiresAt: number;
}

/** Roh-Antwort des Token-Endpunkts. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/** base64url-codierter Zufalls-State für den eigenen `/authorize`-Request. */
function randomState(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Auth0-Login-Flow (Authorization Code + PKCE) für die My-Porsche-/PPA-API.
 *
 * Die HTTP-Schicht wird per {@link HttpClient} injiziert, damit der Flow gegen
 * ein Test-Doppel geprüft werden kann – ohne echtes Porsche-Backend.
 */
export class PorscheAuth {
  constructor(private http: HttpClient) {}

  /**
   * Vollständiger Login mit E-Mail + Passwort.
   *
   * @param onCaptcha Optionaler Callback: erhält das Captcha-Bild (data-URI) und
   *   liefert die vom Menschen gelöste Zeichenfolge zurück. Fehlt er, wird bei
   *   einem Captcha {@link CaptchaRequiredError} geworfen.
   * @throws {CaptchaRequiredError} wenn Auth0 ein Captcha verlangt und kein
   *   `onCaptcha`-Handler übergeben wurde.
   * @throws {AuthenticationError} bei unerwarteten Antworten.
   */
  async login(
    email: string,
    password: string,
    onCaptcha?: (captchaImage: string) => Promise<string>,
  ): Promise<Tokens> {
    const { verifier, challenge } = generatePkce();

    // 1. /authorize → Auth0 leitet zur Login-Maske um; der state steckt in der URL.
    const authorizeQuery = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      audience: AUDIENCE,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: randomState(),
    });
    const authorizeRes = await this.http.request({
      method: 'GET',
      url: `${AUTHORIZE_URL}?${authorizeQuery.toString()}`,
      headers: this.baseHeaders(),
      followRedirects: true,
    });

    const stateMatch = authorizeRes.url.match(STATE_REGEX);
    if (!stateMatch) {
      throw new AuthenticationError(
        'Kein Auth0-state in der /authorize-Antwort – evtl. Captcha/Bot-Detection.',
      );
    }
    const auth0State = stateMatch[1];

    // 2. Identifier (E-Mail) absenden – bei Captcha einmal mit Lösung wiederholen.
    let identifierRes = await this.submitIdentifier(auth0State, email);
    if (identifierRes.status === 400) {
      const captchaImage = parseCaptchaImage(identifierRes.body);
      if (!captchaImage) {
        throw new AuthenticationError(
          'Identifier-Schritt lieferte 400, aber kein erkennbares Captcha.',
        );
      }
      if (!onCaptcha) {
        throw new CaptchaRequiredError('captcha required');
      }
      const solution = await onCaptcha(captchaImage);
      identifierRes = await this.submitIdentifier(auth0State, email, solution);
      if (identifierRes.status === 400) {
        throw new AuthenticationError(
          'Captcha falsch oder abgelaufen – bitte erneut versuchen.',
        );
      }
    }

    // 3. Passwort absenden. Auth0 leitet danach ggf. RELATIV weiter
    //    (/authorize/resume?state=…) und erst am Ende auf den
    //    my-porsche-app://-Callback mit dem Code. Der HttpClient folgt den
    //    http(s)-Redirects und stoppt am Custom-Scheme-Callback.
    const passwordBody = new URLSearchParams({
      state: auth0State,
      username: email,
      password,
      action: 'default',
    });
    const passwordRes = await this.http.request({
      method: 'POST',
      url: `${PASSWORD_URL}?state=${encodeURIComponent(auth0State)}`,
      headers: this.formHeaders(),
      body: passwordBody.toString(),
      followRedirects: true,
    });
    if (passwordRes.status === 400) {
      throw new AuthenticationError(
        'Passwort abgelehnt (400) – bitte Passwort (und ggf. Captcha) prüfen.',
      );
    }
    // Code aus dem Callback (location der letzten 30x, sonst finale url).
    const callbackUrl = passwordRes.headers.location ?? passwordRes.url;
    const code = extractAuthCode(callbackUrl);
    if (!code) {
      throw new AuthenticationError('Kein Authorization-Code im Callback erhalten.');
    }

    // 4. Code gegen Tokens tauschen (Body = JSON).
    return this.exchangeToken({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
  }

  /** Sendet den Identifier-(E-Mail-)Schritt, optional mit Captcha-Lösung. */
  private submitIdentifier(
    auth0State: string,
    email: string,
    captcha?: string,
  ): Promise<HttpResponse> {
    const body = new URLSearchParams({
      state: auth0State,
      username: email,
      'js-available': 'true',
      'webauthn-available': 'true',
      'is-brave': 'false',
      'webauthn-platform-authenticator-available': 'false',
      action: 'default',
    });
    if (captcha) {
      body.set('captcha', captcha);
    }
    return this.http.request({
      method: 'POST',
      url: `${IDENTIFIER_URL}?state=${encodeURIComponent(auth0State)}`,
      headers: this.formHeaders(),
      body: body.toString(),
      followRedirects: true,
    });
  }

  /**
   * Tokens per Refresh-Token erneuern. Liefert die Antwort keinen neuen
   * Refresh-Token, wird der übergebene beibehalten.
   */
  async refresh(refreshToken: string): Promise<Tokens> {
    return this.exchangeToken(
      {
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      },
      refreshToken,
    );
  }

  /** POST `/oauth/token` als JSON und mappt die Antwort auf {@link Tokens}. */
  private async exchangeToken(
    payload: Record<string, string>,
    fallbackRefreshToken?: string,
  ): Promise<Tokens> {
    const res = await this.http.request({
      method: 'POST',
      url: TOKEN_URL,
      headers: { ...this.baseHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      followRedirects: true,
    });

    let parsed: TokenResponse;
    try {
      parsed = JSON.parse(res.body) as TokenResponse;
    } catch {
      throw new AuthenticationError('Token-Antwort war kein gültiges JSON.');
    }

    if (!parsed.access_token || typeof parsed.expires_in !== 'number') {
      throw new AuthenticationError('Token-Antwort ohne access_token/expires_in.');
    }

    const refreshTokenValue = parsed.refresh_token ?? fallbackRefreshToken;
    if (!refreshTokenValue) {
      throw new AuthenticationError('Token-Antwort ohne refresh_token.');
    }

    return {
      accessToken: parsed.access_token,
      refreshToken: refreshTokenValue,
      expiresAt: Math.floor(Date.now() / 1000) + parsed.expires_in,
    };
  }

  /** Basis-Header für alle Requests (User-Agent der echten App). */
  private baseHeaders(): Record<string, string> {
    return { 'User-Agent': USER_AGENT };
  }

  /** Header für die form-urlencoded POSTs der Login-Schritte. */
  private formHeaders(): Record<string, string> {
    return {
      ...this.baseHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  }
}
