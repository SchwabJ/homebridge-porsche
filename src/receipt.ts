/**
 * Monatsbeleg über die geladene Energie — zum Ausdrucken und Weiterreichen.
 *
 * ## Wofür
 *
 * Wer einen Dienstwagen zuhause lädt, bekommt den Strom erstattet. Dafür
 * braucht es keine Kachel, sondern eine Aufstellung, die jemand anderes lesen
 * und prüfen kann: was wann geladen wurde, zu welchem Preis, mit einer Summe.
 *
 * ## Was einen Beleg von einer Anzeige unterscheidet
 *
 * Er muss NACHVOLLZIEHBAR sein. Die Energie hier ist keine Messung an der
 * Steckdose, sondern eine Rechnung aus dem Ladestand mal der Kapazität — und
 * genau das steht auch unter der Tabelle. Ein Beleg, der eine Herkunft
 * verschweigt, die er nicht hat, wäre wertlos; einer, der sie offenlegt, ist
 * genau so viel wert, wie er ist.
 *
 * Getrennt nach Ort: Zuhause geladener Strom läuft über den eigenen Zähler,
 * unterwegs geladener über eine fremde Rechnung. Beides in einer Summe wäre
 * für jeden Zweck falsch, dem der Beleg dient.
 */
import type { ChargeSession } from './sessions';
import type { Labels } from './i18n';

export interface ReceiptLine {
  /** Beginn der Ladung (ISO). */
  startedAt: string;
  endSoc?: number;
  startSoc?: number;
  kwh: number;
  /** Angewandter Arbeitspreis in ct/kWh, sofern bekannt. */
  centPerKwh?: number;
  costEur?: number;
  /** true = zuhause, false = unterwegs, undefined = Ort unbekannt. */
  atHome?: boolean;
}

export interface ReceiptGroup {
  kwh: number;
  costEur: number;
  count: number;
}

export interface Receipt {
  /** Monat als `YYYY-MM`. */
  month: string;
  lines: ReceiptLine[];
  home: ReceiptGroup;
  away: ReceiptGroup;
  /** Ladungen, deren Ort nie bekannt wurde. */
  unknown: ReceiptGroup;
}

const empty = (): ReceiptGroup => ({ kwh: 0, costEur: 0, count: 0 });

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Baut den Beleg eines Monats aus den Ladungen.
 *
 * Zugeordnet wird nach STARTZEITPUNKT: Eine Ladung wird als Ganzes bezahlt und
 * gehört damit genau einem Monat — anders als die Energie in der
 * Dashboard-Zeitreihe, die sich über die Zeit verteilt. Eine Nachtladung vom
 * 31. auf den 1. steht deshalb vollständig im alten Monat.
 *
 * Laufende Ladungen bleiben draußen: Was noch am Kabel hängt, ist noch nicht
 * abgerechnet.
 */
export function buildReceipt(sessions: ChargeSession[], month: string): Receipt {
  const out: Receipt = {
    month,
    lines: [],
    home: empty(),
    away: empty(),
    unknown: empty(),
  };
  for (const s of sessions) {
    if (!s.complete || s.startedAt.slice(0, 7) !== month) {
      continue;
    }
    const kwh = s.energyKwh ?? 0;
    if (kwh <= 0) {
      continue;
    }
    const line: ReceiptLine = {
      startedAt: s.startedAt,
      startSoc: s.startSoc,
      endSoc: s.endSoc,
      kwh: round2(kwh),
      atHome: s.atHome,
    };
    if (s.costEur !== undefined) {
      line.costEur = round2(s.costEur);
      // Der ANGEWANDTE Preis, nicht der aus dem gerundeten Betrag
      // zurückgerechnete: Sonst stünden bei gleichem Tarif in jeder Zeile
      // leicht andere Cent — auf einem Beleg sieht das nach Fehler aus.
      line.centPerKwh =
        s.pricePerKwh !== undefined
          ? Math.round(s.pricePerKwh * 10000) / 100
          : Math.round((s.costEur / kwh) * 10000) / 100;
    }
    out.lines.push(line);

    const group = s.atHome === true ? out.home : s.atHome === false ? out.away : out.unknown;
    group.kwh = round2(group.kwh + kwh);
    group.costEur = round2(group.costEur + (s.costEur ?? 0));
    group.count++;
  }
  return out;
}

/**
 * Der Beleg als CSV.
 *
 * ## Warum das Trennzeichen an der Sprache hängt
 *
 * Tabellenprogramme raten das Trennzeichen nicht, sie nehmen das der
 * Systemsprache. Im deutschsprachigen Raum ist das Komma das
 * Dezimaltrennzeichen, also trennt CSV dort mit Semikolon; im englischen
 * Raum ist es der Punkt, und getrennt wird mit Komma.
 *
 * Die falsche Kombination öffnet nicht etwa unleserlich, sondern FALSCH: Aus
 * `20,09` werden zwei Spalten, und niemand sieht es der Tabelle an. Deshalb
 * folgt beides der eingestellten Sprache, statt eine Konvention zu setzen.
 */
export function receiptCsv(r: Receipt, vehicleName: string, L: Labels): string {
  const german = L.locale.startsWith('de');
  const sep = german ? ';' : ',';
  const rows: string[][] = [
    [L.rcVehicle, vehicleName],
    [L.rcMonth, r.month],
    [],
    [L.dashStart, L.rcPlace, L.dashChargeState, 'kWh', 'ct/kWh', 'EUR'],
  ];
  const num = (n: number | undefined, digits: number): string =>
    n === undefined ? '' : german ? n.toFixed(digits).replace('.', ',') : n.toFixed(digits);
  for (const l of r.lines) {
    rows.push([
      new Date(l.startedAt).toLocaleString(L.locale),
      l.atHome === true ? L.dashAtHome : l.atHome === false ? L.dashAway : L.rcUnknownPlace,
      l.startSoc !== undefined && l.endSoc !== undefined ? `${l.startSoc} → ${l.endSoc} %` : '',
      num(l.kwh, 2),
      num(l.centPerKwh, 2),
      num(l.costEur, 2),
    ]);
  }
  rows.push([]);
  for (const [label, g] of [
    [L.rcSumHome, r.home],
    [L.rcSumAway, r.away],
    [L.rcSumUnknown, r.unknown],
  ] as [string, ReceiptGroup][]) {
    if (g.count > 0) {
      rows.push([label, String(g.count), '', num(g.kwh, 2), '', num(g.costEur, 2)]);
    }
  }
  // Felder mit dem Trennzeichen oder Anführungszeichen müssen gequotet werden
  // — sonst zerreißt eine einzige Zelle die ganze Datei.
  const cell = (v: string): string =>
    v.includes(sep) || /["\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return rows.map((r2) => r2.map(cell).join(sep)).join('\r\n') + '\r\n';
}

/**
 * Die Monate, für die es überhaupt Ladungen gibt — jüngster zuerst.
 */
export function receiptMonths(sessions: ChargeSession[]): string[] {
  const set = new Set<string>();
  for (const s of sessions) {
    if (s.complete && (s.energyKwh ?? 0) > 0) {
      set.add(s.startedAt.slice(0, 7));
    }
  }
  return [...set].sort().reverse();
}
