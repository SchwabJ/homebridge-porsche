import { buildTrips } from '../src/trips';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Eine Fahrt beginnt, wenn der Ladestand fällt — nicht, wenn der
 * Kilometerstand nachkommt.
 *
 * ## Der gemeldete Fall
 *
 *     00:00    1 km    59 → 58 %    —
 *
 * Eine Fahrt kurz nach Mitternacht, die es so nicht gab: Gefahren wurde
 * am Abend davor.
 *
 * Es ist keine Phantomfahrt, sondern eine wirklich gefahrene Strecke — nur
 * mit falscher Uhrzeit:
 *
 *     23:00   60 %   50100 km
 *     23:20   59 %   50100 km    Ladestand fällt: HIER wurde gefahren
 *     00:00   58 %   50101 km    Kilometerstand kommt erst jetzt
 *
 * Das Backend frischt `odometerKm` erst zum Fahrtende auf, der Ladestand
 * läuft mit. Die Fahrterkennung hängt am Kilometerstand und datiert deshalb
 * auf 00:00 — vierzig Minuten daneben, und über die Tagesgrenze hinweg
 * landet die Fahrt sogar im falschen Tag.
 *
 * ## Die Regel
 *
 * Steht der Kilometerstand still, während der Ladestand fällt, und steigt er
 * unmittelbar danach, gehört der Beginn der Fahrt vor den Ladestand-Abfall.
 * Nur unmittelbar davor: Über Stunden fällt der Ladestand auch im Stehen, und
 * eine Fahrt rückwirkend über eine Nacht zu ziehen wäre schlimmer als eine
 * um vierzig Minuten verschobene.
 */
const p = (
  stunde: number,
  minute: number,
  soc: number,
  odo: number,
): ChargeLogSample => ({
  // Frei gewähltes Basisdatum: Es zählen allein die Abstände.
  ts: new Date(Date.UTC(2020, 0, 1, stunde, minute)).toISOString(),
  soc,
  odometerKm: odo,
  plugged: false,
  tripKwh100: 20,
});

/** Ein Abendverlauf, bei dem der Kilometerstand nachläuft. */
const verlauf: ChargeLogSample[] = [
  { ...p(16, 0, 80, 50000), plugged: true, charging: true },
  p(17, 0, 80, 50000),
  p(19, 0, 60, 50100),
  p(20, 0, 60, 50100),
  p(20, 40, 60, 50100),
  p(21, 0, 60, 50100),
  p(21, 20, 59, 50100), // Ladestand fällt — hier wurde gefahren
  p(22, 0, 58, 50101), // Kilometerstand kommt vierzig Minuten später
  p(22, 20, 58, 50101),
];

describe('Fahrtbeginn bei verspätetem Kilometerstand', () => {
  it('datiert die Fahrt auf den Ladestand-Abfall, nicht auf die Meldung', () => {
    const t = buildTrips(verlauf, {});
    const kurz = t.find((x) => x.km === 1);
    expect(kurz).toBeDefined();
    // Beginn vor dem Abfall (21:00), nicht erst bei 21:20.
    expect(kurz?.startedAt).toBe(new Date(Date.UTC(2020, 0, 1, 21, 0)).toISOString());
  });

  it('zieht den Beginn nicht über einen langen Stillstand zurück', () => {
    // Fällt der Ladestand Stunden vorher, war das Standverbrauch — die Fahrt
    // dorthin zu ziehen erfände eine Fahrtdauer von Stunden.
    const langerStand: ChargeLogSample[] = [
      { ...p(4, 0, 80, 50000), plugged: true, charging: true },
      p(5, 0, 80, 50000),
      p(6, 0, 79, 50000), // Ladestand fällt — aber Stunden vor der Fahrt
      p(12, 0, 78, 50000),
      p(18, 0, 77, 50000),
      p(19, 0, 76, 50001), // erst hier die Fahrt
      p(19, 20, 76, 50001),
    ];
    const t = buildTrips(langerStand, {});
    const kurz = t.find((x) => x.km === 1);
    expect(kurz).toBeDefined();
    // Der Beginn bleibt beim letzten Punkt vor dem Kilometerstand-Anstieg.
    expect(kurz?.startedAt).toBe(new Date(Date.UTC(2020, 0, 1, 18, 0)).toISOString());
  });

  it('lässt eine Fahrt mit mitlaufendem Kilometerstand unangetastet', () => {
    // Steigt der Kilometerstand mit dem Ladestand-Abfall zusammen, ist nichts
    // verspätet und nichts zu korrigieren.
    const normal: ChargeLogSample[] = [
      { ...p(6, 0, 80, 50000), plugged: true, charging: true },
      p(7, 0, 80, 50000),
      p(8, 0, 72, 50040),
      p(8, 30, 72, 50040),
    ];
    const t = buildTrips(normal, {});
    expect(t[0]?.startedAt).toBe(new Date(Date.UTC(2020, 0, 1, 7, 0)).toISOString());
  });
});
