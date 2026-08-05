import { capacityFromCharging } from '../src/chargeCapacity';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Die Kapazität von der LADESEITE — der zweite, unabhängige Weg.
 *
 * ## Warum es ihn braucht
 *
 * Die fahrseitige Schätzung (`capacity.ts`) rechnet
 * `Strecke × Verbrauchsangabe / Ladestand-Abfall` und hat drei systematische
 * Fehlerquellen, die ALLE nach unten wirken: nicht erfasster Standverbrauch,
 * die Güte der Verbrauchsangabe des Fahrzeugs und die nichtlineare
 * Ladestandskennlinie. Am eigenen Fahrzeug lieferte sie 73,6 kWh — 87,9 % der
 * Werksangabe, was der Eigentümer zu Recht für zu niedrig hielt.
 *
 * Beim LADEN ist die Energie dagegen direkt messbar: Das Fahrzeug meldet seine
 * Ladeleistung, und über die Zeit integriert ergibt das die zugeführte Energie.
 * Keine Verbrauchsangabe, keine Fahrstrecke, kein Standverbrauch.
 *
 * ## Dass die Leistung netto ist, ist belegt
 *
 * Am Mitschrieb gemessen: `maxPowerKw` steht konstant auf 11 kW — die
 * Anschlussleistung der Wallbox. `powerKw` liegt bei 10,12 kW, also bei 92 %
 * davon. Das ist genau der Wirkungsgrad eines Bordladers; die gemeldete
 * Leistung ist die, die in der Batterie ankommt. Ein Ladeverlust-Zuschlag wäre
 * deshalb falsch.
 *
 * ## Die Fallen, die diese Datei bestimmen
 *
 * 1. **Der Ladestand-Hub steht im Nenner und ist ganzzahlig.** Bei zehn
 *    Prozentpunkten trägt allein die Rundung ±10 %. Deshalb ein Mindesthub.
 * 2. **Ein großer Hub ist nicht automatisch ein guter.** Am eigenen Fahrzeug
 *    steht der größte Hub (34 Punkte) für einen Sprung von 65 auf 99 Prozent
 *    in 102 Sekunden — ein Datenfehler, der 15,1 kWh Kapazität ergäbe. Nach
 *    Hub zu gewichten OHNE vorher zu filtern verschlechterte das Ergebnis von
 *    82,8 auf 63,9 kWh: Der kaputteste Wert bekam das höchste Gewicht.
 *    **Erst filtern, dann gewichten.**
 * 3. **Ladepausen.** Bei tarifgesteuertem Laden (Octopus) liegen Stunden
 *    zwischen zwei Punkten. Die Leistung dazwischen fortzuschreiben erfände
 *    Energie, die nie floss.
 */
const p = (
  min: number,
  soc: number,
  kw: number | undefined,
  over: Partial<ChargeLogSample> = {},
): ChargeLogSample => ({
  ts: new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + min * 60000).toISOString(),
  soc,
  charging: true,
  plugged: true,
  ...(kw !== undefined ? { powerKw: kw } : {}),
  ...over,
});

/** Eine glatte Ladung: 10 kW über die angegebene Dauer. */
const ladung = (vonSoc: number, bisSoc: number, minuten: number, kw = 10): ChargeLogSample[] => {
  const schritte = 12;
  const out: ChargeLogSample[] = [];
  for (let i = 0; i <= schritte; i++) {
    const t = (minuten / schritte) * i;
    const soc = Math.round(vonSoc + ((bisSoc - vonSoc) / schritte) * i);
    out.push(p(t, soc, kw));
  }
  // Abschluss: Kabel raus, damit die Phase endet.
  out.push({ ts: new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + (minuten + 5) * 60000).toISOString(),
             soc: bisSoc, charging: false, plugged: false });
  return out;
};

