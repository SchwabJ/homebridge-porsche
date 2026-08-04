import { idleAlarm, IDLE_ALARM_KWH_PER_DAY } from '../src/idle';
import type { IdleStats } from '../src/idle';

/**
 * Die Schwelle lag bei zwei PROZENTPUNKTEN je Tag — ein Taycan-Wert, aus
 * Taycan-Erfahrungen abgeleitet. Prozentpunkte hängen aber an der
 * Batteriegröße, der Ruheverlust selbst nicht: Er entsteht in der
 * Bordelektronik, und die ist in einem Cayenne E-Hybrid dieselbe wie in einem
 * Taycan.
 *
 *   Taycan  (83,7 kWh):  2 % je Tag = 1,67 kWh
 *   Cayenne (21,8 kWh):  2 % je Tag = 0,44 kWh
 *
 * Ein völlig gesunder Hybrid hätte die Meldung „hoher Ruheverlust" damit
 * regelmäßig ausgelöst. In Kilowattstunden gemessen gilt dieselbe Schwelle
 * für jedes Fahrzeug.
 */
const stats = (over: Partial<IdleStats> = {}): IdleStats => ({
  kwhPerDay: 0.6,
  socPerDay: 0.7,
  observedDays: 6,
  obergrenze: false,
  ...over,
});

describe('idleAlarm misst in Kilowattstunden, nicht in Prozentpunkten', () => {
  it('schweigt bei normalem Ruheverlust', () => {
    expect(idleAlarm(stats(), IDLE_ALARM_KWH_PER_DAY)).toBeUndefined();
  });

  it('warnt, wenn der Verlust die Schwelle überschreitet', () => {
    const a = idleAlarm(stats({ kwhPerDay: 2.8, socPerDay: 3.4 }), IDLE_ALARM_KWH_PER_DAY);
    expect(a).toBeDefined();
    expect(a?.kwhPerDay).toBe(2.8);
  });

  it('verschont einen gesunden Hybrid, den die Prozentregel getroffen hätte', () => {
    // 0,5 kWh je Tag sind für die Bordelektronik normal. In einem Hybrid mit
    // 21,8 kWh sind das 2,3 Prozentpunkte — über der alten Schwelle.
    const hybrid = stats({ kwhPerDay: 0.5, socPerDay: 2.3 });
    expect(idleAlarm(hybrid, IDLE_ALARM_KWH_PER_DAY)).toBeUndefined();
  });

  it('erwischt denselben Hybrid, wenn er wirklich zu viel verliert', () => {
    // Der belegte Schadensfall lag bei 5 bis 10 % je Tag — in einem Hybrid
    // wären das gut 1 bis 2 kWh.
    const kaputt = stats({ kwhPerDay: 2.0, socPerDay: 9.2 });
    expect(idleAlarm(kaputt, IDLE_ALARM_KWH_PER_DAY)).toBeDefined();
  });

  it('warnt weiterhin nicht auf eine bloße Obergrenze', () => {
    expect(
      idleAlarm(stats({ kwhPerDay: 4, obergrenze: true }), IDLE_ALARM_KWH_PER_DAY),
    ).toBeUndefined();
  });

  it('hat eine Schwelle im Bereich der belegten Schadensfälle', () => {
    // Gesund ist deutlich unter 1 kWh je Tag; die Forumsfälle lagen bei 4 bis 8.
    expect(IDLE_ALARM_KWH_PER_DAY).toBeGreaterThan(1);
    expect(IDLE_ALARM_KWH_PER_DAY).toBeLessThan(3);
  });
});
