import { buildSessions, DEFAULT_CAPACITY_KWH } from '../src/sessions';
import type { ChargeLogSample } from '../src/chargeLog';

/** Baut ein Sample mit Zeitstempel `min` Minuten nach 2026-07-27 20:00 Uhr. */
const at = (min: number, over: Partial<ChargeLogSample> = {}): ChargeLogSample => ({
  ts: new Date(Date.UTC(2026, 6, 27, 20, 0, 0) + min * 60000).toISOString(),
  ...over,
});

describe('buildSessions', () => {
  it('returns nothing when the car was never plugged in', () => {
    expect(buildSessions([at(0, { plugged: false }), at(10, { plugged: false })])).toEqual([]);
  });

  it('spans one session from plug-in to unplug', () => {
    const s = buildSessions([
      at(0, { plugged: false, soc: 40 }),
      at(10, { plugged: true, charging: true, soc: 40 }),
      at(70, { plugged: true, charging: true, soc: 80 }),
      at(80, { plugged: false, soc: 80 }),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].complete).toBe(true);
    expect(s[0].startSoc).toBe(40);
    expect(s[0].endSoc).toBe(80);
  });

  it('keeps a tariff-interrupted charge as ONE session (Octopus 15-min slots)', () => {
    // charging toggles off and on repeatedly — plugged stays true throughout.
    const s = buildSessions([
      at(0, { plugged: true, charging: true, soc: 30 }),
      at(15, { plugged: true, charging: false, soc: 35 }),
      at(30, { plugged: true, charging: true, soc: 35 }),
      at(45, { plugged: true, charging: false, soc: 40 }),
      at(60, { plugged: false, soc: 40 }),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].startSoc).toBe(30);
    expect(s[0].endSoc).toBe(40);
  });

  it('computes energy from the SoC delta', () => {
    const s = buildSessions([
      at(0, { plugged: true, charging: true, soc: 20 }),
      at(60, { plugged: false, soc: 70 }),
    ]);
    // 50 % of 83.7 kWh = 41.85
    expect(s[0].energyKwh).toBeCloseTo(0.5 * DEFAULT_CAPACITY_KWH, 1);
  });

  it('applies a custom capacity', () => {
    const s = buildSessions(
      [at(0, { plugged: true, soc: 0 }), at(60, { plugged: false, soc: 100 })],
      { capacityKwh: 90 },
    );
    expect(s[0].energyKwh).toBe(90);
  });

  it('computes cost and records the applied price', () => {
    const s = buildSessions(
      [at(0, { plugged: true, soc: 50 }), at(60, { plugged: false, soc: 60 })],
      { capacityKwh: 100, pricePerKwh: 0.3 },
    );
    expect(s[0].energyKwh).toBe(10);
    expect(s[0].costEur).toBe(3);
    expect(s[0].pricePerKwh).toBe(0.3);
  });

  it('leaves cost empty when no price is configured', () => {
    const s = buildSessions([at(0, { plugged: true, soc: 50 }), at(60, { plugged: false, soc: 60 })]);
    expect(s[0].costEur).toBeUndefined();
  });

  it('never reports negative energy, but flags the SoC drop', () => {
    // Preconditioning while plugged but not charging can lower the SoC.
    const s = buildSessions([
      at(0, { plugged: true, soc: 60 }),
      at(60, { plugged: false, soc: 55 }),
    ]);
    expect(s[0].energyKwh).toBe(0);
    expect(s[0].socDropped).toBe(true);
  });

  it('separates two nights into two sessions', () => {
    const s = buildSessions([
      at(0, { plugged: true, soc: 30 }),
      at(60, { plugged: false, soc: 80 }),
      at(600, { plugged: true, soc: 40 }),
      at(660, { plugged: false, soc: 90 }),
    ]);
    expect(s).toHaveLength(2);
    expect(s[1].startSoc).toBe(40);
  });

  it('marks a still-running session as incomplete and omits the end time', () => {
    const s = buildSessions([at(0, { plugged: true, soc: 30 }), at(30, { plugged: true, soc: 50 })]);
    expect(s[0].complete).toBe(false);
    expect(s[0].endedAt).toBeUndefined();
  });

  it('does NOT end a session on a failed poll (plugged undefined)', () => {
    // A missing reading must not look like unplugging.
    const s = buildSessions([
      at(0, { plugged: true, soc: 30 }),
      at(10, {}),
      at(20, { plugged: true, soc: 40 }),
      at(30, { plugged: false, soc: 40 }),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].complete).toBe(true);
  });

  it('reports peak and average power only from charging samples', () => {
    const s = buildSessions([
      at(0, { plugged: true, charging: true, powerKw: 10 }),
      at(10, { plugged: true, charging: true, powerKw: 12 }),
      at(20, { plugged: true, charging: false, powerKw: 0 }),
      at(30, { plugged: false }),
    ]);
    expect(s[0].peakPowerKw).toBe(12);
    expect(s[0].avgPowerKw).toBe(11);
  });

  it('counts only actual charging time, not the whole plugged-in span', () => {
    const s = buildSessions([
      at(0, { plugged: true, charging: true }),
      at(30, { plugged: true, charging: true }),
      at(60, { plugged: true, charging: false }),
      at(240, { plugged: false }),
    ]);
    expect(s[0].durationMin).toBe(240);
    expect(s[0].chargingMin).toBe(30);
  });

  it('measures the range added instead of deriving it from energy', () => {
    const s = buildSessions([
      at(0, { plugged: true, charging: true, rangeKm: 180 }),
      at(60, { plugged: true, charging: true, rangeKm: 300 }),
      at(70, { plugged: false, rangeKm: 300 }),
    ]);
    expect(s[0].rangeAddedKm).toBe(120);
  });

  it('reports the average km per minute over the CHARGING time only', () => {
    // 120 km in 60 minutes of charging = 2 km/min, even though the cable
    // stayed connected for 70 minutes.
    const s = buildSessions([
      at(0, { plugged: true, charging: true, rangeKm: 180 }),
      at(60, { plugged: true, charging: true, rangeKm: 300 }),
      at(70, { plugged: false, rangeKm: 300 }),
    ]);
    expect(s[0].avgKmPerMin).toBe(2);
  });

  it('takes the peak rate reported by the car', () => {
    const s = buildSessions([
      at(0, { plugged: true, charging: true, rateKmMin: 0.7 }),
      at(10, { plugged: true, charging: true, rateKmMin: 1.4 }),
      at(20, { plugged: false }),
    ]);
    expect(s[0].peakKmPerMin).toBe(1.4);
  });

  it('never reports a negative range gain', () => {
    // Heating during a pause can lower the predicted range.
    const s = buildSessions([
      at(0, { plugged: true, rangeKm: 300 }),
      at(60, { plugged: false, rangeKm: 280 }),
    ]);
    expect(s[0].rangeAddedKm).toBe(0);
  });

  it('records the charging type seen while charging', () => {
    const s = buildSessions([
      at(0, { plugged: true, charging: true, chargingType: 'AC' }),
      at(30, { plugged: false }),
    ]);
    expect(s[0].chargingType).toBe('AC');
  });
});

