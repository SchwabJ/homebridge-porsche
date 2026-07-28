/**
 * Zeitliche Auswertung des Rohdaten-Mitschriebs (Tag / Woche / Monat / Jahr).
 *
 * ## Warum aus Rohdaten und nicht aus Ladevorgängen
 *
 * Eine Nachtladung läuft von 22:00 bis 06:00 und überspannt damit die
 * Tagesgrenze. Würde man sie ihrem Startzeitpunkt zuordnen, landete der
 * gesamte Nachtstrom im Vortag — bei preisgesteuertem Laden also praktisch
 * jede Ladung. Deshalb wird jedes Messintervall einzeln zugeordnet: Der
 * Energiezuwachs zwischen zwei Messpunkten zählt zu dem Zeitraum, in dem der
 * SPÄTERE Messpunkt liegt. Bei 10-Minuten-Takt bleibt der Zuordnungsfehler
 * unter zehn Minuten.
 *
 * Ladevorgänge (siehe {@link ./sessions}) beantworten die andere Frage: wie
 * oft, wie lange und wie viel je Ladung.
 *
 * ## Zeitzone
 *
 * Gespeichert wird UTC, gruppiert wird nach LOKALER Zeit — sonst rutschte eine
 * Ladung um 01:00 Uhr in den Vortag. Sommerzeitwechsel sind damit automatisch
 * korrekt, weil ausschließlich lokale Kalenderfelder verglichen werden.
 */

import type { ChargeLogSample } from './chargeLog';
import type { Labels } from './i18n';

export type Granularity = 'day' | 'week' | 'month' | 'year';

export interface Bucket {
  /** Sortierbarer Schlüssel: `2026-07-27`, `2026-W31`, `2026-07`, `2026`. */
  key: string;
  /** Beschriftung für die Anzeige. */
  label: string;
  /** Geladene Energie in kWh. */
  kwh: number;
  /** Kosten in EUR zum Effektivpreis (Grundpreis abzüglich Bonus). */
  cost: number;
  /** Kosten zum Grundpreis, also ohne Bonus. */
  costGross: number;
  /** Ersparnis durch den Bonus = Grundpreis minus Effektivpreis. */
  saved: number;
  /** Gefahrene Kilometer (aus dem Kilometerstand). */
  km: number;
  /** Geladene Reichweite in km (Zuwachs der Restreichweite am Kabel). */
  rangeAdded: number;
  /** Anzahl der Messpunkte — 0 bedeutet: aufgefüllte Lücke. */
  samples: number;
  /** Summe der Messlücken in Minuten (Abstände deutlich über dem Poll-Takt). */
  gapMinutes: number;
  /** Abgedeckte Zeitspanne in Minuten (erster bis letzter Messpunkt). */
  spanMinutes: number;
}

export interface AggregateOptions {
  capacityKwh: number;
  /** Lokalisierte Texte — bestimmt Monats-, Wochentags- und Wochenbeschriftung. */
  labels: Labels;
  /** Effektivpreis in EUR/kWh (Grundpreis abzüglich Bonus). */
  pricePerKwh?: number;
  /** Grundpreis in EUR/kWh ohne Bonus. Fehlt er, gilt der Effektivpreis. */
  grossPricePerKwh?: number;
  /**
   * Stunde, zu der ein neuer Tag beginnt (lokale Zeit, Standard 0).
   *
   * Bei preisgesteuertem Nachtladen läuft eine Ladung typischerweise von
   * 22 Uhr bis in den frühen Morgen und würde sich um Mitternacht auf zwei
   * Tage verteilen. Mit einer Grenze von z. B. 4 Uhr zählt die gesamte Nacht
   * zum Vorabend — die Tagesansicht zeigt dann eine Ladung statt zweier
   * Bruchstücke. Wirkt auf alle Zeiträume, auch auf Wochen- und Monatsgrenzen.
   */
  dayBoundaryHour?: number;
}

