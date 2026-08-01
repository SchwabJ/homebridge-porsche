import { estimateCapacity, resolveCapacity, stateOfHealth } from '../src/capacity';
import { buildBatteryReport, healthAlarm, HEALTH_ALARM_PCT } from '../src/batteryReport';
import type { ChargeLogSample } from '../src/chargeLog';

// Cayenne E-Hybrid: 21,8 kWh nutzbar, 28 kWh/100 km im E-Betrieb (~78 km E-Reichweite).
const NETTO = 21.8;
const E_VERBRAUCH = 28;

let odo = 40000;
let tag = 0;

/**
 * Ein Entladezyklus: `eKm` elektrisch, `vKm` mit dem Verbrenner.
 * `modus` bestimmt, was das Fahrzeug als tripKwh100 meldet.
 */
function zyklus(eKm: number, vKm: number, modus: 'jeGesamtKm' | 'jeElektrischKm'): ChargeLogSample[] {
  const kwh = (eKm * E_VERBRAUCH) / 100;
  const dropPct = (kwh / NETTO) * 100;
  const gesamtKm = eKm + vKm;
  const gemeldet = modus === 'jeElektrischKm' ? E_VERBRAUCH : (kwh / gesamtKm) * 100;
  const t = (h: number): string =>
    new Date(Date.UTC(2026, 0, 1 + tag, h)).toISOString();
  const start = odo;
  odo += gesamtKm;
  const rows: ChargeLogSample[] = [
    { ts: t(6), soc: 100, odometerKm: start, plugged: true },
    { ts: t(7), soc: 100, odometerKm: start, plugged: false },
    { ts: t(9), soc: Math.round(100 - dropPct), odometerKm: Math.round(odo), plugged: false, tripKwh100: Math.round(gemeldet * 10) / 10 },
    { ts: t(20), soc: Math.round(100 - dropPct), odometerKm: Math.round(odo), plugged: true },
  ];
  tag += 8; // über drei Monate -> TRUST_MIN_DAYS sicher erreicht
  return rows;
}

function lauf(zyklen: ChargeLogSample[][]): void {
  const alle = zyklen.flat();
  const est = estimateCapacity(alle);
  const cap = resolveCapacity({ configured: 83.7, auto: true, measured: est.capacityKwh, cycles: est.samples });
  const rep = buildBatteryReport(est, 83.7);
  const alarm = healthAlarm(rep, HEALTH_ALARM_PCT);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    kapazitaet: est.capacityKwh,
    unsicherheit: est.uncertaintyKwh,
    streuung: est.spreadKwh,
    verwertet: est.samples,
    gesehen: est.cyclesSeen,
    werte: est.values.map((v) => Math.round(v * 10) / 10),
    uebernahme: cap,
    sohGegen83_7: stateOfHealth(est.capacityKwh, 83.7),
    sohGegen21_8: stateOfHealth(est.capacityKwh, NETTO),
    belastbar: rep.trustworthy,
    grund: rep.why,
    pushAlarm: alarm,
  }, null, 1));
}

describe('PHEV-Sonde', () => {
  it('A: Verbrauch je GESAMT-km, gleichmaessiger Pendler', () => {
    const z: ChargeLogSample[][] = [];
    for (let i = 0; i < 12; i++) z.push(zyklus(30, 70, 'jeGesamtKm'));
    console.log('--- A gleichmaessig ---');
    lauf(z);
  });

  it('B: Verbrauch je ELEKTRISCH-km, gleichmaessiger Pendler (30 % elektrisch)', () => {
    odo = 40000; tag = 0;
    const z: ChargeLogSample[][] = [];
    for (let i = 0; i < 12; i++) z.push(zyklus(30, 70, 'jeElektrischKm'));
    console.log('--- B gleichmaessig, 30 % elektrisch ---');
    lauf(z);
  });

  it('B: gemischter Alltag, E-Anteil 25-50 %', () => {
    odo = 40000; tag = 0;
    const anteile = [0.5, 0.42, 0.3, 0.35, 0.28, 0.45, 0.33, 0.25, 0.4, 0.38, 0.31, 0.47];
    const z = anteile.map((s) => {
      const eKm = 35;
      return zyklus(eKm, Math.round(eKm / s - eKm), 'jeElektrischKm');
    });
    console.log('--- B gemischt ---');
    lauf(z);
  });

  it('B: reiner E-Betrieb (die KORREKTEN Zyklen)', () => {
    odo = 40000; tag = 0;
    const z: ChargeLogSample[][] = [];
    for (let i = 0; i < 12; i++) z.push(zyklus(60, 0, 'jeElektrischKm'));
    console.log('--- B rein elektrisch ---');
    lauf(z);
  });

  it('Referenz Taycan 83,7 kWh, 22 kWh/100 km', () => {
    odo = 40000; tag = 0;
    const z: ChargeLogSample[][] = [];
    for (let i = 0; i < 12; i++) {
      const kwh = (300 * 22) / 100;
      const drop = (kwh / 83.7) * 100;
      const start = odo; odo += 300;
      const t = (h: number): string => new Date(Date.UTC(2026, 0, 1 + tag, h)).toISOString();
      z.push([
        { ts: t(6), soc: 100, odometerKm: start, plugged: true },
        { ts: t(7), soc: 100, odometerKm: start, plugged: false },
        { ts: t(9), soc: Math.round(100 - drop), odometerKm: odo, plugged: false, tripKwh100: 22 },
        { ts: t(20), soc: Math.round(100 - drop), odometerKm: odo, plugged: true },
      ]);
      tag += 3;
    }
    console.log('--- Referenz Taycan ---');
    lauf(z);
  });
});
