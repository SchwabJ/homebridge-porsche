import { tripsCsv, sessionsCsv } from '../src/csv';
import type { Trip } from '../src/trips';
import type { ChargeSession } from '../src/sessions';
import { LABELS_DE } from '../src/i18n';

const trip: Trip = {
  startedAt: '2026-07-20T06:10:00.000Z',
  endedAt: '2026-07-20T06:50:00.000Z',
  km: 40,
  minutes: 40,
  gapMinutes: 3,
  startSoc: 80,
  endSoc: 71,
  odometerKm: 50040,
  samples: 12,
  energyKwh: 8,
  kwhPer100km: 20,
  costEur: 1.6,
};

const session: ChargeSession = {
  startedAt: '2026-07-26T20:00:00.000Z',
  endedAt: '2026-07-27T06:00:00.000Z',
  durationMin: 600,
  chargingMin: 180,
  startSoc: 34,
  endSoc: 80,
  energyKwh: 38.5,
  costEur: 7.96,
  pricePerKwh: 0.2067,
  socDropped: false,
  atHome: true,
  chargingType: 'AC',
  complete: true,
  samples: 60,
  phases: [],
};

describe('tripsCsv', () => {
  it('baut Kopfzeile und Datenzeile mit deutschem Dezimalkomma', () => {
    const csv = tripsCsv([trip], 'Taycan', LABELS_DE);
    expect(csv).toContain('Start;Ende;km;Minuten;kWh;kWh/100 km;EUR;Kilometerstand');
    expect(csv).toContain(';40;40;8,00;20,0;1,60;50040');
    expect(csv).toContain('Fahrzeug;Taycan');
  });

  it('lässt fehlende Werte leer, statt 0 zu behaupten', () => {
    const csv = tripsCsv(
      [{ ...trip, energyKwh: undefined, kwhPer100km: undefined, costEur: undefined }],
      'T',
      LABELS_DE,
    );
    expect(csv).toContain(';40;40;;;;50040');
  });

  it('trennt Zeilen mit CRLF für Tabellenprogramme', () => {
    expect(tripsCsv([trip], 'T', LABELS_DE)).toContain('\r\n');
  });
});

describe('sessionsCsv', () => {
  it('führt Ort, Ladestand und angewandten Preis auf', () => {
    const csv = sessionsCsv([session], 'Taycan', LABELS_DE);
    expect(csv).toContain('Start;Ende;Ort;Ladestand;kWh;ct/kWh;EUR;Minuten am Kabel;davon geladen');
    expect(csv).toContain('zuhause;34 → 80 %;38,50;20,67;7,96;600;180');
  });

  it('lässt unvollständige Ladungen weg — sie sind noch nicht abgerechnet', () => {
    const csv = sessionsCsv([{ ...session, complete: false }], 'T', LABELS_DE);
    expect(csv).not.toContain('38,50');
  });

  it('markiert Ladungen ohne Ortsangabe als unbekannt', () => {
    const csv = sessionsCsv([{ ...session, atHome: undefined }], 'T', LABELS_DE);
    expect(csv).toContain('unbekannt');
  });
});