/**
 * Ab welchem Abstand zwischen zwei Messpunkten eine echte Lücke vorliegt.
 *
 * Etwas über dem langsamsten regulären Intervall (30 min), damit normales
 * Polling nicht als Lücke zählt.
 */
const GAP_THRESHOLD_MIN = 35;

/** Verschiebt einen Zeitpunkt um die Tagesgrenze zurück. */
const shift = (d: Date, boundaryHour: number): Date =>
  boundaryHour ? new Date(d.getTime() - boundaryHour * 3600000) : d;

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * ISO-8601-Kalenderwoche (Montag als erster Tag, Woche 1 enthält den 4. Januar).
 *
 * Selbst implementiert, weil JavaScript keine Kalenderwochen kennt. Liefert
 * bewusst auch das ISO-Jahr, das am Jahreswechsel vom Kalenderjahr abweicht:
 * Der 31.12.2026 kann zur ersten Woche 2027 gehören.
 */
export function isoWeek(d: Date): { year: number; week: number } {
  // Auf lokale Mitternacht normalisieren, dann in UTC rechnen.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Auf den Donnerstag derselben Woche schieben (ISO: Woche gehört zu dessen Jahr).
  const dayNr = (t.getUTCDay() + 6) % 7; // Mo=0 … So=6
  t.setUTCDate(t.getUTCDate() - dayNr + 3);
  const isoYear = t.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { year: isoYear, week };
}

/** Bucket-Schlüssel eines Zeitpunkts in lokaler Zeit. */
export function keyOf(d: Date, g: Granularity): string {
  switch (g) {
    case 'day':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    case 'week': {
      const { year, week } = isoWeek(d);
      return `${year}-W${pad(week)}`;
    }
    case 'month':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    case 'year':
      return String(d.getFullYear());
  }
}

/**
 * Menschenlesbare Beschriftung eines Bucket-Schlüssels.
 *
 * Monats- und Wochentagsnamen kommen aus `toLocaleDateString`, nicht aus einer
 * eigenen Liste: Die stand hier fest auf Deutsch und lieferte einem Nutzer mit
 * `language: 'en'` „Juli 2026" mitten in einer englischen Seite. Eigene
 * Namenslisten sind auch der Grund, warum so etwas beim Suchen nach `de-DE`
 * nicht auffällt.
 */
export function labelOf(key: string, g: Granularity, L: Labels): string {
  switch (g) {
    case 'day': {
      const [y, m, d] = key.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(L.locale, {
        weekday: 'short',
        day: '2-digit',
        month: '2-digit',
      });
    }
    case 'week': {
      const [y, w] = key.split('-W');
      return `${L.aggWeek} ${Number(w)} / ${y}`;
    }
    case 'month': {
      const [y, m] = key.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString(L.locale, {
        month: 'long',
        year: 'numeric',
      });
    }
    case 'year':
      return key;
  }
}

/** Nächster Bucket-Schlüssel — für das Auffüllen von Lücken. */
function nextKey(key: string, g: Granularity): string {
  switch (g) {
    case 'day': {
      const [y, m, d] = key.split('-').map(Number);
      const date = new Date(y, m - 1, d + 1);
      return keyOf(date, 'day');
    }
    case 'week': {
      const [y, w] = key.split('-W');
      // Über den Donnerstag der Woche gehen: Jahreswechsel und KW 53 lösen sich
      // dann von selbst, statt über eine Sonderfallbehandlung.
      const jan4 = new Date(Number(y), 0, 4);
      const monday = new Date(jan4);
      monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (Number(w) - 1) * 7);
      monday.setDate(monday.getDate() + 7);
      return keyOf(monday, 'week');
    }
    case 'month': {
      const [y, m] = key.split('-').map(Number);
      return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
    }
    case 'year':
      return String(Number(key) + 1);
  }
}

