import { healthAlarm, HEALTH_ALARM_PCT } from '../src/batteryReport';
import type { BatteryReport } from '../src/batteryReport';

const bericht = (over: Partial<BatteryReport> = {}): BatteryReport => ({
  capacityKwh: 78.4,
  uncertaintyKwh: 1.8,
  ratedKwh: 83.7,
  healthPct: 93.7,
  cycles: 24,
  km: 6200,
  months: [],
  trustworthy: true,
  ...over,
});

describe('healthAlarm — wenn die Batterie messbar nachlässt', () => {
  // Porsche sichert eine Restkapazität über Jahre zu. Wer sie einfordern will,
  // braucht einen Nachweis, der schon läuft — nicht einen, den er anfängt,
  // wenn die Garantie fast abgelaufen ist. Deshalb warnt das Plugin, solange
  // noch Zeit zum Handeln bleibt, und nicht erst an der Garantiegrenze.

  it('schweigt bei gesunder Batterie', () => {
    expect(healthAlarm(bericht(), HEALTH_ALARM_PCT)).toBeUndefined();
  });

  it('warnt, wenn die Gesundheit unter die Schwelle fällt', () => {
    const a = healthAlarm(bericht({ healthPct: 82.5, capacityKwh: 69 }), HEALTH_ALARM_PCT);
    expect(a).toBeDefined();
    expect(a?.healthPct).toBe(82.5);
    expect(a?.capacityKwh).toBe(69);
  });

  it('warnt NICHT, solange die Datenbasis nicht trägt', () => {
    // Das ist der Kern: Eine Warnung über Batteriealterung aus drei Zyklen
    // wäre genau die Sorte Behauptung, die der Nachweis vermeiden soll.
    expect(
      healthAlarm(bericht({ healthPct: 70, trustworthy: false }), HEALTH_ALARM_PCT),
    ).toBeUndefined();
  });

  it('schweigt ohne Messung', () => {
    expect(
      healthAlarm(bericht({ healthPct: undefined, capacityKwh: undefined }), HEALTH_ALARM_PCT),
    ).toBeUndefined();
  });

  it('lässt sich abschalten', () => {
    expect(healthAlarm(bericht({ healthPct: 50 }), 0)).toBeUndefined();
  });

  it('liegt mit der Standardschwelle über der üblichen Garantiegrenze', () => {
    // Garantiert werden typisch 70 % — eine Warnung dort käme zu spät, um
    // noch etwas zu belegen.
    expect(HEALTH_ALARM_PCT).toBeGreaterThan(70);
    expect(HEALTH_ALARM_PCT).toBeLessThan(95);
  });
});
