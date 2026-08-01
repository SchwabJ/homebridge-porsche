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
  /**
   * Wenn nicht: warum nicht — als Grund, nicht als Satz.
   *
   * Bewusst strukturiert statt fertig formuliert: Das Modell soll keine
   * Sprache kennen. Den Satz baut die Anzeige, die auch weiß, in welcher.
   */
  why?:
    | { reason: 'no-measurement' }
    | { reason: 'few-cycles'; cycles: number; needed: number }
    | { reason: 'short-period'; days: number; needed: number };
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
        ? { reason: 'no-measurement' }
        : !genugZyklen
          ? { reason: 'few-cycles', cycles: est.samples, needed: TRUST_MIN_CYCLES }
          : { reason: 'short-period', days: days ?? 0, needed: TRUST_MIN_DAYS };
  }
  return report;
}

/**
 * Ab welcher Gesundheit gewarnt wird, in Prozent der Werksangabe.
 *
 * Bewusst deutlich ÜBER der üblichen Garantiegrenze von rund 70 %: Eine
 * Meldung erst dort käme zu spät, um noch etwas zu belegen. Wer einen
 * Anspruch geltend machen will, braucht einen Nachweis, der bereits läuft —
 * und bei 85 % bleibt Zeit, ihn zu sichern und in der Werkstatt nachfragen
 * zu lassen, bevor es darauf ankommt.
 */
export const HEALTH_ALARM_PCT = 85;

/**
 * Hat die Batterie messbar nachgelassen?
 *
 * Gibt die Werte zurück, wenn gewarnt werden sollte — sonst `undefined`.
 *
 * Ausdrücklich nur bei belastbarer Datenbasis. Eine Warnung über
 * Batteriealterung aus drei Zyklen wäre genau die Sorte Behauptung, die
 * dieser Nachweis vermeiden soll: Die Streuung einzelner Zyklen liegt bei
 * mehreren Prozent, und ein Alarm daraus verunsichert ohne Grund.
 */
export function healthAlarm(
  r: BatteryReport,
  thresholdPct: number,
): { healthPct: number; capacityKwh: number; lossKwh?: number } | undefined {
  if (
    thresholdPct <= 0 ||
    !r.trustworthy ||
    r.healthPct === undefined ||
    r.capacityKwh === undefined ||
    r.healthPct >= thresholdPct
  ) {
    return undefined;
  }
  return {
    healthPct: r.healthPct,
    capacityKwh: r.capacityKwh,
    ...(r.lossKwh !== undefined ? { lossKwh: r.lossKwh } : {}),
  };
}