/**
 * Aggregiert Messpunkte zu Zeiträumen.
 *
 * Erwartet zeitlich sortierte Samples. Leere Zeiträume werden mit Nullwerten
 * aufgefüllt, damit Diagramme die Zeitachse nicht stauchen und einen falschen
 * Verlauf suggerieren.
 */
export function aggregate(
  samples: ChargeLogSample[],
  g: Granularity,
  opts: AggregateOptions,
): Bucket[] {
  const buckets = new Map<string, Bucket>();
  const boundary = opts.dayBoundaryHour ?? 0;

  const touch = (key: string): Bucket => {
    let b = buckets.get(key);
    if (!b) {
      b = { key, label: labelOf(key, g, opts.labels), kwh: 0, cost: 0, costGross: 0, saved: 0, km: 0, rangeAdded: 0, samples: 0, gapMinutes: 0, spanMinutes: 0 };
      buckets.set(key, b);
    }
    return b;
  };

  // Der erste Messpunkt liefert kein Delta, markiert aber einen Zeitraum MIT
  // Daten. Ohne diesen Anker fiele der erste Tag/die erste Woche ganz heraus.
  if (samples.length > 0) {
    touch(keyOf(shift(new Date(samples[0].ts), boundary), g)).samples++;
  }

  // Letzter Messpunkt MIT Ladestand bzw. MIT Kilometerstand — nicht einfach
  // der direkte Vorgänger.
  //
  // Grund: Die API liefert regelmäßig Zeilen ohne jeden Messwert. Verglichen
  // man nur Nachbarn, fiele jeder Sprung über eine solche Lücke hinweg aus der
  // Rechnung: 70 % → (leer) → 75 % ergäbe zweimal „kein Vergleich möglich" und
  // die fünf Prozentpunkte zählte niemand. Am 2026-07-28 fehlten dadurch
  // 5,9 der 20,1 geladenen kWh in der Tagesansicht, während die Session-
  // Rechnung (nur Anfang und Ende) korrekt blieb.
  let lastSoc: ChargeLogSample | undefined;
  let lastOdo: ChargeLogSample | undefined;
  let lastRange: ChargeLogSample | undefined;
  if (samples.length > 0) {
    if (samples[0].soc !== undefined) {
      lastSoc = samples[0];
    }
    if (samples[0].odometerKm !== undefined) {
      lastOdo = samples[0];
    }
    if (samples[0].rangeKm !== undefined) {
      lastRange = samples[0];
    }
  }

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const key = keyOf(shift(new Date(cur.ts), boundary), g);
    const b = touch(key);
    b.samples++;

    // Datenqualität: Wie lange klafft zwischen zwei Messpunkten eine Lücke?
    // Ohne dieses Maß sähe eine Auswertung aus sechs Messpunkten genauso
    // vertrauenswürdig aus wie eine aus sechshundert.
    const gap = (Date.parse(cur.ts) - Date.parse(prev.ts)) / 60000;
    if (Number.isFinite(gap) && gap > 0) {
      b.spanMinutes += Math.min(gap, GAP_THRESHOLD_MIN);
      if (gap > GAP_THRESHOLD_MIN) {
        b.gapMinutes += gap - GAP_THRESHOLD_MIN;
      }
    }

    // Energie: SoC-Anstieg am Kabel. Ohne Stecker kann der SoC nicht steigen —
    // ein Anstieg wäre dann ein Messfehler und wird verworfen.
    if (cur.soc !== undefined) {
      if (
        lastSoc?.soc !== undefined &&
        cur.soc > lastSoc.soc &&
        (cur.plugged || lastSoc.plugged)
      ) {
        b.kwh += ((cur.soc - lastSoc.soc) / 100) * opts.capacityKwh;
      }
      lastSoc = cur;
    }

    // Geladene Reichweite: Zuwachs der Restreichweite, während das Kabel
    // steckt. Ohne Stecker steigt sie nicht durch Laden — ein Anstieg wäre
    // dann eine neu berechnete Prognose und würde die Zahl aufblähen.
    if (cur.rangeKm !== undefined) {
      if (
        lastRange?.rangeKm !== undefined &&
        cur.rangeKm > lastRange.rangeKm &&
        (cur.plugged || lastRange.plugged)
      ) {
        b.rangeAdded += cur.rangeKm - lastRange.rangeKm;
      }
      lastRange = cur;
    }

    // Kilometer: Zuwachs des Kilometerstands. Rückwärtssprünge (Zählerfehler)
    // werden ignoriert statt als negative Fahrt gewertet.
    if (cur.odometerKm !== undefined) {
      if (lastOdo?.odometerKm !== undefined && cur.odometerKm > lastOdo.odometerKm) {
        b.km += cur.odometerKm - lastOdo.odometerKm;
      }
      lastOdo = cur;
    }
  }

  const keys = [...buckets.keys()].sort();
  if (keys.length === 0) {
    return [];
  }

  // Lücken auffüllen (Obergrenze verhindert eine Endlosschleife bei kaputten Daten).
  const out: Bucket[] = [];
  let key = keys[0];
  const last = keys[keys.length - 1];
  for (let guard = 0; guard < 4000; guard++) {
    out.push(touch(key));
    if (key === last) {
      break;
    }
    key = nextKey(key, g);
  }

  const gross = opts.grossPricePerKwh ?? opts.pricePerKwh;
  for (const b of out) {
    b.kwh = Math.round(b.kwh * 100) / 100;
    b.km = Math.round(b.km);
    b.rangeAdded = Math.round(b.rangeAdded);
    b.gapMinutes = Math.round(b.gapMinutes);
    b.spanMinutes = Math.round(b.spanMinutes);
    b.cost = opts.pricePerKwh !== undefined
      ? Math.round(b.kwh * opts.pricePerKwh * 100) / 100
      : 0;
    b.costGross = gross !== undefined ? Math.round(b.kwh * gross * 100) / 100 : 0;
    b.saved = Math.round((b.costGross - b.cost) * 100) / 100;
  }
  return out;
}

