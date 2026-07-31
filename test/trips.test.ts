import { buildTrips, summarizeTrips } from '../src/trips';
import type { ChargeLogSample } from '../src/chargeLog';

/** Messpunkt zur Minute `m` nach einem festen Startpunkt. */
const at = (m: number, over: Partial<ChargeLogSample> = {}): ChargeLogSample => ({
  ts: new Date(Date.UTC(2026, 6, 20, 6, 0) + m * 60000).toISOString(),
  ...over,
});

describe('buildTrips', () => {
  it('trennt zwei Fahrten an der Standzeit dazwischen', () => {
    const trips = buildTrips([
      at(0, { odometerKm: 1000, soc: 80 }),
      at(20, { odometerKm: 1010, soc: 78 }),
      at(40, { odometerKm: 1010, soc: 78 }), // steht
      at(60, { odometerKm: 1025, soc: 75 }),
      at(80, { odometerKm: 1025, soc: 75 }),
    ]);
    expect(trips.map((t) => t.km)).toEqual([10, 15]);
  });

  it('fasst eine Fahrt über mehrere Messpunkte zusammen', () => {
    const trips = buildTrips([
      at(0, { odometerKm: 1000 }),
      at(20, { odometerKm: 1010 }),
      at(40, { odometerKm: 1030 }),
      at(60, { odometerKm: 1055 }),
      at(80, { odometerKm: 1055 }),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0].km).toBe(55);
    expect(trips[0].samples).toBe(4);
  });

  it('lässt eine noch laufende Fahrt am Ende des Mitschriebs nicht fallen', () => {
    const trips = buildTrips([at(0, { odometerKm: 1000 }), at(20, { odometerKm: 1012 })]);
    expect(trips).toHaveLength(1);
    expect(trips[0].km).toBe(12);
  });

  it('überspringt Messpunkte ohne Kilometerstand, statt die Fahrt zu zerschneiden', () => {
    const trips = buildTrips([
      at(0, { odometerKm: 1000 }),
      at(10, { soc: 79 }), // leere Antwort
      at(20, { odometerKm: 1020 }),
      at(40, { odometerKm: 1020 }),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0].km).toBe(20);
  });

  it('weist den größten Messabstand als Auflösungsmaß aus', () => {
    const trips = buildTrips([
      at(0, { odometerKm: 1000 }),
      at(5, { odometerKm: 1005 }),
      at(65, { odometerKm: 1050 }),
      at(70, { odometerKm: 1050 }),
    ]);
    expect(trips[0].gapMinutes).toBe(60);
  });
});

