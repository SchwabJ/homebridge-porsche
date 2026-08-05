/**
 * Nutzbare Batteriekapazität aus den LADEVORGÄNGEN schätzen.
 *
 * ## Warum es diesen zweiten Weg gibt
 *
 * {@link ./capacity} rechnet fahrseitig: `Strecke × Verbrauchsangabe des
 * Fahrzeugs / Ladestand-Abfall`. Das hat drei systematische Fehlerquellen, und
 * alle drei wirken in dieselbe Richtung — nach unten:
 *
 * - Standverbrauch senkt den Ladestand, ohne Strecke zu erzeugen. Er wird
 *   herausgerechnet, aber nie vollständig.
 * - Die Verbrauchsangabe des Fahrzeugs ist selbst eine Schätzung.
 * - Der angezeigte Ladestand ist nicht linear zur Energie.
 *
 * Am eigenen Fahrzeug ergab das 73,6 kWh, also 87,9 % der Werksangabe. Der
 * Eigentümer hielt das für zu niedrig — zu Recht, wie sich zeigte.
 *
 * ## Der Ladeweg ist direkter
 *
 * Beim Laden meldet das Fahrzeug seine Ladeleistung. Über die Zeit integriert
 * ergibt das die zugeführte Energie; geteilt durch den Ladestand-Anstieg folgt
 * die Kapazität. **Keine Verbrauchsangabe, keine Fahrstrecke, kein
 * Standverbrauch.**
 *
 * Am selben Mitschrieb liefert dieser Weg fünf verwertbare Messungen statt
 * vier — und, nachdem eingefrorene Backend-Antworten aussortiert sind, ein
 * Ergebnis von 78,5 kWh gegenüber 73,6 kWh fahrseitig.
 *
 * ## Wo die Leistung gemessen wird, ist NICHT geklärt
 *
 * Eine frühere Fassung dieses Kommentars behauptete, `powerKw` melde die
 * Leistung in der Batterie, weil `maxPowerKw` auf 11 kW steht und 10,12/11
 * gerade 92 % ergibt — den Wirkungsgrad eines Bordladers. Das hält nicht:
 *
 * - `maxPowerKw` steht in 952 von 952 Messpunkten auf exakt 11, ohne jede
 *   Streuung. Das ist die Signatur einer Nennwert-Konstante, nicht einer
 *   Messung — und 11 kW ist zugleich das Typenschild des Taycan-Bordladers
 *   UND die Anschlussleistung der Wallbox. Der Wert kann die beiden Deutungen
 *   nicht trennen.
 * - Beide sagen dieselben 10,1 kW voraus: batterieseitig 11 × 0,92,
 *   kabelseitig 15 A Pilotstrom bei 390 V verkettet.
 * - Ein Korrelationstest über 574 Ladepunkte ergab r = 0,08. Das ist
 *   strukturell so: Wechselstromladen bei festem Pilotstrom bedeutet auf
 *   BEIDEN Seiten des Bordladers konstante Leistung. Aus einem reinen
 *   AC-Mitschrieb ist die Frage nicht beantwortbar.
 *
 * Entscheiden ließe sie sich mit einem Zwischenzähler oder einer einzigen
 * Gleichstromladung — `chargingType` steht auf 1317 von 1317 Punkten auf `AC`.
 *
 * Bis dahin wird die MITTE beider Lesarten ausgewiesen und ihre halbe
 * Differenz in die Unsicherheit aufgenommen — siehe {@link CHARGER_EFFICIENCY}.
 *
 * ## Zwei Fallen
 *
 * 1. **Ein großer Hub ist nicht automatisch ein guter.** Der größte Hub im
 *    Mitschrieb (34 Punkte) gehört zu einem Sprung von 65 auf 99 Prozent in
 *    102 Sekunden — einem Datenfehler, der 15,1 kWh ergäbe. Nach Hub zu
 *    gewichten, ohne vorher zu filtern, verschlechterte das Ergebnis von 82,8
 *    auf 63,9 kWh: Der kaputteste Wert bekam das höchste Gewicht.
 *    **Erst filtern, dann gewichten.**
 * 2. **Ladepausen.** Bei tarifgesteuertem Laden liegen Stunden zwischen zwei
 *    Messpunkten. Die Leistung über eine solche Lücke fortzuschreiben buchte
 *    Energie, die nie floss.
 */
import type { ChargeLogSample } from './chargeLog';

