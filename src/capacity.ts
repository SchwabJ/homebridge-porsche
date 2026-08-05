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

/**
 * Höchste Leistung, die ein STEHENDES Fahrzeug ziehen kann, in kW.
 *
 * ## Warum es diese Grenze braucht
 *
 * Die Standerkennung fragt allein den Kilometerstand: bleibt er gleich und
 * fällt der Ladestand, gilt das als Stillstand. Das Backend frischt den
 * Kilometerstand aber **erst zum Fahrtende** auf, während der Ladestand
 * laufend aktualisiert wird. Am eigenen Mitschrieb gemessen: Von 81
 * Messabständen, die eine Fahrt überlappen, zeigen **54 einen unveränderten
 * Kilometerstand** (67 %).
 *
 * Fahrenergie wandert dadurch in den Standabzug. Weil der Abzug den Nenner
 * verkleinert, wird die Kapazität zu GROSS geschätzt — am eigenen Fahrzeug
 * entstand eine Einzelmessung von 100,9 kWh bei 83,7 kWh Werksangabe.
 *
 * ## Warum die Leistung und nicht die Fahrt selbst
 *
 * Fahrt und Stand sicher zu unterscheiden geht mit den vorliegenden Feldern
 * nicht: Die Restreichweite trennt nicht (im Stand bis −9 km, in der Fahrt ab
 * −0 km), und `tripEnd`/`tripMin` liegen nur auf 5 % der Messpunkte — sie
 * sind zudem KUMULATIV je Ladezyklus, nicht je Fahrt.
 *
 * Die beantwortbare Frage ist deshalb nicht „steht das Auto?", sondern „kann
 * ein stehendes Auto so viel ziehen?". Vorklimatisieren mit Heizung erreicht
 * beim Taycan rund 7 kW, der Ruheverbrauch liegt bei Bruchteilen davon.
 *
 * An den 17 Standsegmenten des echten Mitschriebs trennt das sauber:
 *
 *     15 Segmente    0,6 – 4,5 kW    plausibel, bleiben
 *      2 Segmente   10,3 / 12,5 kW   unmöglich, fallen weg
 *
 * Genau diese beiden verursachten die Fehlmessung.
 */
const MAX_IDLE_KW = 7;

/**
 * Wie weit eine Messung über der Werksangabe liegen darf, bevor sie als
 * Datenfehler gilt.
 *
 * Die Werksangabe ist die NETTO nutzbare Kapazität und wird konservativ
 * angegeben — beim Taycan stehen 83,7 kWh netto rund 93,4 kWh brutto
 * gegenüber. Wie viel vom Puffer tatsächlich nutzbar ist, schwankt mit
 * Temperatur und Softwarestand, weshalb eine Messung leicht darüber möglich
 * ist. 100,9 kWh sind dagegen 120 % der Angabe: dafür reicht kein Puffer.
 */
const RATED_HEADROOM = 1.1;

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
 * Quartilsabstand einer SORTIERTEN Reihe, mit interpolierten Quantilen.
 *
 * Interpoliert, weil die frühere Index-Variante `sorted[⌊(n-1)·p⌋]` bei
 * kleinen Reihen gar nicht die Quartile trifft: bei vier Werten deckte sie
 * 20 % bis 60 % ab statt 25 % bis 75 %, bei sechs 29 % bis 57 %. Der
 * abgedeckte Anteil sprang also mit der Anzahl der Zyklen — und damit sprang
 * eine Größe, die eigentlich ruhig werden soll, je nachdem wie viele
 * Messungen gerade vorliegen.
 */