describe('Ladephasen', () => {
  it('zerlegt eine tarifgesteuerte Ladung in ihre Phasen', () => {
    // Octopus schaltet zweimal ein: die Session bleibt EINE, zeigt aber
    // beide Fenster einzeln.
    const s = buildSessions([
      at(0, { plugged: true, charging: false, soc: 30 }),
      at(10, { plugged: true, charging: true, soc: 30, powerKw: 11 }),
      at(25, { plugged: true, charging: true, soc: 35, powerKw: 11 }),
      at(30, { plugged: true, charging: false, soc: 35 }),
      at(60, { plugged: true, charging: true, soc: 35, powerKw: 11 }),
      at(75, { plugged: true, charging: true, soc: 40, powerKw: 11 }),
      at(90, { plugged: false, soc: 40 }),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].phases).toHaveLength(2);
    expect(s[0].energyKwh).toBeCloseTo(0.1 * 83.7, 1);
  });

  it('rechnet je Phase die eigene Energie', () => {
    const s = buildSessions(
      [
        at(0, { plugged: true, charging: false, soc: 30 }),
        at(10, { plugged: true, charging: true, soc: 30 }),
        at(20, { plugged: true, charging: true, soc: 40 }),
        at(30, { plugged: false, soc: 40 }),
      ],
      { capacityKwh: 100 },
    );
    expect(s[0].phases[0].energyKwh).toBe(10);
    expect(s[0].phases[0].startSoc).toBe(30);
    expect(s[0].phases[0].endSoc).toBe(40);
  });

  it('schließt eine noch laufende Phase mit ab', () => {
    const s = buildSessions([
      at(0, { plugged: true, charging: true, soc: 30 }),
      at(10, { plugged: true, charging: true, soc: 35 }),
    ]);
    expect(s[0].complete).toBe(false);
    expect(s[0].phases).toHaveLength(1);
  });

  it('liefert keine Phasen, wenn nie geladen wurde', () => {
    const s = buildSessions([
      at(0, { plugged: true, charging: false, soc: 30 }),
      at(30, { plugged: false, soc: 30 }),
    ]);
    expect(s[0].phases).toEqual([]);
  });

  it('nimmt den letzten Messpunkt vor dem Einschalten als Phasenstart', () => {
    // Sonst begänne die Phase erst beim zweiten Messpunkt und der erste
    // Ladestand-Sprung fehlte.
    const s = buildSessions(
      [
        at(0, { plugged: true, charging: false, soc: 30 }),
        at(10, { plugged: true, charging: true, soc: 34 }),
        at(20, { plugged: false, soc: 34 }),
      ],
      { capacityKwh: 100 },
    );
    expect(s[0].phases[0].startSoc).toBe(30);
    expect(s[0].phases[0].energyKwh).toBe(4);
  });
});

