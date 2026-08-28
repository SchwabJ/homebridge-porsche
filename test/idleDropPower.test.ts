import { estimateCapacity } from '../src/capacity';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Der Standabzug darf nicht mehr Energie verbuchen, als ein stehendes Auto
 * überhaupt ziehen kann.
 *
 * ## Der Fehler, den das verhindert
 *
 * Die Standerkennung fragt allein den Kilometerstand: Bleibt er gleich und
 * fällt der Ladestand, gilt das als Stillstand, und die Energie wird aus dem
 * Nenner genommen. Das Porsche-Backend frischt den Kilometerstand aber **erst
 * zum Fahrtende** auf, während der Ladestand laufend aktualisiert wird — ein
 * **Großteil der fahrtüberlappenden Messabstände** zeigt deshalb einen
 * unveränderten Kilometerstand.
 *
 * Fahrenergie wandert dadurch in den Standabzug — und weil der Abzug den
 * Nenner verkleinert, wird die Kapazität zu GROSS geschätzt. So entstand eine
 * Einzelmessung deutlich ÜBER der Werksangabe von 83,7 kWh, was physikalisch
 * unmöglich ist.
 *
 * ## Warum die Leistung das richtige Maß ist
 *
 * Fahrt und Stand sicher zu unterscheiden ist mit den vorliegenden Feldern
 * nicht möglich: Die Restreichweite fällt im Stand ebenso wie in der Fahrt,
 * und ihre Wertebereiche überlappen sich — es gibt keine Schwelle, die beides
 * trennt. `tripEnd`/`tripMin` wiederum kommen nur auf einem kleinen Teil der
 * Messpunkte an und taugen deshalb ebenso wenig zur Unterscheidung.
 *
 * Die Frage muss deshalb anders lauten: Nicht „steht das Auto?", sondern
 * „kann ein stehendes Auto so viel ziehen?". Ein Taycan mit voller
 * Vorklimatisierung erreicht rund 7 kW; der Ruheverbrauch liegt bei
 * Bruchteilen davon. Was darüber liegt, ist keine Standzeit, sondern eine
 * verspätete Kilometerstandsmeldung.
 *
 * Genau so trennen sich die Fälle: Die plausiblen Standsegmente bleiben
 * deutlich unter dieser Grenze, die unmöglichen liegen ebenso deutlich
 * darüber, und dazwischen liegt nichts, worüber zu streiten wäre. Genau die
 * Segmente oberhalb der Grenze sind es, die die Fehlmessung verursachten.
 */

/** Ein Messpunkt zur angegebenen Minute nach Beginn. */
const p = (
  min: number,
  soc: number,
  odo: number,
  over: Partial<ChargeLogSample> = {},
): ChargeLogSample => ({
  ts: new Date(Date.UTC(2026, 7, 1, 6, 0, 0) + min * 60000).toISOString(),
  soc,
  odometerKm: odo,
  plugged: false,
  ...over,
});

/**
 * Ein Zyklus mit einer Ladung am Anfang, einer Fahrt und einem Standsegment
 * von wählbarer Höhe.
 *
 * Die Zahlen sind so gewählt, dass die Rechnung glatt aufgeht: 100 km bei
 * 20 kWh/100 km sind 20 kWh. Fällt der Ladestand fahrend um 25 Punkte,
 * ergibt das 80 kWh Kapazität.
 */
const zyklus = (standAbfall: number, standMinuten: number): ChargeLogSample[] => [
  // Ladung setzt den Zyklusanfang.
  p(0, 60, 1000, { plugged: true, charging: true }),
  p(10, 90, 1000, { plugged: true, charging: true }),
  // Fahrt: 100 km, 25 Punkte.
  p(60, 90, 1000, { tripKwh100: 20 }),
  p(120, 65, 1100, { tripKwh100: 20 }),
  // Standsegment: Kilometerstand unverändert, Ladestand fällt.
  p(120 + standMinuten, 65 - standAbfall, 1100, { tripKwh100: 20 }),
  // Nächste Ladung beendet den Zyklus.
  p(400, 65 - standAbfall, 1100, { plugged: true, charging: true }),
];

