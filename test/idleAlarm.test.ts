import { idleAlarm, IDLE_ALARM_PCT_PER_DAY } from '../src/idle';
import type { IdleStats } from '../src/idle';

const stats = (over: Partial<IdleStats> = {}): IdleStats => ({
  kwhPerDay: 0.6,
  socPerDay: 0.7,
  observedDays: 6,
  obergrenze: false,
  ...over,
});

describe('idleAlarm — wenn das Auto im Stehen zu viel verliert', () => {
  // Belegte Fälle aus dem Taycan-Forum: Ein Besitzer verlor 85 → 63 % in drei
  // Wochen am Kabel und danach 5 bis 10 % pro Tag; Ursache war eine einzelne
  // schwache Zelle. Ein zweiter meldete 3 % über wenige Tage. Beide merkten
  // es erst, als die Reichweite fehlte — niemand warnt sie.

  it('schweigt bei normalem Ruheverlust', () => {
    expect(idleAlarm(stats(), IDLE_ALARM_PCT_PER_DAY)).toBeUndefined();
  });

  it('warnt, wenn der Verlust die Schwelle überschreitet', () => {
    const a = idleAlarm(stats({ socPerDay: 3.4, kwhPerDay: 2.8 }), IDLE_ALARM_PCT_PER_DAY);
    expect(a).toBeDefined();
    expect(a?.socPerDay).toBe(3.4);
    expect(a?.kwhPerDay).toBe(2.8);
  });

  it('warnt NICHT auf eine bloße Obergrenze', () => {
    // Ist der Ladestand über die Beobachtung kaum gefallen, nennt die
    // Auswertung eine Obergrenze statt einer Messung. Darauf zu warnen hieße,
    // aus „höchstens so viel" ein „so viel" zu machen.
    expect(
      idleAlarm(stats({ socPerDay: 4, kwhPerDay: 3.3, obergrenze: true }), IDLE_ALARM_PCT_PER_DAY),
    ).toBeUndefined();
  });

  it('warnt nicht auf zu kurzer Beobachtung', () => {
    // Ein Tag Stillstand sagt nichts: Der Ladestand ist ganzzahlig, ein
    // einzelner Punkt sind schon fast ein Prozent.
    expect(
      idleAlarm(stats({ socPerDay: 5, kwhPerDay: 4.2, observedDays: 1 }), IDLE_ALARM_PCT_PER_DAY),
    ).toBeUndefined();
  });

  it('schweigt ohne Auswertung', () => {
    expect(idleAlarm(undefined, IDLE_ALARM_PCT_PER_DAY)).toBeUndefined();
  });

  it('lässt sich die Schwelle vorgeben', () => {
    // Wer sein Auto kennt, setzt sie enger — oder schaltet sie mit 0 ab.
    expect(idleAlarm(stats({ socPerDay: 1.2 }), 1)).toBeDefined();
    expect(idleAlarm(stats({ socPerDay: 1.2 }), 0)).toBeUndefined();
  });

  it('hat eine Standardschwelle im Bereich der belegten Problemfälle', () => {
    // Normal sind unter 1 % je Tag; die Forumsfälle lagen bei 3 bis 10 %.
    expect(IDLE_ALARM_PCT_PER_DAY).toBeGreaterThan(1);
    expect(IDLE_ALARM_PCT_PER_DAY).toBeLessThan(5);
  });
});
