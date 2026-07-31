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
  /**
   * Kapazität aus der laufenden Messung übernehmen, sobald sie trägt.
   *
   * Der eingetragene Wert bleibt der Startwert, bis genug Zyklen vorliegen —
   * siehe `resolveCapacity` in {@link ./capacity}.
   */
  autoCapacity?: boolean;
  /**
   * Ansicht, mit der das Dashboard ohne `?g=`-Parameter öffnet.
   *
   * Wer täglich die Tagesansicht will, soll sie nicht bei jedem Öffnen neu
   * antippen müssen. Ohne Angabe bleibt es beim Monat.
   */
  defaultView?: DefaultView;
  /**
   * Frühere Haustarife, chronologisch aufsteigend nach `until`.
   *
   * Ohne diese Liste gälte der aktuelle Arbeitspreis rückwirkend für die
   * gesamte Historie: Nach einer Preiserhöhung wären alle alten Monatsbelege
   * und Kostenkacheln falsch — und der Beleg ist ausdrücklich zum
   * Weiterreichen gebaut. Gepflegt wird die Liste nicht von Hand, sondern
   * von der Einstellungsseite beim Preiswechsel (siehe {@link archivePrice}).
   */
  priceHistory?: TariffPeriod[];
}

/**
 * Ein abgelöster Haustarif: Er galt für alle Zeitpunkte VOR `until`.
 *
 * `until` ist ein lokaler Kalendertag (`YYYY-MM-DD`) und exklusiv — am Tag des
 * Wechsels gilt bereits der Nachfolger. Der Bonus wird mit eingefroren: Er ist
 * Teil des Effektivpreises, und ein Tarifwechsel wechselt oft beides.
 */
export interface TariffPeriod {
  until: string;
  priceCt: number;
  bonusCt: number;
}

const FILE = 'dashboard-settings.json';

/** Die wählbaren Standardansichten — dieselben Werte wie der `g`-Parameter. */
export const DEFAULT_VIEWS = ['day', 'week', 'month', 'year'] as const;
export type DefaultView = (typeof DEFAULT_VIEWS)[number];

/** Die Zahlenfelder — alles außer Tarifhistorie und Standardansicht. */
type NumericKey = Exclude<
  keyof DashboardSettings,
  'priceHistory' | 'defaultView' | 'autoCapacity'
>;

/** Grenzen je Feld — fangen Tippfehler ab, ohne zu bevormunden. */
const LIMITS: Record<NumericKey, { min: number; max: number; decimals: number }> = {
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
  for (const key of Object.keys(LIMITS) as NumericKey[]) {
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
  const history = sanitizeHistory(src.priceHistory);
  if (history.length > 0) {
    out.priceHistory = history;
  }
  // Whitelist statt Durchreichen: Der Wert landet später im g-Parameter der
  // Oberfläche — Unsinn wird hier verworfen, nicht dort interpretiert.
  if (DEFAULT_VIEWS.includes(src.defaultView as DefaultView)) {
    out.defaultView = src.defaultView as DefaultView;
  }
  // Ein Häkchen kommt aus dem Formular als 'true'/'false' oder als echter
  // Boolean aus einem JSON-Aufruf — beides muss ankommen.
  if (src.autoCapacity !== undefined && src.autoCapacity !== '') {
    out.autoCapacity = src.autoCapacity === true || src.autoCapacity === 'true';
  }
  return out;
}

/** Ein gültiger lokaler Kalendertag: vier Stellen Jahr, Monat 01–12, Tag 01–31. */
export const dayOk = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number(v.slice(5, 7)) >= 1 &&
  Number(v.slice(5, 7)) <= 12 &&
  Number(v.slice(8, 10)) >= 1 &&
  Number(v.slice(8, 10)) <= 31;

/**
 * Prüft eine gelesene Tarifhistorie Eintrag für Eintrag.
 *
 * Kaputte Einträge fallen einzeln, statt die ganze Liste zu kosten: Die Datei
 * liegt auf der Platte und kann von Hand angefasst worden sein — ein Tippfehler
 * darf nicht alle übrigen Perioden mitreißen. Sortiert wird immer, denn der
 * Lookup ({@link tariffAt}) verlässt sich auf die Reihenfolge.
 */
function sanitizeHistory(raw: unknown): TariffPeriod[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: TariffPeriod[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') {
      continue;
    }
    const { until, priceCt, bonusCt } = e as Record<string, unknown>;
    const price = typeof priceCt === 'number' ? priceCt : NaN;
    const bonus = bonusCt === undefined ? 0 : typeof bonusCt === 'number' ? bonusCt : NaN;
    const lim = LIMITS.priceCt;
    if (
      !dayOk(until) ||
      !Number.isFinite(price) ||
      price < lim.min ||
      price > lim.max ||
      !Number.isFinite(bonus) ||
      bonus < lim.min ||
      bonus > lim.max
    ) {
      continue;
    }
    out.push({ until, priceCt: price, bonusCt: bonus });
  }
  return out.sort((a, b) => a.until.localeCompare(b.until));
}

