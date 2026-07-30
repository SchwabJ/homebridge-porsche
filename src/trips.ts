/**
 * Fahrten aus dem Mitschrieb ableiten — das Gegenstück zur Ladungsliste.
 *
 * ## Warum überhaupt
 *
 * Das Dashboard zeigte bisher nur, was in die Batterie hineinging. Was
 * herauskam, stand nirgends: keine Strecke, kein Verbrauch je Fahrt, keine
 * Kosten einer einzelnen Fahrt. Dabei liegt beides im selben Mitschrieb.
 *
 * ## Was eine Fahrt hier ist
 *
 * Eine zusammenhängende Folge von Messpunkten mit steigendem Kilometerstand.
 * Ein Messpunkt ohne Zuwachs beendet sie — das Fahrzeug stand mindestens ein
 * Abfrageintervall lang.
 *
 * **Das ist eine Näherung, und zwar eine grobe.** Ohne Kabel fragt das Plugin
 * alle 20 bis 60 Minuten ab. Zwei Fahrten mit fünf Minuten Pause dazwischen
 * verschmelzen deshalb zu einer; eine Fahrt über zwei Abfragen hinweg bleibt
 * eine. Genauer geht es nicht: Der Kilometerstand kommt aus derselben
 * zwischengespeicherten Antwort wie alles andere, ein Fahrtenschreiber ist die
 * Schnittstelle nicht. Jede Fahrt trägt deshalb {@link Trip.gapMinutes} — den
 * größten Messabstand in ihr —, damit die Anzeige sagen kann, wie fein sie
 * überhaupt aufgelöst ist.
 *
 * ## Woher der Verbrauch kommt — und warum NICHT aus dem Ladestand
 *
 * Der naheliegende Weg wäre `SoC-Abfall × Kapazität`. Der Ladestand kommt aber
 * ganzzahlig: ±0,5 Prozentpunkte sind bei einer 80-kWh-Batterie schon ±0,4 kWh.
 * Auf einer Fahrt von fünf Kilometern ist das die halbe verbrauchte Energie.
 *
 * Das Fahrzeug meldet stattdessen `TRIP_STATISTICS_CYCLIC` — den Verbrauch
 * SEIT DEM LETZTEN LADEN, in kWh/100 km. Mit der seither gefahrenen Strecke
 * ergibt das die kumulierte Energie des laufenden Zyklus:
 *
 *     E(k) = km_seit_Ladung(k) × kwh100(k) / 100
 *
 * Die Energie einer einzelnen Fahrt ist dann schlicht die Differenz zweier
 * solcher Stände — `E(k) − E(k−1)`. **Kein Ladestand, keine Kapazität, keine
 * Annahme über die Batterie: Das ist die Angabe des Fahrzeugs selbst.**
 *
 * An einem echten Mitschrieb nachgerechnet ergibt das durchweg plausible Werte:
 * niedrige auf langen Überlandstrecken, deutlich höhere auf Kurzstrecken von
 * ein bis drei Kilometern. Genau das erwartet man; der Ladestand-Weg lieferte
 * auf denselben Fahrten Unsinn.
 *
 * ## Wo diese Rechnung ihre Grenze hat
 *
 * `kwh100` kommt auf eine Nachkommastelle gerundet. Der Rundungsfehler wirkt
 * auf den KUMULIERTEN Stand, wächst also mit der Strecke seit dem Laden — und
 * er trifft die Differenz zweimal. Auf einer kurzen Fahrt am Ende eines langen
 * Zyklus bleibt davon nichts Brauchbares übrig. Deshalb rechnet
 * {@link errorKwh} den Fehler mit und die Anzeige schweigt, sobald er zu groß
 * wird ({@link MAX_REL_ERROR}) — eine Verbrauchsangabe mit ±40 % ist keine
 * Information, sondern eine Behauptung.
 */
import type { ChargeLogSample } from './chargeLog';

