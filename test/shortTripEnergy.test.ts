import { buildTrips } from '../src/trips';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Kurze Fahrten zeigen ihren Verbrauch als UNGEFÄHR, statt zu schweigen.
 *
 * ## Der gemeldete Fall
 *
 *     Di., 04.08., 23:30    1 km    78 → 78 %    —
 *     Di., 04.08., 21:01    2 km    79 → 79 %    —
 *
 * „Das sind leere Fahrten, ich bin hier tatsächlich gefahren."
 *
 * Beide Spalten sind aus demselben Grund leer: Zwei Kilometer sind bei 20
 * kWh/100 km rund 0,4 kWh, also 0,5 Prozentpunkte. Der Ladestand kommt
 * ganzzahlig und bleibt deshalb stehen.
 *
 * Der Verbrauch dagegen IST rechenbar — er kommt aus dem Zyklus-Zähler des
 * Fahrzeugs, nicht aus dem Ladestand. Verworfen wurde er allein von der
 * Fehlerschranke: 0,41 ± 0,09 kWh sind 22 % relativer Fehler, erlaubt waren
 * 15 %.
 *
 * ## Die Regel
 *
 * Bis zur bisherigen Schranke steht die Zahl wie gehabt. Darüber steht sie
 * weiterhin, aber als ungefähr gekennzeichnet — bis zu einer zweiten,
 * weiteren Grenze, ab der auch das nicht mehr trägt.
 *
 * Eine Zahl mit 22 % Unsicherheit ist keine gute Zahl, aber sie ist eine
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
  ts: new Date(Date.UTC(2026, 7, 4, 18, 0, 0) + min * 60000).toISOString(),
  odometerKm: odo,
  soc,
  plugged: false,
  ...(kwh100 !== undefined ? { tripKwh100: kwh100 } : {}),
});

/** Der gemeldete Verlauf: Ladung, lange Fahrt, dann zwei kurze. */
const verlauf: ChargeLogSample[] = [
  { ts: new Date(Date.UTC(2026, 7, 4, 17, 0, 0)).toISOString(),
    odometerKm: 53000, soc: 99, plugged: true, charging: true },
  p(10, 53000, 99, 20.3),
  p(60, 53093, 79, 20.3),   // 93 km — die lange Fahrt, klar bewertbar
  p(75, 53093, 79, 20.3),   // Stillstand: beendet die lange Fahrt
  p(120, 53095, 79, 20.3),  // 2 km — der gemeldete Fall
  p(200, 53095, 78, 20.3),  // Stillstand: beendet die 2-km-Fahrt
  p(260, 53096, 78, 20.4),  // 1 km — der zweite gemeldete Fall
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
    // 2 km bei 20,3 kWh/100 km sind 0,41 kWh.
    expect(kurz?.energyKwh).toBeCloseTo(0.41, 1);
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
      { ts: new Date(Date.UTC(2026, 7, 4, 17, 0, 0)).toISOString(),
        odometerKm: 53000, soc: 99, plugged: true, charging: true },
      p(10, 53000, 99),
      p(60, 53002, 99),
    ];
    const t = buildTrips(ohne, {});
    expect(t[0]?.energyKwh).toBeUndefined();
  });
});
