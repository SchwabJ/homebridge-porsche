/**
 * Nutzbare Batteriekapazität aus echten Fahrdaten schätzen.
 *
 * ## Warum überhaupt
 *
 * Die geladene Energie wird als `SoC-Delta × Kapazität` gerechnet — die
 * Kapazität ist damit der empfindlichste Parameter der ganzen Auswertung.
 * Konfiguriert wird üblicherweise der Datenblattwert des Neufahrzeugs. Eine
 * gealterte Batterie mit 90 % Gesundheitszustand hat aber ein Zehntel weniger,
 * und dieses Zehntel schlägt auf JEDE Zahl im Dashboard durch — auf die kWh,
 * die Kosten und die Ersparnis gleichermaßen.
 *
 * ## Wie
 *
 * Das Fahrzeug meldet seinen eigenen Verbrauch (`avgKwhPerHundredKm`, seit dem
 * letzten Laden). Mit der Strecke ergibt das die entnommene Energie; zusammen
 * mit dem Ladestand-Abfall folgt daraus die Kapazität:
 *
 *     Kapazität = (km × kWh/100km / 100) / (SoC-Abfall / 100)
 *
 * Das ist die einzige Größe hier, die weder Datenblatt noch Zertifikat
 * braucht — sie kommt aus dem Fahrzeug selbst.
 *
 * ## Zwei Fallstricke, die diese Datei bestimmen
 *
 * 1. **Der Bezugsrahmen muss zusammenpassen.** Gerechnet wird über einen
 *    ganzen Entladezyklus, nicht über einzelne Messabstände — nur dann meint
 *    der gemeldete Verbrauch genau die Strecke, die im Zähler steht.
 * 2. **Zähler und Nenner müssen dasselbe messen.** Der gemeldete Verbrauch
 *    enthält nur Fahrenergie; Standverbrauch senkt aber ebenfalls den
 *    Ladestand. Bliebe er im Nenner, fiele die Schätzung um genau diesen
 *    Anteil zu niedrig aus. Er wird deshalb herausgerechnet.
 *
 * ## Grenzen (bewusst offengelegt)
 *
 * Was bleibt, ist systematisch: die Güte der Verbrauchsangabe des Fahrzeugs,
 * die nichtlineare Ladestandskennlinie, die Temperaturabhängigkeit. Diese
 * Anteile mitteln sich über viele Zyklen NICHT heraus — deshalb der Boden
 * unter der ausgewiesenen Unsicherheit. Eine Schätzung ohne Angabe ihrer
 * Unsicherheit wäre hier gefährlicher als gar keine.
 */
import type { ChargeLogSample } from './chargeLog';

/** Mindeststrecke eines verwertbaren Entladezyklus in km. */
const MIN_KM = 25;
/**
 * Mindest-Ladestandsabfall in Prozentpunkten.
 *
 * Der Ladestand kommt GANZZAHLIG. Der Abfall trägt damit eine Unsicherheit von
 * ±0,5 Prozentpunkten, und weil er im Nenner steht, schlägt sie voll auf die
 * Kapazität durch: bei 4 Prozentpunkten sind das ±13 %, bei 20 noch ±2,5 %.
 *
 * Die frühere Grenze von 3 ließ genau die Abschnitte zu, bei denen die Rundung
 * alles andere überdeckt — fünf davon ergaben Einzelwerte von 51 bis 83 kWh.
 */
