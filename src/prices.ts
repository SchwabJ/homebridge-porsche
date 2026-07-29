/**
 * Selbst eingetragene Preise für Ladungen unterwegs.
 *
 * Der konfigurierte Arbeitspreis ist der Haustarif. Unterwegs zahlt man je
 * nach Säule das Zwei- bis Fünffache, und das weiß nur der Fahrer — die API
 * liefert dazu nichts. Deshalb kann jede Fremdladung im Dashboard einen
 * eigenen Preis bekommen.
 *
 * ## Warum eine eigene Datei
 *
 * Der Mitschrieb ist ein reines Messprotokoll: Er wird angehängt und nie
 * verändert. Eingetragene Preise sind das Gegenteil — sie kommen nachträglich
 * dazu und werden korrigiert. Beides in einer Datei zu mischen hieße, das
 * Messprotokoll umzuschreiben.
 *
 * ## Warum der Startzeitpunkt als Schlüssel
 *
 * Eine Ladung hat keine ID; sie wird bei jedem Seitenaufruf neu aus den
 * Messpunkten rekonstruiert. Stabil bleibt dabei der Zeitpunkt des
 * Einsteckens — er stammt aus einem Messpunkt und ändert sich nicht mehr,
 * sobald die Ladung vorbei ist.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Eingetragener Preis einer Ladung.
 *
 * Beide Formen sind erlaubt, weil beide vorkommen: An der Säule steht der
 * Arbeitspreis, auf der Abrechnung der Betrag. Wer den Betrag kennt, soll ihn
 * nicht erst durch die geschätzte Energiemenge teilen müssen — zumal dabei die
 * Unsicherheit unserer eigenen kWh-Schätzung in den Preis wandern würde.
 */
export interface ChargePrice {
  /** Gesamtbetrag in EUR. Hat Vorrang, wenn beides gesetzt ist. */
  eur?: number;
  /** Arbeitspreis in ct/kWh. */
  ct?: number;
  /** Freitext, z. B. der Anbieter. */
  note?: string;
}

/** Alle eingetragenen Preise, nach `startedAt` der Ladung. */
export type PriceStore = Record<string, ChargePrice>;

const FILE = 'charge-prices.json';

/**
 * Liest die eingetragenen Preise.
 *
 * Wirft nie: Eine fehlende oder beschädigte Datei darf das Dashboard nicht
 * lahmlegen — sie kostet dann die Preise, nicht die Ladehistorie.
 */
export function readPrices(dir: string): PriceStore {
  try {
    const raw = fs.readFileSync(path.join(dir, FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PriceStore;
    }
  } catch {
    // keine Datei, kein Zugriff oder kaputtes JSON — leer weitermachen
  }
  return {};
}

/**
 * Trägt einen Preis ein oder entfernt ihn (leeres `price`).
 *
 * Schreibt über eine temporäre Datei und benennt sie um: Ein Absturz mitten im
 * Schreiben darf nicht die bereits eingetragenen Preise kosten. Gibt zurück,
 * ob es geklappt hat — der Aufrufer meldet das an die Oberfläche zurück,
 * statt einen Erfolg vorzutäuschen.
 */
export function writePrice(dir: string, key: string, price?: ChargePrice): boolean {
  const store = readPrices(dir);
  if (price === undefined || (price.eur === undefined && price.ct === undefined)) {
    delete store[key];
  } else {
    store[key] = price;
  }
  const target = path.join(dir, FILE);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Aufräumen ist Kür — der Fehler steht schon fest.
    }
    return false;
  }
}

/**
 * Kosten einer Ladung aus dem eingetragenen Preis.
 *
 * `undefined`, solange weder Betrag noch Arbeitspreis vorliegen — dann bleibt
 * die Kostenspalte leer, statt den Haustarif auf eine Fremdladung anzuwenden.
 */
export function costFrom(
  price: ChargePrice | undefined,
  energyKwh: number | undefined,
): number | undefined {
  if (!price) {
    return undefined;
  }
  if (price.eur !== undefined) {
    return price.eur;
  }
  if (price.ct !== undefined && energyKwh !== undefined) {
    return (price.ct / 100) * energyKwh;
  }
  return undefined;
}

/**
 * Prüft eine Eingabe aus dem Netz und gibt sie bereinigt zurück.
 *
 * `undefined` bedeutet „nicht verwendbar". Die Grenzen sind großzügig, sollen
 * aber Tippfehler und Unsinn abfangen: 900 € für eine Ladung oder 5 €/kWh sind
 * kein Tarif, sondern ein verrutschtes Komma.
 */
export function sanitize(input: unknown): ChargePrice | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const src = input as Record<string, unknown>;
  const num = (v: unknown, max: number): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
    return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 100) / 100 : undefined;
  };
  const out: ChargePrice = {};
  const eur = num(src.eur, 500);
  const ct = num(src.ct, 300);
  if (eur !== undefined) {
    out.eur = eur;
  }
  if (ct !== undefined) {
    out.ct = ct;
  }
  if (typeof src.note === 'string' && src.note.trim()) {
    out.note = src.note.trim().slice(0, 40);
  }
  return out.eur === undefined && out.ct === undefined ? undefined : out;
}