describe('capacityFromCharging', () => {
  it('rechnet die Kapazität aus zugeführter Energie und Ladestand-Hub', () => {
    // 10 kW über 2 Stunden sind 20 kWh; steigt der Ladestand dabei um 25
    // Punkte, ergibt das roh 80 kWh. Ausgewiesen wird die Mitte beider
    // Lesarten des Messpunkts (batterie- oder kabelseitig), also 80 × 0,96.
    const est = capacityFromCharging(ladung(30, 55, 120), { ratedKwh: 83.7 });
    expect(est.samples).toBe(1);
    expect(est.rawKwh).toBeCloseTo(80, 0);
    expect(est.capacityKwh).toBeCloseTo(76.8, 0);
  });

  it('verwirft einen zu kleinen Ladestand-Hub', () => {
    // Fünf Punkte tragen ±20 % allein aus der Rundung — daraus lässt sich
    // keine Kapazität ableiten.
    expect(capacityFromCharging(ladung(30, 35, 24), { ratedKwh: 83.7 }).samples).toBe(0);
  });

  it('verwirft eine unmögliche Messung, auch bei großem Hub', () => {
    // Der reale Fall: Ladestand springt 65 -> 99 in zwei Minuten. Der Hub ist
    // mit 34 Punkten der größte im Mitschrieb, die Energie passt aber nicht
    // dazu — es ergäbe 15 kWh Kapazität.
    const sprung = [p(0, 65, 10), p(1, 82, 10), p(2, 99, 10),
                    { ts: p(7, 99, undefined).ts, soc: 99, charging: false, plugged: false }];
    expect(capacityFromCharging(sprung, { ratedKwh: 83.7 }).samples).toBe(0);
  });

  it('verwirft eine Messung über der Werksangabe', () => {
    // Dieselbe Regel wie fahrseitig: 10 % Zuschlag auf die Netto-Werksangabe,
    // darüber ist es ein Datenfehler.
    const zuHoch = ladung(30, 42, 120); // 20 kWh auf 12 Punkte = 167 kWh
    expect(capacityFromCharging(zuHoch, { ratedKwh: 83.7 }).samples).toBe(0);
  });

  it('gewichtet große Ladungen stärker als kleine', () => {
    // Nach dem Filter ist der Hub ein Maß für die Güte: Er steht im Nenner,
    // und sein Rundungsfehler ist 1/Hub.
    const gross = ladung(20, 45, 120).map((s) => s);          // 25 Punkte, 80 kWh
    const klein = ladung(60, 72, 72, 10).map((s) => ({        // 12 Punkte, 100 kWh
      ...s,
      ts: new Date(Date.parse(s.ts) + 86400000).toISOString(),
    }));
    const est = capacityFromCharging([...gross, ...klein], { ratedKwh: 110 });
    expect(est.samples).toBe(2);
    // Ungewichtet wäre der Mittelwert 90; mit Gewicht 25 zu 12 liegt er näher
    // an der großen Ladung.
    expect(est.rawKwh).toBeLessThan(88);
    expect(est.rawKwh).toBeGreaterThan(80);
  });

  it('erfindet keine Energie über eine Ladepause hinweg', () => {
    // Tarifgesteuertes Laden pausiert. Die Leistung über die Lücke
    // fortzuschreiben buchte Energie, die nie floss.
    const mitPause: ChargeLogSample[] = [
      p(0, 30, 10), p(30, 35, 10), p(60, 40, 10),
      // vier Stunden Pause, dann geht es weiter
      p(300, 40, 10), p(330, 45, 10), p(360, 50, 10),
      { ts: p(400, 50, undefined).ts, soc: 50, charging: false, plugged: false },
    ];
    const est = capacityFromCharging(mitPause, { ratedKwh: 83.7 });
    // Ohne Pausenschutz: 6 h × 10 kW = 60 kWh auf 20 Punkte = 300 kWh.
    // Mit Schutz: 2 h × 10 kW = 20 kWh auf 20 Punkte = 100 kWh — immer noch
    // über der Werksangabe und damit verworfen, aber aus dem richtigen Grund.
    expect(est.capacityKwh === undefined || est.capacityKwh < 150).toBe(true);
  });

  it('schweigt ohne Leistungsangaben', () => {
    const ohneKw: ChargeLogSample[] = [
      p(0, 30, undefined), p(60, 45, undefined), p(120, 55, undefined),
      { ts: p(130, 55, undefined).ts, soc: 55, charging: false, plugged: false },
    ];
    expect(capacityFromCharging(ohneKw, { ratedKwh: 83.7 }).samples).toBe(0);
  });
});
