import { buildTrips } from '../src/trips';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Der reale Verlauf vom 28. Juli 2026:
 *
 *   22:10:13   52602 km   kein Kabel
 *   22:10:37   52602 km   Kabel steckt, lädt
 *   22:11:35   52603 km   Kabel steckt, lädt   ← ein Kilometer mehr
 *
 * Ein Auto, das am Kabel lädt, fährt nicht. Der Kilometer wurde gefahren,
 * aber erst nach dem Einstecken gemeldet — das Fahrzeug übermittelt den Stand
 * mit Verzug. Für die Fahrterkennung fiel er damit zwischen die Stühle: Die
 * Fahrt war beendet, eine neue begann nie.
 *
 * Über den Mitschrieb summiert waren es drei Kilometer, um die die
 * Fahrtenliste hinter dem Kilometerstand zurückblieb — 682 gegen 685.
 */
const p = (
  zeit: string,
  odo: number,
  plugged: boolean,
  over: Partial<ChargeLogSample> = {},
): ChargeLogSample => ({
  ts: `2026-07-28T${zeit}.000Z`,
  odometerKm: odo,
  soc: 48,
  plugged,
  ...(plugged ? { charging: true } : {}),
  ...over,
});

describe('Verspätet gemeldeter Kilometerstand', () => {
  it('schlägt den Nachtrag der letzten Fahrt zu, statt ihn zu verlieren', () => {
    const verlauf: ChargeLogSample[] = [
      p('20:00:00', 52560, false, { soc: 80 }),
      p('21:00:00', 52590, false, { soc: 60 }),
      p('22:10:13', 52602, false),
      // Ab hier am Kabel — der Kilometerstand steigt trotzdem noch.
      p('22:10:37', 52602, true),
      p('22:11:35', 52603, true),
      p('22:30:00', 52603, true, { soc: 60 }),
    ];
    const trips = buildTrips(verlauf, {});
    const summe = trips.reduce((a, t) => a + t.km, 0);
    expect(summe).toBe(52603 - 52560);
  });

  it('erfindet keine Fahrt, wo nur nachgemeldet wurde', () => {
    // Der Nachtrag gehört zur bestehenden Fahrt — eine eigene Fahrt über
    // einen Kilometer in vierzig Sekunden wäre Unsinn.
    const verlauf: ChargeLogSample[] = [
      p('20:00:00', 52560, false, { soc: 80 }),
      p('21:00:00', 52590, false, { soc: 60 }),
      p('22:10:13', 52602, false),
      p('22:10:37', 52602, true),
      p('22:11:35', 52603, true),
      p('22:30:00', 52603, true, { soc: 60 }),
    ];
    const trips = buildTrips(verlauf, {});
    expect(trips.length).toBe(1);
  });

  it('lässt einen Kilometerstand ohne Kabel unangetastet', () => {
    // Ohne Kabel ist ein steigender Kilometerstand schlicht eine Fahrt.
    const verlauf: ChargeLogSample[] = [
      p('20:00:00', 52560, false, { soc: 80 }),
      p('21:00:00', 52590, false, { soc: 60 }),
      p('22:00:00', 52600, false, { soc: 55 }),
    ];
    const trips = buildTrips(verlauf, {});
    expect(trips.reduce((a, t) => a + t.km, 0)).toBe(40);
  });
});
