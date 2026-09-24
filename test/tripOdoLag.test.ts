import { buildTrips } from '../src/trips';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Ein Verlauf, bei dem der Kilometerstand am Kabel nachläuft:
 *
 *   22:00   50040 km   kein Kabel
 *   22:10   50040 km   Kabel steckt, lädt
 *   22:20   50041 km   Kabel steckt, lädt   ← ein Kilometer mehr
 *
 * Ein Auto, das am Kabel lädt, fährt nicht. Der Kilometer wurde gefahren,
 * aber erst nach dem Einstecken gemeldet — das Fahrzeug übermittelt den Stand
 * mit Verzug. Für die Fahrterkennung fiel er damit zwischen die Stühle: Die
 * Fahrt war beendet, eine neue begann nie.
 *
 * Jeder so nachgemeldete Kilometer fehlte damit in der Summe der erkannten
 * Fahrten: Die Fahrtenliste blieb hinter dem Kilometerstand zurück.
 */
const p = (
  zeit: string,
  odo: number,
  plugged: boolean,
  over: Partial<ChargeLogSample> = {},
): ChargeLogSample => ({
  ts: `2020-01-01T${zeit}.000Z`,
  odometerKm: odo,
  soc: 50,
  plugged,
  ...(plugged ? { charging: true } : {}),
  ...over,
});

describe('Verspätet gemeldeter Kilometerstand', () => {
  it('schlägt den Nachtrag der letzten Fahrt zu, statt ihn zu verlieren', () => {
    const verlauf: ChargeLogSample[] = [
      p('20:00:00', 50000, false, { soc: 80 }),
      p('21:00:00', 50030, false, { soc: 60 }),
      p('22:00:00', 50040, false),
      // Ab hier am Kabel — der Kilometerstand steigt trotzdem noch.
      p('22:10:00', 50040, true),
      p('22:20:00', 50041, true),
      p('22:30:00', 50041, true, { soc: 60 }),
    ];
    const trips = buildTrips(verlauf, {});
    const summe = trips.reduce((a, t) => a + t.km, 0);
    expect(summe).toBe(50041 - 50000);
  });

  it('erfindet keine Fahrt, wo nur nachgemeldet wurde', () => {
    // Der Nachtrag gehört zur bestehenden Fahrt: Am Kabel und beim Laden
    // fährt das Fahrzeug nicht, der Kilometer kann also nur von der Fahrt
    // stammen, die gerade geendet hat.
    const verlauf: ChargeLogSample[] = [
      p('20:00:00', 50000, false, { soc: 80 }),
      p('21:00:00', 50030, false, { soc: 60 }),
      p('22:00:00', 50040, false),
      p('22:10:00', 50040, true),
      p('22:20:00', 50041, true),
      p('22:30:00', 50041, true, { soc: 60 }),
    ];
    const trips = buildTrips(verlauf, {});
    expect(trips.length).toBe(1);
  });

  it('lässt einen Kilometerstand ohne Kabel unangetastet', () => {
    // Ohne Kabel ist ein steigender Kilometerstand schlicht eine Fahrt.
    const verlauf: ChargeLogSample[] = [
      p('20:00:00', 50000, false, { soc: 80 }),
      p('21:00:00', 50030, false, { soc: 60 }),
      p('22:00:00', 50040, false, { soc: 50 }),
    ];
    const trips = buildTrips(verlauf, {});
    expect(trips.reduce((a, t) => a + t.km, 0)).toBe(40);
  });
});
