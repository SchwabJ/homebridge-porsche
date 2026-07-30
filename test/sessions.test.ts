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

describe('Ladeabbruch erkennen', () => {
  /**
   * Ladung mit Ziel 80 %, die bei `endSoc` aufhört und danach `idleMin`
   * Minuten stromlos am Kabel steht, bevor ausgesteckt wird.
   */
  const ladung = (endSoc: number, idleMin: number): ChargeLogSample[] => {
    const rows: ChargeLogSample[] = [
      at(0, { soc: 40, plugged: true, charging: false, targetSoc: 80, atHome: true }),
    ];
    // Bis Minute 100 wird geladen — danach beginnt die Stillstandszeit, an
    // der sich der Abbruch entscheidet.
    for (let m = 10; m <= 100; m += 10) {
      const soc = Math.round(40 + ((endSoc - 40) * m) / 100);
      rows.push(at(m, { soc, plugged: true, charging: true, targetSoc: 80, atHome: true }));
    }
    for (let m = 110; m <= 100 + idleMin; m += 10) {
      rows.push(
        at(m, { soc: endSoc, plugged: true, charging: false, targetSoc: 80, atHome: true }),
      );
    }
    rows.push(at(110 + idleMin, { soc: endSoc, plugged: false, targetSoc: 80 }));
    return rows;
  };

  it('meldet einen Abbruch, wenn das Ziel offen blieb und der Strom lange aus war', () => {
    const [s] = buildSessions(ladung(60, 120));
    expect(s.aborted).toBe(true);
    expect(s.targetSoc).toBe(80);
    expect(s.endSoc).toBe(60);
  });

  it('schweigt, wenn nach dem Ladeende sofort ausgesteckt wurde', () => {
    // Wer morgens los muss, zieht den Stecker — das ist kein Abbruch.
    const [s] = buildSessions(ladung(60, 0));
    expect(s.aborted).toBeUndefined();
  });

  it('schweigt bei einer normalen Ladepause der Tarifsteuerung', () => {
    // Eine halbe Stunde Pause ist bei Viertelstunden-Slots Alltag.
    const [s] = buildSessions(ladung(60, 30));
    expect(s.aborted).toBeUndefined();
  });

  it('schweigt, wenn das Ziel praktisch erreicht wurde', () => {
    // Das Fahrzeug hört regelmäßig ein bis zwei Punkte vorher auf.
    const [s] = buildSessions(ladung(78, 300));
    expect(s.aborted).toBeUndefined();
  });

  it('schweigt ohne gesetztes Ziel', () => {
    const rows = ladung(60, 300).map(({ targetSoc: _weg, ...rest }) => rest);
    const [s] = buildSessions(rows);
    expect(s.aborted).toBeUndefined();
  });

  it('schweigt, solange die Ladung noch läuft', () => {
    const rows = ladung(60, 300);
    rows.pop(); // kein Ausstecken beobachtet
    const [s] = buildSessions(rows);
    expect(s.complete).toBe(false);
    expect(s.aborted).toBeUndefined();
  });

  it('misst am ZULETZT gesetzten Ziel, nicht am ersten', () => {
    // Wer während der Ladung von 60 auf 100 hochsetzt, will die 100.
    const [s] = buildSessions([
      at(0, { soc: 40, plugged: true, charging: true, targetSoc: 60, atHome: true }),
      at(30, { soc: 55, plugged: true, charging: true, targetSoc: 60, atHome: true }),
      at(60, { soc: 60, plugged: true, charging: false, targetSoc: 100, atHome: true }),
      at(200, { soc: 60, plugged: true, charging: false, targetSoc: 100, atHome: true }),
      at(210, { soc: 60, plugged: false, targetSoc: 100 }),
    ]);
    expect(s.targetSoc).toBe(100);
    expect(s.aborted).toBe(true);
  });

  it('schweigt, wenn überhaupt nie geladen wurde', () => {
    // Angesteckt, nichts passiert — daran ist nichts abgebrochen.
    const [s] = buildSessions([
      at(0, { soc: 60, plugged: true, charging: false, targetSoc: 80, atHome: true }),
      at(200, { soc: 60, plugged: true, charging: false, targetSoc: 80, atHome: true }),
      at(210, { soc: 60, plugged: false, targetSoc: 80 }),
    ]);
    expect(s.aborted).toBeUndefined();
  });
});

