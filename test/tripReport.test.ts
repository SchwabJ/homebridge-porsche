import { buildTripReport, tripMonths } from '../src/tripReport';
import type { Trip } from '../src/trips';

const trip = (over: Partial<Trip>): Trip => ({
  startedAt: '2026-07-20T06:10:00.000Z',
  endedAt: '2026-07-20T06:50:00.000Z',
  km: 40,
  minutes: 40,
  gapMinutes: 0,
  samples: 12,
  ...over,
});

describe('buildTripReport', () => {
  it('nimmt nur die Fahrten des Monats — nach ENDE, wie die Liste', () => {
    const r = buildTripReport(
      [
        trip({ endedAt: '2026-07-20T06:50:00.000Z', km: 40 }),
        // Mitten im Juni, nicht am Monatsrand: 30.06. 22:00 UTC wäre lokal
        // schon der 1. Juli — genau die Verschiebung, die der eigene Test
        // weiter unten prüft.
        trip({ endedAt: '2026-06-15T12:00:00.000Z', km: 99 }),
      ],
      '2026-07',
    );
    expect(r.lines).toHaveLength(1);
    expect(r.km).toBe(40);
  });

  it('summiert Strecke, Energie und Kosten', () => {
    const r = buildTripReport(
      [
        trip({ km: 40, energyKwh: 8, costEur: 1.6 }),
        trip({ km: 60, energyKwh: 12, costEur: 2.4, endedAt: '2026-07-21T08:00:00.000Z' }),
      ],
      '2026-07',
    );
    expect(r.km).toBe(100);
    expect(r.energyKwh).toBe(20);
    expect(r.costEur).toBe(4);
    expect(r.kwhPer100km).toBe(20);
  });

  it('teilt den Verbrauch nur durch die BEWERTETE Strecke', () => {
    // Eine Fahrt ohne Verbrauchsangabe darf die Kennzahl nicht kleinrechnen.
    const r = buildTripReport(
      [
        trip({ km: 100, energyKwh: 20, costEur: 4 }),
        trip({ km: 100, endedAt: '2026-07-21T08:00:00.000Z' }),
      ],
      '2026-07',
    );
    expect(r.km).toBe(200);
    expect(r.ratedKm).toBe(100);
    expect(r.kwhPer100km).toBe(20);
  });

  it('lässt die Verbrauchskennzahl weg, wenn nichts bewertet ist', () => {
    const r = buildTripReport([trip({ km: 40 })], '2026-07');
    expect(r.kwhPer100km).toBeUndefined();
  });

  it('ordnet nach LOKALEM Monat, nicht nach UTC', () => {
    // Eine Fahrt, die am 1. um 00:30 Ortszeit endet, ist in UTC noch der
    // Vormonat — auf einem Bericht wäre das der falsche Monat.
    const lokal = new Date(2026, 7, 1, 0, 30);
    const monat = `${lokal.getFullYear()}-${String(lokal.getMonth() + 1).padStart(2, '0')}`;
    const r = buildTripReport([trip({ endedAt: lokal.toISOString() })], monat);
    expect(r.lines).toHaveLength(1);
  });
});

describe('tripMonths', () => {
  it('liefert die Monate mit Fahrten, jüngster zuerst', () => {
    expect(
      tripMonths([
        trip({ endedAt: '2026-06-10T08:00:00.000Z' }),
        trip({ endedAt: '2026-07-20T08:00:00.000Z' }),
      ]),
    ).toEqual(['2026-07', '2026-06']);
  });

  it('zählt eine Fahrt ohne Strecke nicht mit', () => {
    expect(tripMonths([trip({ km: 0 })])).toEqual([]);
  });
});