/**
 * Größter Anteil, den der Rundungsfehler am Verbrauch einer Fahrt haben darf.
 *
 * Darüber bleibt die Fahrt in der Liste, aber ohne Verbrauchszahl. Die Strecke
 * ist ja trotzdem gefahren worden — nur was sie gekostet hat, ist dann nicht
 * mehr sagbar.
 */
const MAX_REL_ERROR = 0.15;

/** Rundungsschritt von `tripKwh100` laut Fahrzeug, in kWh/100 km. */
const KWH100_STEP = 0.1;

/**
 * Strecke, ab der ein Reichweiten-Faktor ausgewiesen wird, in km.
 *
 * Die Restreichweitenanzeige ist eine Prognose und springt auch ohne Fahrt —
 * beim Einschalten der Heizung fällt sie um zweistellige Kilometer. Über
 * hundert Kilometer mitteln sich solche Sprünge heraus, über zehn bestimmen
 * sie das Ergebnis.
 */
const MIN_KM_FOR_RANGE_FACTOR = 100;

export interface Trip {
  /** Letzter Messpunkt VOR der Bewegung — dort stand das Fahrzeug noch. */
  startedAt: string;
  /** Messpunkt, an dem der Kilometerstand zuletzt stieg. */
  endedAt: string;
  /** Gefahrene Strecke in km. */
  km: number;
  /**
   * Zeit zwischen beiden Punkten in Minuten.
   *
   * Das ist NICHT die Fahrzeit: Zwischen dem letzten Messpunkt im Stand und
   * dem ersten mit Zuwachs liegt beliebig viel Standzeit. Eine
   * Durchschnittsgeschwindigkeit lässt sich daraus nicht ableiten, und sie
   * wird deshalb auch nirgends gezeigt.
   */
  minutes: number;
  /** Größter Messabstand innerhalb der Fahrt — das Auflösungsmaß. */
  gapMinutes: number;
  /** Verbrauchte Energie in kWh, aus der Verbrauchsangabe des Fahrzeugs. */
  energyKwh?: number;
  /** Verbrauch in kWh/100 km. */
  kwhPer100km?: number;
  /** Kosten in EUR, sofern ein Arbeitspreis gilt. */
  costEur?: number;
  /** Ladestand am Anfang und am Ende, wenn bekannt. */
  startSoc?: number;
  endSoc?: number;
  /**
   * Wie viel Restreichweite die Anzeige über diese Fahrt verloren hat, in km.
   *
   * Trifft die Prognose des Fahrzeugs zu, entspricht das genau der gefahrenen
   * Strecke. Ist sie größer, war das Auto optimistisch — jeder gefahrene
   * Kilometer kostete mehr als einen Kilometer Anzeige.
   */
  rangeLostKm?: number;
  /** Kilometerstand am Ende der Fahrt. */
  odometerKm?: number;
  /** Anzahl der Messpunkte, aus denen die Fahrt gebildet wurde. */
  samples: number;
}

export interface TripOptions {
  /** Effektiver Arbeitspreis in EUR/kWh. Ohne Angabe bleiben die Kosten leer. */
  pricePerKwh?: number;
}

/**
 * Fehler der kumulierten Zyklus-Energie, der allein aus der Rundung von
 * `kwh100` folgt: halbe Schrittweite mal Strecke.
 */
const errorKwh = (cycleKm: number): number => (cycleKm * (KWH100_STEP / 2)) / 100;

/** Ein Messpunkt, der für die Fahrterkennung überhaupt taugt. */
interface Point {
  ts: string;
  odometerKm: number;
  soc?: number;
  rangeKm?: number;
  kwh100?: number;
  plugged?: boolean;
  charging?: boolean;
}

/**
 * Baut die Fahrten aus einer zeitlich sortierten Messpunktfolge.
 *
 * Erwartet die Ausgabe von `readSamples` — nicht selbst gelesene Dateien.
 * Ältere Mitschriebe enthalten Zeilen, die eine leere Antwort als
 * „ausgesteckt" festhalten; unrepariert erzeugen sie Phantomfahrten von null
 * Kilometern.
 */