describe('Standabzug mit physikalischer Leistungsgrenze', () => {
  const TAYCAN = { ratedKwh: 83.7 };

  it('zieht einen plausiblen Standverbrauch weiterhin ab', () => {
    // Ein Prozentpunkt über zwanzig Minuten sind bei 83,7 kWh rund 2,5 kW —
    // Standklima, und gehört nicht in die Fahrrechnung.
    const est = estimateCapacity(zyklus(1, 20), TAYCAN);
    expect(est.samples).toBe(1);
    // Ladestand fällt 90 -> 64, davon 1 Punkt Stand: 20 kWh / 0,25 = 80,0.
    expect(est.capacityKwh).toBeCloseTo(80, 0);
  });

  it('zieht einen unmöglich hohen Abfall NICHT ab', () => {
    // Fünf Punkte in zwanzig Minuten sind bei 83,7 kWh rund 12,5 kW. Kein
    // stehendes Auto zieht das — der Kilometerstand kam bloß verspätet.
    // Solche Segmente verzerrten den Median.
    const est = estimateCapacity(zyklus(5, 20), TAYCAN);
    expect(est.samples).toBe(1);
    // Ohne Abzug: 20 kWh / 0,30 = 66,7. Mit falschem Abzug wären es 80,0.
    expect(est.capacityKwh).toBeCloseTo(66.7, 0);
  });

  it('erkennt denselben Abfall über eine lange Zeit als Stand an', () => {
    // Fünf Punkte über hundert Minuten sind wieder rund 2,5 kW — plausibel.
    // Die Grenze ist die LEISTUNG, nicht die Höhe des Abfalls.
    const est = estimateCapacity(zyklus(5, 100), TAYCAN);
    expect(est.samples).toBe(1);
    expect(est.capacityKwh).toBeCloseTo(80, 0);
  });

  it('zählt eine stundenlange Messlücke nicht als beobachtete Standzeit', () => {
    // IDLE_MAX_GAP_MIN war dokumentiert, aber nirgends angewandt. Was in
    // einer Lücke von Stunden geschah, weiß niemand — sie als Standzeit zu
    // verbuchen verdünnte den Abzug beliebig.
    const est = estimateCapacity(zyklus(5, 300), TAYCAN);
    expect(est.samples).toBe(1);
    expect(est.capacityKwh).toBeCloseTo(66.7, 0);
  });
});

describe('Plausibilitätsfilter kennt die Werksangabe', () => {
  it('verwirft eine Messung oberhalb der Werkskapazität', () => {
    // Eine gealterte Batterie wird nicht größer als neu. Bisher galt eine
    // feste Obergrenze von 120 kWh — 143 % der Taycan-Werksangabe —, und
    // die ließ die zu hohe Messung durch, die den Median verzerrt hat.
    const hoch: ChargeLogSample[] = [
      p(0, 60, 1000, { plugged: true, charging: true }),
      p(10, 99, 1000, { plugged: true, charging: true }),
      // 100 km bei 20 kWh/100 km = 20 kWh, aber nur 18 Punkte Abfall
      // -> 111 kWh. Über der Werksangabe, also ein Datenfehler.
      p(60, 99, 1000, { tripKwh100: 20 }),
      p(120, 81, 1100, { tripKwh100: 20 }),
      p(400, 81, 1100, { plugged: true, charging: true }),
    ];
    expect(estimateCapacity(hoch, { ratedKwh: 83.7 }).samples).toBe(0);
  });

  it('behält sie ohne bekannte Werksangabe — mit der alten weiten Grenze', () => {
    // Fehlt die Werksangabe (fremdes Modell), bleibt nur der absolute
    // Rahmen. Lieber eine fragwürdige Messung als gar keine Messung.
    const hoch: ChargeLogSample[] = [
      p(0, 60, 1000, { plugged: true, charging: true }),
      p(10, 99, 1000, { plugged: true, charging: true }),
      p(60, 99, 1000, { tripKwh100: 20 }),
      p(120, 81, 1100, { tripKwh100: 20 }),
      p(400, 81, 1100, { plugged: true, charging: true }),
    ];
    expect(estimateCapacity(hoch).samples).toBe(1);
  });
});