describe('Ladezeit bei Tarifsteuerung', () => {
  /**
   * Nachtladung mit einer echten PAUSE: 30 min laden, 90 min stromlos am
   * Kabel, wieder 30 min laden. Genau das Muster eines Slot-Tarifs.
   */
  const mitPause = (): ChargeLogSample[] => {
    const rows: ChargeLogSample[] = [];
    // Phase 1: 0–30 min
    for (let m = 0; m <= 30; m += 10) {
      rows.push(at(m, { soc: 40 + m / 5, plugged: true, charging: true, atHome: true }));
    }
    // Pause: 40–120 min, am Kabel aber ohne Strom
    for (let m = 40; m <= 120; m += 10) {
      rows.push(at(m, { soc: 46, plugged: true, charging: false, atHome: true }));
    }
    // Phase 2: 130–160 min
    for (let m = 130; m <= 160; m += 10) {
      rows.push(at(m, { soc: 46 + (m - 130) / 5, plugged: true, charging: true, atHome: true }));
    }
    rows.push(at(170, { soc: 52, plugged: false }));
    return rows;
  };

  it('zählt die stromlose Pause NICHT zur Ladezeit', () => {
    // Vorher wurden die Abstände zwischen allen Lade-Messpunkten summiert.
    // Diese Summe teleskopiert zu „letzter minus erster" und enthielt damit
    // genau das, was sie ausschließen sollte: die Pause. Am echten Mitschrieb
    // stand unter „davon 4 h 55 min laden" ein Wert, den die Phasenliste
    // derselben Zeile mit 2 h 47 min widerlegte.
    const [s] = buildSessions(mitPause());
    expect(s.durationMin).toBe(170);
    // Zwei Phasen von je 30 min, plus je der vorangestellte Ankerpunkt.
    expect(s.chargingMin).toBeLessThan(90);
    expect(s.chargingMin).toBe(s.phases.reduce((a, p) => a + p.durationMin, 0));
  });

  it('bleibt widerspruchsfrei zur Phasenliste, die daneben steht', () => {
    // Zwei Zahlen auf derselben Seite, die dasselbe meinen, müssen gleich sein.
    for (const rows of [mitPause(), mitPause().slice(0, 12)]) {
      const [s] = buildSessions(rows);
      expect(s.chargingMin).toBe(s.phases.reduce((a, p) => a + p.durationMin, 0));
    }
  });

  it('ergibt eine physikalisch plausible Ladeleistung', () => {
    // Die Gegenprobe von außen: Energie geteilt durch Ladezeit muss eine
    // Leistung ergeben, die die Wallbox liefern kann. Mit der Pause im Nenner
    // kam die halbe heraus.
    const [s] = buildSessions(mitPause(), { capacityKwh: 100 });
    const kw = ((s.energyKwh as number) / s.chargingMin) * 60;
    expect(kw).toBeGreaterThan(8);
    expect(kw).toBeLessThan(12);
  });

  it('lässt eine Ladung ohne Pause unverändert', () => {
    const rows: ChargeLogSample[] = [];
    for (let m = 0; m <= 60; m += 10) {
      rows.push(at(m, { soc: 40 + m / 3, plugged: true, charging: true, atHome: true }));
    }
    rows.push(at(70, { soc: 60, plugged: false }));
    const [s] = buildSessions(rows);
    expect(s.chargingMin).toBe(60);
  });
});

describe('Laderate gegen die gemessene Leistung', () => {
  /** Ladung mit Reichweitensprung aus dem Cache. */
  const mitSprung = (powerKw?: number): ChargeLogSample[] => [
    at(0, { plugged: true, charging: true, rangeKm: 100, soc: 40, powerKw }),
    at(3, { plugged: true, charging: true, rangeKm: 340, soc: 41, powerKw }),
    at(60, { plugged: true, charging: true, rangeKm: 360, soc: 70, powerKw }),
    at(70, { plugged: false, rangeKm: 360, soc: 70 }),
  ];

  it('verwirft eine Rate, die die gemeldete Leistung nicht hergibt', () => {
    // 11 kW ergeben bei fünf km je kWh höchstens 0,9 km/min. Aus dem Sprung
    // käme 4,3 — unter jeder festen Obergrenze, an einer Wallbox unmöglich.
    const [s] = buildSessions(mitSprung(11));
    expect(s.avgKmPerMin).toBeUndefined();
  });

  it('lässt eine plausible Rate stehen', () => {
    const rows = [
      at(0, { plugged: true, charging: true, rangeKm: 100, soc: 40, powerKw: 11 }),
      at(60, { plugged: true, charging: true, rangeKm: 155, soc: 70, powerKw: 11 }),
      at(70, { plugged: false, rangeKm: 155, soc: 70 }),
    ];
    const [s] = buildSessions(rows);
    // 55 km in 60 min = 0,92 km/min, Grenze bei 11 kW = 1,37.
    expect(s.avgKmPerMin).toBeCloseTo(0.9, 1);
  });

  it('erlaubt der Schnellladung ihre hohe Rate', () => {
    const rows = [
      at(0, { plugged: true, charging: true, rangeKm: 100, soc: 20, powerKw: 180 }),
      at(20, { plugged: true, charging: true, rangeKm: 400, soc: 80, powerKw: 180 }),
      at(25, { plugged: false, rangeKm: 400, soc: 80 }),
    ];
    const [s] = buildSessions(rows);
    // 300 km in 20 min = 15 km/min; bei 180 kW sind 22,5 erlaubt.
    expect(s.avgKmPerMin).toBeCloseTo(15, 0);
  });

  it('zeigt die Rate ohne gemeldete Leistung, kann sie dann aber nicht prüfen', () => {
    // Bewusste Entscheidung, nicht Nachlässigkeit: Die Rate ist GEMESSEN
    // (Reichweitendifferenz durch Zeit), nur ihre Plausibilität ist ohne
    // Leistungsangabe unprüfbar. Sie zu verschweigen hieße, in dem Randfall,
    // in dem das Fahrzeug keine Leistung meldet, auch die brauchbaren Zahlen
    // zu verlieren — und das ist der häufigere Fall als ein Cache-Sprung
    // ausgerechnet dort.
    const [s] = buildSessions(mitSprung(undefined));
    expect(s.avgKmPerMin).toBeDefined();
  });

  it('verwirft den Sprung, nicht die ganze Ladung', () => {
    const [s] = buildSessions(mitSprung(11));
    // Die Energiebilanz aus dem Ladestand bleibt gültig — sie kommt aus einer
    // anderen Größe. Nur die Reichweite ist nicht mehr bestimmbar.
    expect(s.energyKwh).toBeGreaterThan(0);
    expect(s.rangeAddedKm).toBeUndefined();
  });
});