/**
 * Kleinster Ladestand-Hub, aus dem sich eine Kapazität ableiten lässt.
 *
 * Der Hub steht im Nenner und kommt ganzzahlig: Beide Enden tragen ±0,5
 * Prozentpunkte, zusammen also ±1 auf den Hub. Bei zehn Punkten sind das
 * ±10 % auf die Kapazität, bei fünf schon ±20 %.
 *
 * Zehn ist ein Kompromiss: Am eigenen Mitschrieb bleiben damit sechs von
 * zwölf Ladungen übrig. Strenger zu sein kostete Messungen, ohne das Ergebnis
 * zu bewegen — der Median liegt bei jeder Wahl zwischen 81 und 83 kWh.
 */
const MIN_SOC_GAIN = 10;

/**
 * Größter Messabstand, über den die Ladeleistung fortgeschrieben wird.
 *
 * Der normale Takt am Kabel liegt bei drei Minuten. Bei tarifgesteuertem Laden
 * pausiert die Ladung aber stundenlang, und die letzte gemeldete Leistung gilt
 * dann NICHT weiter. Fünfzehn Minuten decken einen ausgefallenen Poll ab und
 * schneiden alles Längere sauber heraus.
 */
const MAX_STEP_MIN = 15;

/** Anteil der Messpunkte, die eine Leistungsangabe tragen müssen. */
const MIN_POWER_COVERAGE = 0.8;

/**
 * Ab wann eine unveränderte Antwort als EINGEFROREN gilt, in Minuten.
 *
 * In der Nacht zum 4. August meldete die Schnittstelle über fünf Stunden
 * unverändert `soc: 65`, `rangeKm: 279` und `powerKw: 10,12` — bei
 * durchgehend `charging: true` und einem `dataTs`, der jede Minute weiterlief.
 * Das Plugin pollte sauber; das Backend lieferte eine zwischengespeicherte
 * Momentaufnahme mit frischem Zeitstempel. Um 07:30 sprang alles gleichzeitig:
 * Ladestand 65 → 99, Reichweite 279 → 426.
 *
 * Die Integration buchte daraus rund 50 kWh, die nie geflossen sind. Über den
 * ganzen Mitschrieb liegen 380 von 955 Ladepunkten in solchen Blöcken — fünf
 * der acht Messungen waren betroffen.
 *
 * Erkennbar ist es NICHT am Ladestand allein: Der steht bei feinem Takt
 * regelmäßig still, weil er ganzzahlig kommt. Erkennbar ist, dass ALLE DREI
 * Größen zugleich stehen — bei echtem Laden schwankt die Leistung immer ein
 * wenig (gemessen 9,96 bis 10,23 kW) und die Reichweite folgt dem Ladestand
 * mit feinerer Auflösung.
 *
 * Zwanzig Minuten lassen normalen Gleichlauf durch und fangen die Blöcke, die
 * Stunden dauern.
 */
const FROZEN_MIN = 20;

/** Verwerfen, was außerhalb liegt — dort steckt ein Datenfehler. */
const PLAUSIBLE_MIN_KWH = 40;
const PLAUSIBLE_MAX_KWH = 120;

/**
 * Zuschlag auf die Werksangabe, bis zu dem eine Messung plausibel bleibt.
 *
 * Dieselbe Begründung wie fahrseitig: Die Werksangabe ist die NETTO nutzbare
 * Kapazität und konservativ gewählt — beim Taycan stehen 83,7 kWh netto rund
 * 93,4 kWh brutto gegenüber.
 */
const RATED_HEADROOM = 1.1;

/**
 * Wirkungsgrad des Bordladers — die Unsicherheit über den MESSPUNKT.
 *
 * Ungeklärt ist, ob `powerKw` die Leistung am Kabel oder in der Batterie
 * meldet. Beide Lesarten sagen dieselben 10,1 kW voraus:
 *
 *     batterieseitig   11 kW × 92 % Wirkungsgrad          = 10,1
 *     kabelseitig      15 A Pilotstrom bei 390 V          = 10,1
 *
 * `maxPowerKw` hilft nicht: Es steht in 952 von 952 Messpunkten auf exakt 11,
 * ohne jede Streuung — die Signatur einer Nennwert-Konstante. Und 11 kW ist
 * zugleich das Typenschild des Bordladers und die Leistung des Anschlusses.
 * Ein Korrelationstest über 574 Ladepunkte ergab r = 0,08; das ist strukturell
 * so, weil Wechselstromladen bei festem Pilotstrom auf BEIDEN Seiten des
 * Bordladers konstante Leistung bedeutet.
 *
 * Entscheiden ließe sich die Frage mit einem Zwischenzähler oder einer
 * einzigen Gleichstromladung — im Mitschrieb steht `chargingType` auf 1317
 * von 1317 Punkten auf `AC`.
 *
 * Bis dahin wird die MITTE beider Lesarten ausgewiesen und ihre halbe
 * Differenz in die Unsicherheit aufgenommen. Das ist die realistischste
 * Aussage, die die Daten hergeben: Eine der beiden Zahlen zu nennen hieße,
 * sich ohne Beleg festzulegen — und zwar um vier Prozent in die eine oder
 * andere Richtung.
 */
