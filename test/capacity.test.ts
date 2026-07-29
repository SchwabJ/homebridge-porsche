import { capacityTrend, estimateCapacity, idleKwhPerDay, stateOfHealth } from '../src/capacity';
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

describe('Standverbrauch', () => {
  /** `hours` Stunden Stillstand mit `drop` Prozentpunkten Verlust. */
  const stehen = (hours: number, drop: number): ChargeLogSample[] => {
    const rows: ChargeLogSample[] = [];
    const steps = hours; // ein Messpunkt je Stunde
    for (let i = 0; i <= steps; i++) {
      rows.push(
        at(i * 60, {
          soc: Math.round(80 - (drop * i) / steps),
          odometerKm: 50000,
          plugged: false,
        }),
      );
    }
    return rows;
  };

  it('schweigt unter einem Tag beobachteter Standzeit', () => {
    // Der Ladestand ist ganzzahlig — über wenige Stunden entscheidet allein
    // die Rundung, ob 0 oder 10 kWh am Tag herauskämen.
    expect(idleKwhPerDay(estimateCapacity(stehen(12, 2)), 83.7)).toBeUndefined();
  });

  it('rechnet den Verlust auf einen Tag hoch', () => {
    // 48 h, 4 Punkte → 2 Punkte je Tag → 2 % von 100 kWh = 2,0 kWh/Tag.
    expect(idleKwhPerDay(estimateCapacity(stehen(48, 4)), 100)).toBeCloseTo(2, 1);
  });

  it('hängt linear an der Kapazität', () => {
    const est = estimateCapacity(stehen(48, 4));
    expect(idleKwhPerDay(est, 50)).toBeCloseTo(1, 1);
  });

  it('zählt eine lange Datenlücke NICHT als beobachtete Standzeit', () => {
    // Sonst verdünnte jeder Plugin-Ausfall den Wert beliebig — was in der
    // Lücke geschah, weiß niemand.
    const mit = estimateCapacity([
      at(0, { soc: 80, odometerKm: 50000, plugged: false }),
      at(60, { soc: 79, odometerKm: 50000, plugged: false }),
      at(60 + 600, { soc: 78, odometerKm: 50000, plugged: false }), // 10 h Lücke
    ]);
    expect(mit.idleMinutes).toBe(60);
    expect(mit.idleSocDrop).toBe(1);
  });

  it('zählt Zeit mit Streckenzuwachs nicht mit', () => {
    const est = estimateCapacity([
      at(0, { soc: 80, odometerKm: 50000, plugged: false }),
      at(60, { soc: 79, odometerKm: 50000, plugged: false }),
      at(120, { soc: 70, odometerKm: 50060, plugged: false }),
    ]);
    expect(est.idleMinutes).toBe(60);
    expect(est.idleSocDrop).toBe(1);
  });

  it('sammelt auch aus Zyklen, die für die Kapazität zu kurz sind', () => {
    // 30 h Stehen ohne einen einzigen Kilometer: als Entladezyklus wertlos,
    // für den Standverbrauch die beste Datenquelle, die es gibt.
    const est = estimateCapacity(stehen(30, 3));
    expect(est.samples).toBe(0);
    expect(est.idleMinutes).toBe(30 * 60);
    expect(idleKwhPerDay(est, 100)).toBeCloseTo(2.4, 1);
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
