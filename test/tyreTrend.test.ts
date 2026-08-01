import { tyreTrend, TYRE_DROP_BAR } from '../src/tyres';
import type { ChargeLogSample } from '../src/chargeLog';

const tag = (n: number, bar: [number, number, number, number]): ChargeLogSample => ({
  ts: new Date(Date.UTC(2026, 6, n)).toISOString(),
  tyreBar: bar,
});

describe('tyreTrend — der schleichende Plattfuß', () => {
  // Reifendruck wird seit jeher mitgeschrieben, aber nur als letzter Wert
  // angezeigt. Ein Reifen, der über Wochen gleichmäßig Luft verliert, ist
  // damit unsichtbar: Jede Einzelmessung sieht harmlos aus, erst die Kurve
  // zeigt es. Genau das ist der Fall, den man früh bemerken will.

  it('erkennt einen gleichmäßigen Druckverlust an einem Rad', () => {
    const t = tyreTrend([
      tag(1, [3.1, 3.1, 3.1, 3.1]),
      tag(8, [3.0, 3.1, 3.1, 3.1]),
      tag(15, [2.9, 3.1, 3.1, 3.1]),
      tag(22, [2.75, 3.1, 3.1, 3.1]),
    ]);
    expect(t.dropping).toHaveLength(1);
    expect(t.dropping[0].wheel).toBe(0);
    expect(t.dropping[0].fromBar).toBeCloseTo(3.1, 2);
    expect(t.dropping[0].toBar).toBeCloseTo(2.75, 2);
  });

  it('schweigt bei stabilem Druck', () => {
    const t = tyreTrend([
      tag(1, [3.1, 3.1, 3.1, 3.1]),
      tag(15, [3.1, 3.0, 3.1, 3.1]),
      tag(22, [3.1, 3.1, 3.1, 3.1]),
    ]);
    expect(t.dropping).toHaveLength(0);
  });

  it('hält Temperaturschwankungen nicht für einen Plattfuß', () => {
    // Kalte Nacht, warmer Tag: 0,1 bar Unterschied sind normal und betreffen
    // ALLE Räder gleichzeitig. Ein Loch betrifft eines.
    const t = tyreTrend([
      tag(1, [3.1, 3.1, 3.1, 3.1]),
      tag(15, [2.95, 2.95, 2.95, 2.95]),
      tag(22, [2.9, 2.9, 2.9, 2.9]),
    ]);
    expect(t.dropping).toHaveLength(0);
  });

  it('braucht einen Mindestzeitraum, bevor es etwas behauptet', () => {
    // Zwei Messungen an einem Tag sagen über Wochen nichts.
    const t = tyreTrend([tag(1, [3.1, 3.1, 3.1, 3.1]), tag(1, [2.6, 3.1, 3.1, 3.1])]);
    expect(t.dropping).toHaveLength(0);
  });

  it('liefert den Verlauf je Rad für die Anzeige', () => {
    const t = tyreTrend([tag(1, [3.1, 3.1, 3.0, 3.0]), tag(8, [3.0, 3.1, 3.0, 3.0])]);
    expect(t.series).toHaveLength(4);
    expect(t.series[0].map((p) => p.bar)).toEqual([3.1, 3.0]);
    expect(t.series[0][0].at).toBe(tag(1, [0, 0, 0, 0]).ts);
  });

  it('kommt ohne Messungen aus', () => {
    const t = tyreTrend([]);
    expect(t.dropping).toHaveLength(0);
    expect(t.series.every((s) => s.length === 0)).toBe(true);
  });

  it('hat eine Schwelle über der üblichen Temperaturschwankung', () => {
    // Ein warmer gegen einen kalten Tag macht rund 0,1 bar; darunter wäre
    // jede Woche ein Alarm.
    expect(TYRE_DROP_BAR).toBeGreaterThan(0.15);
    expect(TYRE_DROP_BAR).toBeLessThan(0.6);
  });
});