describe('Verbrauch je Fahrt', () => {
  /**
   * Ein Zyklus: Laden bei km 1000, danach zwei Fahrten.
   *
   * `tripKwh100` ist der Verbrauch SEIT dem Laden. Nach 40 km mit 20,0 sind
   * das 8,0 kWh; nach weiteren 60 km mit 25,0 insgesamt 25,0 kWh. Die zweite
   * Fahrt hat also 17,0 kWh auf 60 km verbraucht — 28,3 kWh/100 km.
   */
  const zyklus = (): ChargeLogSample[] => [
    at(0, { odometerKm: 1000, charging: true, plugged: true, soc: 80 }),
    at(10, { odometerKm: 1000, plugged: false, soc: 80 }),
    at(30, { odometerKm: 1040, tripKwh100: 20, soc: 71 }),
    at(50, { odometerKm: 1040, tripKwh100: 20, soc: 71 }),
    at(70, { odometerKm: 1100, tripKwh100: 25, soc: 51 }),
    at(90, { odometerKm: 1100, tripKwh100: 25, soc: 51 }),
  ];

  it('rechnet die Energie aus der Angabe des Fahrzeugs, nicht aus dem Ladestand', () => {
    const trips = buildTrips(zyklus());
    expect(trips).toHaveLength(2);
    expect(trips[0].energyKwh).toBeCloseTo(8, 2);
    expect(trips[0].kwhPer100km).toBeCloseTo(20, 1);
    // 25,0 − 8,0 = 17,0 kWh auf 60 km. Aus dem Ladestand (20 Punkte × 83,7 /
    // 100 = 16,7 kWh) käme ein anderer Wert — hier zählt das Fahrzeug.
    expect(trips[1].energyKwh).toBeCloseTo(17, 2);
    expect(trips[1].kwhPer100km).toBeCloseTo(28.3, 1);
  });

  it('rechnet die Kosten aus dieser Energie', () => {
    const trips = buildTrips(zyklus(), { pricePerKwh: 0.2 });
    expect(trips[0].costEur).toBeCloseTo(1.6, 2);
    expect(trips[1].costEur).toBeCloseTo(3.4, 2);
  });

  it('wählt den Preis je Fahrt nach ihrem Startzeitpunkt', () => {
    // Tarifwechsel zwischen zwei Fahrten desselben Verbrauchszyklus: Jede
    // Fahrt rechnet mit dem Preis, der bei ihrem Beginn galt.
    const trips = buildTrips(
      [
        at(0, { charging: true, odometerKm: 1000 }),
        at(10, { odometerKm: 1000, tripKwh100: 0, soc: 80 }),
        at(30, { odometerKm: 1040, tripKwh100: 20, soc: 71 }),
        at(50, { odometerKm: 1040, tripKwh100: 20, soc: 71 }),
        at(1500, { odometerKm: 1040, tripKwh100: 20, soc: 71 }),
        at(1520, { odometerKm: 1100, tripKwh100: 25, soc: 51 }),
        at(1540, { odometerKm: 1100, tripKwh100: 25, soc: 51 }),
      ],
      {
        pricePerKwh: 0.99, // wird durch priceFor verdrängt
        priceFor: (startedAt) =>
          startedAt < at(1000).ts
            ? { pricePerKwh: 0.2, grossPricePerKwh: 0.2 }
            : { pricePerKwh: 0.3, grossPricePerKwh: 0.3 },
      },
    );
    expect(trips).toHaveLength(2);
    expect(trips[0].costEur).toBeCloseTo(1.6, 2); // 8 kWh × 0,20
    expect(trips[1].costEur).toBeCloseTo(5.1, 2); // 17 kWh × 0,30
  });

  it('lässt die Kosten ohne Arbeitspreis leer, statt null zu behaupten', () => {
    const trips = buildTrips(zyklus());
    expect(trips[0].costEur).toBeUndefined();
    expect(trips[0].energyKwh).toBeDefined();
  });

  it('schweigt, solange der Anfang des Zyklus unbekannt ist', () => {
    // Der Mitschrieb beginnt mitten in der Fahrt: Wie viel seit dem letzten
    // Laden schon gefahren wurde, steht nirgends.
    const trips = buildTrips([
      at(0, { odometerKm: 5000, tripKwh100: 21 }),
      at(20, { odometerKm: 5030, tripKwh100: 21 }),
      at(40, { odometerKm: 5030, tripKwh100: 21 }),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0].km).toBe(30);
    expect(trips[0].energyKwh).toBeUndefined();
  });

  it('schweigt, wenn die Rundung den Wert überdeckt', () => {
    // Ein Kilometer am Ende eines langen Zyklus: Der Rundungsschritt von
    // 0,1 kWh/100 km wiegt über 400 km mehr als die Fahrt selbst.
    const trips = buildTrips([
      at(0, { odometerKm: 1000, charging: true, plugged: true }),
      at(10, { odometerKm: 1000, plugged: false }),
      at(30, { odometerKm: 1400, tripKwh100: 20 }),
      at(50, { odometerKm: 1400, tripKwh100: 20 }),
      at(70, { odometerKm: 1401, tripKwh100: 20 }),
      at(90, { odometerKm: 1401, tripKwh100: 20 }),
    ]);
    expect(trips).toHaveLength(2);
    expect(trips[0].energyKwh).toBeDefined();
    expect(trips[1].km).toBe(1);
    expect(trips[1].energyKwh).toBeUndefined();
  });

  it('beginnt mit dem Laden einen neuen Zyklus', () => {
    const trips = buildTrips([
      ...zyklus(),
      at(110, { odometerKm: 1100, plugged: true, charging: true, soc: 60 }),
      at(130, { odometerKm: 1100, plugged: false, soc: 80 }),
      at(150, { odometerKm: 1130, tripKwh100: 18, soc: 73 }),
      at(170, { odometerKm: 1130, tripKwh100: 18, soc: 73 }),
    ]);
    const letzte = trips[trips.length - 1];
    expect(letzte.km).toBe(30);
    // 30 km × 18 / 100 = 5,4 kWh — der Zähler steht wieder bei null, sonst
    // käme hier die Differenz zum Stand vor dem Laden heraus.
    expect(letzte.energyKwh).toBeCloseTo(5.4, 2);
  });

  it('verwirft die Differenz, wenn der Zähler unbemerkt zurückgesetzt hat', () => {
    const trips = buildTrips([
      at(0, { odometerKm: 1000, charging: true, plugged: true }),
      at(10, { odometerKm: 1000, plugged: false }),
      at(30, { odometerKm: 1100, tripKwh100: 25 }),
      at(50, { odometerKm: 1100, tripKwh100: 25 }),
      // Zähler springt auf einen kleineren Stand, ohne Ladevorgang dazwischen.
      at(70, { odometerKm: 1130, tripKwh100: 2 }),
      at(90, { odometerKm: 1130, tripKwh100: 2 }),
    ]);
    expect(trips[1].km).toBe(30);
    expect(trips[1].energyKwh).toBeUndefined();
  });

  it('bürdet einer Fahrt nicht die Energie der vorigen auf', () => {
    // Setzt der Mitschrieb nach dem Laden aus, ist der Ladepunkt trotzdem der
    // Anker: Die Strecke bis zum nächsten Messpunkt wird als eigene Fahrt
    // geführt, statt in der folgenden aufzugehen.
    const trips = buildTrips([
      at(0, { odometerKm: 1000, charging: true, plugged: true }),
      at(10, { odometerKm: 1020, plugged: false, tripKwh100: 20 }),
      at(30, { odometerKm: 1020, tripKwh100: 20 }),
      at(50, { odometerKm: 1060, tripKwh100: 20 }),
      at(70, { odometerKm: 1060, tripKwh100: 20 }),
    ]);
    expect(trips.map((t) => t.km)).toEqual([20, 40]);
    expect(trips[0].energyKwh).toBeCloseTo(4, 2);
    expect(trips[1].energyKwh).toBeCloseTo(8, 2);
  });

  it('schreibt den Zählerstand auch dann fort, wenn eine Fahrt ohne Verbrauch bleibt', () => {
    // Die kurze Fahrt bekommt wegen der Rundung keine Zahl. Die lange danach
    // darf deren Energie trotzdem nicht mitrechnen.
    const trips = buildTrips([
      at(0, { odometerKm: 1000, charging: true, plugged: true }),
      at(10, { odometerKm: 1000, plugged: false }),
      at(30, { odometerKm: 1400, tripKwh100: 20 }),
      at(50, { odometerKm: 1400, tripKwh100: 20 }),
      at(70, { odometerKm: 1401, tripKwh100: 20 }), // ohne Verbrauchsangabe
      at(90, { odometerKm: 1401, tripKwh100: 20 }),
      at(110, { odometerKm: 1441, tripKwh100: 21 }),
      at(130, { odometerKm: 1441, tripKwh100: 21 }),
    ]);
    expect(trips.map((t) => t.km)).toEqual([400, 1, 40]);
    expect(trips[1].energyKwh).toBeUndefined();
    // Stand nach 441 km: 441 × 21 / 100 = 92,61. Davor 1401 × … − 1000 = 401
    // km × 20 / 100 = 80,2. Bleiben 12,41 kWh für diese Fahrt.
    expect(trips[2].energyKwh).toBeCloseTo(12.41, 2);
  });
});

