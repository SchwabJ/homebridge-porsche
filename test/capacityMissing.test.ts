import { aggregate } from '../src/aggregate';
import { idleStats } from '../src/idle';
import type { IdleAnalysis } from '../src/idle';
import { LABELS_DE } from '../src/i18n';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Was passiert, wenn die Batteriekapazität unbekannt ist.
 *
 * ## Warum das kein Randfall ist
 *
 * Die Vorgabe von 83,7 kWh ist ein **Taycan**-Wert. Bei einem Cayenne PHEV mit
 * 21,8 kWh liegt sie um den Faktor 3,8 daneben — und dieser Faktor landet
 * ungebremst im Preis: Ein Zuwachs von zehn Prozentpunkten wird zu 8,4 statt
 * 2,2 kWh, und die Kosten wachsen mit.
 *
 * Erkannt wurde das schon (`capacityTrust.ts`), aber die Prüfung erzeugte nur
 * einen Warntext — die Aggregation rechnete mit jeder Zahl, die man ihr
 * reichte. Eine Warnung, unter der die falsche Zahl weiter steht, ist keine
 * Prüfung.
 *
 * ## Die Regel
 *
 * Ohne Kapazität entsteht keine Energie- und keine Kostenzahl. Nicht null —
 * null behauptet „nichts geladen". Der Ladestand-Zuwachs ist ja gemessen, nur
 * seine Umrechnung in Kilowattstunden fehlt. Er wird deshalb in
 * Prozentpunkten ausgewiesen, so wie die Fahrten ihre Strecke ohne
 * Verbrauchsangabe ausweisen (`unratedKm`).
 */
const local = (
  d: number,
  h: number,
  over: Partial<ChargeLogSample> = {},
): ChargeLogSample => ({ ts: new Date(2026, 7, d, h, 0).toISOString(), ...over });

/** Eine Ladung von 40 auf 60 Prozent — zwanzig Prozentpunkte. */
const LADUNG: ChargeLogSample[] = [
  local(1, 20, { soc: 40, plugged: true, charging: true, odometerKm: 1000 }),
  local(1, 21, { soc: 50, plugged: true, charging: true, odometerKm: 1000 }),
  local(1, 22, { soc: 60, plugged: true, charging: true, odometerKm: 1000 }),
];

describe('Aggregation ohne bekannte Batteriekapazität', () => {
  it('rechnet mit Kapazität wie bisher', () => {
    // Die Gegenprobe: Mit Kapazität muss alles beim Alten bleiben.
    const [b] = aggregate(LADUNG, 'day', {
      capacityKwh: 100,
      pricePerKwh: 0.3,
      labels: LABELS_DE,
    });
    expect(b.kwh).toBeCloseTo(20, 5);
    expect(b.cost).toBeCloseTo(6, 5);
    expect(b.unratedSocGain).toBe(0);
  });

  it('erzeugt ohne Kapazität weder Energie noch Kosten', () => {
    const [b] = aggregate(LADUNG, 'day', { pricePerKwh: 0.3, labels: LABELS_DE });
    expect(b.kwh).toBe(0);
    expect(b.cost).toBe(0);
    expect(b.costGross).toBe(0);
  });

  it('weist den ungerechneten Ladestand-Zuwachs aus', () => {
    // Die Messung ist da — nur ihre Umrechnung fehlt. Sie zu verschweigen
    // hieße, eine Ladung ganz zu unterschlagen.
    const [b] = aggregate(LADUNG, 'day', { pricePerKwh: 0.3, labels: LABELS_DE });
    expect(b.unratedSocGain).toBe(20);
  });

  it('behauptet keine Ersparnis, wo nichts gerechnet wurde', () => {
    const [b] = aggregate(LADUNG, 'day', {
      pricePerKwh: 0.2,
      grossPricePerKwh: 0.35,
      labels: LABELS_DE,
    });
    expect(b.saved).toBe(0);
  });

  it('lässt gefahrene Kilometer unberührt', () => {
    // Die Strecke kommt aus dem Kilometerstand, nicht aus der Batterie.
    const fahrt: ChargeLogSample[] = [
      local(2, 8, { soc: 60, plugged: false, odometerKm: 1000 }),
      local(2, 9, { soc: 50, plugged: false, odometerKm: 1050 }),
    ];
    const [b] = aggregate(fahrt, 'day', { labels: LABELS_DE });
    expect(b.km).toBe(50);
  });
});

describe('Ruheverlust ohne bekannte Batteriekapazität', () => {
  const analyse: IdleAnalysis = {
    idleMinutes: 6 * 1440,
    idleSocDrop: 12,
    climateMinutes: 0,
    climateSocDrop: 0,
    phases: [],
  };

  it('rechnet mit Kapazität', () => {
    expect(idleStats(analyse, 80)?.kwhPerDay).toBeCloseTo(1.6, 1);
  });

  it('schweigt ohne Kapazität', () => {
    // Die Warnschwelle steht in Kilowattstunden je Tag — zwei Prozentpunkte
    // sind beim Taycan 1,67 kWh und beim Cayenne 0,44. Ohne Kapazität ist der
    // Verlust in Prozentpunkten zwar messbar, aber nicht bewertbar.
    expect(idleStats(analyse, undefined)).toBeUndefined();
  });
});
