import { buildTrips } from '../src/trips';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Kurze Fahrten zeigen ihren Verbrauch als UNGEFÄHR, statt zu schweigen.
 *
 * ## Der gemeldete Fall
 *
 *     23:30    1 km    60 → 60 %    —
 *     21:00    2 km    60 → 60 %    —
 *
 * Es waren wirklich gefahrene Strecken — die Liste zeigte nur nichts an.
 *
 * Beide Spalten sind aus demselben Grund leer: Zwei Kilometer sind bei 20
 * kWh/100 km rund 0,4 kWh, also 0,5 Prozentpunkte. Der Ladestand kommt
 * ganzzahlig und bleibt deshalb stehen.
 *
 * Der Verbrauch dagegen IST rechenbar — er kommt aus dem Zyklus-Zähler des
 * Fahrzeugs, nicht aus dem Ladestand. Verworfen wurde er allein von der
 * Fehlerschranke: 0,40 ± 0,10 kWh sind 25 % relativer Fehler, erlaubt waren
 * 15 %.
 *
 * ## Die Regel
 *
 * Bis zur bisherigen Schranke steht die Zahl wie gehabt. Darüber steht sie
 * weiterhin, aber als ungefähr gekennzeichnet — bis zu einer zweiten,
 * weiteren Grenze, ab der auch das nicht mehr trägt.
 *
 * Eine Zahl mit 25 % Unsicherheit ist keine gute Zahl, aber sie ist eine
 * Aussage: „ungefähr 20 kWh/100 km" trifft zu, „—" behauptet, man wisse
 * nichts. Auf einer Fahrt von zwei Kilometern ist das der Unterschied
 * zwischen einer groben und gar keiner Auskunft.
 */
const p = (
  min: number,
  odo: number,
  soc: number,
  kwh100?: number,
): ChargeLogSample => ({
  // Frei gewähltes Basisdatum: Es zählen allein die Abstände.
  ts: new Date(Date.UTC(2020, 0, 1, 18, 0, 0) + min * 60000).toISOString(),
  odometerKm: odo,
  soc,
  plugged: false,
  ...(kwh100 !== undefined ? { tripKwh100: kwh100 } : {}),
});

/** Der gemeldete Verlauf: Ladung, lange Fahrt, dann zwei kurze. */
const verlauf: ChargeLogSample[] = [
  { ts: new Date(Date.UTC(2020, 0, 1, 17, 0, 0)).toISOString(),
    odometerKm: 50000, soc: 80, plugged: true, charging: true },
  p(10, 50000, 80, 20.0),
  p(60, 50100, 60, 20.0),   // 100 km — die lange Fahrt, klar bewertbar
  p(75, 50100, 60, 20.0),   // Stillstand: beendet die lange Fahrt
  p(120, 50102, 60, 20.0),  // 2 km — der gemeldete Fall
  p(200, 50102, 59, 20.0),  // Stillstand: beendet die 2-km-Fahrt
  p(260, 50103, 59, 20.1),  // 1 km — der zweite gemeldete Fall
];

describe('Verbrauch kurzer Fahrten', () => {
  it('bewertet die lange Fahrt weiterhin genau', () => {
    const t = buildTrips(verlauf, {});
    const lang = t.find((x) => x.km > 50);
    expect(lang?.energyKwh).toBeDefined();
    expect(lang?.approximate).toBeFalsy();
  });

  it('nennt für die 2-km-Fahrt einen ungefähren Verbrauch', () => {
    const t = buildTrips(verlauf, {});
    const kurz = t.find((x) => x.km === 2);
    expect(kurz).toBeDefined();
    // 2 km bei 20,0 kWh/100 km sind 0,40 kWh.
    expect(kurz?.energyKwh).toBeCloseTo(0.4, 2);
    expect(kurz?.approximate).toBe(true);
  });

  it('kennzeichnet den Wert als ungefähr, statt Genauigkeit zu behaupten', () => {
    const t = buildTrips(verlauf, {});
    for (const x of t) {
      if (x.approximate) {
        expect(x.energyKwh).toBeDefined();
      }
    }
    // Mindestens eine Fahrt muss gekennzeichnet sein, sonst prüft der Test nichts.
    expect(t.some((x) => x.approximate)).toBe(true);
  });

  it('schweigt weiterhin, wo auch eine grobe Angabe nicht trägt', () => {
    // Ohne Verbrauchszähler des Fahrzeugs gibt es gar nichts zu rechnen.
    const ohne: ChargeLogSample[] = [
      { ts: new Date(Date.UTC(2020, 0, 1, 17, 0, 0)).toISOString(),
        odometerKm: 50000, soc: 80, plugged: true, charging: true },
      p(10, 50000, 80),
      p(60, 50002, 80),
    ];
    const t = buildTrips(ohne, {});
    expect(t[0]?.energyKwh).toBeUndefined();
  });
});