describe('Ort der Ladung', () => {
  it('nimmt ein einziges „zuhause" für die ganze Session', () => {
    // Beim Anstecken trägt die zwischengespeicherte Antwort oft noch die
    // Position von unterwegs — real beobachtet waren elf Minuten, bis
    // „zuhause" ankam. Der Anfang der Ladung darf dadurch nicht verloren gehen.
    const s = buildSessions([
      at(0, { plugged: true, soc: 40 }),
      at(3, { plugged: true, soc: 40 }),
      at(11, { plugged: true, soc: 42, atHome: true }),
      at(60, { plugged: true, soc: 60, atHome: true }),
      at(70, { plugged: false, soc: 60 }),
    ]);
    expect(s[0].atHome).toBe(true);
  });

  it('meldet auswärts, wenn NIE ein „zuhause" kam', () => {
    const s = buildSessions([
      at(0, { plugged: true, soc: 40, atHome: false }),
      at(60, { plugged: true, soc: 70, atHome: false }),
      at(70, { plugged: false, soc: 70 }),
    ]);
    expect(s[0].atHome).toBe(false);
  });

  it('lässt den Ort offen, solange nie eine Position vorlag', () => {
    const s = buildSessions([
      at(0, { plugged: true, soc: 40 }),
      at(60, { plugged: true, soc: 70 }),
      at(70, { plugged: false, soc: 70 }),
    ]);
    expect(s[0].atHome).toBeUndefined();
  });

  it('lässt „zuhause" gegen ein späteres „auswärts" bestehen', () => {
    // Das Fahrzeug bewegt sich am Kabel nicht. Ein „auswärts" nach einem
    // „zuhause" ist eine veraltete Position, kein Ortswechsel.
    const s = buildSessions([
      at(0, { plugged: true, soc: 40, atHome: true }),
      at(30, { plugged: true, soc: 55, atHome: false }),
      at(60, { plugged: false, soc: 55 }),
    ]);
    expect(s[0].atHome).toBe(true);
  });

  it('trennt zwei Ladungen an verschiedenen Orten', () => {
    const s = buildSessions([
      at(0, { plugged: true, soc: 30, atHome: true }),
      at(60, { plugged: false, soc: 70 }),
      at(600, { plugged: true, soc: 40, atHome: false }),
      at(660, { plugged: false, soc: 80 }),
    ]);
    expect(s.map((x) => x.atHome)).toEqual([true, false]);
  });
});