const CHARGER_EFFICIENCY = 0.92;

export interface ChargeCapacityOptions {
  /** Werkskapazität in kWh, sofern sie zu diesem Fahrzeug gehört. */
  ratedKwh?: number;
}

/** Eine einzelne ladeseitige Messung. */
export interface ChargeCapacityPoint {
  /** Beginn der Ladung (ISO). */
  at: string;
  /** Ladestand am Anfang und Ende. */
  fromSoc: number;
  toSoc: number;
  /** Zugeführte Energie in kWh. */
  kwh: number;
  /** Daraus abgeleitete Kapazität in kWh. */
  capacityKwh: number;
}

export interface ChargeCapacityEstimate {
  /** Gewichtetes Mittel der Einzelmessungen in kWh. */
  capacityKwh?: number;
  /** Anzahl verwerteter Ladungen. */
  samples: number;
  /** Wie viele Ladungen überhaupt betrachtet wurden. */
  seen: number;
  /**
   * Ausgewiesene Unsicherheit in kWh.
   *
   * Aus dem Rundungsfehler des größten Hubs und der beobachteten Streuung —
   * das Größere von beidem, damit weder die eine noch die andere Quelle
   * unterschlagen wird.
   */
  uncertaintyKwh?: number;
  /**
   * Das Ergebnis OHNE die Messpunkt-Korrektur — also unter der Annahme, die
   * Leistung werde batterieseitig gemeldet. Die obere der beiden Lesarten.
   */
  rawKwh?: number;
  /** Die Einzelmessungen in zeitlicher Reihenfolge. */
  points: ChargeCapacityPoint[];
}

/** Ladephasen aus dem Mitschrieb schneiden. */
function* ladephasen(samples: Iterable<ChargeLogSample>): Generator<ChargeLogSample[]> {
  let offen: ChargeLogSample[] | undefined;
  for (const s of samples) {
    if (s.charging === true && s.soc !== undefined) {
      (offen ??= []).push(s);
      continue;
    }
    if (offen !== undefined) {
      yield offen;
      offen = undefined;
    }
  }
  if (offen !== undefined) {
    yield offen;
  }
}

/**
 * Schätzt die Kapazität aus den Ladevorgängen.
 *
 * Erwartet zeitlich sortierte Messpunkte — die Ausgabe von `readSamples` oder
 * `streamSamples`.
 */
