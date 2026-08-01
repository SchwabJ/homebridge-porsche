/**
 * Typisierter API-Client für die Porsche-PPA-API (Taycan).
 *
 * Kapselt Header, Auth-Refresh (401) und Backoff-Retries (429/5xx) hinter
 * wenigen öffentlichen Methoden. Sämtliche HTTP-Calls laufen über einen
 * injizierten {@link HttpClient} (Dependency Injection) — dadurch ist der
 * Client ohne echtes Backend testbar.
 *
 * 12V-Schutz: `getState` liest ausschließlich über den gecachten
 * Mess-Endpunkt ({@link buildMeasurementUrl}) OHNE `wakeUpJob`-Parameter, weckt
 * das geparkte Fahrzeug also nie.
 */

import { createHash } from 'crypto';

import { HttpClient, HttpResponse } from '../http';
import { parseMeasurements, VehicleState } from './measurements';
import { buildMeasurementUrl } from '../wake';
import { PorscheCommand, spinChallenge, unlock as unlockCommand } from './commands';

/** Basis-URL der PPA-App-API (alle Pfade werden hier angehängt). */
const BASE = 'https://api.ppa.porsche.com/app';

/** Verifizierte Client-Kennung der My-Porsche-App. */
const CLIENT_ID = '41843fb4-691d-4970-85c7-2673e8ecef40';

/** User-Agent der My-Porsche-App (iOS), den das Backend erwartet. */
const USER_AGENT = 'My Porsche/2.1.0 (iPhone; iOS 17.0; Scale/3.00)';

/** Backoff-Wartezeiten (ms) für 429-Antworten (Rate-Limit). */
const RATE_LIMIT_BACKOFF_MS = [5000, 10000, 20000];

/** Backoff-Wartezeiten (ms) für 5xx-Antworten (Server-Fehler). */
const SERVER_ERROR_BACKOFF_MS = [3000, 6000, 12000];

/** Maximale Anzahl an Retries bei transienten Fehlern (429/5xx). */
const MAX_TRANSIENT_RETRIES = 3;

/** Wartezeit (ms) zwischen zwei Job-Status-Abfragen nach einem Befehl. */
const COMMAND_POLL_INTERVAL_MS = 2500;

/** Maximale Anzahl Job-Status-Abfragen (≈ COMMAND_POLL_INTERVAL_MS × N Timeout). */
const COMMAND_POLL_MAX = 14;

/** Job-Ergebnisse, die „erfolgreich abgeschlossen" bedeuten. */
const RESULT_DONE = new Set(['PERFORMED', 'SUCCESS', 'SUCCEEDED']);

/** Job-Ergebnisse, die einen endgültigen Fehlschlag bedeuten. */
const RESULT_FAILED = new Set(['ERROR', 'FAILED', 'FAILURE', 'TIMEOUT']);

/** Optionen für den {@link PorscheClient} (DI für Token-Handling + Sleep). */
export interface PorscheClientOptions {
  /** Liefert das aktuell gültige Access-Token (Bearer). */
  getAccessToken: () => string;
  /** Erneuert das Access-Token und liefert das neue Token zurück. */
  refresh: () => Promise<string>;
  /** Wartefunktion für Backoffs; in Tests injizierbar. Default: echtes setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Ein einzelnes Fahrzeug aus der Fahrzeugliste. */
export interface VehicleListEntry {
  vin: string;
  /** Werblicher Name, etwa „Taycan 4 Cross Turismo". */
  modelName?: string;
  /**
   * Antriebsart laut Fahrzeug: `BEV`, `PHEV` und was Porsche sonst vergibt.
   *
   * Am 01.08.2026 an einem Taycan gemessen — die Fahrzeugliste trägt ein
   * `modelType`-Objekt mit `{ code, year, body, generation, model, engine }`.
   * Diese eine Angabe entscheidet, ob mehrere Auswertungen überhaupt etwas
   * aussagen dürfen.
   */
  engine?: string;
  /** Baureihe in Großbuchstaben, etwa `TAYCAN`. */
  model?: string;
  /** Modelljahr als Zeichenkette, wie geliefert. */
  year?: string;
}

/** Liest einen Eintrag der Fahrzeugliste; unbekannte Felder bleiben leer. */
export function parseVehicleEntry(v: unknown): VehicleListEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const t = (o.modelType ?? {}) as Record<string, unknown>;
  const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);
  return {
    vin: str(o.vin) ?? str(o.VIN) ?? '',
    modelName: str(o.modelName),
    engine: str(t.engine),
    model: str(t.model),
    year: str(t.year),
  };
}

