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

export type Granularity = 'hour' | 'day' | 'week' | 'month' | 'year';

/**
 * Die Unterteilung EINES Zeitraums — was im Balkendiagramm nebeneinander steht.
 *
 * Der gewählte Zeitraum ist der Rahmen, nicht der Balken: Wer „Woche" wählt,
 * will die Tage dieser Woche sehen, nicht die letzten sechsundzwanzig Wochen.
 * Vorher zeigte die Wochenansicht einen einzigen Balken, obwohl an zwei Tagen
 * geladen worden war — beide lagen in derselben Woche.
 */
export const SUB: Record<Granularity, Granularity> = {
  hour: 'hour',
  day: 'hour',
  week: 'day',
  month: 'week',
  year: 'month',
};

export interface Bucket {
  /** Sortierbarer Schlüssel: `2026-07-27`, `2026-W31`, `2026-07`, `2026`. */
  key: string;
  /**
   * Zeitstempel des ersten Messpunkts in diesem Abschnitt (ISO).
   *
   * Nötig, um einen Abschnitt seinem übergeordneten Zeitraum zuzuordnen: Aus
   * dem Schlüssel allein ginge das nicht, weil eine Kalenderwoche über den
   * Monatswechsel reichen kann.
   */
  from: string;
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
  /**
   * VERBRAUCHTE Energie in kWh — das Gegenstück zu {@link Bucket.kwh}.
   *
   * Je MESSPUNKT gerechnet, nicht je Fahrt: Eine zweistündige Fahrt verteilt
   * sich damit über die Stunden, die sie tatsächlich gedauert hat. Wird die
   * Energie einer ganzen Fahrt dem Abschnitt ihres Endes zugeschlagen, steht
   * in der Stundenansicht ein 46-kWh-Balken in einer Stunde, während die
   * Stunde davor mit 100 gefahrenen Kilometern auf null steht.
   *
   * Quelle ist `TRIP_STATISTICS_CYCLIC`: der Verbrauchsschnitt seit dem
   * letzten Laden. Mal der Strecke seit dem Laden ergibt das die kumulierte
   * Energie des Zyklus; der Zuwachs zwischen zwei Messpunkten ist der
   * Verbrauch dazwischen. Über eine ganze Fahrt summiert sich das exakt auf
   * deren Energie auf.
   */
  usedKwh: number;
  /**
   * Gefahrene Kilometer OHNE zugehörige Verbrauchsangabe.
   *
   * Solange das Fahrzeug nach einem Ladevorgang noch keinen Schnitt gemeldet
   * hat — oder der Mitschrieb mitten in einem Zyklus beginnt — bleibt die
   * Energie unbekannt. Diese Strecke wird gezählt und ausgewiesen, statt den
   * Verbrauch stillschweigend zu kurz darzustellen.
   */
  unratedKm: number;
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
    case 'hour':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
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
    case 'hour': {
      const [, hh] = key.split('T');
      return `${hh}:00`;
    }
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

/**
 * Beginn eines Abschnitts aus seinem Schlüssel.
 *
 * Für aufgefüllte Lücken: Dort gibt es keinen Messpunkt, aus dem sich `from`
 * ergäbe — die Zuordnung zum übergeordneten Zeitraum braucht ihn trotzdem.
 */
function fromKey(key: string, g: Granularity): string {
  switch (g) {
    case 'hour': {
      const [datum, hh] = key.split('T');
      const [y, m, d] = datum.split('-').map(Number);
      return new Date(y, m - 1, d, Number(hh)).toISOString();
    }
    case 'day': {
      const [y, m, d] = key.split('-').map(Number);
      return new Date(y, m - 1, d).toISOString();
    }
    case 'week': {
      const [y, w] = key.split('-W');
      const jan4 = new Date(Number(y), 0, 4);
      const monday = new Date(jan4);
      monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (Number(w) - 1) * 7);
      return monday.toISOString();
    }
    case 'month': {
      const [y, m] = key.split('-').map(Number);
      return new Date(y, m - 1, 1).toISOString();
    }
    case 'year':
      return new Date(Number(key), 0, 1).toISOString();
  }
}

