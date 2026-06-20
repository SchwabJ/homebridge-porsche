import { request as undiciRequest } from 'undici';

/**
 * Antwort eines HTTP-Requests, reduziert auf das, was der Auth-Flow braucht.
 *
 * `url` ist die FINALE URL nach allen gefolgten Redirects – daraus liest der
 * Auth-Flow den von Auth0 vergebenen `state` aus.
 */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Finale URL nach Redirects. */
  url: string;
}

/**
 * Minimaler HTTP-Client als Schnittstelle, damit der Auth-Flow gegen ein
 * Test-Doppel (Dependency Injection) geprüft werden kann – ohne echtes Backend.
 */
export interface HttpClient {
  request(opts: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    body?: string;
    /**
     * Bei `true` werden 30x-Redirects intern gefolgt (finale URL in `url`).
     * Bei `false` wird die erste 30x-Antwort zurückgegeben – die Ziel-URL
     * steht dann in `headers.location`.
     */
    followRedirects: boolean;
  }): Promise<HttpResponse>;
}

/**
 * Wandelt undicis Header-Map (`string | string[] | undefined`) defensiv in eine
 * flache `Record<string,string>` um. Mehrfach-Header werden per `, ` verbunden,
 * undefinierte Werte übersprungen – nötig für `strict`-Kompilierung.
 */
function flattenHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** Liest `set-cookie` als Array, egal ob undici einen String oder ein Array liefert. */
function extractSetCookies(
  raw: Record<string, string | string[] | undefined>,
): string[] {
  const value = raw['set-cookie'];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** Reduziert eine `Set-Cookie`-Zeile auf das `name=value`-Paar (vor dem ersten `;`). */
function cookiePair(setCookieLine: string): string {
  const semi = setCookieLine.indexOf(';');
  return semi === -1 ? setCookieLine : setCookieLine.slice(0, semi);
}

/** Maximale Anzahl gefolgter Redirects, bevor abgebrochen wird (Schleifenschutz). */
const MAX_REDIRECTS = 10;

/**
 * Default-Implementierung auf Basis von `undici` mit eigenem Cookie-Jar über
 * die gesamte Request-Kette: Cookies aus `set-cookie` werden gesammelt und bei
 * Folge-Requests als `cookie`-Header mitgeschickt.
 *
 * Diese Klasse wird NICHT unit-getestet (das übernimmt das manuelle Bootstrap);
 * sie muss lediglich kompilieren und den Vertrag von {@link HttpClient} erfüllen.
 */
export class UndiciHttpClient implements HttpClient {
  /** Cookie-Jar über die Lebensdauer dieses Clients (Name → name=value). */
  private cookieJar = new Map<string, string>();

  async request(opts: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects: boolean;
  }): Promise<HttpResponse> {
    let currentUrl = opts.url;
    let method: 'GET' | 'POST' = opts.method;
    let body: string | undefined = opts.body;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      const cookieHeader = this.cookieHeader();
      if (cookieHeader) {
        headers.cookie = cookieHeader;
      }

      const res = await undiciRequest(currentUrl, {
        method,
        headers,
        body,
        // Redirects steuern wir selbst, damit der Cookie-Jar greift.
        maxRedirections: 0,
      });

      const rawHeaders = res.headers as Record<string, string | string[] | undefined>;
      this.storeCookies(extractSetCookies(rawHeaders));

      const isRedirect = res.statusCode >= 300 && res.statusCode < 400;
      const flat = flattenHeaders(rawHeaders);

      if (isRedirect && opts.followRedirects && flat.location && hop < MAX_REDIRECTS) {
        // Body verwerfen, um den Socket freizugeben.
        await res.body.text();
        // Relative Locations gegen die aktuelle URL auflösen.
        const nextUrl = new URL(flat.location, currentUrl);
        // Custom-Scheme-Callback (z. B. my-porsche-app://) NICHT fetchen – undici
        // kann das nicht. Stattdessen als finale Antwort zurückgeben, damit der
        // Aufrufer den Code aus location/url lesen kann.
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          return {
            status: res.statusCode,
            headers: { ...flat, location: nextUrl.toString() },
            body: '',
            url: nextUrl.toString(),
          };
        }
        currentUrl = nextUrl.toString();
        // 30x → Folge-Request ist immer ein GET ohne Body.
        method = 'GET';
        body = undefined;
        continue;
      }

      const text = await res.body.text();
      return {
        status: res.statusCode,
        headers: flat,
        body: text,
        url: currentUrl,
      };
    }

    throw new Error(`UndiciHttpClient: zu viele Redirects (> ${MAX_REDIRECTS})`);
  }

  /** Baut den `cookie`-Header aus dem Jar (oder `''`, wenn leer). */
  private cookieHeader(): string {
    return Array.from(this.cookieJar.values()).join('; ');
  }

  /** Übernimmt empfangene `set-cookie`-Zeilen in den Jar (name → name=value). */
  private storeCookies(setCookies: string[]): void {
    for (const line of setCookies) {
      const pair = cookiePair(line);
      const eq = pair.indexOf('=');
      if (eq === -1) {
        continue;
      }
      this.cookieJar.set(pair.slice(0, eq), pair);
    }
  }
}
