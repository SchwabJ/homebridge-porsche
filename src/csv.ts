/**
 * CSV-Exporte für Fahrten und die vollständige Ladungsliste.
 *
 * Dieselben Konventionen wie der Monatsbeleg ({@link ./receipt}): Trennzeichen
 * und Dezimaltrennzeichen folgen der eingestellten Sprache, damit ein
 * Tabellenprogramm die Datei ohne Nachfrage öffnet — deutsch Semikolon und
 * Komma, sonst Komma und Punkt. Fehlende Werte bleiben LEER statt 0: Eine
 * Fahrt ohne belastbaren Verbrauch hat keinen, und eine 0 wäre eine
 * Behauptung.
 */
import type { Trip } from './trips';
import type { ChargeSession } from './sessions';
import type { Labels } from './i18n';
import { socSpan } from './format';

/**
 * Felder mit Trennzeichen oder Anführungszeichen quoten — sonst zerreißt
 * eine einzige Zelle die ganze Datei.
 */
const cell = (v: string, sep: string): string =>
  new RegExp(`["${sep}\n]`).test(v) ? `"${v.replace(/"/g, '""')}"` : v;

const join = (rows: string[][], sep: string): string =>
  rows.map((r) => r.map((c) => cell(c, sep)).join(sep)).join('\r\n') + '\r\n';

/** Zeitpunkt wie in Beleg und Druckansicht: mit Jahr, ohne Sekunden. */
const stamp = (iso: string | undefined, L: Labels): string =>
  iso === undefined
    ? ''
    : new Date(iso).toLocaleString(L.locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

/** Die Fahrtenliste als CSV — ein Fahrtenbuch light. */
export function tripsCsv(trips: Trip[], vehicleName: string, L: Labels): string {
  const german = L.locale.startsWith('de');
  const sep = german ? ';' : ',';
  const num = (n: number | undefined, digits: number): string =>
    n === undefined ? '' : german ? n.toFixed(digits).replace('.', ',') : n.toFixed(digits);

  const rows: string[][] = [
    [L.rcVehicle, vehicleName],
    [],
    [L.dashStart, L.csvEnd, 'km', L.csvMinutes, 'kWh', 'kWh/100 km', 'EUR', L.csvOdometer],
  ];
  for (const t of trips) {
    rows.push([
      stamp(t.startedAt, L),
      stamp(t.endedAt, L),
      String(t.km),
      String(t.minutes),
      num(t.energyKwh, 2),
      num(t.kwhPer100km, 1),
      num(t.costEur, 2),
      t.odometerKm !== undefined ? String(t.odometerKm) : '',
    ]);
  }
  return join(rows, sep);
}

/**
 * Alle abgeschlossenen Ladungen als CSV — über alle Monate, anders als der
 * Beleg. Laufende bleiben draußen: Was noch am Kabel hängt, ist noch nicht
 * abgerechnet.
 */
export function sessionsCsv(sessions: ChargeSession[], vehicleName: string, L: Labels): string {
  const german = L.locale.startsWith('de');
  const sep = german ? ';' : ',';
  const num = (n: number | undefined, digits: number): string =>
    n === undefined ? '' : german ? n.toFixed(digits).replace('.', ',') : n.toFixed(digits);

  const rows: string[][] = [
    [L.rcVehicle, vehicleName],
    [],
    [
      L.dashStart, L.csvEnd, L.rcPlace, L.dashChargeState, 'kWh', 'ct/kWh', 'EUR',
      L.csvPluggedMinutes, L.csvChargingMinutes, L.csvType,
    ],
  ];
  for (const s of sessions) {
    if (!s.complete) {
      continue;
    }
    rows.push([
      stamp(s.startedAt, L),
      stamp(s.endedAt, L),
      s.atHome === true ? L.dashAtHome : s.atHome === false ? L.dashAway : L.rcUnknownPlace,
      socSpan(s.startSoc, s.endSoc, ''),
      num(s.energyKwh, 2),
      // Der ANGEWANDTE Preis, wie im Beleg — nicht aus dem gerundeten
      // Betrag zurückgerechnet.
      s.pricePerKwh !== undefined ? num(Math.round(s.pricePerKwh * 10000) / 100, 2) : '',
      num(s.costEur, 2),
      String(Math.round(s.durationMin)),
      String(Math.round(s.chargingMin)),
      s.chargingType ?? '',
    ]);
  }
  return join(rows, sep);
}
