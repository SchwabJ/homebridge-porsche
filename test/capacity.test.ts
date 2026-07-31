import { capacityTrend, estimateCapacity, resolveCapacity, stateOfHealth } from '../src/capacity';
import type { ChargeLogSample } from '../src/chargeLog';

const at = (min: number, over: Partial<ChargeLogSample> = {}): ChargeLogSample => ({
  ts: new Date(Date.UTC(2026, 6, 28, 8, 0, 0) + min * 60000).toISOString(),
  ...over,
});

/** Fahrt: `km` gefahren bei `kwh100` Verbrauch, Ladestand fällt um `drop`. */
const drive = (
  startSoc: number,
  drop: number,
  km: number,
  kwh100: number,
): ChargeLogSample[] => [
  at(0, { soc: startSoc, odometerKm: 50000, tripKwh100: kwh100, plugged: false }),
  at(60, { soc: startSoc - drop, odometerKm: 50000 + km, tripKwh100: kwh100, plugged: false }),
];

describe('estimateCapacity', () => {
  it('rechnet die Kapazität aus Strecke, Verbrauch und Ladestandsabfall', () => {
    // 100 km bei 20 kWh/100km = 20 kWh für 25 Prozentpunkte → 80 kWh.
    const e = estimateCapacity(drive(80, 25, 100, 20));
    expect(e.capacityKwh).toBe(80);
    expect(e.samples).toBe(1);
  });

  it('liefert nichts ohne verwertbare Abschnitte', () => {
    expect(estimateCapacity([]).capacityKwh).toBeUndefined();
    expect(estimateCapacity([at(0, { soc: 80 })]).capacityKwh).toBeUndefined();
  });

  it('überspringt zu kurze Strecken', () => {
    // Unter 5 km dominieren Rundungsfehler des Ladestands.
    expect(estimateCapacity(drive(80, 25, 3, 20)).samples).toBe(0);
  });

  it('überspringt zu kleinen Ladestandsabfall', () => {
    expect(estimateCapacity(drive(80, 2, 100, 20)).samples).toBe(0);
  });

  it('ignoriert Abschnitte AM KABEL', () => {
    // Dort könnte gleichzeitig geladen werden — der Abfall wäre verfälscht.
    const s = [
      at(0, { soc: 80, odometerKm: 50000, tripKwh100: 20, plugged: true }),
      at(60, { soc: 55, odometerKm: 50100, tripKwh100: 20, plugged: true }),
    ];
    expect(estimateCapacity(s).samples).toBe(0);
  });

  it('verwirft unplausible Werte statt sie einzurechnen', () => {
    // 100 km bei 2 kWh/100km ergäbe 8 kWh Kapazität — offensichtlich Datenfehler.
    expect(estimateCapacity(drive(80, 25, 100, 2)).samples).toBe(0);
  });

  it('nimmt den Median, nicht den Mittelwert', () => {
    // Drei ZYKLEN — durch Ladepausen getrennt: 80, 80 und ein Ausreißer bei
    // 100 → Median 80.
    const s = [
      ...drive(90, 25, 100, 20),
      at(90, { plugged: true }),
      at(120, { soc: 90, odometerKm: 51000, tripKwh100: 20, plugged: false }),
      at(180, { soc: 65, odometerKm: 51100, tripKwh100: 20, plugged: false }),
      at(210, { plugged: true }),
      at(240, { soc: 90, odometerKm: 52000, tripKwh100: 25, plugged: false }),
      at(300, { soc: 65, odometerKm: 52100, tripKwh100: 25, plugged: false }),
    ];
    const e = estimateCapacity(s);
    expect(e.samples).toBe(3);
    expect(e.capacityKwh).toBe(80);
  });

  it('summiert die ausgewertete Strecke', () => {
    expect(estimateCapacity(drive(80, 25, 100, 20)).km).toBe(100);
  });

  it('weist die Streuung erst ab vier Abschnitten aus', () => {
    expect(estimateCapacity(drive(80, 25, 100, 20)).spreadKwh).toBeUndefined();
  });
});

