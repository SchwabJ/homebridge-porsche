/**
 * Ladefenster — laden nur in einem selbst gewählten Zeitraum.
 *
 * Der Ladetimer des Fahrzeugs kennt nur eine ABFAHRTSZEIT, kein Fenster. Wer
 * einen Nachttarif hat (Octopus, aWATTar & Co.) will aber genau das: „lade
 * zwischen 00:30 und 04:30, sonst nicht". Taycan-Fahrer beschreiben das
 * Problem seit Jahren; dazu kommen Fälle, in denen ein eingerichteter
 * Ladeplan ohne Zutun in Sofortladen umkippte, und die Beobachtung, dass sich
 * eine laufende Ladung aus der App überhaupt nicht stoppen lässt.
 *
 * Das Plugin kann es besser, weil es im Haus des Nutzers läuft: Am Kabel
 * fragt es alle drei Minuten nach und kann selbst starten und stoppen.
 *
 * Diese Datei enthält NUR die Entscheidung, nicht ihre Ausführung — sie ist
 * rein und ohne Nebenwirkungen, damit sich jeder Grenzfall prüfen lässt, ohne
 * ein Auto anzufassen.
 *
 * ZURÜCKHALTUNG IST DIE REGEL. Die Funktion gibt im Zweifel `undefined`
 * zurück, also „nichts tun":
 *  - ohne konfiguriertes Fenster (Standard ist aus),
 *  - ohne steckendes Kabel,
 *  - bei jedem unbekannten Messwert — die Schnittstelle beantwortet einen
 *    Teil der Abfragen ohne Werte, und auf einen geratenen Ladestand hin das
 *    Laden zu stoppen wäre der schlimmste Fehler, den sie machen kann,
 *  - unterhalb der Sofortlade-Schwelle des Fahrzeugs. Das ist dessen Reserve;
 *    ein Sparfenster darf sie nicht aushebeln. Ein fahrbereites Auto ist mehr
 *    wert als billiger Strom.
 */

import type { ChargeSession } from './sessions';

/** Ein Ladefenster in Minuten seit Mitternacht, lokale Zeit. */
export interface ChargeWindow {
  fromMin: number;
  toMin: number;
}

