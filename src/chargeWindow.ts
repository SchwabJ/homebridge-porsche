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