describe('Zyklus statt Messabstand', () => {
  it('wertet EINEN Zyklus aus, nicht jeden Messabstand einzeln', () => {
    // Vier Messpunkte ohne Kabel dazwischen sind eine Fahrt, keine drei.
    const s = [
      at(0, { soc: 80, odometerKm: 50000, tripKwh100: 20, plugged: false }),
      at(30, { soc: 70, odometerKm: 50040, tripKwh100: 20, plugged: false }),
      at(60, { soc: 62, odometerKm: 50075, tripKwh100: 20, plugged: false }),
      at(90, { soc: 55, odometerKm: 50100, tripKwh100: 20, plugged: false }),
    ];
    const e = estimateCapacity(s);
    expect(e.samples).toBe(1);
    // 100 km bei 20 kWh/100km = 20 kWh für 25 Prozentpunkte → 80 kWh.
    expect(e.capacityKwh).toBe(80);
  });

  it('nimmt den Verbrauch vom ENDE des Zyklus', () => {
    // TRIP_STATISTICS_CYCLIC wächst über den Zyklus; erst am Ende steht der
    // Durchschnitt über die ganze Strecke.
    const s = [
      at(0, { soc: 80, odometerKm: 50000, tripKwh100: 35, plugged: false }),
      at(60, { soc: 55, odometerKm: 50100, tripKwh100: 20, plugged: false }),
    ];
    expect(estimateCapacity(s).capacityKwh).toBe(80);
  });

  it('lässt eine LEERE Antwort den Zyklus nicht zerschneiden', () => {
    // Die API liefert etwa stündlich eine Zeile ohne jeden Messwert. Sie sagt
    // nichts über den Stecker und darf keinen Zyklus beenden.
    const s = [
      at(0, { soc: 80, odometerKm: 50000, tripKwh100: 20, plugged: false }),
      at(30, {}),
      at(60, { soc: 55, odometerKm: 50100, tripKwh100: 20, plugged: false }),
    ];
    expect(estimateCapacity(s).samples).toBe(1);
  });

  it('verwirft einen Zyklus mit zu kleinem Ladestandsabfall', () => {
    // Unter 15 Prozentpunkten bestimmt die ganzzahlige Meldung das Ergebnis.
    const s = [
      at(0, { soc: 80, odometerKm: 50000, tripKwh100: 20, plugged: false }),
      at(60, { soc: 70, odometerKm: 50040, tripKwh100: 20, plugged: false }),
    ];
    expect(estimateCapacity(s).samples).toBe(0);
  });

  it('rechnet den Standverbrauch heraus', () => {
    // 100 km bei 20 kWh/100km = 20 kWh. Der Ladestand fällt um 30 Punkte, aber
    // 5 davon im Stand (Vorklimatisierung, Zündung an) — die zählen nicht in
    // den Nenner, weil der Verbrauchswert des Fahrzeugs sie auch nicht im
    // Zähler hat. 20 kWh / 0,25 = 80 kWh statt 66,7.
    const rows = [
      at(0, { soc: 80, odometerKm: 50000, tripKwh100: 20, plugged: false }),
      at(30, { soc: 75, odometerKm: 50000, tripKwh100: 20, plugged: false }),
      at(90, { soc: 50, odometerKm: 50100, tripKwh100: 20, plugged: false }),
    ];
    expect(estimateCapacity(rows).capacityKwh).toBe(80);
  });

  it('verwirft einen Zyklus, wenn nach dem Standabzug zu wenig übrig bleibt', () => {
    // Fast alles im Stand verloren: Was bleibt, trägt die Rundung nicht.
    const rows = [
      at(0, { soc: 80, odometerKm: 50000, tripKwh100: 20, plugged: false }),
      at(30, { soc: 62, odometerKm: 50000, tripKwh100: 20, plugged: false }),
      at(90, { soc: 55, odometerKm: 50100, tripKwh100: 20, plugged: false }),
    ];
    expect(estimateCapacity(rows).samples).toBe(0);
  });

  it('weist eine Unsicherheit aus, die nie unter den systematischen Boden fällt', () => {
    const e = estimateCapacity(drive(80, 25, 100, 20));
    // Die reine SoC-Rundung ergäbe hier ±1,6 kWh. Ausgewiesen werden 3 % von
    // 80 kWh, weil die Verbrauchsangabe des Fahrzeugs und der Standverbrauch
    // sich durch keine Wiederholung herausmitteln.
    expect(e.uncertaintyKwh).toBeCloseTo(2.4, 1);
  });

  it('lässt die Unsicherheit auch bei vielen Zyklen nicht beliebig klein werden', () => {
    // Zehn identische Zyklen: Der statistische Fehler ginge gegen null, die
    // ausgewiesene Unsicherheit bleibt beim Boden stehen. Sonst stünde dort
    // eine Genauigkeit, die das Verfahren nicht hergibt.
    const rows = [];
    for (let i = 0; i < 10; i++) {
      rows.push(
        at(i * 200, { soc: 80, odometerKm: 50000 + i * 1000, tripKwh100: 20, plugged: false }),
        at(i * 200 + 60, { soc: 55, odometerKm: 50100 + i * 1000, tripKwh100: 20, plugged: false }),
        at(i * 200 + 90, { plugged: true }),
      );
    }
    const e = estimateCapacity(rows);
    expect(e.samples).toBe(10);
    expect(e.capacityKwh).toBe(80);
    expect(e.uncertaintyKwh).toBeCloseTo(2.4, 1);
  });

  it('nennt keine Unsicherheit ohne Schätzung', () => {
    expect(estimateCapacity([]).uncertaintyKwh).toBeUndefined();
  });
});

