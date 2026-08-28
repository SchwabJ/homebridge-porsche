import { stateOfHealth, healthSpread } from '../src/capacity';

/**
 * Die Batteriegesundheit in Prozent — eine Zahl, drei Orte, drei Formen.
 *
 * ## Der Anlass
 *
 * Die Prozentangabe der Batteriegesundheit war in der Anzeige nicht mehr
 * auffindbar — sichtbar blieben allein die Kilowattstunden.
 *
 * ## Was tatsächlich der Fall war
 *
 * Die Prozentzahl war nie weg, sie stand nur verteilt und uneinheitlich:
 *
 *   - Kachel-Überschrift: unterdrückt ab weniger als zehn Zyklen
 *   - Kachel-Balken: `width: soh ?? 0` — also **0 %**, was sich wie eine
 *     Gesundheit von null liest statt wie „unbekannt"
 *   - Kachel-Fußzeile: „Messung −4,4 %" — dieselbe Aussage wie „95,6 %",
 *     nur als Abweichung getarnt, und ohne jede Schwelle
 *   - /batterie: „95,6 % der eingestellten 83,7 kWh", ebenfalls ohne Schwelle
 *
 * ## Die Regel
 *
 * Die Zahl wird gezeigt — aber nur zusammen mit ihrer Spanne. Direkt daneben
 * steht ohnehin „± 2,0 kWh"; dieselbe Messung in Prozent ohne Spanne
 * auszuweisen behauptet eine Auflösung, die sie nicht hat.
 *
 * Sie zu verschweigen war die schlechtere Antwort: Wer die Gesundheit sehen
 * will, fand sonst einen leeren Balken und eine als Abweichung verkleidete
 * Zwillingszahl.
 */
describe('healthSpread — die Prozentzahl trägt ihre Unsicherheit mit', () => {
  it('rechnet die Unsicherheit in Prozentpunkte um', () => {
    // Ein Beispielstand: 80,0 kWh ± 2,0 bei 83,7 kWh Werksangabe.
    // 2,0 / 83,7 sind 2,39 Prozentpunkte — die Gesundheit ist damit
    // 95,6 % ± 2,4, also irgendwo zwischen 93,2 und 98,0 %.
    expect(healthSpread(2.0, 83.7)).toBeCloseTo(2.4, 1);
  });

  it('schweigt ohne ausgewiesene Unsicherheit', () => {
    // Keine erfundene Spanne, wo die Messung keine nennt.
    expect(healthSpread(undefined, 83.7)).toBeUndefined();
  });

  it('schweigt ohne Bezugsgröße', () => {
    expect(healthSpread(2.0, undefined)).toBeUndefined();
    expect(healthSpread(2.0, 0)).toBeUndefined();
  });

  it('bleibt bei sinkender Unsicherheit konsistent zur kWh-Angabe', () => {
    // Halbiert sich die Unsicherheit in kWh, halbiert sie sich auch in
    // Prozentpunkten. Darum geht es, wenn eine unmögliche Einzelmessung aus
    // der Reihe fällt: Der Fehlerbalken schrumpft in beiden Einheiten
    // gleichzeitig.
    expect(healthSpread(4.0, 83.7)).toBeCloseTo(4.8, 1);
    expect(healthSpread(2.0, 83.7)).toBeCloseTo(2.4, 1);
  });
});

describe('stateOfHealth — unverändert', () => {
  it('rechnet die Gesundheit als Anteil der Werksangabe', () => {
    expect(stateOfHealth(80.0, 83.7)).toBeCloseTo(95.6, 1);
  });

  it('schweigt ohne Messung', () => {
    expect(stateOfHealth(undefined, 83.7)).toBeUndefined();
  });
});