const MIN_SOC_DROP = 15;
/**
 * Untergrenze der ausgewiesenen Unsicherheit, als Anteil der Schätzung.
 *
 * Über viele Zyklen mittelt sich der ZUFÄLLIGE Fehler heraus — mit 1/√n, aus
 * ±1,1 kWh werden nach hundert Zyklen ±0,11. Der SYSTEMATISCHE Anteil bleibt
 * dabei unverändert stehen, und der ist hier der größere:
 *
 * - `avgKwhPerHundredKm` ist eine Angabe des Fahrzeugs. Ist sie um wenige
 *   Prozent daneben, ist es jede Schätzung ebenfalls — in dieselbe Richtung.
 * - Vorklimatisieren und Standverbrauch senken den Ladestand, ohne Strecke zu
 *   erzeugen. Das drückt die Schätzung dauerhaft nach unten.
 * - Der angezeigte Ladestand ist nicht exakt linear zur Energie, und die
 *   nutzbare Kapazität hängt von der Temperatur ab.
 *
 * Ohne diesen Boden stünde nach hundert Zyklen eine Genauigkeit da, die das
 * Verfahren nicht hergibt. Eine zu klein ausgewiesene Unsicherheit ist
 * schädlicher als gar keine: Sie lädt dazu ein, der Zahl zu glauben.
 */
const SYSTEMATIC_FLOOR = 0.03;

/**
 * Längster Messabstand, der noch als beobachtete Standzeit zählt, in Minuten.
 *
 * Fällt das Plugin aus oder schläft das Fahrzeug tief, klafft im Mitschrieb
 * eine Lücke von Stunden. Die als „gemessene Standzeit" zu zählen verdünnte
 * den Standverbrauch beliebig — man wüsste ja gar nicht, was in der Lücke
 * geschah. Zwei Stunden decken den normalen Abfragetakt mit Reserve ab.
 */
const IDLE_MAX_GAP_MIN = 120;

/** Verwerfen, was außerhalb dieses Bereichs liegt — dort steckt ein Datenfehler. */
const PLAUSIBLE_MIN_KWH = 40;
const PLAUSIBLE_MAX_KWH = 120;

export interface CapacityEstimate {
  /** Geschätzte nutzbare Kapazität in kWh (Median). */
  capacityKwh?: number;
  /** Anzahl VERWERTETER Fahrstrecken zwischen zwei Ladungen. */
  samples: number;
  /**
   * Wie viele Fahrstrecken es überhaupt gab — verwertete wie verworfene.
   *
   * Für Diagnose, nicht für die Anzeige: Eine Strecke fällt praktisch nur
   * heraus, solange das Fahrzeug noch keinen Verbrauchswert geliefert hat —
   * ein Anfangszustand, der sich nicht wiederholt. „1 von 2" in der
   * Oberfläche wirft dann eine Frage auf, die es dauerhaft nicht gibt.
   */
  cyclesSeen: number;
  /**
   * Ausgewiesene Unsicherheit der Schätzung in kWh.
   *
   * Das Größere aus dem statistischen Fehler (der mit mehr Zyklen schrumpft)
   * und einem systematischen Boden (der das nicht tut) — siehe
   * {@link SYSTEMATIC_FLOOR}.
   */
  uncertaintyKwh?: number;
  /** Streuung als Spanne zwischen dem 25. und 75. Perzentil, in kWh. */
  spreadKwh?: number;
  /** Zurückgelegte Strecke aller verwerteten Abschnitte. */
  km: number;
  /**
   * Ladestand, der im STAND verloren ging — in Prozentpunkten, über alle
   * Zyklen summiert.
   *
   * Fällt in der Kapazitätsrechnung ohnehin an (er muss dort herausgerechnet
   * werden, siehe {@link estimateCapacity}); ihn wegzuwerfen hieße, die
   * Antwort auf „was zieht mein Standklima" zu verschenken. Gezählt wird über
   * ALLE Zyklen, auch die für die Kapazität verworfenen — für diese Frage
   * taugt jeder.
   */
  idleSocDrop: number;
  /** Zeit, über die dieser Verlust entstand, in Minuten. */
  idleMinutes: number;
  /** Einzelschätzungen, aufsteigend — für Diagnose und Diagramme. */
  values: number[];
  /**
   * Dieselben Einzelschätzungen in ZEITLICHER Reihenfolge, mit ihrem Zeitpunkt.
   *
   * `values` ist für den Median sortiert und hat damit jeden Zeitbezug
   * verloren. Für die Frage „wird die Batterie schlechter?" ist genau der
   * Zeitbezug das Entscheidende.
   */
  points: { at: string; kwh: number }[];
}