describe('summarizeTrips', () => {
  const trips = [
    { km: 100, energyKwh: 20, costEur: 4, startedAt: '', endedAt: '', minutes: 0, gapMinutes: 0, samples: 2 },
    { km: 50, startedAt: '', endedAt: '', minutes: 0, gapMinutes: 0, samples: 2 },
  ];

  it('zählt die ganze Strecke, auch ohne Verbrauchsangabe', () => {
    expect(summarizeTrips(trips).km).toBe(150);
  });

  it('bezieht den Schnitt nur auf die bewertete Strecke', () => {
    const s = summarizeTrips(trips);
    expect(s.ratedKm).toBe(100);
    expect(s.kwhPer100km).toBeCloseTo(20, 1);
  });

  it('bleibt bei leerer Eingabe stumm statt zu rechnen', () => {
    const s = summarizeTrips([]);
    expect(s.trips).toBe(0);
    expect(s.kwhPer100km).toBeUndefined();
  });
});

describe('Reichweiten-Ehrlichkeit', () => {
  /** Fahrt über `km` mit `lost` km Verlust in der Restreichweitenanzeige. */
  const fahrt = (min: number, km: number, lost: number, von: number, range: number): ChargeLogSample[] => [
    at(min, { odometerKm: von, rangeKm: range }),
    at(min + 20, { odometerKm: von + km, rangeKm: range - lost }),
    at(min + 40, { odometerKm: von + km, rangeKm: range - lost }),
  ];

  it('meldet 1,0, wenn die Prognose zutrifft', () => {
    const s = summarizeTrips(buildTrips(fahrt(0, 120, 120, 1000, 400)));
    expect(s.rangeFactor).toBeCloseTo(1, 2);
  });

  it('meldet mehr als 1, wenn das Auto optimistisch war', () => {
    // 100 km gefahren, 130 km Anzeige verloren.
    const s = summarizeTrips(buildTrips(fahrt(0, 100, 130, 1000, 400)));
    expect(s.rangeFactor).toBeCloseTo(1.3, 2);
  });

  it('meldet weniger als 1, wenn man weiter kam als angezeigt', () => {
    const s = summarizeTrips(buildTrips(fahrt(0, 100, 90, 1000, 400)));
    expect(s.rangeFactor).toBeCloseTo(0.9, 2);
  });

  it('schweigt unter hundert Kilometern', () => {
    // Die Anzeige springt beim Heizen auch ohne Fahrt — über kurze Strecken
    // bestimmt dieser Sprung das Ergebnis.
    const s = summarizeTrips(buildTrips(fahrt(0, 40, 60, 1000, 400)));
    expect(s.rangeFactor).toBeUndefined();
    expect(s.rangeKm).toBe(40);
  });

  it('zählt nur Fahrten mit bekannter Reichweite in den Bezug', () => {
    const trips = buildTrips([
      ...fahrt(0, 80, 80, 1000, 400),
      at(100, { odometerKm: 1080 }),
      at(120, { odometerKm: 1140 }), // 60 km ohne rangeKm
      at(140, { odometerKm: 1140 }),
    ]);
    const s = summarizeTrips(trips);
    expect(s.km).toBe(140);
    expect(s.rangeKm).toBe(80);
    expect(s.rangeFactor).toBeUndefined();
  });
});

