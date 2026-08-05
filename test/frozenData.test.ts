import { capacityFromCharging } from '../src/chargeCapacity';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Eingefrorene Backend-Daten dürfen keine Energie erzeugen.
 *
 * ## Der reale Fall
 *
 * In der Nacht zum 4. August meldete die Schnittstelle über fünf Stunden
 * unverändert `soc: 65`, `rangeKm: 279` und `powerKw: 10.12` — bei
 * durchgehend `charging: true` und einem `dataTs`, der jede Minute weiterlief.
 * Das Plugin hat sauber gepollt; das Backend lieferte eine zwischen-
 * gespeicherte Momentaufnahme mit frischem Zeitstempel. Um 07:30 sprang alles
 * gleichzeitig: Ladestand 65 → 99, Reichweite 279 → 426.
 *
 * Die Integration der Ladeleistung buchte daraus rund 50 kWh, die nie
 * geflossen sind. Über den ganzen Mitschrieb liegen 380 von 955 Ladepunkten
 * in solchen Blöcken.
 *
 * ## Woran es erkennbar ist
 *
 * Nicht am Ladestand allein — der steht bei feinem Takt oft still, weil er
 * ganzzahlig kommt. Erkennbar ist es daran, dass ALLE DREI Größen zugleich
 * unverändert bleiben: Ladestand, Reichweite und Leistung. Die Leistung
 * schwankt bei echtem Laden immer ein wenig (gemessen: 9,96 bis 10,23 kW),
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
  ts: new Date(Date.UTC(2026, 7, 4, 0, 0, 0) + min * 60000).toISOString(),
  soc,
  rangeKm: range,
  powerKw: kw,
  charging: true,
  plugged: true,
});

describe('Eingefrorene Backend-Daten', () => {
  it('bucht keine Energie über einen eingefrorenen Block', () => {
    // Der reale Verlauf: echte Ladung, dann fünf Stunden Stillstand aller
    // Werte, dann ein Sprung. Ohne Erkennung ergäbe das eine Kapazität aus
    // 50 erfundenen Kilowattstunden.
    const verlauf: ChargeLogSample[] = [];
    for (let i = 0; i <= 20; i++) verlauf.push(p(i * 3, 50 + Math.round(i * 0.7), 200 + i * 3, 10.1));
    // Ab hier eingefroren: alle drei Werte konstant, zwei Stunden lang.
    for (let i = 1; i <= 40; i++) verlauf.push(p(60 + i * 3, 64, 260, 10.12));
    // Der Sprung.
    verlauf.push(p(185, 99, 420, 10.15));
    verlauf.push({ ts: p(200, 99, 420, 0).ts, soc: 99, charging: false, plugged: false });

    const est = capacityFromCharging(verlauf, { ratedKwh: 83.7 });
    // Ohne Erkennung: rund 3,4 h × 10,1 kW = 34 kWh auf 49 Punkte = 70 kWh —
    // eine plausibel AUSSEHENDE Zahl aus erfundener Energie. Mit Erkennung
    // bleibt der Block draußen.
    for (const pt of est.points) {
      // Keine verwertete Messung darf den eingefrorenen Bereich enthalten.
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