const median = (sorted: number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Schätzt die Kapazität aus den ENTLADEZYKLEN des Mitschriebs.
 *
 * Ein Zyklus ist eine zusammenhängende Spanne ohne Kabel — vom Ausstecken bis
 * zum nächsten Anstecken. Nicht der einzelne Messabstand:
 *
 * 1. `tripKwh100` ist `TRIP_STATISTICS_CYCLIC`, also der Verbrauch SEIT DEM
 *    LETZTEN LADEN. Auf einen Zwanzig-Minuten-Abschnitt angewandt ist das der
 *    falsche Durchschnitt; über den ganzen Zyklus ist es genau der richtige.
 * 2. Der Ladestand ist ganzzahlig. Über einen Zyklus fällt er um Dutzende
 *    Prozentpunkte, die Rundung wiegt dann kaum noch — über zwanzig Minuten
 *    fällt er um drei, und die Rundung bestimmt das Ergebnis.
 *
 * Ein „unbekannt" (leere API-Antwort) unterbricht einen Zyklus NICHT: Solche
 * Zeilen tragen keinen Messwert und sagen nichts über den Stecker.
 */
export function estimateCapacity(samples: ChargeLogSample[]): CapacityEstimate {
  const values: number[] = [];
  const points: { at: string; kwh: number }[] = [];
  const uncertainties: number[] = [];
  let km = 0;
  let cyclesSeen = 0;
  let idleSocDrop = 0;
  let idleMinutes = 0;

  /** Messpunkte des laufenden Zyklus, oder undefined außerhalb. */
  let cycle: ChargeLogSample[] | undefined;

  const finish = (): void => {
    if (!cycle) {
      return;
    }
    const usable = cycle.filter((s) => s.soc !== undefined && s.odometerKm !== undefined);
    cycle = undefined;
    if (usable.length < 2) {
      return;
    }
    cyclesSeen++;

    // Standanteil zuerst, VOR allen Abbruchbedingungen: Für die Frage „was
    // zieht das Auto im Stehen" ist auch ein Zyklus brauchbar, der für die
    // Kapazitätsschätzung zu kurz ist.
    //
    // Nur zwischen Messpunkten OHNE Streckenzuwachs — nur dort ist der
    // Verlust sicher nicht gefahren worden. Messpunkte am Kabel kommen hier
    // gar nicht erst an: Ein Zyklus ist per Definition die Zeit ohne Stecker,
    // und was am Kabel verbraucht wird, lädt sofort nach.
    for (let i = 1; i < usable.length; i++) {
      const a = usable[i - 1];
      const b = usable[i];
      if ((b.odometerKm as number) !== (a.odometerKm as number)) {
        continue;
      }
      const minutes = (Date.parse(b.ts) - Date.parse(a.ts)) / 60000;
      if (minutes <= 0 || minutes > IDLE_MAX_GAP_MIN) {
        continue;
      }
      idleMinutes += minutes;
      const d = (a.soc as number) - (b.soc as number);
      if (d > 0) {
        idleSocDrop += d;
      }
    }

    const first = usable[0];
    const last = usable[usable.length - 1];
    // Verbrauch vom ENDE des Zyklus: Dort steht der Durchschnitt über genau
    // die Strecke, die zwischen den beiden Punkten liegt.
    const kwh100 = last.tripKwh100;
    if (kwh100 === undefined || kwh100 <= 0) {
      return;
    }
    const drivenKm = (last.odometerKm as number) - (first.odometerKm as number);
    const socDrop = (first.soc as number) - (last.soc as number);
    if (drivenKm < MIN_KM || socDrop < MIN_SOC_DROP) {
      return;
    }

    // Standverbrauch herausrechnen.
    //
    // Vorklimatisieren und eingeschaltete Zündung senken den Ladestand, ohne
    // einen Kilometer zu erzeugen. Der Verbrauchswert des Fahrzeugs zählt sie
    // NICHT mit — nachgemessen: Über zwanzig Minuten Standverbrauch mit einem
    // Prozentpunkt Verlust blieb `avgKwhPerHundredKm` unverändert, obwohl er
    // um 0,7 hätte steigen müssen. Der Zähler enthält also nur Fahrenergie.
    //
    // Bliebe der Standanteil im Nenner, würde die Kapazität um genau diesen
    // Anteil zu niedrig geschätzt — bei viel Standklima sind das zweistellige
    // Prozente. Deshalb zählt nur der Ladestand-Abfall, der zwischen zwei
    // Messpunkten MIT zurückgelegter Strecke entstand.
    let idleDrop = 0;
    for (let i = 1; i < usable.length; i++) {
      const a = usable[i - 1];
      const b = usable[i];
      const km = (b.odometerKm as number) - (a.odometerKm as number);
      const d = (a.soc as number) - (b.soc as number);
      if (km === 0 && d > 0) {
        idleDrop += d;
      }
    }
    const drivingDrop = socDrop - idleDrop;
    if (drivingDrop < MIN_SOC_DROP) {
      return;
    }

    const usedKwh = (drivenKm * kwh100) / 100;
    const capacity = usedKwh / (drivingDrop / 100);
    if (capacity < PLAUSIBLE_MIN_KWH || capacity > PLAUSIBLE_MAX_KWH) {
      return;
    }
    values.push(capacity);
    points.push({ at: last.ts, kwh: Math.round(capacity * 10) / 10 });
    // Was allein die ganzzahlige Meldung des Ladestands offen lässt.
    uncertainties.push(
      (usedKwh / ((drivingDrop - 0.5) / 100) - usedKwh / ((drivingDrop + 0.5) / 100)) / 2,
    );
    km += drivenKm;
  };

  for (const cur of samples) {
    if (cur.plugged === true) {
      finish();
      continue;
    }
    if (cur.plugged === false && cycle === undefined) {
      cycle = [];
    }
    cycle?.push(cur);
  }
  finish();

  const est: CapacityEstimate = {
    samples: values.length,
    cyclesSeen,
    km,
    idleSocDrop: Math.round(idleSocDrop * 10) / 10,
    idleMinutes: Math.round(idleMinutes),
    points,
    values: [...values].sort((a, b) => a - b),
  };
  if (values.length === 0) {
    return est;
  }
  est.capacityKwh = Math.round(median(est.values) * 10) / 10;

  // Statistischer Fehler: bei einem Zyklus die Rundung, ab zweien die
  // beobachtete Streuung geteilt durch die Wurzel aus der Anzahl.
  const roundingErr = median([...uncertainties].sort((a, b) => a - b));
  let statistical = roundingErr;
  if (values.length >= 2) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
    statistical = Math.max(roundingErr / Math.sqrt(values.length), Math.sqrt(variance / values.length));
  }
  est.uncertaintyKwh =
    Math.round(Math.max(statistical, est.capacityKwh * SYSTEMATIC_FLOOR) * 10) / 10;
  if (values.length >= 4) {
    const q = (p: number): number => est.values[Math.floor((est.values.length - 1) * p)];
    est.spreadKwh = Math.round((q(0.75) - q(0.25)) * 10) / 10;
  }
  return est;
}