/**
 * Ist das ein Plug-in-Hybrid? `undefined` heißt UNBEKANNT.
 *
 * Der Rückgabewert ist bewusst dreiwertig. „Unbekannt" darf nicht
 * stillschweigend zu „elektrisch" werden: Sonst rechnete das Plugin bei einem
 * Hybrid weiter munter falsch, und niemand merkte es. Wer sich darauf stützt,
 * fragt deshalb auf `=== false` und nicht auf `!isPluginHybrid(...)`.
 *
 * Warum die Frage überhaupt zählt: Die Kapazitätsschätzung rechnet aus der
 * Strecke zwischen zwei Ladungen. Fährt ein Hybrid Teile davon mit dem
 * Verbrennungsmotor, ist das Ergebnis nicht ungenau, sondern falsch — und
 * alles, was darauf aufsetzt (kWh je Ladung, Kosten, Ersparnis, Verbrauch,
 * Batterie-Nachweis), wäre still falsch statt sichtbar kaputt.
 */
export function isPluginHybrid(v: VehicleListEntry | undefined): boolean | undefined {
  const e = v?.engine?.toUpperCase();
  if (e === undefined) {
    return undefined;
  }
  if (e === 'BEV') {
    return false;
  }
  if (e.includes('PHEV') || e.includes('HYBRID')) {
    return true;
  }
  // Ein Wert, den wir nicht kennen, ist keine Antwort. Porsche kann morgen
  // etwas Neues vergeben, und dann ist Schweigen richtiger als Raten.
  return undefined;
}

/** Default-Sleep auf Basis von `setTimeout` (echtes Warten). */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Berechnet den S-PIN-Hash fürs Entriegeln, exakt wie CJNE:
 * `sha512(bytes.fromhex(spin + challenge)).hexdigest().upper()`.
 *
 * `spin` (4-stellige PIN) und `challenge` (aus SPIN_CHALLENGE) werden als EIN
 * Hex-String konkateniert und als Bytes interpretiert (nicht als Text!), dann
 * SHA-512, Hex-Digest, GROSSBUCHSTABEN.
 */
export function computeSpinHash(spin: string, challenge: string): string {
  const hex = spin + challenge;
  // Python `bytes.fromhex` WIRFT bei ungerader Länge / Nicht-Hex; Node
  // `Buffer.from(hex,'hex')` trunkiert dagegen STILL → still-falscher Hash.
  // Darum hier explizit validieren, damit ein Datenfehler laut scheitert.
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(
      `S-PIN-Hash: ungültige Hex-Eingabe (PIN+Challenge muss gerade Hex-Länge haben): "${spin}"+"${challenge}"`,
    );
  }
  return createHash('sha512').update(Buffer.from(hex, 'hex')).digest('hex').toUpperCase();
}

/**
 * Extrahiert die `challenge` aus einer SPIN_CHALLENGE-Antwort. Der genaue Pfad
 * ist je nach Backend-Variante unterschiedlich — daher mehrere bekannte Stellen
 * prüfen (Top-Level, `data`, `status`).
 */
export function extractChallenge(resp: unknown): string | undefined {
  const r = resp as Record<string, any> | null | undefined;
  const c =
    r?.challenge ??
    r?.data?.challenge ??
    r?.status?.challenge ??
    r?.status?.details?.challenge;
  return typeof c === 'string' && c.length > 0 ? c : undefined;
}

