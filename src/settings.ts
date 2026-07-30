/**
 * Im Dashboard änderbare Auswertungs-Einstellungen.
 *
 * ## Warum nicht einfach die Homebridge-Konfiguration
 *
 * Weil sie für diese Werte das falsche Werkzeug ist. Ein Strompreis ändert
 * sich zum Jahreswechsel, ein Fremdtarif je nach Anbieter — dafür jedes Mal
 * die Plugin-Einstellungen zu öffnen und Homebridge neu zu starten, steht in
 * keinem Verhältnis. Diese Werte ändern auch nichts am Verhalten des Plugins:
 * Sie werden erst beim Auswerten gelesen, also bei jedem Seitenaufruf neu.
 *
 * In die `config.json` von Homebridge schreibt dieses Modul bewusst NICHT.
 * Das ist eine fremde Datei, die mehrere Plugins teilen; sie im laufenden
 * Betrieb umzuschreiben, riskiert fremde Konfiguration für einen Komfortgewinn.
 *
 * ## Vorrang
 *
 * Was hier steht, gewinnt gegen die Plugin-Einstellungen — es ist die
 * spätere und speziellere Angabe. Fehlt ein Wert, gilt weiter Homebridge.
 * Die Einstellungsseite weist beides aus, damit niemand rätselt, warum eine
 * Änderung in Homebridge nichts bewirkt.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Im Dashboard änderbare Werte.
 *
 * Bewusst nur Auswertungs-Parameter. Der Dashboard-Port und die Poll-Intervalle
 * bleiben in Homebridge: Sie greifen beim Start des Plugins, und eine
 * Einstellung, die erst nach einem Neustart wirkt, gehört dorthin, wo man den
 * Neustart ohnehin auslöst.
 */
export interface DashboardSettings {
  /** Arbeitspreis in ct/kWh. */
  priceCt?: number;
  /** Ladebonus in ct/kWh, der vom Arbeitspreis abgezogen wird. */
  bonusCt?: number;
  /** Vorgabepreis für Ladungen unterwegs in ct/kWh. */
  externalPriceCt?: number;
  /** Nutzbare Kapazität in kWh. */
  capacityKwh?: number;
  /** Stunde, zu der ein neuer Tag beginnt. */
  dayBoundaryHour?: number;
}

const FILE = 'dashboard-settings.json';

/** Grenzen je Feld — fangen Tippfehler ab, ohne zu bevormunden. */
const LIMITS: Record<keyof DashboardSettings, { min: number; max: number; decimals: number }> = {
  priceCt: { min: 0, max: 300, decimals: 2 },
  bonusCt: { min: 0, max: 300, decimals: 2 },
  externalPriceCt: { min: 0, max: 300, decimals: 2 },
  capacityKwh: { min: 10, max: 300, decimals: 1 },
  dayBoundaryHour: { min: 0, max: 12, decimals: 0 },
};

/** Liest die Einstellungen; wirft nie. */
export function readSettings(dir: string): DashboardSettings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return sanitizeSettings(parsed) ?? {};
    }
  } catch {
    // keine Datei oder kaputtes JSON — dann gelten die Plugin-Einstellungen
  }
  return {};
}

/**
 * Schreibt die Einstellungen. Wie bei den Preisen über eine temporäre Datei,
 * damit ein Absturz mitten im Schreiben nicht alles kostet.
 */
export function writeSettings(dir: string, next: DashboardSettings): boolean {
  const target = path.join(dir, FILE);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Aufräumen ist Kür
    }
    return false;
  }
}

/**
 * Prüft eine Eingabe und gibt sie bereinigt zurück.
 *
 * Ein leeres Feld bedeutet „nicht gesetzt" und fällt auf die
 * Plugin-Einstellung zurück — deshalb wird es entfernt statt auf 0 gesetzt.
 * Eine 0 dagegen ist eine gültige Angabe: Sie schaltet die Kosten bewusst ab.
 */
export function sanitizeSettings(input: unknown): DashboardSettings | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const src = input as Record<string, unknown>;
  const out: DashboardSettings = {};
  for (const key of Object.keys(LIMITS) as (keyof DashboardSettings)[]) {
    const raw = src[key];
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
    const lim = LIMITS[key];
    if (!Number.isFinite(n) || n < lim.min || n > lim.max) {
      continue;
    }
    const f = 10 ** lim.decimals;
    out[key] = Math.round(n * f) / f;
  }
  return out;
}

/** Woher ein Wert stammt — für die Anzeige auf der Einstellungsseite. */
export type Source = 'dashboard' | 'plugin';

/**
 * Legt die Dashboard-Einstellungen über die Plugin-Werte.
 *
 * Gibt neben dem Ergebnis auch die Herkunft je Feld zurück: Ohne sie ließe
 * sich nicht erklären, warum eine Änderung in Homebridge folgenlos bleibt.
 */
export function mergeSettings<T extends Record<string, number>>(
  fromPlugin: T,
  fromDashboard: DashboardSettings,
): { values: T; source: Record<keyof T, Source> } {
  const values = { ...fromPlugin };
  const source = {} as Record<keyof T, Source>;
  for (const key of Object.keys(fromPlugin) as (keyof T)[]) {
    const own = (fromDashboard as Record<string, number | undefined>)[key as string];
    if (own !== undefined) {
      (values as Record<string, number>)[key as string] = own;
      source[key] = 'dashboard';
    } else {
      source[key] = 'plugin';
    }
  }
  return { values, source };
}

/**
 * Die Schlüssel, deren Werte {@link sanitizeSettings} VERWORFEN hat.
 *
 * Nötig für eine ehrliche Rückmeldung: Wer 9999 als Arbeitspreis einträgt,
 * bekam bisher „gesichert" zu sehen, während der Wert stillschweigend fiel.
 * Ein leeres Feld zählt nicht als verworfen — es ist die gültige Art, einen
 * Wert zurückzunehmen.
 */
export function rejectedSettings(input: unknown): (keyof DashboardSettings)[] {
  if (!input || typeof input !== 'object') {
    return [];
  }
  const src = input as Record<string, unknown>;
  const ok = sanitizeSettings(input) ?? {};
  const out: (keyof DashboardSettings)[] = [];
  for (const key of Object.keys(LIMITS) as (keyof DashboardSettings)[]) {
    const raw = src[key];
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }
    if (ok[key] === undefined) {
      out.push(key);
    }
  }
  return out;
}