/**
 * Gesundheitszustand gegenüber der Werkskapazität, in Prozent.
 *
 * Bewusst getrennt von der Schätzung selbst: Der Bezugswert ist eine Annahme
 * über das Neufahrzeug, die Schätzung dagegen eine Messung.
 */
export function stateOfHealth(
  estimated: number | undefined,
  factoryKwh: number,
): number | undefined {
  if (estimated === undefined || factoryKwh <= 0) {
    return undefined;
  }
  return Math.round((estimated / factoryKwh) * 1000) / 10;
}

/**
 * Mindest-Standzeit, bevor ein Standverbrauch ausgewiesen wird, in Stunden.
 *
 * Der Ladestand kommt ganzzahlig: Über zwei Stunden gemessen entscheidet die
 * Rundung allein, ob 0 oder 1 Prozentpunkt herauskommt — hochgerechnet auf
 * einen Tag wären das 0 oder 10 kWh. Erst über einen ganzen Tag gesammelter
 * Standzeit trägt die Zahl.
 */
const IDLE_MIN_HOURS = 24;

/**
 * Standverbrauch in kWh je Tag — was das Auto verliert, ohne zu fahren.
 *
 * Vorklimatisieren, eingeschaltete Zündung, Wachbleiben der Steuergeräte: All
 * das senkt den Ladestand, ohne einen Kilometer zu erzeugen. In der
 * Kapazitätsschätzung ist es eine Störgröße, die herausgerechnet wird — für
 * sich genommen ist es die Antwort auf eine ganz eigene Frage.
 *
 * Gibt `undefined` zurück, solange zu wenig Standzeit beobachtet wurde.
 */