export function capacityFromCharging(
  samples: Iterable<ChargeLogSample>,
  opts: ChargeCapacityOptions = {},
): ChargeCapacityEstimate {
  const points: ChargeCapacityPoint[] = [];
  let seen = 0;

  const maxKwh =
    opts.ratedKwh !== undefined ? opts.ratedKwh * RATED_HEADROOM : PLAUSIBLE_MAX_KWH;

  for (const phase of ladephasen(samples)) {
    if (phase.length < 3) {
      continue;
    }
    seen++;
    const von = phase[0].soc as number;
    const bis = phase[phase.length - 1].soc as number;
    const hub = bis - von;
    if (hub < MIN_SOC_GAIN) {
      continue;
    }

    // Eingefrorene Abschnitte markieren: Läuft die Zeit weiter, während
    // Ladestand, Reichweite UND Leistung auf derselben Zahl stehen, ist die
    // Antwort zwischengespeichert. Was in dieser Zeit geschah, weiß niemand —
    // Energie daraus zu buchen erfindet sie.
    const eingefroren = new Array<boolean>(phase.length).fill(false);
    for (let i = 0; i < phase.length; ) {
      let j = i + 1;
      while (
        j < phase.length &&
        phase[j].soc === phase[i].soc &&
        phase[j].rangeKm === phase[i].rangeKm &&
        phase[j].powerKw === phase[i].powerKw
      ) {
        j++;
      }
      const dauer = (Date.parse(phase[j - 1].ts) - Date.parse(phase[i].ts)) / 60000;
      if (j - i > 1 && dauer >= FROZEN_MIN) {
        for (let k = i + 1; k < j; k++) {
          eingefroren[k] = true;
        }
      }
      i = j;
    }

    // Energie durch Integration der gemeldeten Leistung. Über eine Lücke
    // hinweg wird NICHT fortgeschrieben — siehe MAX_STEP_MIN.
    let kwh = 0;
    let mitLeistung = 0;
    let eingefrorenMin = 0;
    for (let i = 1; i < phase.length; i++) {
      const min = (Date.parse(phase[i].ts) - Date.parse(phase[i - 1].ts)) / 60000;
      if (eingefroren[i]) {
        eingefrorenMin += min;
        continue;
      }
      const kw = phase[i].powerKw ?? phase[i - 1].powerKw;
      if (kw === undefined || kw <= 0) {
        continue;
      }
      mitLeistung++;
      if (min <= 0 || min > MAX_STEP_MIN) {
        continue;
      }
      kwh += kw * (min / 60);
    }
    // Eine Ladung, die zu weiten Teilen eingefroren war, ist als Ganzes
    // unbrauchbar: Der Ladestand-Hub am Ende enthält dann Energie, die in der
    // Lücke floss und nicht gemessen wurde.
    const dauerMin = (Date.parse(phase[phase.length - 1].ts) - Date.parse(phase[0].ts)) / 60000;
    if (dauerMin > 0 && eingefrorenMin / dauerMin > 0.2) {
      continue;
    }
    if (mitLeistung / (phase.length - 1) < MIN_POWER_COVERAGE || kwh <= 0) {
      continue;
    }

    const capacityKwh = kwh / (hub / 100);
    // ERST filtern, dann gewichten: Der größte Hub im eigenen Mitschrieb
    // gehört zu einem Datenfehler. Ohne diesen Filter bekäme ausgerechnet er
    // das höchste Gewicht.
    if (capacityKwh < PLAUSIBLE_MIN_KWH || capacityKwh > maxKwh) {
      continue;
    }
    points.push({
      at: phase[0].ts,
      fromSoc: von,
      toSoc: bis,
      kwh: Math.round(kwh * 100) / 100,
      capacityKwh: Math.round(capacityKwh * 10) / 10,
    });
  }

  const est: ChargeCapacityEstimate = { samples: points.length, seen, points };
  if (points.length === 0) {
    return est;
  }

  // Gewichtet mit dem Hub: Sein Rundungsfehler ist 1/Hub, große Ladungen
  // tragen also mehr Information.
  const gewicht = (p: ChargeCapacityPoint): number => p.toSoc - p.fromSoc;
  const summe = points.reduce((a, p) => a + gewicht(p), 0);
  const roh = points.reduce((a, p) => a + p.capacityKwh * gewicht(p), 0) / summe;

  // Die Mitte beider Lesarten des Messpunkts — siehe CHARGER_EFFICIENCY.
  // `roh` gilt, wenn die Leistung batterieseitig gemeldet wird;
  // `roh × Wirkungsgrad`, wenn kabelseitig.
  const untergrenze = roh * CHARGER_EFFICIENCY;
  const mittel = (roh + untergrenze) / 2;
  est.capacityKwh = Math.round(mittel * 10) / 10;
  est.rawKwh = Math.round(roh * 10) / 10;

  // Unsicherheit: das Größere aus dem Rundungsfehler der besten Messung und
  // der beobachteten Streuung. Beides einzeln unterschätzt sie.
  const groesterHub = Math.max(...points.map(gewicht));
  const rundung = mittel / groesterHub;
  let streuung = 0;
  if (points.length >= 2) {
    const mw = points.reduce((a, p) => a + p.capacityKwh, 0) / points.length;
    const varianz =
      points.reduce((a, p) => a + (p.capacityKwh - mw) ** 2, 0) / (points.length - 1);
    streuung = Math.sqrt(varianz / points.length);
  }
  // Die Messpunkt-Frage ist eine SYSTEMATISCHE Unsicherheit: Sie mittelt sich
  // über beliebig viele Ladungen nicht heraus und muss deshalb quadratisch zu
  // den statistischen Anteilen addiert werden, statt mit ihnen zu konkurrieren.
  const messpunkt = (roh - untergrenze) / 2;
  const statistisch = Math.max(rundung, streuung);
  est.uncertaintyKwh =
    Math.round(Math.sqrt(statistisch ** 2 + messpunkt ** 2) * 10) / 10;
  return est;
}