describe('stateOfHealth', () => {
  it('setzt die Schätzung ins Verhältnis zur Werkskapazität', () => {
    expect(stateOfHealth(74.5, 83.7)).toBe(89);
  });

  it('liefert nichts ohne Schätzung', () => {
    expect(stateOfHealth(undefined, 83.7)).toBeUndefined();
  });

  it('vermeidet die Division durch null', () => {
    expect(stateOfHealth(74.5, 0)).toBeUndefined();
  });
});

describe('Kapazitätsverlauf', () => {
  /**
   * Ein verwertbarer Entladezyklus im Monat `month`, Tag `day`, mit einer
   * Kapazität von `kwh`.
   *
   * Gerechnet wird rückwärts: Bei 30 Prozentpunkten Abfall und 100 km Strecke
   * folgt aus `kwh` der nötige Verbrauchswert.
   */
  const zyklus = (month: string, day: number, kwh: number, odo: number): ChargeLogSample[] => {
    const drop = 30;
    const km = 100;
    const kwh100 = Math.round(((kwh * drop) / 100 / km) * 100 * 10) / 10;
    const iso = (h: number): string =>
      `${month}-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
    return [
      { ts: iso(6), soc: 80, odometerKm: odo, plugged: true, charging: true },
      { ts: iso(7), soc: 80, odometerKm: odo, plugged: false },
      { ts: iso(9), soc: 80 - drop, odometerKm: odo + km, plugged: false, tripKwh100: kwh100 },
      { ts: iso(10), soc: 80 - drop, odometerKm: odo + km, plugged: true, charging: true },
    ];
  };

  /** `monate` Monate mit je `proMonat` Zyklen der Kapazität `kwh`. */
  const reihe = (monate: string[], proMonat: number, kwh: (m: number) => number) => {
    const rows: ChargeLogSample[] = [];
    let odo = 50000;
    monate.forEach((m, i) => {
      for (let n = 0; n < proMonat; n++) {
        rows.push(...zyklus(m, 5 + n * 5, kwh(i), odo));
        odo += 100;
      }
    });
    return rows;
  };

  it('schweigt bei zu wenigen Monaten', () => {
    const est = estimateCapacity(reihe(['2026-01', '2026-02', '2026-03'], 2, () => 80));
    expect(est.samples).toBe(6);
    expect(capacityTrend(est)).toEqual([]);
  });

  it('lässt Monate mit nur einer Schätzung ganz weg', () => {
    // Eine Linie, die zwischen belastbaren Werten über einen Zufallswert
    // läuft, behauptet einen Verlauf, den es nicht gibt.
    const rows = [
      ...reihe(['2026-01', '2026-02', '2026-03', '2026-04'], 2, () => 80),
      ...reihe(['2026-05'], 1, () => 60),
    ];
    const t = capacityTrend(estimateCapacity(rows));
    expect(t.map((x) => x.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });

  it('liefert die Monate in zeitlicher Reihenfolge mit ihrem Median', () => {
    const t = capacityTrend(
      estimateCapacity(
        reihe(['2026-01', '2026-02', '2026-03', '2026-04'], 2, (i) => 80 - i),
      ),
    );
    expect(t.map((x) => x.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(t.map((x) => Math.round(x.kwh))).toEqual([80, 79, 78, 77]);
    expect(t.every((x) => x.samples === 2)).toBe(true);
  });

  it('nimmt den Median, nicht den Mittelwert', () => {
    // Drei Werte je Monat, einer davon ein Ausreißer nach unten.
    const rows: ChargeLogSample[] = [];
    let odo = 50000;
    for (const m of ['2026-01', '2026-02', '2026-03', '2026-04']) {
      for (const [n, kwh] of [80, 80, 50].entries()) {
        rows.push(...zyklus(m, 5 + n * 5, kwh, odo));
        odo += 100;
      }
    }
    const t = capacityTrend(estimateCapacity(rows));
    expect(t[0].kwh).toBeCloseTo(80, 0);
  });
});

describe('resolveCapacity', () => {
  it('nimmt den Messwert, sobald genug Zyklen vorliegen', () => {
    expect(resolveCapacity({ configured: 83.7, auto: true, measured: 79.4, cycles: 12 })).toEqual({
      capacityKwh: 79.4,
      source: 'gemessen',
    });
  });

  it('bleibt beim Startwert, solange die Analyse zu dünn ist', () => {
    // Genau der Punkt: 83,7 ist ein Startwert, bis die Messung trägt.
    expect(resolveCapacity({ configured: 83.7, auto: true, measured: 79.4, cycles: 3 })).toEqual({
      capacityKwh: 83.7,
      source: 'eingestellt',
    });
  });

  it('rührt den eingestellten Wert ohne Automatik nicht an', () => {
    expect(resolveCapacity({ configured: 83.7, auto: false, measured: 79.4, cycles: 99 })).toEqual({
      capacityKwh: 83.7,
      source: 'eingestellt',
    });
  });

  it('kommt ohne Messwert zurecht', () => {
    expect(resolveCapacity({ configured: 83.7, auto: true, cycles: 0 })).toEqual({
      capacityKwh: 83.7,
      source: 'eingestellt',
    });
  });

  it('verwirft einen unsinnigen Messwert, statt die Historie zu zerrechnen', () => {
    // Eine Messung von 8 kWh oder 300 kWh ist ein Auswertungsfehler, kein
    // Akku — sie würde jede kWh-Zahl der Historie mitreißen.
    expect(
      resolveCapacity({ configured: 83.7, auto: true, measured: 8, cycles: 20 }).source,
    ).toBe('eingestellt');
    expect(
      resolveCapacity({ configured: 83.7, auto: true, measured: 300, cycles: 20 }).source,
    ).toBe('eingestellt');
  });
});

describe('Zeilen mit unbekanntem Steckerzustand', () => {
  it('lässt eine Ladezeile ohne plugged den Zyklus nicht verfälschen', () => {
    // `plugged` fehlt genau dann, wenn CHARGING_SUMMARY in der Antwort fehlt
    // — unabhängig von BATTERY_LEVEL und MILEAGE. Die Zeile trägt dann
    // weiter Ladestand und Kilometerstand. Fällt sie in eine laufende
    // Ladung, ginge ein STEIGENDER Ladestand als Zyklusende in die Rechnung
    // und die geschätzte Kapazität fiele zu hoch aus (nachgestellt: 74,1
    // statt 66,7 kWh, also +11 %) — und die Automatik übernähme das.
    const iso = (h: number): string =>
      new Date(Date.UTC(2026, 6, 28, h, 0)).toISOString();
    const sauber: ChargeLogSample[] = [
      { ts: iso(6), soc: 80, odometerKm: 1000, plugged: false },
      { ts: iso(7), soc: 50, odometerKm: 1100, plugged: false, tripKwh100: 20 },
      { ts: iso(8), soc: 50, odometerKm: 1100, plugged: true, charging: true },
    ];
    const mitKabelzeile: ChargeLogSample[] = [
      sauber[0],
      sauber[1],
      // Lädt bereits, aber CHARGING_SUMMARY fehlt → plugged undefined
      { ts: iso(7.5), soc: 53, odometerKm: 1100, tripKwh100: 20 },
      sauber[2],
    ];
    const a = estimateCapacity(sauber).capacityKwh;
    const b = estimateCapacity(mitKabelzeile).capacityKwh;
    expect(a).toBeDefined();
    expect(b).toBe(a);
  });
});

describe('Zyklusende ohne Verbrauchsangabe', () => {
  it('nutzt den letzten Messpunkt MIT Verbrauchswert, statt den Zyklus zu verwerfen', () => {
    // `tripKwh100` kommt aus einem eigenen Messschlüssel und kann auf dem
    // letzten Messpunkt fehlen. Bisher fiel dann der ganze Zyklus heraus —
    // die Zyklenzahl blieb zu niedrig, und die 10er-Schwelle der
    // Kapazitäts-Automatik wurde später oder nie erreicht.
    const iso = (h: number): string => new Date(Date.UTC(2026, 6, 28, h, 0)).toISOString();
    const mitWertAmEnde: ChargeLogSample[] = [
      { ts: iso(6), soc: 80, odometerKm: 1000, plugged: false },
      { ts: iso(9), soc: 50, odometerKm: 1100, plugged: false, tripKwh100: 20 },
      { ts: iso(10), soc: 50, odometerKm: 1100, plugged: true, charging: true },
    ];
    const ohneWertAmEnde: ChargeLogSample[] = [
      { ts: iso(6), soc: 80, odometerKm: 1000, plugged: false },
      { ts: iso(9), soc: 50, odometerKm: 1100, plugged: false, tripKwh100: 20 },
      // Letzter Messpunkt des Zyklus, gleicher Kilometerstand, kein Wert
      { ts: iso(9.5), soc: 50, odometerKm: 1100, plugged: false },
      { ts: iso(10), soc: 50, odometerKm: 1100, plugged: true, charging: true },
    ];
    const a = estimateCapacity(mitWertAmEnde);
    const b = estimateCapacity(ohneWertAmEnde);
    expect(a.samples).toBe(1);
    expect(b.samples).toBe(1);
    expect(b.capacityKwh).toBe(a.capacityKwh);
  });
});

describe('Standanteil und Messrahmen', () => {
  it('rechnet den Standanteil nur innerhalb des Messrahmens heraus', () => {
    // Der Rahmen endet beim letzten Messpunkt MIT Verbrauchswert. Die
    // Standverbrauchs-Schleife lief dagegen bis zum allerletzten Punkt des
    // Zyklus. Fällt `tripKwh100` auf den letzten Zeilen aus — genau der
    // Fall, für den der Rahmen eingeführt wurde —, wird ein Standanteil
    // abgezogen, der außerhalb liegt: Der Fahranteil fällt zu klein aus und
    // die Kapazität damit zu HOCH.
    const iso = (h: number): string => new Date(Date.UTC(2026, 6, 28, h, 0)).toISOString();
    const bis = (h: number, soc: number, odo: number, kwh100?: number): ChargeLogSample => ({
      ts: iso(h), soc, odometerKm: odo, plugged: false,
      ...(kwh100 === undefined ? {} : { tripKwh100: kwh100 }),
    });
    // Zyklus: 90 % → 60 % über 150 km bei 20 kWh/100 km → 30 kWh / 30 % = 100 kWh
    const sauber = [
      bis(6, 90, 1000, 20),
      bis(9, 60, 1150, 20),
      { ts: iso(10), soc: 60, odometerKm: 1150, plugged: true, charging: true },
    ];
    // Dasselbe, aber danach eine Standzeile OHNE Verbrauchswert, in der der
    // Ladestand weiter fällt.
    const mitStand = [
      bis(6, 90, 1000, 20),
      bis(9, 60, 1150, 20),
      bis(10, 58, 1150),
      { ts: iso(11), soc: 58, odometerKm: 1150, plugged: true, charging: true },
    ];
    const a = estimateCapacity(sauber).capacityKwh;
    const b = estimateCapacity(mitStand).capacityKwh;
    expect(a).toBeDefined();
    expect(b).toBe(a);
  });
});