/** Zustandsgrößen, auf die sich die Entscheidung stützt. */
export interface WindowState {
  plugged?: boolean;
  charging?: boolean;
  soc?: number;
  /** Ladeziel des Fahrzeugs in Prozent. */
  targetSoc?: number;
  /** Sofortlade-Schwelle: Bis dahin lädt das Fahrzeug unabhängig vom Timer. */
  minSoc?: number;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Liest zwei Uhrzeiten als `HH:MM`.
 *
 * Gibt `undefined` zurück, sobald etwas nicht stimmt — ein vertipptes Fenster
 * darf nicht stillschweigend zu einem anderen werden, sonst steht das Auto
 * morgens ungeladen da. Lieber gar kein Fenster als ein falsches.
 */
export function parseWindow(from: string, to: string): ChargeWindow | undefined {
  const a = HHMM.exec(from);
  const b = HHMM.exec(to);
  if (!a || !b) {
    return undefined;
  }
  const fromMin = Number(a[1]) * 60 + Number(a[2]);
  const toMin = Number(b[1]) * 60 + Number(b[2]);
  // Gleiche Zeit heißt kein Fenster, nicht „rund um die Uhr".
  if (fromMin === toMin) {
    return undefined;
  }
  return { fromMin, toMin };
}

/** Liegt der Zeitpunkt im Fenster? Trägt auch ein Fenster über Mitternacht. */
function imFenster(jetzt: Date, w: ChargeWindow): boolean {
  const min = jetzt.getHours() * 60 + jetzt.getMinutes();
  return w.fromMin < w.toMin
    ? min >= w.fromMin && min < w.toMin
    : min >= w.fromMin || min < w.toMin;
}

/**
 * Was jetzt zu tun ist: starten, stoppen — oder nichts.
 *
 * `undefined` heißt ausdrücklich „nichts tun" und ist die häufigste Antwort.
 */
export function chargeWindowAction(
  jetzt: Date,
  fenster: ChargeWindow | undefined,
  state: WindowState,
): 'start' | 'stop' | undefined {
  if (!fenster || state.plugged !== true) {
    return undefined;
  }
  // Kein Raten auf unvollständigen Daten. Siehe Dateikopf.
  const { charging, soc, targetSoc, minSoc } = state;
  if (charging === undefined || soc === undefined || targetSoc === undefined) {
    return undefined;
  }

  // Die Reserve des Fahrzeugs schlägt jedes Sparfenster: Unterhalb der
  // Sofortlade-Schwelle wird geladen, egal wie spät es ist.
  if (minSoc !== undefined && soc < minSoc) {
    return charging ? undefined : 'start';
  }

  // Am Ziel gibt es nichts mehr zu starten. Ein laufendes Laden hier zu
  // stoppen ist nicht nötig — das erledigt das Fahrzeug selbst.
  if (soc >= targetSoc) {
    return undefined;
  }

  if (imFenster(jetzt, fenster)) {
    return charging ? undefined : 'start';
  }
  return charging ? 'stop' : undefined;
}

/**
 * Wie lang eine Ladepause sein muss, um als fremder Takt zu gelten.
 *
 * Kurze Aussetzer entstehen auch ohne fremde Steuerung — beim Anstecken, bei
 * einem Netzhüpfer, beim Umschalten der Wallbox. Ein Tarif-Slot dauert
 * länger: An einer real beobachteten Nacht lagen die Pausen bei 34 und
 * 94 Minuten.
 */
const PACED_PAUSE_MIN = 20;

/** Wie viele der jüngsten abgeschlossenen Ladungen betrachtet werden. */
const PACED_LOOKBACK = 5;

/**
 * Wird das Laden bereits von außen getaktet?
 *
 * Das ist die wichtigste Frage vor jedem Eingriff. Wer einen Tarif wie
 * Intelligent Octopus Go oder Tibber nutzt, überlässt dem Anbieter die
 * Entscheidung, WANN geladen wird — der startet und stoppt selbst, oft in
 * Viertelstundenschritten. Ein zweites Ladefenster daneben wäre kein
 * Sparprogramm, sondern ein Wettlauf: Der Anbieter startet, wir stoppen, der
 * Anbieter startet erneut. Dasselbe gilt für einen Ladeplan im Fahrzeug.
 *
 * Erkennbar ist das an den Ladepausen der letzten Ladungen: Wenn eine Ladung
 * mehrfach unterbrochen wurde, OBWOHL das Ziel noch nicht erreicht war, hat
 * das jemand anders entschieden. Ein Fahrzeug, das ungestört lädt, lädt
 * durch, bis es fertig ist.
 *
 * OHNE HISTORIE lautet die Antwort `true`, also „Finger weg". Kein Wissen ist
 * kein Freibrief: Frisch eingerichtet weiß das Plugin nicht, wer taktet, und
 * darf dann nicht der Erste sein, der eingreift.
 */
export function externallyPaced(sessions: ChargeSession[]): boolean {
  const jüngste = sessions.filter((s) => s.complete).slice(-PACED_LOOKBACK);
  if (jüngste.length === 0) {
    return true;
  }
  return jüngste.some((s) => {
    for (let i = 1; i < s.phases.length; i++) {
      const pause =
        (Date.parse(s.phases[i].startedAt) - Date.parse(s.phases[i - 1].endedAt)) / 60000;
      if (pause < PACED_PAUSE_MIN) {
        continue;
      }
      // Entscheidend ist der Ladestand VOR der Pause, nicht der am Ende der
      // Ladung: Auch ein getakteter Tarif lädt am Schluss bis zum Ziel. Wer
      // die ganze Ladung danach beurteilt, erkennt gerade den häufigsten Fall
      // nicht. Umgekehrt ist eine Pause, nach der das Ziel schon erreicht
      // war, kein fremder Takt — dann hört das Fahrzeug von selbst auf.
      const davor = s.phases[i - 1].endSoc;
      if (s.targetSoc === undefined || davor === undefined || davor < s.targetSoc) {
        return true;
      }
    }
    return false;
  });
}
