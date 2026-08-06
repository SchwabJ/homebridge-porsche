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
 * ganzzahlig: ±0,5 Prozentpunkte sind bei 83,7 kWh schon ±0,42 kWh. Auf einer
 * Fahrt von fünf Kilometern ist das die halbe verbrauchte Energie.
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
 * Nachgerechnet an drei Tagen echtem Mitschrieb ergibt das lauter plausible
 * Werte — 15 kWh/100 km auf der Landstraße, 31 auf einer Kurzstrecke von einem
 * Kilometer. Genau das erwartet man; der Ladestand-Weg lieferte auf denselben
 * Fahrten Unsinn.
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

/**
 * Bis hierher wird der Verbrauch noch gezeigt — aber als UNGEFÄHR.
 *
 * Gemeldet wurden Fahrten wie diese:
 *
 *     Di., 04.08., 23:30    1 km    78 → 78 %    —
 *     Di., 04.08., 21:01    2 km    79 → 79 %    —
 *
 * „Das sind leere Fahrten, ich bin hier tatsächlich gefahren."
 *
 * Beide Spalten waren aus demselben Grund leer: Zwei Kilometer sind bei
 * 20 kWh/100 km rund 0,4 kWh, also 0,5 Prozentpunkte — der Ladestand kommt
 * ganzzahlig und bleibt stehen. Der Verbrauch dagegen war rechenbar
 * (0,41 ± 0,09 kWh), nur überschritt sein relativer Fehler mit 22 % die
 * Schranke darüber.
 *
 * Eine Zahl mit 22 % Unsicherheit ist keine gute Zahl, aber sie ist eine
 * Aussage. „Ungefähr 20 kWh/100 km" trifft zu; „—" behauptet, man wisse
 * nichts. Auf einer Fahrt von zwei Kilometern ist das der Unterschied
 * zwischen einer groben und gar keiner Auskunft.
 *
 * Jenseits dieser zweiten Grenze bleibt es beim Schweigen: Ab etwa der Hälfte
 * relativen Fehlers ist auch „ungefähr" keine Beschreibung mehr.
 */
const MAX_APPROX_ERROR = 0.5;

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

/**
 * Größter Kilometer-Zuwachs am Kabel, der noch als Meldeverzug durchgeht.
 *
 * Ein Auto, das lädt, fährt nicht. Steigt der Kilometerstand trotzdem, hat das
 * Fahrzeug ihn verspätet gemeldet — die Strecke wurde vor dem Einstecken
 * gefahren, die Antwort kam nur später. Am eigenen Mitschrieb dreimal
 * beobachtet, jedes Mal genau ein Kilometer:
 *
 *     22:10:13   52602 km   kein Kabel
 *     22:10:37   52602 km   Kabel steckt, lädt
 *     22:11:35   52603 km   Kabel steckt, lädt
 *
 * Ohne Nachtrag blieb die Fahrtenliste um diese Kilometer hinter dem
 * Kilometerstand zurück: 682 statt 685 über zwei Wochen.
 *
 * Die Grenze hält den Fall klein. Wächst der Stand am Kabel um zweistellige
 * Kilometer, ist keine Meldung verspätet, sondern eine Fahrt gar nicht
 * mitgeschrieben worden — die dann einer alten Fahrt zuzuschlagen, verfälschte
 * deren Verbrauch, statt eine Lücke zu schließen.
 */
const ODO_LAG_MAX_KM = 2;

/**
 * Wie weit der Fahrtbeginn zurückgezogen werden darf, wenn der Kilometerstand
 * verspätet kam — in Minuten.
 *
 * Gemeldet wurde:
 *
 *     Do., 06.08., 00:01    1 km    69 → 68 %    —
 *     „Wieder eine Phantomfahrt. Ich bin ca. 23 Uhr 1 km gefahren!"
 *
 * Es war seine Fahrt, nur mit falscher Uhrzeit:
 *
 *     23:01   70 %   53124 km
 *     23:21   69 %   53124 km    Ladestand fällt: HIER wurde gefahren
 *     00:01   68 %   53125 km    Kilometerstand kommt erst jetzt
 *
 * Der Ladestand reagiert sofort, der Kilometerstand erst zum Fahrtende. Die
 * Fahrterkennung hängt am Kilometerstand und datierte deshalb vierzig Minuten
 * zu spät — über die Tagesgrenze hinweg sogar in den falschen Tag.
 *
 * Zurückgezogen wird nur über EINEN Messabstand: Über Stunden fällt der
 * Ladestand auch im Stehen, und eine Fahrt rückwirkend über eine Nacht zu
 * ziehen wäre schlimmer als eine um vierzig Minuten verschobene. Fünfzig
 * Minuten decken den langsamsten regulären Takt (40 min) mit Reserve ab.
 */