export interface Efficiency {
  kwh: number;
  km: number;
  cost: number;
  /** Kosten ohne Bonus. */
  costGross: number;
  /** Ersparnis durch den Bonus. */
  saved: number;
  /** Geladene Energie je 100 km. Undefined ohne gefahrene Strecke. */
  kwhPer100km?: number;
  /** Kosten je Kilometer in Cent. */
  centPerKm?: number;
}

/**
 * Verbrauchskennzahlen über mehrere Zeiträume.
 *
 * Wichtige Einschränkung: Geladene Energie und gefahrene Strecke fallen nicht
 * gleichzeitig an — was heute geladen wird, wird morgen gefahren. Über kurze
 * Zeiträume ist die Kennzahl deshalb verzerrt und wird erst über Monate
 * aussagekräftig. Sie misst zudem *bezahlte* Energie, nicht den reinen
 * Fahrverbrauch: Ladeverluste und Standklima stecken mit drin — genau das,
 * was für einen Kostenvergleich richtig ist.
 */
export function efficiency(buckets: Bucket[]): Efficiency {
  const kwh = buckets.reduce((a, b) => a + b.kwh, 0);
  const km = buckets.reduce((a, b) => a + b.km, 0);
  const cost = buckets.reduce((a, b) => a + b.cost, 0);
  const costGross = buckets.reduce((a, b) => a + b.costGross, 0);
  const e: Efficiency = {
    kwh: Math.round(kwh * 10) / 10,
    km,
    cost: Math.round(cost * 100) / 100,
    costGross: Math.round(costGross * 100) / 100,
    saved: Math.round((costGross - cost) * 100) / 100,
  };
  if (km > 0) {
    e.kwhPer100km = Math.round((kwh / km) * 100 * 10) / 10;
    e.centPerKm = Math.round((cost / km) * 100 * 10) / 10;
  }
  return e;
}