describe('Fahrt ohne Verbrauchsangabe am Endpunkt', () => {
  it('bürdet ihre Energie nicht der nächsten Fahrt auf', () => {
    // `tripKwh100` kommt aus TRIP_STATISTICS_CYCLIC, `odometerKm` aus
    // MILEAGE — getrennte Schlüssel, der eine kann ohne den anderen fehlen.
    // Trägt der letzte Messpunkt einer Fahrt keinen Verbrauch, blieb der
    // Zyklusstand bisher auf dem der VORVORIGEN Fahrt stehen, und die
    // folgende Fahrt bekam die Energie beider aufgebürdet (nachgestellt:
    // 58 statt 30 kWh/100 km).
    const iso = (h: number, m = 0): string =>
      new Date(Date.UTC(2026, 6, 28, h, m)).toISOString();
    const rows: ChargeLogSample[] = [
      { ts: iso(5), odometerKm: 1000, soc: 90, plugged: true, charging: true },
      { ts: iso(6), odometerKm: 1000, soc: 90, plugged: false },
      // Fahrt 1: 40 km bei 30 kWh/100 km
      { ts: iso(7), odometerKm: 1040, soc: 76, tripKwh100: 30 },
      { ts: iso(7, 30), odometerKm: 1040, soc: 76, tripKwh100: 30 },
      // Fahrt 2: 40 km. Ein Zwischenpunkt trägt den Zählerstand, die
      // Endpunkte nicht — der typische Fall, weil eine Fahrt mehrere Polls
      // hat und nur einzelne Antworten den Verbrauchsschlüssel verlieren.
      { ts: iso(8, 30), odometerKm: 1060, soc: 69, tripKwh100: 30 },
      { ts: iso(9), odometerKm: 1080, soc: 62 },
      { ts: iso(9, 30), odometerKm: 1080, soc: 62 },
      // Fahrt 3: 40 km, wieder mit Wert
      { ts: iso(11), odometerKm: 1120, soc: 48, tripKwh100: 30 },
      { ts: iso(11, 30), odometerKm: 1120, soc: 48, tripKwh100: 30 },
    ];
    const trips = buildTrips(rows);
    const letzte = trips[trips.length - 1];
    // 40 km bei 30 kWh/100 km = 12 kWh — nicht 24 (zwei Fahrten).
    expect(letzte.kwhPer100km).toBeLessThan(40);
    expect(letzte.energyKwh).toBeLessThan(20);
  });

  it('lässt die nächste Fahrt unbewertet, wenn der Zyklusstand ganz fehlt', () => {
    // Trägt KEIN Messpunkt einer Fahrt einen Verbrauchswert, ist der
    // Zählerstand verloren. Dann ist „keine Zahl" die einzige ehrliche
    // Ausgabe — eine berechnete enthielte fremde Energie.
    const iso = (h: number, m = 0): string =>
      new Date(Date.UTC(2026, 6, 28, h, m)).toISOString();
    const trips = buildTrips([
      { ts: iso(5), odometerKm: 1000, soc: 90, plugged: true, charging: true },
      { ts: iso(6), odometerKm: 1000, soc: 90, plugged: false },
      { ts: iso(7), odometerKm: 1040, soc: 76 },
      { ts: iso(7, 30), odometerKm: 1040, soc: 76 },
      { ts: iso(9), odometerKm: 1080, soc: 62, tripKwh100: 30 },
      { ts: iso(9, 30), odometerKm: 1080, soc: 62, tripKwh100: 30 },
    ]);
    expect(trips[trips.length - 1].energyKwh).toBeUndefined();
  });
});

