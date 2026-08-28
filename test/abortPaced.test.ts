import { buildSessions } from '../src/sessions';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Der Fall, für den die Ausnahme gebaut wurde:
 *
 *   eingesteckt bei einem niedrigeren Ladeziel
 *   kurz darauf meldet das Fahrzeug 100 %  (der Tarifanbieter setzt sein Ziel)
 *   geladen wird in mehreren Phasen, getrennt von Pausen weit über der
 *   Taktschwelle von 20 Minuten
 *   Ende bei 80 %
 *
 * Das Dashboard hängte daran „bei 80 % statt 100 %" — den Abbruch-Hinweis.
 * Aus seiner Sicht folgerichtig: Ziel 100, Ende 80. Nur war es kein Abbruch.
 * Ein Anbieter, der in Zeitfenstern lädt, hört auf, wenn sein Fenster endet,
 * und er hatte das Ziel selbst gesetzt.
 *
 * Die Pausenstruktur verrät ihn: Wer ungestört lädt, lädt durch.
 */

/** Frei gewählte Basis: Es zählen allein die Abstände, nicht der Kalendertag. */
const t = (h: number, m: number, tag = 1): string =>
  new Date(Date.UTC(2020, 0, tag, h, m)).toISOString();

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
  /**
   * Vier Ladephasen mit Pausen über der Taktschwelle.
   *
   * Gemessen wird die Pause vom letzten Ladeimpuls bis zum ersten Messpunkt
   * ohne Strom: Der schließt die Phase ab und wird der nächsten vorangestellt.
   * Der Abstand zum WIEDEREINSCHALTEN geht also nicht ein — deshalb liegt hier
   * jeder Ruhemesspunkt eine volle Stunde hinter seiner Phase.
   */
  const getaktet: ChargeLogSample[] = [
    p(t(22, 0), 40, false),
    p(t(22, 10), 40, true),
    p(t(23, 0), 50, true),
    // Pause 60 min
    p(t(0, 0, 2), 50, false),
    p(t(0, 30, 2), 50, true),
    p(t(1, 0, 2), 60, true),
    // Pause 60 min
    p(t(2, 0, 2), 60, false),
    p(t(2, 30, 2), 60, true),
    p(t(3, 0, 2), 70, true),
    // Pause 60 min
    p(t(4, 0, 2), 70, false),
    p(t(4, 30, 2), 70, true),
    p(t(5, 0, 2), 80, true),
    // Lange Ruhe am Kabel, dann ausgesteckt.
    p(t(11, 0, 2), 80, false),
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
      p(t(22, 0), 40, false),
      p(t(22, 10), 40, true),
      p(t(0, 0, 2), 60, true),
      p(t(1, 0, 2), 80, true),
      p(t(8, 0, 2), 80, false),
      { ts: t(9, 0, 2), soc: 80, plugged: false, odometerKm: 50000 },
    ];
    const [s] = buildSessions(durchgehend, { capacityKwh: 83.7 });
    expect(s.aborted).toBe(true);
  });
});