export function idleKwhPerDay(
  est: CapacityEstimate,
  capacityKwh: number,
): number | undefined {
  if (est.idleMinutes < IDLE_MIN_HOURS * 60 || capacityKwh <= 0) {
    return undefined;
  }
  const kwh = (est.idleSocDrop * capacityKwh) / 100;
  const days = est.idleMinutes / 1440;
  return Math.round((kwh / days) * 100) / 100;
}

/**
 * Wie viele Monate mit je einer verwertbaren Schätzung nötig sind, bevor ein
 * Verlauf gezeigt wird.
 *
 * Ein Punkt ist kein Verlauf, zwei sind eine Gerade durch zwei Zufälle. Die
 * Streuung einzelner Zyklen liegt bei mehreren Prozent — erst über mehrere
 * Monate hebt sich eine echte Alterung davon ab.
 */
const TREND_MIN_MONTHS = 4;

/** Wie viele Einzelschätzungen ein Monatswert mindestens braucht. */
const TREND_MIN_PER_MONTH = 2;

export interface CapacityMonth {
  /** Monat als `YYYY-MM`. */
  month: string;
  /** Median der Schätzungen dieses Monats, in kWh. */
  kwh: number;
  /** Wie viele Einzelschätzungen dahinterstehen. */
  samples: number;
}

/**
 * Der Kapazitätsverlauf als Monatswerte — leer, solange er nichts hergibt.
 *
 * Der MEDIAN je Monat, nicht der Mittelwert: Eine einzelne Fahrt mit viel
 * Standklima oder bei Frost zieht einen Mittelwert mit sich, den Median nicht.
 *
 * Monate mit zu wenigen Schätzungen fallen ganz heraus, statt als unsicherer
 * Punkt in der Kurve zu landen — eine Linie, die zwischen zwei belastbaren
 * Werten über einen Zufallswert läuft, behauptet einen Verlauf, den es nicht
 * gibt.
 */
export function capacityTrend(est: CapacityEstimate): CapacityMonth[] {
  const byMonth = new Map<string, number[]>();
  for (const p of est.points) {
    const m = p.at.slice(0, 7);
    const list = byMonth.get(m);
    if (list) {
      list.push(p.kwh);
    } else {
      byMonth.set(m, [p.kwh]);
    }
  }
  const months: CapacityMonth[] = [];
  for (const [month, list] of [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.length < TREND_MIN_PER_MONTH) {
      continue;
    }
    const sorted = [...list].sort((a, b) => a - b);
    months.push({
      month,
      kwh: Math.round(median(sorted) * 10) / 10,
      samples: list.length,
    });
  }
  return months.length >= TREND_MIN_MONTHS ? months : [];
}