describe('Lade-Messpunkt ohne Kilometerstand', () => {
  it('schneidet den Verbrauchszyklus trotzdem', () => {
    // Am Kabel ändert sich der Kilometerstand nicht — fehlt MILEAGE in der
    // Antwort, wurde der Lade-Messpunkt bisher ganz übersprungen und der
    // Zyklus-Anker blieb stehen. Die erste Fahrt danach bekam dadurch einen
    // viel zu niedrigen Verbrauch (3,3 statt 20 kWh/100 km).
    const iso = (h: number): string => new Date(Date.UTC(2026, 6, 28, h, 0)).toISOString();
    const trips = buildTrips([
      { ts: iso(5), odometerKm: 1000, soc: 90, plugged: true, charging: true },
      { ts: iso(6), odometerKm: 1000, soc: 90, plugged: false },
      { ts: iso(7), odometerKm: 1100, soc: 65, tripKwh100: 25 },
      { ts: iso(7.5), odometerKm: 1100, soc: 65, tripKwh100: 25 },
      // Zweite Ladung — Antwort ohne Kilometerstand
      { ts: iso(8), soc: 90, plugged: true, charging: true },
      { ts: iso(9), odometerKm: 1100, soc: 90, plugged: false },
      { ts: iso(10), odometerKm: 1130, soc: 82, tripKwh100: 20 },
      { ts: iso(10.5), odometerKm: 1130, soc: 82, tripKwh100: 20 },
    ]);
    const letzte = trips[trips.length - 1];
    expect(letzte.kwhPer100km).toBeCloseTo(20, 0);
  });
});

describe('Stiller Zählerrücksetzer', () => {
  it('bürdet der nächsten Fahrt nicht die Strecke der verworfenen auf', () => {
    // Fällt der Verbrauchszähler ohne erkennbaren Ladevorgang zurück, bleibt
    // die betroffene Fahrt zu Recht unbewertet. Der Zyklusanker wanderte
    // dabei aber auf den ANFANG dieser Fahrt: Die nächste rechnete ihre
    // Energie über eine Strecke, die die verworfene mit enthielt, und zog
    // nichts davon ab — 43 % zu hoher Verbrauch, den auch die
    // Fehlerschranke nicht abfing, weil sie vom selben Fehler mitwächst.
    const iso = (h: number, m = 0): string =>
      new Date(Date.UTC(2026, 6, 28, h, m)).toISOString();
    const trips = buildTrips([
      { ts: iso(5), odometerKm: 1000, soc: 90, plugged: true, charging: true },
      { ts: iso(6), odometerKm: 1000, soc: 90, plugged: false },
      // Fahrt 1: 60 km, Zähler steht auf 25 kWh/100 km
      { ts: iso(7), odometerKm: 1060, soc: 72, tripKwh100: 25 },
      { ts: iso(7, 30), odometerKm: 1060, soc: 72, tripKwh100: 25 },
      // Fahrt 2: 40 km — der Zähler ist still zurückgefallen
      { ts: iso(9), odometerKm: 1100, soc: 64, tripKwh100: 5 },
      { ts: iso(9, 30), odometerKm: 1100, soc: 64, tripKwh100: 5 },
      // Fahrt 3: 40 km bei 20 kWh/100 km seit dem Rücksetzer
      { ts: iso(11), odometerKm: 1140, soc: 56, tripKwh100: 20 },
      { ts: iso(11, 30), odometerKm: 1140, soc: 56, tripKwh100: 20 },
    ]);
    const letzte = trips[trips.length - 1];
    // 40 km à 20 kWh/100 km = 8 kWh. Mit der Strecke der verworfenen Fahrt
    // wären es 16 kWh auf 40 km, also 40 kWh/100 km.
    expect(letzte.kwhPer100km).toBeLessThan(30);
  });
});