/** Der lokale Kalendertag eines Zeitpunkts als `YYYY-MM-DD`. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Der zu einem Zeitpunkt gültige Haustarif.
 *
 * Verglichen wird nach LOKALEM Kalendertag — dieselbe Regel wie beim
 * Monatsbeleg: Eine Ladung um 01:00 Ortszeit am Tag des Tarifwechsels ist in
 * UTC noch der Vortag, gehört aber zum neuen Preis.
 */
export function tariffAt(
  history: TariffPeriod[] | undefined,
  current: { priceCt: number; bonusCt: number },
  iso: string,
): { priceCt: number; bonusCt: number } {
  if (!history || history.length === 0) {
    return current;
  }
  const day = localDay(iso);
  // Chronologisch aufsteigend: Der erste Eintrag, dessen Ende NACH dem Tag
  // liegt, ist die Periode, in die der Tag fällt.
  for (const p of history) {
    if (day < p.until) {
      return { priceCt: p.priceCt, bonusCt: p.bonusCt };
    }
  }
  return current;
}

/**
 * Schreibt die Tarifhistorie bei einem Preiswechsel fort.
 *
 * `fromDay` ist der Tag, ab dem der NEUE Tarif gilt. Die Regeln:
 *
 * 1. Einträge, deren `until` nach `fromDay` liegt, beschreiben eine Zukunft,
 *    die diese Änderung ersetzt — sie fallen weg.
 * 2. Existiert bereits ein Eintrag mit `until == fromDay`, bleibt er: Er
 *    beschreibt die Zeit VOR dem Wechsel, und die ändert sich nicht dadurch,
 *    dass der Preis AB dem Tag neu festgelegt wird.
 * 3. Sonst wird der bisherige Tarif mit `until = fromDay` archiviert.
 * 4. Ist der letzte Eintrag danach identisch mit dem neuen Tarif, fällt er
 *    weg: So räumt sich ein zurückgenommener Tippfehler von selbst auf,
 *    statt als falsche Periode in der Historie zu stehen.
 */
export function archivePrice(
  history: TariffPeriod[] | undefined,
  old: { priceCt: number; bonusCt: number },
  neu: { priceCt: number; bonusCt: number },
  fromDay: string,
): TariffPeriod[] {
  const same = (a: { priceCt: number; bonusCt: number }, b: { priceCt: number; bonusCt: number }): boolean =>
    a.priceCt === b.priceCt && a.bonusCt === b.bonusCt;
  const base = (history ?? []).slice().sort((a, b) => a.until.localeCompare(b.until));
  if (same(old, neu)) {
    return base;
  }
  const out = base.filter((p) => p.until < fromDay);
  const hatGrenze = base.some((p) => p.until === fromDay);
  if (hatGrenze) {
    out.push(base.find((p) => p.until === fromDay) as TariffPeriod);
  } else {
    out.push({ until: fromDay, priceCt: old.priceCt, bonusCt: old.bonusCt });
  }
  while (out.length > 0 && same(out[out.length - 1], neu)) {
    out.pop();
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
  const out: NumericKey[] = [];
  for (const key of Object.keys(LIMITS) as NumericKey[]) {
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
