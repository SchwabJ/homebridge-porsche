/**
 * Batterie-Nachweis — die gemessene Kapazität als belegtes Dokument.
 *
 * ## Wozu
 *
 * Die Batterie ist das teuerste Bauteil und bestimmt den Wiederverkaufswert.
 * Ihren Gesundheitszustand zu erfahren ist heute unangenehm schwer: Die
 * offizielle App nennt ihn nicht, die Werkstatt misst ihn nur auf Nachfrage,
 * und Besitzer behelfen sich mit OBD-Steckern und mehrtägigen Prozeduren
 * (auf 85 % laden, Zellspannungen notieren, auf 5 % fahren, über Nacht
 * balancieren). In einem Forumsthread tragen 93 Fahrzeuge ihre Messungen
 * zusammen, weil es anders nicht geht.
 *
 * Dieses Plugin misst die Kapazität ohnehin — aus der Strecke zwischen zwei
 * Ladungen. Was fehlte, ist die Form: eine Zahl auf einer Kachel überzeugt
 * keinen Käufer und keine Garantieabteilung. Ein Nachweis braucht Verlauf,
 * Datenbasis und die Methode dazu.
 *
 * ## Warum die Datenbasis mit ins Dokument gehört
 *
 * „78,4 kWh" ist ohne Kontext wertlos. Erst „aus 24 Entladezyklen über
 * 6 200 km zwischen Januar und April, Unsicherheit ±1,8 kWh" ist eine
 * Aussage, die jemand prüfen kann. Deshalb trägt der Bericht sie mit — und
 * sagt ausdrücklich, wenn sie noch nicht trägt.
 */
import { capacityTrend, type CapacityEstimate, type CapacityMonth } from './capacity';

/**
 * Ab wann die Aussage als belastbar gilt.
 *
 * Dieselbe Zahl wie beim Übernehmen der gemessenen Kapazität in die
 * Konfiguration: Wer darunter von Alterung spricht, beschreibt Streuung.
 */
const TRUST_MIN_CYCLES = 10;

/**
 * Und über wie viele Tage.
 *
 * Die Streuung einzelner Zyklen liegt bei mehreren Prozent — über zwei
 * Wochen hebt sich keine Alterung davon ab, egal wie viele Zyklen darin
 * liegen. Ein Verlust über einen so kurzen Zeitraum wäre Rauschen mit
 * Nachkommastelle.
 */
const TRUST_MIN_DAYS = 60;

export interface BatteryReport {
  /** Gemessene nutzbare Kapazität in kWh. */
  capacityKwh?: number;
  /** Ausgewiesene Unsicherheit in kWh. */
  uncertaintyKwh?: number;
  /** Kapazität laut Einstellung (Werksangabe) in kWh. */
  ratedKwh: number;
  /** Gemessen in Prozent der Werksangabe. */
  healthPct?: number;
  /** Verwertete Entladezyklen. */
  cycles: number;
  /** Zurückgelegte Strecke aller verwerteten Abschnitte. */
  km: number;
  /** Erste und letzte Einzelmessung. */
  firstAt?: string;
  lastAt?: string;
  /** Tage zwischen erster und letzter Messung. */
  days?: number;
  /** Verlust zwischen der ersten und der letzten Messung in kWh. */
  lossKwh?: number;
  /** Monatswerte für den Verlauf. */
  months: CapacityMonth[];
  /** Trägt die Datenbasis eine Aussage über Alterung? */
  trustworthy: boolean;
  /** Wenn nicht: warum nicht, in einem Satz. */
  why?: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Baut den Batterie-Nachweis aus der laufenden Kapazitätsschätzung. */
export function buildBatteryReport(est: CapacityEstimate, ratedKwh: number): BatteryReport {
  const first = est.points[0];
  const last = est.points[est.points.length - 1];
  const days =
    first && last
      ? Math.round((Date.parse(last.at) - Date.parse(first.at)) / 86400000)
      : undefined;

  const genugZyklen = est.samples >= TRUST_MIN_CYCLES;
  const genugZeit = days !== undefined && days >= TRUST_MIN_DAYS;
  const trustworthy = est.capacityKwh !== undefined && genugZyklen && genugZeit;

  const report: BatteryReport = {
    capacityKwh: est.capacityKwh,
    uncertaintyKwh: est.uncertaintyKwh,
    ratedKwh,
    cycles: est.samples,
    km: est.km,
    months: capacityTrend(est),
    trustworthy,
  };
  if (est.capacityKwh !== undefined && ratedKwh > 0) {
    report.healthPct = round1((est.capacityKwh / ratedKwh) * 100);
  }
  if (first) {
    report.firstAt = first.at;
  }
  if (last) {
    report.lastAt = last.at;
  }
  if (days !== undefined) {
    report.days = days;
  }
  // Der Verlust NUR, wenn der Zeitraum ihn hergibt. Zwei Messungen in drei
  // Tagen unterscheiden sich auch ohne jede Alterung — eine Zahl daraus wäre
  // eine Behauptung, kein Nachweis. Das ist der Kern dieses Dokuments.
  if (trustworthy && first && last) {
    report.lossKwh = round1(Math.max(0, first.kwh - last.kwh));
  }
  if (!trustworthy) {
    report.why =
      est.capacityKwh === undefined
        ? 'Noch keine Messung: Dafür braucht es mindestens eine Fahrstrecke zwischen zwei Ladungen.'
        : !genugZyklen
          ? `Erst ${est.samples === 1 ? "ein Zyklus" : `${est.samples} Zyklen`} gemessen — belastbar ab ${TRUST_MIN_CYCLES}.`
          : `Erst ${days} Tage erfasst — über einen so kurzen Zeitraum ist jede Alterung von der normalen Streuung nicht zu unterscheiden (belastbar ab ${TRUST_MIN_DAYS} Tagen).`;
  }
  return report;
}
