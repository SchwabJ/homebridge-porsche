import { buildTrips } from '../src/trips';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Eine Fahrt beginnt, wenn der Ladestand fällt — nicht, wenn der
 * Kilometerstand nachkommt.
 *
 * ## Der gemeldete Fall
 *
 *     Do., 06.08., 00:01    1 km    69 → 68 %    —
 *
 * „Wieder eine Phantomfahrt. Ich bin ca. 23 Uhr 1 km gefahren!"
 *
 * Es ist keine Phantomfahrt, sondern seine — mit falscher Uhrzeit:
 *
 *     23:01   70 %   53124 km
 *     23:21   69 %   53124 km    Ladestand fällt: HIER wurde gefahren
 *     00:01   68 %   53125 km    Kilometerstand kommt erst jetzt
 *
 * Das Backend frischt `odometerKm` erst zum Fahrtende auf, der Ladestand
 * läuft mit. Die Fahrterkennung hängt am Kilometerstand und datiert deshalb
 * auf 00:01 — vierzig Minuten daneben, und über die Tagesgrenze hinweg
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
  ts: new Date(Date.UTC(2026, 7, 5, stunde, minute)).toISOString(),
  soc,
  odometerKm: odo,
  plugged: false,
  tripKwh100: 20.5,
});

/** Der reale Verlauf des 5. August, abends. */
const verlauf: ChargeLogSample[] = [
  { ...p(16, 0, 80, 53100), plugged: true, charging: true },
  p(17, 0, 80, 53100),
  p(19, 0, 71, 53124),
  p(20, 1, 70, 53124),
  p(20, 41, 70, 53124),
  p(21, 1, 70, 53124),
  p(21, 21, 69, 53124), // Ladestand fällt — hier wurde gefahren
  p(22, 1, 68, 53125), // Kilometerstand kommt vierzig Minuten später
  p(22, 21, 68, 53125),
];

describe('Fahrtbeginn bei verspätetem Kilometerstand', () => {
  it('datiert die Fahrt auf den Ladestand-Abfall, nicht auf die Meldung', () => {
    const t = buildTrips(verlauf, {});
    const kurz = t.find((x) => x.km === 1);
    expect(kurz).toBeDefined();
    // Beginn vor dem Abfall (21:01), nicht erst bei 21:21.
    expect(kurz?.startedAt).toBe(new Date(Date.UTC(2026, 7, 5, 21, 1)).toISOString());
  });

  it('zieht den Beginn nicht über einen langen Stillstand zurück', () => {
    // Fällt der Ladestand Stunden vorher, war das Standverbrauch — die Fahrt
    // dorthin zu ziehen erfände eine Fahrtdauer von Stunden.
    const langerStand: ChargeLogSample[] = [
      { ...p(4, 0, 80, 53100), plugged: true, charging: true },
      p(5, 0, 80, 53100),
      p(6, 0, 79, 53100), // Ladestand fällt — aber Stunden vor der Fahrt
      p(12, 0, 78, 53100),
      p(18, 0, 77, 53100),
      p(19, 0, 76, 53101), // erst hier die Fahrt
      p(19, 20, 76, 53101),
    ];
    const t = buildTrips(langerStand, {});
    const kurz = t.find((x) => x.km === 1);
    expect(kurz).toBeDefined();
    // Der Beginn bleibt beim letzten Punkt vor dem Kilometerstand-Anstieg.
    expect(kurz?.startedAt).toBe(new Date(Date.UTC(2026, 7, 5, 18, 0)).toISOString());
  });

  it('lässt eine Fahrt mit mitlaufendem Kilometerstand unangetastet', () => {
    // Steigt der Kilometerstand mit dem Ladestand-Abfall zusammen, ist nichts
    // verspätet und nichts zu korrigieren.
    const normal: ChargeLogSample[] = [
      { ...p(6, 0, 80, 53100), plugged: true, charging: true },
      p(7, 0, 80, 53100),
      p(8, 0, 72, 53140),
      p(8, 30, 72, 53140),
    ];
    const t = buildTrips(normal, {});
    expect(t[0]?.startedAt).toBe(new Date(Date.UTC(2026, 7, 5, 7, 0)).toISOString());
  });
});
