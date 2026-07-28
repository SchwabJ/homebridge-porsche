/**
 * Rohdaten-Mitschrieb / raw sample log.
 *
 * Schreibt bei jedem Poll eine Zeile JSON in eine tagesrotierte Datei. Das ist
 * die Grundlage für spätere Auswertungen (Ladevorgänge, Energiemenge, Kosten,
 * Verbrauchstrend) — das Plugin selbst wertet NICHTS aus, es hält nur fest.
 *
 * Bewusst JSONL statt einer Datenbank: kein nativer Build auf dem Pi, kein
 * Schema-Zwang, und ein Absturz mitten im Schreiben kostet höchstens die letzte
 * Zeile statt der ganzen Datei. Auswertende Prozesse lesen die Dateien nur.
 *
 * Fehler werden IMMER geschluckt: Ein volles Dateisystem oder fehlende Rechte
 * dürfen niemals den Poll-Zyklus oder HomeKit beeinträchtigen.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { VehicleState } from './api/measurements';

/** Eine Zeile des Mitschriebs. Bewusst flach — je Zeile ein Poll-Ergebnis. */
export interface ChargeLogSample {
  /** Zeitpunkt des Polls (ISO 8601). */
  ts: string;
  /** Zeitstempel der Messdaten laut Backend (ms), falls vorhanden. */
  dataTs?: number;
  soc?: number;
  rangeKm?: number;
  odometerKm?: number;
  charging?: boolean;
  plugged?: boolean;
  chargingType?: string;
  powerKw?: number;
  /** Höchstmögliche Ladeleistung an diesem Anschluss in kW. */
  maxPowerKw?: number;
  /** Laderate in km Reichweite je Minute — dieselbe Ladung, andere Darstellung. */
  rateKmMin?: number;
  targetSoc?: number;
  /** Mindestladestand des aktiven Profils (bis dahin lädt das Auto sofort). */
  minSoc?: number;
  /**
   * Stand das Fahrzeug beim Messen zuhause?
   *
   * Bewusst nur als Ja/Nein statt als Koordinaten: Für die Auswertung
   * („zuhause oder auswärts geladen") genügt das vollständig, und die
   * Mitschriebdatei bleibt frei von Bewegungsprofilen. Fehlt der Wert, war
   * keine Position verfügbar — etwa bei aktivem Privatmodus.
   */
  atHome?: boolean;
  /** Vom Fahrzeug gemessener Fahrverbrauch in kWh/100 km (Gegenprobe). */
  tripKwh100?: number;
}

/**
 * Baut die Zeile aus dem Fahrzeugzustand.
 *
 * Undefinierte Felder werden weggelassen (kein `null`-Rauschen in der Datei);
 * `ts` ist immer gesetzt, damit jede Zeile einen Zeitbezug hat.
 */
export function buildSample(
  state: VehicleState,
  now: Date,
  atHome?: boolean,
): ChargeLogSample {
  const sample: ChargeLogSample = { ts: now.toISOString() };
  const put = <K extends keyof ChargeLogSample>(
    key: K,
    value: ChargeLogSample[K],
  ): void => {
    if (value !== undefined) {
      sample[key] = value;
    }
  };
  put('dataTs', state.dataTimestamp);
  put('soc', state.soc);
  put('rangeKm', state.rangeKm);
  put('odometerKm', state.odometerKm);
  put('charging', state.charging);
  put('plugged', state.plugged);
  put('chargingType', state.chargingType);
  put('powerKw', state.chargingPowerKw);
  put('maxPowerKw', state.maxChargingPowerKw);
  put('rateKmMin', state.chargeRateKmMin);
  put('targetSoc', state.targetSoc);
  put('minSoc', state.minSocProfile);
  put('atHome', atHome);
  put('tripKwh100', state.tripConsumptionKwhPer100Km);
  return sample;
}

/** Dateiname des Tages: `YYYY-MM-DD.jsonl` (lokale Zeit, wie der Nutzer denkt). */
export function fileNameFor(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.jsonl`;
}

/**
 * Hängt eine Zeile an den Tagesmitschrieb an.
 *
 * Wirft NIE. Gibt `true` zurück, wenn geschrieben wurde — nur für Tests und
 * Diagnose; Aufrufer dürfen den Rückgabewert ignorieren.
 */
export function appendSample(
  dir: string,
  state: VehicleState,
  now: Date,
  atHome?: boolean,
): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(buildSample(state, now, atHome)) + '\n';
    fs.appendFileSync(path.join(dir, fileNameFor(now)), line, 'utf8');
    return true;
  } catch {
    // Absichtlich still: Mitschrieb ist Beiwerk, HomeKit hat Vorrang.
    return false;
  }
}
