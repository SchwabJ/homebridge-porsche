import { buildSessions } from '../src/sessions';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Der reale Verlauf der Nacht vom 1. auf den 2. August 2026:
 *
 *   23:38  eingesteckt, eigenes Ladeziel 80 %
 *   23:43  das gemeldete Ziel wechselt auf 100 %  (Tarifanbieter)
 *          geladen wird in fünf Phasen, Pausen von 91, 43, 79 und 13 Minuten
 *   11:56  Ende bei 80 %
 *
 * Das Dashboard hängte daran „bei 80 % statt 100 %" — den Abbruch-Hinweis.
 * Aus seiner Sicht folgerichtig: Ziel 100, Ende 80. Nur war es kein Abbruch.
 * Ein Anbieter, der in Zeitfenstern lädt, hört auf, wenn sein Fenster endet,
 * und er hatte das Ziel selbst gesetzt.
 *
 * Die Pausenstruktur verrät ihn: Wer ungestört lädt, lädt durch.
 */
const t = (h: number, m: number, tag = 1): string =>
  new Date(Date.UTC(2026, 7, tag, h, m)).toISOString();

const p = (
  zeit: string,
  soc: number,
  laedt: boolean,
  over: Partial<ChargeLogSample> = {},
): ChargeLogSample => ({
  ts: zeit,
  soc,
  plugged: true,
  charging: laedt,
  targetSoc: 100,
  odometerKm: 50000,
  ...over,
});

describe('Abbruch-Hinweis bei tarifgesteuertem Laden', () => {
  /** Fünf Ladephasen mit langen Pausen — der reale Verlauf. */
  const getaktet: ChargeLogSample[] = [
    p(t(23, 38), 58, false),
    p(t(23, 45), 58, true),
    p(t(23, 55), 62, true),
    // Pause 91 min
    p(t(1, 26, 2), 62, false),
    p(t(1, 30, 2), 62, true),
    p(t(2, 10, 2), 70, true),
    // Pause 43 min
    p(t(2, 53, 2), 70, false),
    p(t(3, 0, 2), 70, true),
    p(t(4, 0, 2), 78, true),
    // Pause 79 min
    p(t(5, 19, 2), 78, false),
    p(t(5, 25, 2), 78, true),
    p(t(6, 0, 2), 80, true),
    // Lange Ruhe am Kabel, dann ausgesteckt.
    p(t(11, 56, 2), 80, false),
    { ts: t(12, 0, 2), soc: 80, plugged: false, odometerKm: 50000 },
  ];

  it('meldet keinen Abbruch, wo ein Tarif in Zeitfenstern lädt', () => {
    const [s] = buildSessions(getaktet, { capacityKwh: 83.7 });
    expect(s.endSoc).toBe(80);
    expect(s.targetSoc).toBe(100);
    expect(s.aborted).not.toBe(true);
  });

  it('meldet den Abbruch weiterhin, wo durchgehend geladen wurde', () => {
    // Dieselbe Ladung ohne Pausen: Hier hat tatsächlich etwas aufgehört.
    const durchgehend: ChargeLogSample[] = [
      p(t(23, 38), 58, false),
      p(t(23, 45), 58, true),
      p(t(1, 0, 2), 70, true),
      p(t(2, 0, 2), 80, true),
      p(t(8, 0, 2), 80, false),
      { ts: t(9, 0, 2), soc: 80, plugged: false, odometerKm: 50000 },
    ];
    const [s] = buildSessions(durchgehend, { capacityKwh: 83.7 });
    expect(s.aborted).toBe(true);
  });
});