export function buildTrips(
  samples: Iterable<ChargeLogSample>,
  opts: TripOptions = {},
): Trip[] {
  const trips: Trip[] = [];
  /** Kilometerstand beim Beginn des laufenden Verbrauchszyklus. */
  let cycleStartKm: number | undefined;
  /** Kumulierte Energie am Ende der letzten Fahrt dieses Zyklus. */
  let prevCycleKwh: number | undefined;
  /** Messpunkte der laufenden Fahrt, beginnend mit dem letzten im Stand. */
  let open: Point[] | undefined;

  const close = (): void => {
    if (!open || open.length < 2) {
      open = undefined;
      return;
    }
    const first = open[0];
    const last = open[open.length - 1];
    const km = last.odometerKm - first.odometerKm;
    if (km <= 0) {
      open = undefined;
      return;
    }
    let gap = 0;
    for (let i = 1; i < open.length; i++) {
      gap = Math.max(gap, (Date.parse(open[i].ts) - Date.parse(open[i - 1].ts)) / 60000);
    }
    const trip: Trip = {
      startedAt: first.ts,
      endedAt: last.ts,
      km,
      minutes: Math.round((Date.parse(last.ts) - Date.parse(first.ts)) / 60000),
      gapMinutes: Math.round(gap),
      startSoc: first.soc,
      endSoc: last.soc,
      odometerKm: last.odometerKm,
      samples: open.length,
    };
    if (first.rangeKm !== undefined && last.rangeKm !== undefined) {
      trip.rangeLostKm = first.rangeKm - last.rangeKm;
    }

    // Verbrauch aus der Angabe des Fahrzeugs — siehe Kopfkommentar.
    if (cycleStartKm !== undefined && last.kwh100 !== undefined && last.kwh100 > 0) {
      const cycleKm = last.odometerKm - cycleStartKm;
      const cycleKwh = (cycleKm * last.kwh100) / 100;
      // Der Stand vor dieser Fahrt. Fehlt er, ist sie die erste des Zyklus —
      // dann stand der Zähler davor auf null.
      //
      // Auch eine Fahrt OHNE ausgewiesenen Verbrauch schreibt ihren Stand
      // fort: Sonst bekäme die nächste ihre Energie mit aufgebürdet.
      const energy = cycleKwh - (prevCycleKwh ?? 0);
      // Ein gefallener Zählerstand heißt: Das Fahrzeug hat zwischendurch
      // zurückgesetzt, ohne dass ein Ladevorgang im Mitschrieb steht. Dann ist
      // die Differenz bedeutungslos — die Fahrt bleibt ohne Verbrauchszahl,
      // und der Zyklus beginnt hier neu.
      if (energy < 0) {
        cycleStartKm = first.odometerKm;
        prevCycleKwh = undefined;
      } else {
        if (energy > 0) {
          const err = errorKwh(cycleKm) + errorKwh(Math.max(0, cycleKm - km));
          if (err / energy <= MAX_REL_ERROR) {
            trip.energyKwh = Math.round(energy * 100) / 100;
            trip.kwhPer100km = Math.round((energy / km) * 1000) / 10;
            if (opts.pricePerKwh !== undefined && opts.pricePerKwh > 0) {
              trip.costEur = Math.round(energy * opts.pricePerKwh * 100) / 100;
            }
          }
        }
        prevCycleKwh = cycleKwh;
      }
    }

    trips.push(trip);
    open = undefined;
  };

  // Die Messpunkte werden EINZELN verarbeitet, nicht erst zu einer Liste
  // aufgesammelt: `samples` darf ein Generator über die Tagesdateien sein, und
  // eine Zwischenliste hätte die ganze Historie wieder im Speicher.
  let prev: Point | undefined;
  for (const raw of samples) {
    if (raw.odometerKm === undefined) {
      continue;
    }
    const p: Point = {
      ts: raw.ts,
      odometerKm: raw.odometerKm,
      soc: raw.soc,
      rangeKm: raw.rangeKm,
      kwh100: raw.tripKwh100,
      plugged: raw.plugged,
      charging: raw.charging,
    };
    // Der Verbrauchszähler des Fahrzeugs setzt sich mit dem LADEN zurück,
    // nicht mit dem Ein- oder Ausstecken. Am Kabel zu stehen genügt nicht:
    // Wer nur ansteckt und den Strom nie einschaltet, hat weiterhin denselben
    // Zähler — ein Rücksetzen dort verschöbe den Bezugspunkt still.
    //
    // Der Kilometerstand ändert sich beim Laden nicht, deshalb darf jeder
    // Lade-Messpunkt den Zyklusanfang setzen.
    if (p.charging === true) {
      close();
      cycleStartKm = p.odometerKm;
      prevCycleKwh = undefined;
      prev = p;
      continue;
    }
    if (prev !== undefined) {
      if (p.odometerKm > prev.odometerKm) {
        if (open === undefined) {
          open = [prev];
        }
        open.push(p);
      } else if (open !== undefined) {
        close();
      }
    }
    prev = p;
  }
  close();
  return trips;
}

