import { estimateCapacity, stateOfHealth } from '../src/capacity';
import type { ChargeLogSample } from '../src/chargeLog';

const at = (min: number, over: Partial<ChargeLogSample> = {}): ChargeLogSample => ({
  ts: new Date(Date.UTC(2026, 6, 28, 8, 0, 0) + min * 60000).toISOString(),
  ...over,
});

/** Fahrt: `km` gefahren bei `kwh100` Verbrauch, Ladestand fällt um `drop`. */
const drive = (
  startSoc: number,
  drop: number,
  km: number,
  kwh100: number,
): ChargeLogSample[] => [
  at(0, { soc: startSoc, odometerKm: 50000, tripKwh100: kwh100, plugged: false }),
  at(60, { soc: startSoc - drop, odometerKm: 50000 + km, tripKwh100: kwh100, plugged: false }),
];

describe('estimateCapacity', () => {
  it('rechnet die Kapazität aus Strecke, Verbrauch und Ladestandsabfall', () => {
    // 100 km bei 20 kWh/100km = 20 kWh für 25 Prozentpunkte → 80 kWh.
    const e = estimateCapacity(drive(80, 25, 100, 20));
    expect(e.capacityKwh).toBe(80);
    expect(e.samples).toBe(1);
  });

  it('liefert nichts ohne verwertbare Abschnitte', () => {
    expect(estimateCapacity([]).capacityKwh).toBeUndefined();
    expect(estimateCapacity([at(0, { soc: 80 })]).capacityKwh).toBeUndefined();
  });

  it('überspringt zu kurze Strecken', () => {
    // Unter 5 km dominieren Rundungsfehler des Ladestands.
    expect(estimateCapacity(drive(80, 25, 3, 20)).samples).toBe(0);
  });

  it('überspringt zu kleinen Ladestandsabfall', () => {
    expect(estimateCapacity(drive(80, 2, 100, 20)).samples).toBe(0);
  });

  it('ignoriert Abschnitte AM KABEL', () => {
    // Dort könnte gleichzeitig geladen werden — der Abfall wäre verfälscht.
    const s = [
      at(0, { soc: 80, odometerKm: 50000, tripKwh100: 20, plugged: true }),
      at(60, { soc: 55, odometerKm: 50100, tripKwh100: 20, plugged: true }),
    ];
    expect(estimateCapacity(s).samples).toBe(0);
  });

  it('verwirft unplausible Werte statt sie einzurechnen', () => {
    // 100 km bei 2 kWh/100km ergäbe 8 kWh Kapazität — offensichtlich Datenfehler.
    expect(estimateCapacity(drive(80, 25, 100, 2)).samples).toBe(0);
  });

  it('nimmt den Median, nicht den Mittelwert', () => {
    // Drei Schätzungen: 80, 80 und ein Ausreißer bei 100 → Median 80.
    const s = [
      ...drive(90, 25, 100, 20),
      at(120, { soc: 90, odometerKm: 51000, tripKwh100: 20, plugged: false }),
      at(180, { soc: 65, odometerKm: 51100, tripKwh100: 20, plugged: false }),
      at(240, { soc: 90, odometerKm: 52000, tripKwh100: 25, plugged: false }),
      at(300, { soc: 65, odometerKm: 52100, tripKwh100: 25, plugged: false }),
    ];
    const e = estimateCapacity(s);
    expect(e.samples).toBe(3);
    expect(e.capacityKwh).toBe(80);
  });

  it('summiert die ausgewertete Strecke', () => {
    expect(estimateCapacity(drive(80, 25, 100, 20)).km).toBe(100);
  });

  it('weist die Streuung erst ab vier Abschnitten aus', () => {
    expect(estimateCapacity(drive(80, 25, 100, 20)).spreadKwh).toBeUndefined();
  });
});

describe('stateOfHealth', () => {
  it('setzt die Schätzung ins Verhältnis zur Werkskapazität', () => {
    expect(stateOfHealth(74.5, 83.7)).toBe(89);
  });

  it('liefert nichts ohne Schätzung', () => {
    expect(stateOfHealth(undefined, 83.7)).toBeUndefined();
  });

  it('vermeidet die Division durch null', () => {
    expect(stateOfHealth(74.5, 0)).toBeUndefined();
  });
});
