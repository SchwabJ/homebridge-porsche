import { buildYearReceipt, receiptYears } from '../src/receipt';
import type { ChargeSession } from '../src/sessions';

const ladung = (over: Partial<ChargeSession> = {}): ChargeSession => ({
  startedAt: '2026-03-14T20:00:00.000Z',
  endedAt: '2026-03-15T06:00:00.000Z',
  durationMin: 600,
  chargingMin: 180,
  energyKwh: 30,
  costEur: 8,
  atHome: true,
  socDropped: false,
  complete: true,
  samples: 60,
  phases: [],
  ...over,
});

describe('buildYearReceipt — der Jahresnachweis', () => {
  // Seit dem 01.01.2026 entfallen in Deutschland die monatlichen Pauschalen
  // für zuhause geladenen Dienstwagenstrom. Eine steuerfreie Erstattung durch
  // den Arbeitgeber setzt seither einen Nachweis der geladenen Kilowattstunden
  // voraus — und zwar für das ganze Jahr, nicht für einen Monat.

  it('fasst die Monate eines Jahres zusammen', () => {
    const r = buildYearReceipt(
      [
        ladung({ startedAt: '2026-01-05T20:00:00.000Z', energyKwh: 20, costEur: 5 }),
        ladung({ startedAt: '2026-01-20T20:00:00.000Z', energyKwh: 25, costEur: 6 }),
        ladung({ startedAt: '2026-03-14T20:00:00.000Z', energyKwh: 30, costEur: 8 }),
      ],
      '2026',
    );
    expect(r.year).toBe('2026');
    expect(r.months).toHaveLength(2);
    expect(r.months[0].month).toBe('2026-01');
    expect(r.months[0].home.kwh).toBe(45);
    expect(r.months[0].home.count).toBe(2);
  });

  it('summiert das Jahr getrennt nach Ort', () => {
    // Für die Erstattung zählt ausschließlich, was ZUHAUSE geladen wurde —
    // unterwegs rechnet der Ladeanbieter selbst ab.
    const r = buildYearReceipt(
      [
        ladung({ energyKwh: 30, costEur: 8, atHome: true }),
        ladung({ energyKwh: 50, costEur: 25, atHome: false }),
        ladung({ energyKwh: 10, costEur: 3, atHome: undefined }),
      ],
      '2026',
    );
    expect(r.home.kwh).toBe(30);
    expect(r.away.kwh).toBe(50);
    expect(r.unknown.kwh).toBe(10);
  });

  it('lässt andere Jahre draußen', () => {
    const r = buildYearReceipt(
      [ladung({ startedAt: '2025-12-30T20:00:00.000Z' }), ladung()],
      '2026',
    );
    expect(r.months).toHaveLength(1);
    expect(r.home.kwh).toBe(30);
  });

  it('lässt laufende Ladungen draußen — sie sind nicht abgerechnet', () => {
    const r = buildYearReceipt([ladung({ complete: false })], '2026');
    expect(r.home.count).toBe(0);
  });

  it('kommt mit einem Jahr ohne Ladungen aus', () => {
    const r = buildYearReceipt([], '2026');
    expect(r.months).toHaveLength(0);
    expect(r.home.kwh).toBe(0);
  });

  it('rundet Summen auf zwei Stellen, statt Kommafehler anzuhäufen', () => {
    const r = buildYearReceipt(
      [ladung({ energyKwh: 0.1 }), ladung({ energyKwh: 0.2 })],
      '2026',
    );
    expect(r.home.kwh).toBe(0.3);
  });
});

describe('receiptYears', () => {
  it('nennt die Jahre mit abgerechneten Ladungen, jüngstes zuerst', () => {
    const years = receiptYears([
      ladung({ startedAt: '2025-05-01T20:00:00.000Z' }),
      ladung({ startedAt: '2026-03-14T20:00:00.000Z' }),
      ladung({ startedAt: '2026-04-14T20:00:00.000Z' }),
    ]);
    expect(years).toEqual(['2026', '2025']);
  });

  it('nennt kein Jahr ohne abgeschlossene Ladung', () => {
    expect(receiptYears([ladung({ complete: false })])).toEqual([]);
  });
});
