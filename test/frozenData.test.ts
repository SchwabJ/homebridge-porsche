import { capacityFromCharging } from '../src/chargeCapacity';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Eingefrorene Backend-Daten dürfen keine Energie erzeugen.
 *
 * ## Der Fehlerfall
 *
 * Die Schnittstelle kann über Stunden unverändert denselben Ladestand,
 * dieselbe Reichweite und dieselbe Leistung melden — bei durchgehend
 * `charging: true` und einem `dataTs`, der jede Minute weiterläuft. Das
 * Plugin pollt dabei sauber; das Backend liefert eine zwischengespeicherte
 * Momentaufnahme mit frischem Zeitstempel. Endet der Stillstand, springen
 * alle drei Werte gleichzeitig auf den tatsächlichen Stand.
 *
 * Die Integration der Ladeleistung bucht daraus Energie, die nie geflossen
 * ist. Solche Blöcke treten regelmäßig auf; ohne Erkennung verfälschen sie
 * jede Kapazitätsschätzung.
 *
 * ## Woran es erkennbar ist
 *
 * Nicht am Ladestand allein — der steht bei feinem Takt oft still, weil er
 * ganzzahlig kommt. Erkennbar ist es daran, dass ALLE DREI Größen zugleich
 * unverändert bleiben: Ladestand, Reichweite und Leistung. Die Leistung
 * schwankt bei echtem Laden immer ein wenig — um einige Zehntel Kilowatt —,
 * und die Reichweite folgt dem Ladestand mit feinerer Auflösung.
 *
 * Bleiben alle drei über längere Zeit auf derselben Zahl, ist die Antwort
 * zwischengespeichert — und was in dieser Zeit wirklich geschah, weiß niemand.
 */
const p = (
  min: number,
  soc: number,
  range: number,
  kw: number,
): ChargeLogSample => ({
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + min * 60000).toISOString(),
  soc,
  rangeKm: range,
  powerKw: kw,
  charging: true,
  plugged: true,
});

describe('Eingefrorene Backend-Daten', () => {
  it('bucht keine Energie über einen eingefrorenen Block', () => {
    // Der Ablauf im Muster: echte Ladung, dann zwei Stunden Stillstand aller
    // Werte, dann ein Sprung. Ohne Erkennung ergäbe das eine Kapazität aus
    // erfundenen Kilowattstunden.
    const verlauf: ChargeLogSample[] = [];
    for (let i = 0; i <= 20; i++) verlauf.push(p(i * 3, 50 + Math.round(i * 0.7), 200 + i * 3, 10.1));
    // Ab hier eingefroren: alle drei Werte konstant, zwei Stunden lang.
    for (let i = 1; i <= 40; i++) verlauf.push(p(60 + i * 3, 64, 260, 10.0));
    // Der Sprung.
    verlauf.push(p(185, 99, 420, 10.2));
    verlauf.push({ ts: p(200, 99, 420, 0).ts, soc: 99, charging: false, plugged: false });

    const est = capacityFromCharging(verlauf, { ratedKwh: 83.7 });
    // Ohne Erkennung: rund 3,4 h × 10,1 kW = 34 kWh auf 49 Punkte = 70 kWh —
    // eine plausibel AUSSEHENDE Zahl aus erfundener Energie. Mit Erkennung
    // bleibt der Block draußen.
    for (const pt of est.points) {
      // Keine verwertete Messung darf den eingefrorenen Bereich enthalten.
      // Der volle Hub des Musters (50 → 99) ist nur zu erreichen, indem man
      // ihn überspannt — die Schwelle trennt genau das ab.
      expect(pt.toSoc - pt.fromSoc).toBeLessThan(40);
    }
  });

  it('lässt eine echte Ladung unangetastet', () => {
    // Gegenprobe: Bei echtem Laden schwankt die Leistung, und die Reichweite
    // folgt dem Ladestand. Nichts davon darf als eingefroren gelten.
    const echt: ChargeLogSample[] = [];
    for (let i = 0; i <= 40; i++) {
      echt.push(p(i * 3, 30 + Math.round(i * 0.6), 150 + i * 3, 10.0 + (i % 3) * 0.05));
    }
    echt.push({ ts: p(130, 54, 270, 0).ts, soc: 54, charging: false, plugged: false });
    const est = capacityFromCharging(echt, { ratedKwh: 83.7 });
    expect(est.samples).toBe(1);
    expect(est.capacityKwh).toBeGreaterThan(40);
  });

  it('erkennt einen kurzen Stillstand NICHT als eingefroren', () => {
    // Bei dreiminütigem Takt steht der ganzzahlige Ladestand regelmäßig ein
    // paar Punkte lang still. Das ist normal und darf nichts auslösen.
    const normal: ChargeLogSample[] = [];
    for (let i = 0; i <= 40; i++) {
      // Ladestand steigt schubweise (ganzzahlig), Leistung schwankt leicht.
      // Der Hub ist so gewählt, dass rund 83 kWh herauskommen — sonst schlüge
      // der Plausibilitätsfilter zu und der Test prüfte etwas anderes.
      normal.push(p(i * 3, 30 + Math.floor(i * 0.6), 150 + i * 2, 10.0 + (i % 2) * 0.1));
    }
    normal.push({ ts: p(130, 54, 230, 0).ts, soc: 54, charging: false, plugged: false });
    const est = capacityFromCharging(normal, { ratedKwh: 83.7 });
    expect(est.samples).toBe(1);
  });
});
