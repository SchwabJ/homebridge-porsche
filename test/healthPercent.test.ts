import { stateOfHealth, healthSpread } from '../src/capacity';

/**
 * Die Batteriegesundheit in Prozent — eine Zahl, drei Orte, drei Formen.
 *
 * ## Was der Eigentümer meldete
 *
 * „Die Batteriegesundheit zeigt nur noch kWh, aber keine % mehr an."
 *
 * ## Was tatsächlich der Fall war
 *
 * Die Prozentzahl war nie weg, sie stand nur verteilt und uneinheitlich:
 *
 *   - Kachel-Überschrift: unterdrückt ab weniger als zehn Zyklen
 *   - Kachel-Balken: `width: soh ?? 0` — also **0 %**, was sich wie eine
 *     Gesundheit von null liest statt wie „unbekannt"
 *   - Kachel-Fußzeile: „Messung −12,1 %" — dieselbe Aussage wie „87,9 %",
 *     nur als Abweichung getarnt, und ohne jede Schwelle
 *   - /batterie: „87,9 % der eingestellten 83,7 kWh", ebenfalls ohne Schwelle
 *
 * ## Die Regel
 *
 * Die Zahl wird gezeigt — aber nur zusammen mit ihrer Spanne. Direkt daneben
 * steht ohnehin „± 2,2 kWh"; dieselbe Messung in Prozent ohne Spanne
 * auszuweisen behauptet eine Auflösung, die sie nicht hat.
 *
 * Sie zu verschweigen war die schlechtere Antwort: Wer die Gesundheit sehen
 * will, fand sonst einen leeren Balken und eine als Abweichung verkleidete
 * Zwillingszahl.
 */
describe('healthSpread — die Prozentzahl trägt ihre Unsicherheit mit', () => {
  it('rechnet die Unsicherheit in Prozentpunkte um', () => {
    // Der Stand am eigenen Fahrzeug: 73,6 kWh ± 2,2 bei 83,7 kWh Werksangabe.
    // 2,2 / 83,7 sind 2,63 Prozentpunkte — die Gesundheit ist damit
    // 87,9 % ± 2,6, also irgendwo zwischen 85,3 und 90,5 %.
    expect(healthSpread(2.2, 83.7)).toBeCloseTo(2.6, 1);
  });

  it('schweigt ohne ausgewiesene Unsicherheit', () => {
    // Keine erfundene Spanne, wo die Messung keine nennt.
    expect(healthSpread(undefined, 83.7)).toBeUndefined();
  });

  it('schweigt ohne Bezugsgröße', () => {
    expect(healthSpread(2.2, undefined)).toBeUndefined();
    expect(healthSpread(2.2, 0)).toBeUndefined();
  });

  it('bleibt bei sinkender Unsicherheit konsistent zur kWh-Angabe', () => {
    // Halbiert sich die Unsicherheit in kWh, halbiert sie sich auch in
    // Prozentpunkten. Genau das ist am Fahrzeug passiert, als die
    // unmögliche Einzelmessung herausfiel: ± 4,8 wurde zu ± 2,2.
    expect(healthSpread(4.8, 83.7)).toBeCloseTo(5.7, 1);
    expect(healthSpread(2.4, 83.7)).toBeCloseTo(2.9, 1);
  });
});

describe('stateOfHealth — unverändert', () => {
  it('rechnet die Gesundheit als Anteil der Werksangabe', () => {
    expect(stateOfHealth(73.6, 83.7)).toBeCloseTo(87.9, 1);
  });

  it('schweigt ohne Messung', () => {
    expect(stateOfHealth(undefined, 83.7)).toBeUndefined();
  });
});