export class PorscheClient {
  private readonly getAccessToken: () => string;
  private readonly refresh: () => Promise<string>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly http: HttpClient,
    opts: PorscheClientOptions,
  ) {
    this.getAccessToken = opts.getAccessToken;
    this.refresh = opts.refresh;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Listet die Fahrzeuge des Kontos; mappt `vin` (auch `VIN`) und `modelName`. */
  async listVehicles(): Promise<VehicleListEntry[]> {
    const data = await this.request('GET', '/connect/v1/vehicles');
    const list: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.vehicles)
        ? data.vehicles
        : [];
    return list.map(parseVehicleEntry);
  }

  /**
   * Liest den Fahrzeugzustand über den gecachten Mess-Endpunkt.
   * Nutzt {@link buildMeasurementUrl} (ohne `wakeUpJob`) und parst die
   * Messwert-Liste mit {@link parseMeasurements}.
   */
  async getState(vin: string, keys: string[]): Promise<VehicleState> {
    const path = buildMeasurementUrl(vin, keys);
    const data = await this.request('GET', path);
    // data ist das echte Antwort-Objekt { …, measurements:[…] } (oder ein Array);
    // parseMeasurements behandelt beide Formen.
    return parseMeasurements(data);
  }

  /**
   * Sendet einen Fahrzeugbefehl und wartet auf dessen Ausführung.
   *
   * Wire-Format der PPA-API: `{ key, payload }` — das Befehls-Feld heißt `key`
   * (NICHT `commandName`; das war ein Transkriptionsfehler einer Fremd-Lib und
   * führte zu `400 unknownError`/`10_01`). Antwort ist `201 Created` mit
   * `{ status: { id, result } }`.
   *
   * Ist `result === 'ACCEPTED'`, wurde nur ein Job eingereiht — der reale Vollzug
   * wird per {@link awaitCommand} über `GET /commands/{id}` bis `PERFORMED`/`ERROR`
   * verfolgt. So loggt die Plattform echten Vollzug statt blind „gesendet".
   */
  async sendCommand(vin: string, cmd: PorscheCommand): Promise<void> {
    const data = await this.request('POST', `/connect/v1/vehicles/${vin}/commands`, {
      key: cmd.commandName,
      payload: cmd.payload,
    });

    const result: string | undefined = data?.status?.result;
    const jobId: string | undefined = data?.status?.id;

    if (result && RESULT_FAILED.has(result)) {
      throw new Error(`Porsche API: Befehl ${cmd.commandName} abgelehnt (${result})`);
    }
    // Bereits abgeschlossen → fertig. Akzeptiert + Job-ID → Vollzug abwarten.
    if (result && RESULT_DONE.has(result)) {
      return;
    }
    if (jobId) {
      await this.awaitCommand(vin, jobId, cmd.commandName);
    }
  }

  /**
   * Entriegelt das Fahrzeug über den S-PIN-Challenge-Flow (zwei Schritte):
   *  1. POST SPIN_CHALLENGE → `challenge` aus der Antwort.
   *  2. hash = {@link computeSpinHash}(spin, challenge).
   *  3. POST UNLOCK mit `{ spin: { challenge, hash } }`, dann Job-Vollzug abwarten.
   *
   * Wirft bei fehlender Challenge oder Backend-Ablehnung — der Aufrufer
   * (Schloss-Accessory) setzt dann den Target zurück auf „verriegelt".
   */
  async unlock(vin: string, spin: string): Promise<void> {
    const path = `/connect/v1/vehicles/${vin}/commands`;

    // (1) Challenge anfordern.
    const ch = spinChallenge();
    const chData = await this.request('POST', path, { key: ch.commandName, payload: ch.payload });
    const challenge = extractChallenge(chData);
    if (!challenge) {
      throw new Error('Porsche API: SPIN_CHALLENGE lieferte keine challenge');
    }

    // (2) Hash berechnen + (3) UNLOCK senden.
    const hash = computeSpinHash(spin, challenge);
    const u = unlockCommand(challenge, hash);
    const data = await this.request('POST', path, { key: u.commandName, payload: u.payload });

    const result: string | undefined = data?.status?.result;
    const jobId: string | undefined = data?.status?.id;
    if (result && RESULT_FAILED.has(result)) {
      const details = data?.status?.details;
      throw new Error(
        `Porsche API: UNLOCK abgelehnt (${result}` +
          `${details ? `, ${typeof details === 'string' ? details : JSON.stringify(details)}` : ''})`,
      );
    }
    if (result && RESULT_DONE.has(result)) {
      return;
    }
    if (jobId) {
      await this.awaitCommand(vin, jobId, 'UNLOCK');
    }
  }

  /**
   * Pollt den Job-Status eines eingereichten Befehls bis `PERFORMED` (Erfolg)
   * oder `ERROR` (wirft). Läuft der Job nach {@link COMMAND_POLL_MAX} Versuchen
   * noch, kehrt die Methode geräuschlos zurück (der Befehl wurde akzeptiert;
   * der nächste State-Poll spiegelt das Ergebnis) — kein künstlicher Fehler.
   */
  private async awaitCommand(vin: string, jobId: string, name: string): Promise<void> {
    const path = `/connect/v1/vehicles/${vin}/commands/${jobId}`;
    for (let i = 0; i < COMMAND_POLL_MAX; i++) {
      await this.sleep(COMMAND_POLL_INTERVAL_MS);
      const data = await this.request('GET', path);
      const result: string | undefined = data?.status?.result;
      if (result && RESULT_DONE.has(result)) {
        return;
      }
      if (result && RESULT_FAILED.has(result)) {
        // status.details trägt den echten Ablehnungsgrund (z. B. Tür offen,
        // Zündung an, precondition) — in die Fehlermeldung aufnehmen.
        const details = data?.status?.details;
        throw new Error(
          `Porsche API: Befehl ${name} fehlgeschlagen (Job ${jobId}: ${result}` +
            `${details ? `, ${typeof details === 'string' ? details : JSON.stringify(details)}` : ''})`,
        );
      }
      // ACCEPTED / IN_PROGRESS / unbekannt → weiter pollen.
    }
    // Timeout: Befehl wurde akzeptiert, Vollzug nur (noch) nicht bestätigt.
  }

  /**
   * Führt einen authentifizierten Request aus und behandelt Status-Codes:
   * - 200/202 → JSON-Body (leerer Body → `{}`), 204 → `{}`
   * - 401 → genau EINMAL `refresh()`, dann mit neuem Bearer wiederholen
   * - 429 → bis zu 3 Retries (Backoff 5/10/20 s)
   * - 5xx → bis zu 3 Retries (Backoff 3/6/12 s)
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    jsonBody?: Record<string, unknown>,
  ): Promise<any> {
    let token = this.getAccessToken();
    let refreshed = false;
    let transientRetries = 0;

    // Schleife endet immer per return oder throw (begrenzte Retries/ein Refresh).
    for (;;) {
      const res = await this.doRequest(method, path, token, jsonBody);

      // 201 Created ist die Erfolgs-Antwort des Command-Endpunkts (Job angelegt).
      if (res.status === 200 || res.status === 201 || res.status === 202) {
        return res.body ? JSON.parse(res.body) : {};
      }
      if (res.status === 204) {
        return {};
      }

      if (res.status === 401) {
        if (refreshed) {
          throw new Error(`Porsche API: Authentifizierung fehlgeschlagen (401) für ${path}`);
        }
        refreshed = true;
        token = await this.refresh();
        continue;
      }

      if (res.status === 429) {
        if (transientRetries >= MAX_TRANSIENT_RETRIES) {
          throw new Error(`Porsche API: Rate-Limit (429) nach ${MAX_TRANSIENT_RETRIES} Retries für ${path}`);
        }
        await this.sleep(RATE_LIMIT_BACKOFF_MS[transientRetries]);
        transientRetries++;
        continue;
      }

      if (res.status >= 500 && res.status <= 599) {
        if (transientRetries >= MAX_TRANSIENT_RETRIES) {
          throw new Error(`Porsche API: Server-Fehler (${res.status}) nach ${MAX_TRANSIENT_RETRIES} Retries für ${path}`);
        }
        await this.sleep(SERVER_ERROR_BACKOFF_MS[transientRetries]);
        transientRetries++;
        continue;
      }

      throw new Error(`Porsche API: unerwarteter Status ${res.status} für ${path}: ${res.body}`);
    }
  }

  /** Setzt die Standard-Header und führt genau EINEN HTTP-Call aus. */
  private doRequest(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    jsonBody?: Record<string, unknown>,
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'X-Client-ID': CLIENT_ID,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    };

    let body: string | undefined;
    if (jsonBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(jsonBody);
    }

    return this.http.request({
      method,
      url: BASE + path,
      headers,
      body,
      followRedirects: true,
    });
  }
}