export interface TripSummary {
  trips: number;
  km: number;
  energyKwh: number;
  costEur: number;
  /** Verbrauch über alle Fahrten MIT Verbrauchsangabe, in kWh/100 km. */
  kwhPer100km?: number;
  /** Strecke, für die ein Verbrauch bekannt ist — der Bezug der Zeile darüber. */
  ratedKm: number;
  /**
   * Wie viel Restreichweite je gefahrenem Kilometer verloren ging.
   *
   * 1,0 heißt: Die Prognose des Fahrzeugs trifft zu. 1,2 heißt: Jeder
   * gefahrene Kilometer kostet 1,2 km Anzeige — das Auto verspricht 20 % mehr,
   * als es hält. Unter 1,0 ist es zu vorsichtig.
   *
   * `undefined`, solange zu wenig Strecke vorliegt: Die Reichweitenanzeige
   * springt beim Heizen auch ohne Fahrt, und über wenige Kilometer bestimmt
   * dieser Sprung das Ergebnis.
   */
  rangeFactor?: number;
  /** Strecke, auf der dieser Faktor beruht. */
  rangeKm: number;
}

/**
 * Fasst Fahrten zusammen.
 *
 * Der Durchschnittsverbrauch bezieht sich nur auf die Fahrten MIT
 * Verbrauchsangabe. Eine Fahrt ohne sie in den Nenner zu nehmen, verdünnte den
 * Schnitt — deshalb steht {@link TripSummary.ratedKm} daneben.
 */
export function summarizeTrips(trips: Trip[]): TripSummary {
  const out: TripSummary = {
    trips: trips.length,
    km: 0,
    energyKwh: 0,
    costEur: 0,
    ratedKm: 0,
    rangeKm: 0,
  };
  let rangeLost = 0;
  for (const t of trips) {
    out.km += t.km;
    if (t.energyKwh !== undefined) {
      out.energyKwh += t.energyKwh;
      out.ratedKm += t.km;
      out.costEur += t.costEur ?? 0;
    }
    if (t.rangeLostKm !== undefined) {
      rangeLost += t.rangeLostKm;
      out.rangeKm += t.km;
    }
  }
  out.km = Math.round(out.km);
  out.energyKwh = Math.round(out.energyKwh * 10) / 10;
  out.costEur = Math.round(out.costEur * 100) / 100;
  if (out.ratedKm > 0) {
    out.kwhPer100km = Math.round((out.energyKwh / out.ratedKm) * 1000) / 10;
  }
  out.rangeKm = Math.round(out.rangeKm);
  if (out.rangeKm >= MIN_KM_FOR_RANGE_FACTOR) {
    out.rangeFactor = Math.round((rangeLost / out.rangeKm) * 100) / 100;
  }
  return out;
}