const quartilsabstand = (sorted: number[]): number => {
  const q = (p: number): number => {
    const pos = (sorted.length - 1) * p;
    const unten = Math.floor(pos);
    const oben = Math.ceil(pos);
    return sorted[unten] + (pos - unten) * (sorted[oben] - sorted[unten]);
  };
  return q(0.75) - q(0.25);
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
export interface CapacityOptions {
  /**
   * Werkskapazität dieses Fahrzeugs in kWh, sofern sie zu ihm gehört.
   *
   * Zwei Prüfungen hängen daran, und beide fallen ohne sie milder aus:
   * die Leistungsgrenze des Standabzugs ({@link MAX_IDLE_KW}) und die
   * Obergrenze der Plausibilität. Eine gealterte Batterie wird nicht größer
   * als neu — ohne Werksangabe lässt sich das aber nicht sagen, und dann ist
   * eine fragwürdige Messung besser als gar keine.
   *
   * Weglassen, wo die Zahl nicht belegt ist (siehe `capacityTrust.ts`).
   */
  ratedKwh?: number;
}

export function estimateCapacity(
  samples: Iterable<ChargeLogSample>,
  opts: CapacityOptions = {},
): CapacityEstimate {
  const values: number[] = [];
  const points: { at: string; kwh: number }[] = [];
  const uncertainties: number[] = [];
  let km = 0;
  let cyclesSeen = 0;

  /** Messpunkte des laufenden Zyklus, oder undefined außerhalb. */
  let cycle: ChargeLogSample[] | undefined;

  const finish = (): void => {
    if (!cycle) {
      return;
    }
    // Hintere Kante bereinigen: Zeilen ohne `plugged` am ENDE des Zyklus
    // abschneiden.
    //
    // In der Mitte sind sie harmlos und sollen den Zyklus ausdrücklich nicht
    // unterbrechen — ein fehlgeschlagener Poll ist kein Einstecken. Am Ende
    // sind sie es nicht: `plugged` fehlt genau dann, wenn CHARGING_SUMMARY
    // in der Antwort fehlt, während Ladestand und Kilometerstand weiter
    // ankommen. Fällt so eine Zeile in eine bereits laufende Ladung, geht
    // ein STEIGENDER Ladestand als Zyklusende in die Rechnung — nachgemessen
    // 74,1 statt 66,7 kWh, also elf Prozent zu hoch. Über die automatische
    // Übernahme (siehe {@link resolveCapacity}) schriebe das die Historie um.
    let ende = cycle.length;
    while (ende > 0 && cycle[ende - 1].plugged === undefined) {
      ende--;
    }
    const usable = cycle
      .slice(0, ende)
      .filter((s) => s.soc !== undefined && s.odometerKm !== undefined);
    cycle = undefined;
    if (usable.length < 2) {
      return;
    }
    cyclesSeen++;

    const first = usable[0];
    const last = usable[usable.length - 1];
    // Verbrauch vom ENDE des Zyklus: Dort steht der Durchschnitt über genau
    // die Strecke, die zwischen den beiden Punkten liegt.
    //
    // Fehlt der Wert auf dem allerletzten Messpunkt — `tripKwh100` kommt aus
    // einem eigenen Messschlüssel und kann allein ausfallen —, gilt der
    // letzte Punkt MIT Wert als Zyklusende. Sonst fiele der ganze Zyklus
    // heraus, die Zyklenzahl bliebe zu niedrig, und die Zehner-Schwelle der
    // Kapazitäts-Automatik würde später oder nie erreicht. Der Verzicht auf
    // die letzten Meter kostet nichts: Am Zyklusende steht das Fahrzeug
    // längst, dort kommt weder Strecke noch Ladestand-Abfall dazu.
    const wertPunkt = ((): ChargeLogSample => {
      for (let i = usable.length - 1; i >= 0; i--) {
        const k = usable[i].tripKwh100;
        if (k !== undefined && k > 0) {
          return usable[i];
        }
      }
      return last;
    })();
    const kwh100 = wertPunkt.tripKwh100;
    if (kwh100 === undefined || kwh100 <= 0) {
      return;
    }
    const drivenKm = (wertPunkt.odometerKm as number) - (first.odometerKm as number);
    const socDrop = (first.soc as number) - (wertPunkt.soc as number);
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
    // Nur INNERHALB des Messrahmens.
    //
    // Der Rahmen endet bei `wertPunkt` — dem letzten Messpunkt mit
    // Verbrauchswert; `drivenKm` und `socDrop` beziehen sich auf ihn. Lief
    // die Schleife bis zum Zyklusende weiter, zog sie einen Standanteil ab,
    // der außerhalb des Rahmens liegt und in `socDrop` gar nicht enthalten
    // ist. Der Fahranteil fiel dadurch zu klein und die Kapazität zu HOCH
    // aus — nachgemessen 107,1 statt 100 kWh bei einer einzigen Standzeile
    // hinter dem letzten Wertpunkt. Und das trifft genau den Fall, für den
    // der Rahmen überhaupt eingeführt wurde.
    const rahmenEnde = usable.indexOf(wertPunkt);
    let idleDrop = 0;
    for (let i = 1; i <= (rahmenEnde >= 0 ? rahmenEnde : usable.length - 1); i++) {
      const a = usable[i - 1];
      const b = usable[i];
      const km = (b.odometerKm as number) - (a.odometerKm as number);
      const d = (a.soc as number) - (b.soc as number);
      if (km !== 0 || d <= 0) {
        continue;
      }
      const minuten = (Date.parse(b.ts) - Date.parse(a.ts)) / 60000;
      // Ein Messabstand von Stunden ist keine BEOBACHTETE Standzeit — was
      // in der Lücke geschah, weiß niemand. Die Konstante war bisher nur
      // dokumentiert und nirgends angewandt.
      if (minuten <= 0 || minuten > IDLE_MAX_GAP_MIN) {
        continue;
      }
      // Kann ein stehendes Auto so viel ziehen? Ohne Werksangabe wird mit
      // der kleinsten plausiblen Batterie gerechnet — dann greift die Grenze
      // nur, wo der Abfall selbst für die kleinste Batterie unmöglich wäre.
      const bezugKwh = opts.ratedKwh ?? PLAUSIBLE_MIN_KWH;
      const kw = ((d / 100) * bezugKwh) / (minuten / 60);
      if (kw > MAX_IDLE_KW) {
        continue;
      }
      idleDrop += d;
    }
    const drivingDrop = socDrop - idleDrop;
    if (drivingDrop < MIN_SOC_DROP) {
      return;
    }

    const usedKwh = (drivenKm * kwh100) / 100;
    const capacity = usedKwh / (drivingDrop / 100);
    // Die Obergrenze hängt an der Werksangabe, wo sie bekannt ist. Die feste
    // Grenze von 120 kWh sind 143 % der Taycan-Werksangabe — sie ließ die
    // 100,9 kWh durch, die den Median um 2,5 kWh nach oben zogen.
    //
    // Der Zuschlag ist nötig, nicht großzügig: Die Werksangabe ist die NETTO
    // nutzbare Kapazität, und Hersteller geben sie konservativ an. Beim
    // Taycan stehen 83,7 kWh netto rund 93,4 kWh brutto gegenüber; wie viel
    // vom Puffer tatsächlich nutzbar ist, schwankt mit Temperatur und
    // Software. Eine Messung leicht über der Angabe ist deshalb kein
    // Datenfehler. Erst deutlich darüber wird sie einer: 100,9 kWh sind
    // 120 % der Angabe, die verworfene Grenze liegt bei 110 %.
    const maxKwh = opts.ratedKwh !== undefined
      ? opts.ratedKwh * RATED_HEADROOM
      : PLAUSIBLE_MAX_KWH;
    if (capacity < PLAUSIBLE_MIN_KWH || capacity > maxKwh) {
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
  if (values.length >= 4) {
    // Ab vier Zyklen wird die Streuung ROBUST bestimmt — aus dem
    // Quartilsabstand statt aus der Varianz um den Mittelwert.
    //
    // Der ausgewiesene Wert ist der Median. Eine Unsicherheit, die aus der
    // Varianz um den MITTELWERT kommt, misst deshalb etwas anderes als der
    // Wert: Ein einzelner Datenfehler kann den Median nur um eine Position
    // verschieben, den Fehlerbalken aber beliebig weit aufblähen. Genau das
    // ist am Fahrzeug passiert — ein unmöglicher Zyklus (100,9 kWh bei 83,7
    // kWh Werksangabe) trieb die Anzeige von ±2,3 auf ±4,8, ohne dass sich
    // an der Kenntnis über die Batterie irgendetwas verschlechtert hätte.
    //
    // Der Quartilsabstand ist der Abstand ZWEIER Ordnungsstatistiken und
    // bezieht sich nicht auf den Median. Er erbt damit auch nicht dessen
    // Wanderung, wenn ein weiterer Wert die Medianposition verschiebt —
    // daran scheitert die sonst naheliegende MAD-Variante, die hier trotz
    // Robustheit von ±2,4 auf ±3,3 gestiegen wäre.
    //
    // /1.349 rechnet den Quartilsabstand auf eine Standardabweichung um,
    // /√n macht daraus den Fehler des Mittelpunkts. Unter vier Zyklen ist
    // kein Quartilsabstand definiert; dort bleibt es bei der beobachteten
    // Streuung, die nach oben irrt und damit auf der sicheren Seite liegt.
    //
    // Was der Quartilsabstand NICHT leistet: den Ausreißer erkennen. Bei
    // fünf Messungen ist das statistisch nicht möglich — ein Zaun, der die
    // 100,9 verwirft, verwirft auch in 13 % der sauberen Fünferreihen eine
    // gute Messung. Unmögliche Werte gehören an der Quelle aussortiert
    // (siehe PLAUSIBLE_MAX_KWH), nicht in der Fehlerrechnung.
    const iqr = quartilsabstand(est.values);
    est.spreadKwh = Math.round(iqr * 10) / 10;
    statistical = Math.max(
      roundingErr / Math.sqrt(values.length),
      iqr / 1.349 / Math.sqrt(values.length),
    );
  }
  est.uncertaintyKwh =
    Math.round(Math.max(statistical, est.capacityKwh * SYSTEMATIC_FLOOR) * 10) / 10;
  return est;
}

/**
 * Gesundheitszustand gegenüber der Werkskapazität, in Prozent.
 *
 * Bewusst getrennt von der Schätzung selbst: Der Bezugswert ist eine Annahme
 * über das Neufahrzeug, die Schätzung dagegen eine Messung.
 */
/**
 * Die Unsicherheit der Gesundheitsangabe in PROZENTPUNKTEN.
 *
 * Neben der Kapazität steht ohnehin ihre Spanne — „73,6 kWh ± 2,2". Dieselbe
 * Messung als „87,9 %" ohne Spanne auszuweisen behauptet eine Auflösung, die
 * sie nicht hat: Bei ± 2,2 kWh von 83,7 sind es ± 2,6 Prozentpunkte, der wahre
 * Wert liegt also irgendwo zwischen 85,3 und 90,5 %.
 *
 * Die Alternative — die Prozentzahl ganz zu unterdrücken, solange die
 * Stichprobe dünn ist — sah in der Anzeige schlechter aus als das Problem:
 * Der Gesundheitsbalken stand daraufhin auf null, was sich wie eine Gesundheit
 * von null liest, und zwei Zeilen tiefer stand dieselbe Aussage weiterhin als
 * „Messung −12,1 %".
 */
export function healthSpread(
  uncertaintyKwh: number | undefined,
  factoryKwh: number | undefined,
): number | undefined {
  if (uncertaintyKwh === undefined || factoryKwh === undefined || factoryKwh <= 0) {
    return undefined;
  }
  return Math.round((uncertaintyKwh / factoryKwh) * 1000) / 10;
}

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
 * Ab wie vielen Zyklen die Messung den eingestellten Wert ablösen darf.
 *
 * Vorher schwankt die Schätzung zu stark: Jeder Zyklus bringt eine eigene
 * Fehlerquelle (Rundung des Ladestands, Standverbrauch, Verbrauchszähler des
 * Fahrzeugs), und erst über zehn mittelt sich das zu etwas, an dem eine
 * ganze Historie hängen darf. Dieselbe Schwelle, ab der die Einstellungsseite
 * den Messwert zur Übernahme anbietet.
 */
export const ADOPT_MIN_CYCLES = 10;

/**
 * Ab wann die Anzeige eine GESUNDHEIT in Prozent behaupten darf.
 *
 * Dieselbe Schwelle wie beim Übernehmen und im Batterie-Nachweis — vorher
 * galten hier drei verschiedene Maßstäbe für dieselbe Zahl: Die Kachel zeigte
 * sie ab dem ersten Zyklus, der Nachweis nannte sie erst ab zehn belastbar,
 * und übernommen wurde sie ebenfalls erst ab zehn.
 *
 * Am Fahrzeug beobachtet, und der Grund für diese Konstante: Die Gesundheit
 * sprang binnen Stunden von 90 auf 96 Prozent. Der Wert ist der MEDIAN der
 * Einzelmessungen, und bei drei oder vier davon verschiebt ihn jede neue
 * deutlich. Eine Batterie wird nicht besser — was da sprang, war die
 * Stichprobe, nicht die Zelle.
 *
 * Die gemessene Kapazität selbst darf weiter dastehen: Sie trägt ihre
 * Unsicherheit sichtbar mit sich. Eine Prozentzahl mit Fortschrittsbalken tut
 * das nicht, sie liest sich wie ein Befund.
 */
export const HEALTH_MIN_CYCLES = ADOPT_MIN_CYCLES;

/** Grenzen, in denen ein gemessener Kapazitätswert überhaupt plausibel ist. */
const PLAUSIBLE_KWH = { min: 20, max: 200 };

/**
 * Welche Kapazität die Auswertung benutzt — eingestellter Wert oder Messung.
 *
 * Der eingestellte Wert (Datenblatt, z. B. 83,7) ist ein STARTWERT: Er trägt
 * die Auswertung, solange zu wenig gemessen wurde. Ist die Automatik an und
 * die Messung reif ({@link ADOPT_MIN_CYCLES}), übernimmt sie — dann rechnet
 * die Historie mit der Batterie, die das Auto wirklich hat, statt mit der,
 * die es einmal hatte.
 *
 * Ein unsinniger Messwert wird verworfen statt übernommen: An der Kapazität
 * hängt JEDE kWh- und Kostenzahl: Ein Auswertungsfehler dürfte niemals
 * stillschweigend die ganze Historie umschreiben.
 */
/**
 * Wie weit die beiden Messwege auseinanderliegen dürfen, damit übernommen wird.
 *
 * Ab {@link ADOPT_MIN_CYCLES} ersetzt die gemessene Kapazität die eingestellte
 * — und geht ab dann in jede kWh-, Kosten- und Ersparniszahl ein, rückwirkend
 * über die ganze Historie. Eine hohe Zyklenzahl belegt aber nur, dass VIEL
 * gemessen wurde, nicht dass RICHTIG gemessen wurde.
 *
 * Am eigenen Fahrzeug liefern die beiden Wege
 *
 *     über die Fahrten     73,6 kWh   (87,9 % der Werksangabe)
 *     über die Ladungen    81,0 kWh   (96,8 %)
 *
 * also zehn Prozent Unterschied. Welcher näher an der Wahrheit liegt, ist
 * offen — und solange das so ist, darf keiner von beiden still die
 * Kostenrechnung übernehmen.
 *
 * Stimmen sie dagegen überein, stützen sich zwei Verfahren mit
 * unterschiedlichen systematischen Fehlern gegenseitig. Das ist ein weit
 * stärkerer Beleg als jede Zyklenzahl.
 *
 * Fünf Prozent liegen in der Größenordnung der Einzelfehler beider Verfahren:
 * eng genug, um Widersprüche zu fangen, weit genug, um normale Streuung
 * durchzulassen.
 */
export const ADOPT_MAX_DISAGREEMENT = 0.05;

export function resolveCapacity(opts: {
  configured: number;
  auto?: boolean;
  measured?: number;
  cycles: number;
  /**
   * Dieselbe Größe auf dem ANDEREN Weg gemessen — siehe `chargeCapacity.ts`.
   *
   * Fehlt sie (zu wenige Ladungen, keine Leistungsangaben), bleibt es beim
   * bisherigen Verhalten: Wer keine Gegenprobe hat, verliert die Automatik
   * nicht.
   */
  crossCheck?: number;
}): { capacityKwh: number; source: 'gemessen' | 'eingestellt' } {
  const { configured, auto, measured, cycles, crossCheck } = opts;
  // Widersprechen sich die beiden Wege, ist die Messung nicht belastbar —
  // egal wie viele Zyklen dahinterstehen.
  const einig =
    crossCheck === undefined ||
    measured === undefined ||
    Math.abs(measured - crossCheck) / Math.max(measured, crossCheck) <=
      ADOPT_MAX_DISAGREEMENT;
  if (
    auto &&
    einig &&
    measured !== undefined &&
    cycles >= ADOPT_MIN_CYCLES &&
    measured >= PLAUSIBLE_KWH.min &&
    measured <= PLAUSIBLE_KWH.max
  ) {
    return { capacityKwh: measured, source: 'gemessen' };
  }
  return { capacityKwh: configured, source: 'eingestellt' };
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