const SOC_LEAD_MAX_MIN = 50;

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
  /**
   * Der Verbrauch ist nur ungefähr — sein Rundungsfehler liegt über
   * {@link MAX_REL_ERROR}, aber noch unter {@link MAX_APPROX_ERROR}.
   *
   * Trifft praktisch nur Kurzstrecken: Der Fehler des Zyklus-Zählers wirkt
   * absolut, sein Anteil an einer Fahrt wächst also, je kürzer sie ist.
   */
  approximate?: boolean;
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
  /**
   * Preis je STARTZEITPUNKT einer Fahrt — hat Vorrang vor `pricePerKwh`.
   *
   * Dieselbe Regel wie bei den Ladungen: Nach einem Tarifwechsel behalten
   * alte Fahrten ihre alten Kosten, statt rückwirkend neu bewertet zu werden.
   */
  priceFor?: (startedAt: string) => { pricePerKwh: number; grossPricePerKwh: number };
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
        // Anker auf das ENDE dieser Fahrt, nicht auf ihren Anfang.
        //
        // Die Fahrt selbst bleibt zu Recht unbewertet — ihr Zählerstand ist
        // unbrauchbar. Setzte man den Anker aber auf ihren Anfang, rechnete
        // die NÄCHSTE Fahrt ihre Energie über eine Strecke, die diese hier
        // mit enthält, und zog nichts davon ab: nachgemessen 40 statt 20
        // kWh/100 km. Die Fehlerschranke fängt das nicht, weil sie mit der
        // aufgeblähten Energie mitwächst. Genau davor warnt der Zweig
        // darunter — im Rücksetzer-Pfad passierte es trotzdem.
        cycleStartKm = last.odometerKm;
        prevCycleKwh = undefined;
      } else {
        if (energy > 0) {
          const err = errorKwh(cycleKm) + errorKwh(Math.max(0, cycleKm - km));
          const rel = err / energy;
          if (rel <= MAX_APPROX_ERROR) {
            trip.energyKwh = Math.round(energy * 100) / 100;
            trip.kwhPer100km = Math.round((energy / km) * 1000) / 10;
            if (rel > MAX_REL_ERROR) {
              trip.approximate = true;
            }
            const price = opts.priceFor
              ? opts.priceFor(trip.startedAt).pricePerKwh
              : opts.pricePerKwh;
            if (price !== undefined && price > 0) {
              trip.costEur = Math.round(energy * price * 100) / 100;
            }
          }
        }
        prevCycleKwh = cycleKwh;
      }
    } else if (cycleStartKm !== undefined) {
      // Der Endpunkt trägt keinen Verbrauchswert — `tripKwh100` kommt aus
      // einem eigenen Messschlüssel und kann allein fehlen. Ohne
      // Fortschreibung bliebe `prevCycleKwh` auf dem Stand der VORVORIGEN
      // Fahrt stehen, und die nächste bekäme die Energie dieser hier mit
      // aufgebürdet (nachgemessen 60 statt 30 kWh/100 km).
      const mitWert = [...open].reverse().find((p) => p.kwh100 !== undefined && p.kwh100 > 0);
      if (mitWert) {
        // Ein früherer Messpunkt DERSELBEN Fahrt trägt den Zählerstand. Für
        // die Reststrecke bis zum Fahrtende gilt sein Verbrauchsschnitt
        // weiter: Der Schnitt ist ein Mittel über den ganzen Zyklus und
        // ändert sich über wenige Kilometer kaum. Die Alternative — die
        // Reststrecke gar nicht zu buchen — wäre keine Enthaltung, sondern
        // ein Geschenk an die nächste Fahrt (nachgemessen 45 statt 30).
        prevCycleKwh = ((last.odometerKm - cycleStartKm) * (mitWert.kwh100 as number)) / 100;
      } else {
        // Kein einziger Messpunkt dieser Fahrt trägt einen Wert: Der
        // Zyklusstand ist verloren. Dann bleiben die folgenden Fahrten
        // unbewertet, bis das nächste Laden den Zyklus neu setzt — lieber
        // keine Zahl als eine, die fremde Energie enthält.
        cycleStartKm = undefined;
        prevCycleKwh = undefined;
      }
    }

    trips.push(trip);
    open = undefined;
  };

  /**
   * Verbucht einen Kilometerstand, der erst am Kabel eintraf.
   *
   * Läuft noch eine Fahrt, gehört der Punkt schlicht zu ihr. Ist sie bereits
   * geschlossen — der Regelfall, weil der erste Ladepunkt sie beendet —, wächst
   * die letzte Fahrt um den Zuwachs.
   *
   * Die Zeitangaben bleiben, wie sie sind: Gefahren wurde vor dem Einstecken,
   * und `endedAt` auf den Ladepunkt zu ziehen machte aus vierzig Minuten
   * Standzeit vierzig Minuten Fahrt.
   */
  const nachtragen = (p: Point, prev: Point | undefined): void => {
    if (prev === undefined) return;
    const zuwachs = p.odometerKm - prev.odometerKm;
    if (zuwachs <= 0 || zuwachs > ODO_LAG_MAX_KM) return;
    if (open !== undefined) {
      open.push(p);
      return;
    }
    const letzte = trips[trips.length - 1];
    // Der Kilometerstand muss seit dem Fahrtende unverändert sein, sonst
    // schließt der Nachtrag nicht lückenlos an und gehört woanders hin.
    if (letzte === undefined || letzte.odometerKm !== prev.odometerKm) return;
    letzte.km += zuwachs;
    letzte.odometerKm = p.odometerKm;
    if (letzte.energyKwh !== undefined) {
      letzte.kwhPer100km = Math.round((letzte.energyKwh / letzte.km) * 1000) / 10;
    }
  };

  // Die Messpunkte werden EINZELN verarbeitet, nicht erst zu einer Liste
  // aufgesammelt: `samples` darf ein Generator über die Tagesdateien sein, und
  // eine Zwischenliste hätte die ganze Historie wieder im Speicher.
  let prev: Point | undefined;
  /** Der Punkt VOR `prev` — für den zurückgezogenen Fahrtbeginn. */
  let vorletzter: Point | undefined;
  for (const raw of samples) {
    if (raw.odometerKm === undefined) {
      // Ein LADE-Messpunkt schneidet den Verbrauchszyklus auch ohne
      // Kilometerstand: Am Kabel ändert sich der Stand nicht, der letzte
      // bekannte gilt also weiter. Ihn hier zu übergehen ließ den Anker auf
      // der vorherigen Ladung stehen, und die erste Fahrt danach bekam einen
      // viel zu niedrigen Verbrauch zugeschrieben (3,3 statt 20 kWh/100 km).
      if (raw.charging === true && prev !== undefined) {
        close();
        cycleStartKm = prev.odometerKm;
        prevCycleKwh = undefined;
      }
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
      // ERST den Kilometerstand verbuchen, dann schließen: Danach ist die
      // Fahrt in der Liste und der Zuwachs hätte niemanden mehr, zu dem er
      // gehört.
      nachtragen(p, prev);
      close();
      cycleStartKm = p.odometerKm;
      prevCycleKwh = undefined;
      prev = p;
      continue;
    }
    if (prev !== undefined) {
      if (p.odometerKm > prev.odometerKm) {
        if (open === undefined) {
          // Der Ladestand fällt VOR dem Kilometerstand — siehe
          // SOC_LEAD_MAX_MIN. Fiel er schon im Messabstand davor, begann die
          // Fahrt dort, und der Beginn wird um einen Punkt zurückgezogen.
          const davor = vorletzter;
          const zurueck =
            davor !== undefined &&
            davor.soc !== undefined &&
            prev.soc !== undefined &&
            davor.soc > prev.soc &&
            davor.odometerKm === prev.odometerKm &&
            (Date.parse(prev.ts) - Date.parse(davor.ts)) / 60000 <= SOC_LEAD_MAX_MIN;
          open = zurueck ? [davor as Point, prev] : [prev];
        }
        open.push(p);
      } else if (open !== undefined) {
        close();
      }
    }
    vorletzter = prev;
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
