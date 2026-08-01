import { buildBatteryReport } from '../src/batteryReport';
import type { CapacityEstimate } from '../src/capacity';

const punkt = (tag: number, kwh: number): { at: string; kwh: number } => ({
  at: new Date(Date.UTC(2026, 0, tag)).toISOString(),
  kwh,
});

const schaetzung = (over: Partial<CapacityEstimate> = {}): CapacityEstimate => ({
  capacityKwh: 78.4,
  samples: 24,
  cyclesSeen: 26,
  uncertaintyKwh: 1.8,
  spreadKwh: 4.2,
  km: 6200,
  values: [76, 78, 79, 81],
  // Je zwei Messungen im Monat, weil ein Monatswert sonst als zu dünn
  // verworfen wird — eine Linie über Zufallswerte behauptet einen Verlauf,
  // den es nicht gibt.
  points: [
    punkt(5, 80.3),
    punkt(12, 79.9),
    punkt(40, 79.4),
    punkt(47, 79.0),
    punkt(75, 78.6),
    punkt(82, 78.2),
    punkt(103, 78.0),
    punkt(110, 77.9),
  ],
  ...over,
});

describe('buildBatteryReport', () => {
  it('nennt Kapazität, Unsicherheit und Gesundheit gegen die Werksangabe', () => {
    const r = buildBatteryReport(schaetzung(), 83.7);
    expect(r.capacityKwh).toBe(78.4);
    expect(r.uncertaintyKwh).toBe(1.8);
    // 78,4 von 83,7 sind 93,7 %.
    expect(r.healthPct).toBe(93.7);
    expect(r.ratedKwh).toBe(83.7);
  });

  it('nennt die Datenbasis, auf der die Zahl ruht', () => {
    // Ohne sie ist der Nachweis wertlos: „78,4 kWh" sagt nichts, solange
    // nicht dabeisteht, aus wie vielen Zyklen über welche Strecke und welchen
    // Zeitraum das gerechnet wurde.
    const r = buildBatteryReport(schaetzung(), 83.7);
    expect(r.cycles).toBe(24);
    expect(r.km).toBe(6200);
    expect(r.firstAt).toBe(punkt(5, 0).at);
    expect(r.lastAt).toBe(punkt(110, 0).at);
  });

  it('rechnet den Verlust über den erfassten Zeitraum', () => {
    // Von 80,1 auf 77,9 kWh in 105 Tagen. Genau diese Zahl will ein Käufer
    // sehen — und Porsche im Garantiefall.
    const r = buildBatteryReport(schaetzung(), 83.7);
    expect(r.lossKwh).toBeCloseTo(2.4, 1);
    expect(r.days).toBe(105);
  });

  it('behauptet keinen Verlust, wo die Messung ihn nicht hergibt', () => {
    // Zwei Punkte in drei Tagen sagen über Alterung nichts. Eine Zahl daraus
    // wäre eine Behauptung, kein Nachweis.
    const r = buildBatteryReport(
      schaetzung({ points: [punkt(5, 80.1), punkt(8, 77.9)] }),
      83.7,
    );
    expect(r.lossKwh).toBeUndefined();
    expect(r.trustworthy).toBe(false);
  });

  it('erklärt, warum die Zahl noch nicht belastbar ist', () => {
    const r = buildBatteryReport(schaetzung({ samples: 3 }), 83.7);
    expect(r.trustworthy).toBe(false);
    // Der Grund ist strukturiert, nicht formuliert — den Satz baut die
    // Anzeige, die auch die Sprache kennt.
    expect(r.why).toEqual({ reason: 'few-cycles', cycles: 3, needed: 10 });
  });

  it('gilt als belastbar bei genug Zyklen über genug Zeit', () => {
    expect(buildBatteryReport(schaetzung(), 83.7).trustworthy).toBe(true);
  });

  it('kommt ohne Messung aus, statt Nullen zu behaupten', () => {
    const r = buildBatteryReport(
      { samples: 0, cyclesSeen: 0, km: 0, values: [], points: [] },
      83.7,
    );
    expect(r.capacityKwh).toBeUndefined();
    expect(r.healthPct).toBeUndefined();
    expect(r.lossKwh).toBeUndefined();
    expect(r.trustworthy).toBe(false);
  });

  it('fasst den Verlauf nach Monaten zusammen', () => {
    // Für den Nachweis zählt die Kurve, nicht der Einzelwert: Eine Kapazität
    // ohne Verlauf ist eine Momentaufnahme, die jeder bestreiten kann.
    const r = buildBatteryReport(schaetzung(), 83.7);
    expect(r.months.length).toBeGreaterThan(1);
    expect(r.months[0].month).toBe('2026-01');
    expect(r.months[0].kwh).toBeGreaterThan(0);
  });
});