/** Nächster Bucket-Schlüssel — für das Auffüllen von Lücken. */
function nextKey(key: string, g: Granularity): string {
  switch (g) {
    case 'hour': {
      const [datum, hh] = key.split('T');
      const [y, m, d] = datum.split('-').map(Number);
      return keyOf(new Date(y, m - 1, d, Number(hh) + 1), 'hour');
    }
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
  samples: Iterable<ChargeLogSample>,
  g: Granularity,
  opts: AggregateOptions,
): Bucket[] {
  const buckets = new Map<string, Bucket>();
  const boundary = opts.dayBoundaryHour ?? 0;

  const touch = (key: string, ts?: string): Bucket => {
    let b = buckets.get(key);
    if (b && !b.from && ts) {
      b.from = ts;
    }
    if (!b) {
      b = { key, from: ts ?? '', label: labelOf(key, g, opts.labels), kwh: 0, cost: 0, costGross: 0, saved: 0, km: 0, rangeAdded: 0, usedKwh: 0, unratedKm: 0, samples: 0, gapMinutes: 0, spanMinutes: 0 };
      buckets.set(key, b);
    }
    return b;
  };

  // Der erste Messpunkt liefert kein Delta, markiert aber einen Zeitraum MIT
  // Daten. Ohne diesen Anker fiele der erste Tag/die erste Woche ganz heraus.
  //
  // Alles in EINEM Durchlauf: `samples` darf ein Generator sein, der die
  // Tagesdateien einzeln liest und wieder freigibt. Ein zweiter Zugriff auf
  // `samples[0]` wäre dann nicht möglich — und genau daran hängt, ob sechs
  // Jahre Mitschrieb in den Speicher eines Raspberry Pi passen.

  // Letzter Messpunkt MIT Ladestand bzw. MIT Kilometerstand — nicht einfach
  // der direkte Vorgänger.
  //
  // Grund: Die API liefert regelmäßig Zeilen ohne jeden Messwert. Verglichen
  // man nur Nachbarn, fiele jeder Sprung über eine solche Lücke hinweg aus der
  // Rechnung: 70 % → (leer) → 75 % ergäbe zweimal „kein Vergleich möglich" und
  // die fünf Prozentpunkte zählte niemand. In der Zeitreihe fehlt dadurch ein
  // erheblicher Teil der geladenen Energie, während die Session-Rechnung
  // (nur Anfang und Ende) korrekt bleibt — Tabelle und Diagramm widersprechen
  // sich dann, was den Fehler erst auffällig macht.
  let lastSoc: ChargeLogSample | undefined;
  let lastOdo: ChargeLogSample | undefined;
  let lastRange: ChargeLogSample | undefined;
  // Verbrauchszyklus: Kilometerstand beim letzten Laden und die dort erreichte
  // kumulierte Energie. Der Zähler des Fahrzeugs beginnt mit jedem Laden neu.
  let cycleStartKm: number | undefined;
  let cycleKwh = 0;
  let prev: ChargeLogSample | undefined;

  for (const cur of samples) {
    if (prev === undefined) {
      // Der erste Messpunkt: Anker setzen, kein Delta.
      touch(keyOf(shift(new Date(cur.ts), boundary), g), cur.ts).samples++;
      if (cur.soc !== undefined) {
        lastSoc = cur;
      }
      if (cur.odometerKm !== undefined) {
        lastOdo = cur;
      }
      if (cur.rangeKm !== undefined) {
        lastRange = cur;
      }
      // Stünde die Ladung genau am Anfang der Reihe, bliebe der
      // Verbrauchszyklus ohne Bezugspunkt und die ganze folgende Strecke
      // unbewertet.
      if (cur.charging === true && cur.odometerKm !== undefined) {
        cycleStartKm = cur.odometerKm;
      }
      prev = cur;
      continue;
    }
    // Zugeordnet wird nach dem SPÄTEREN der beiden Messpunkte: Ein Zuwachs
    // wird dem Zeitpunkt gutgeschrieben, an dem er festgestellt wurde. Eine
    // Nachtladung landet damit auf dem Tag ihres Endes, nicht anteilig auf
    // beiden — anteilig aufzuteilen setzte voraus, den Verlauf zwischen zwei
    // Messpunkten zu kennen, und den kennt hier niemand.
    //
    // Genau dafür gibt es die Tagesgrenze: Wer eine Nachtladung dem Vorabend
    // zurechnen will, setzt sie auf 4 — dann verschiebt sich der Schnitt,
    // statt dass die Energie geteilt wird.
    const key = keyOf(shift(new Date(cur.ts), boundary), g);
    const b = touch(key, cur.ts);
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
    let gefahren = 0;
    if (cur.odometerKm !== undefined) {
      if (lastOdo?.odometerKm !== undefined && cur.odometerKm > lastOdo.odometerKm) {
        gefahren = cur.odometerKm - lastOdo.odometerKm;
        b.km += gefahren;
      }
      lastOdo = cur;
    }

    // Verbrauch — siehe {@link Bucket.usedKwh}.
    //
    // Der Zähler des Fahrzeugs beginnt mit dem LADEN neu, nicht mit dem
    // Ein- oder Ausstecken: Wer ansteckt und den Strom nie einschaltet, hat
    // weiterhin denselben Zähler. Am Kabel ändert sich der Kilometerstand
    // nicht, deshalb darf jeder Lade-Messpunkt den Zyklus setzen.
    if (cur.charging === true && cur.odometerKm !== undefined) {
      cycleStartKm = cur.odometerKm;
      cycleKwh = 0;
    } else if (
      cycleStartKm !== undefined &&
      cur.odometerKm !== undefined &&
      cur.tripKwh100 !== undefined &&
      cur.tripKwh100 > 0
    ) {
      const jetzt = ((cur.odometerKm - cycleStartKm) * cur.tripKwh100) / 100;
      const zuwachs = jetzt - cycleKwh;
      if (zuwachs >= 0) {
        b.usedKwh += zuwachs;
        cycleKwh = jetzt;
      } else {
        // Gefallener Zählerstand: Das Fahrzeug hat zurückgesetzt, ohne dass
        // ein Ladevorgang im Mitschrieb steht. Der Zyklus beginnt hier neu,
        // und die Strecke dieses Abschnitts bleibt unbewertet.
        cycleStartKm = cur.odometerKm;
        cycleKwh = 0;
        b.unratedKm += gefahren;
      }
    } else if (gefahren > 0) {
      b.unratedKm += gefahren;
    }

    prev = cur;
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
    out.push(touch(key, fromKey(key, g)));
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
    b.usedKwh = Math.round(b.usedKwh * 100) / 100;
    b.unratedKm = Math.round(b.unratedKm);
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
