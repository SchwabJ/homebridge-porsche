import { analyzeIdle, idleStats } from '../src/idle';
import type { ChargeLogSample } from '../src/chargeLog';

/** Messpunkt m Minuten nach Mitternacht UTC, im Stand ohne Kabel. */
const at = (m: number, over: Partial<ChargeLogSample> = {}): ChargeLogSample => ({
  ts: new Date(Date.UTC(2026, 6, 28, 0, 0, 0) + m * 60000).toISOString(),
  plugged: false,
  odometerKm: 50000,
  ...over,
});

describe('analyzeIdle', () => {
  it('summiert den SoC-Abfall einer ruhigen Nacht', () => {
    // 70 → 68 über zwölf Stunden: zwei Prozentpunkte echte Ruhe.
    const rows = [];
    for (let m = 0; m <= 720; m += 30) {
      rows.push(at(m, { soc: m < 360 ? 70 : 68 }));
    }
    const r = analyzeIdle(rows);
    expect(r.idleSocDrop).toBe(2);
    expect(r.idleMinutes).toBe(720);
    expect(r.phases).toHaveLength(1);
    expect(r.phases[0].socDrop).toBe(2);
  });

  it('bucht Verlust bei laufender Klima auf den Klima-Topf', () => {
    // climateOn wird nur bei ÄNDERUNG geschrieben — der Zustand muss über
    // Zeilen ohne das Feld hinweg als letzter bekannter fortgelten.
    const rows = [
      at(0, { soc: 70, climateOn: true }),
      at(30, { soc: 69 }),
      at(60, { soc: 68, climateOn: false }),
      at(90, { soc: 68 }),
    ];
    const r = analyzeIdle(rows);
    expect(r.climateSocDrop).toBe(2);
    expect(r.climateMinutes).toBe(60);
    expect(r.idleSocDrop).toBe(0);
    // Nach dem Abschalten zählt die Zeit NICHT sofort als Ruhe: Der
    // Innenraum kühlt aus, das ist genauso wenig Ruhe wie nach einer Fahrt.
    expect(r.idleMinutes).toBe(0);
  });

  it('lässt die erste Stunde nach einer Fahrt nicht als Ruhe zählen', () => {
    // An echten Daten belegt: Alle scheinbaren Ruheverluste stammten aus den
    // Minuten direkt nach einer Fahrt — Nachlauf und Batteriekühlung. Die
    // Nächte danach verloren nichts. Zählt man den Nachlauf mit, misst man
    // das Abkühlen und nennt es Ruhe.
    const rows = [
      at(0, { soc: 70, odometerKm: 50000 }),
      at(20, { soc: 68, odometerKm: 50030 }), // Fahrt
      at(50, { soc: 67, odometerKm: 50030 }), // Nachlauf — zählt nicht
      at(80, { soc: 67, odometerKm: 50030 }), // immer noch Nachlauf
      at(110, { soc: 66, odometerKm: 50030 }), // ab hier Ruhe
      at(140, { soc: 66, odometerKm: 50030 }),
    ];
    const r = analyzeIdle(rows);
    // Nur die Intervalle ab 80 min (= 60 min nach Fahrtende bei 20 min).
    expect(r.idleMinutes).toBe(60);
    expect(r.idleSocDrop).toBe(1);
  });

  it('zählt NICHT als Ruhe, wenn der Kilometerstand fehlt', () => {
    // Sonst wird eine Fahrt zur Ruhephase: Ohne Kilometerstand ist „nicht
    // gefahren" nicht belegt, sondern nur unbelegt — und der Fahrverbrauch
    // landete im Ruhe-Topf. Nachgestellt ergab das 8 statt 0 Prozentpunkte.
    const rows = [
      at(0, { soc: 70, odometerKm: 50000 }),
      // Fahrt, aber die Antwort trägt keinen Kilometerstand (MILEAGE fehlt,
      // BATTERY_LEVEL nicht) — der Helfer setzt sonst einen Default.
      { ts: at(20).ts, plugged: false, soc: 66 },
      at(40, { soc: 62, odometerKm: 50080 }),
      at(60, { soc: 62, odometerKm: 50080 }),
    ];
    const r = analyzeIdle(rows);
    expect(r.idleSocDrop).toBe(0);
    expect(r.idleMinutes).toBe(0);
  });

  it('zählt weder am Kabel noch beim Fahren', () => {
    const rows = [
      at(0, { soc: 70 }),
      at(30, { soc: 69, odometerKm: 50010 }), // gefahren
      at(60, { soc: 69, plugged: true }), // angesteckt
      at(90, { soc: 72, plugged: true }),
    ];
    const r = analyzeIdle(rows);
    expect(r.idleSocDrop).toBe(0);
    expect(r.idleMinutes).toBe(0);
  });

  it('lässt einen leeren Poll die Ruhephase nicht zerschneiden', () => {
    // An echten Nutzerdaten gemessen: In 20 von 94 Stunden (21 % der Zeit!)
    // liefert die API kein `plugged`. Zerschnitte jede solche Zeile die
    // Phase, fiele ein Fünftel der Betriebszeit aus der Auswertung.
    // buildSessions macht es längst richtig: ein fehlgeschlagener Poll ist
    // kein Ausstecken.
    const rows = [
      at(0, { soc: 70 }),
      { ts: at(20).ts }, // leere Antwort: nur ts
      at(40, { soc: 69 }),
      at(60, { soc: 69 }),
    ];
    const r = analyzeIdle(rows);
    expect(r.idleMinutes).toBe(60);
    expect(r.idleSocDrop).toBe(1);
  });

  it('zählt eine zu lange Folge leerer Polls trotzdem nicht', () => {
    // Die Lückensicherung muss über die übersprungenen Zeilen hinweg
    // greifen — sonst würde aus „drei Stunden nichts gemessen" stillschweigend
    // „drei Stunden Ruhe".
    const rows = [
      at(0, { soc: 70 }),
      { ts: at(60).ts },
      { ts: at(120).ts },
      at(180, { soc: 68 }),
    ];
    const r = analyzeIdle(rows);
    expect(r.idleMinutes).toBe(0);
    expect(r.idleSocDrop).toBe(0);
  });

  it('bricht bei einer Messlücke ab, statt Unbekanntes als Ruhe zu zählen', () => {
    // Zwischen den Punkten liegen drei Stunden ohne Messung — was darin
    // geschah (Klima? Zündung?), weiß niemand. Lieber Daten verlieren als
    // eine Behauptung aufstellen.
    const r = analyzeIdle([at(0, { soc: 70 }), at(180, { soc: 68 })]);
    expect(r.idleSocDrop).toBe(0);
    expect(r.idleMinutes).toBe(0);
  });

  it('wertet einen SoC-Anstieg ohne Kabel als Messfehler, nicht als Gewinn', () => {
    const r = analyzeIdle([at(0, { soc: 70 }), at(30, { soc: 71 }), at(60, { soc: 71 })]);
    expect(r.idleSocDrop).toBe(0);
    expect(r.idleMinutes).toBe(60);
  });

  it('führt auch eine Phase von gut zwei Stunden auf', () => {
    // An echten Nutzerdaten gemessen: Das Auto hängt fast durchgehend am
    // Kabel, die längste kabellose Phase in fünf Tagen war drei Stunden.
    // Eine Sechs-Stunden-Schwelle ließe die Liste dauerhaft leer.
    const rows = [];
    for (let m = 0; m <= 150; m += 30) {
      rows.push(at(m, { soc: m < 90 ? 70 : 69 }));
    }
    const r = analyzeIdle(rows);
    expect(r.phases).toHaveLength(1);
    expect(r.phases[0].socDrop).toBe(1);
  });

  it('liefert die größten Ruhephasen zuerst', () => {
    const rows = [];
    // Nacht 1: 0–600 min, Verlust 2. Danach Fahrt. Nacht 2: 700–1300, Verlust 1.
    for (let m = 0; m <= 600; m += 30) {
      rows.push(at(m, { soc: m < 300 ? 70 : 68 }));
    }
    rows.push(at(650, { soc: 68, odometerKm: 50020 }));
    for (let m = 700; m <= 1300; m += 30) {
      rows.push(at(m, { soc: m < 1000 ? 68 : 67, odometerKm: 50020 }));
    }
    const r = analyzeIdle(rows);
    expect(r.phases).toHaveLength(2);
    expect(r.phases[0].socDrop).toBe(2);
    expect(r.phases[1].socDrop).toBe(1);
  });
});

describe('idleStats', () => {
  const analyse = (drop: number, minutes: number) => ({
    idleSocDrop: drop,
    idleMinutes: minutes,
    climateSocDrop: 0,
    climateMinutes: 0,
    phases: [],
  });

  it('rechnet den Tagesverlust hoch, wenn der Abfall die Rundung überragt', () => {
    // 5 Punkte über 4 Tage bei 80 kWh: 1,25 %/Tag = 1,0 kWh/Tag.
    const s = idleStats(analyse(5, 5760), 80);
    expect(s?.socPerDay).toBe(1.3);
    expect(s?.kwhPerDay).toBe(1);
    expect(s?.obergrenze).toBe(false);
  });

  it('nennt eine OBERGRENZE, solange der Abfall im Rundungsrauschen liegt', () => {
    // Genau der Fall aus die Daten: über Tage hinweg fällt der ganzzahlige
    // Ladestand kaum. Eine Punktschätzung daraus wäre erfunden — ehrlich ist
    // „höchstens so viel", gerechnet mit dem Rundungszuschlag.
    const s = idleStats(analyse(0, 5760), 80);
    expect(s?.obergrenze).toBe(true);
    // 0 gemessen + 1 Punkt Rundung über 4 Tage = 0,25 %/Tag = 0,2 kWh/Tag
    expect(s?.kwhPerDay).toBe(0.2);
  });

  it('schweigt unter 48 Stunden beobachteter Ruhe', () => {
    expect(idleStats(analyse(1, 1440), 80)).toBeUndefined();
  });
});

describe('Klima-Zustand über übersprungene Zeilen', () => {
  it('bucht den Verlust in den Klima-Topf, auch wenn das Aus auf einer leeren Zeile steht', () => {
    // Die Zeile ohne `plugged` wird übersprungen — ihr Klima-Zustand darf
    // aber nicht rückwirkend für das Intervall gelten, das vor ihr begann.
    // Sonst erscheint Vorklimatisierungs-Verlust als Ruheverlust, und genau
    // die Trennung kippt, für die die Auswertung gebaut wurde.
    const rows = [
      at(0, { soc: 70, climateOn: true }),
      { ts: at(20).ts, soc: 68, climateOn: false }, // ohne plugged: übersprungen
      at(40, { soc: 68 }),
    ];
    const r = analyzeIdle(rows);
    expect(r.idleSocDrop).toBe(0);
    expect(r.climateSocDrop).toBe(2);
  });
});

describe('Klima auf einer übersprungenen Zeile', () => {
  it('bucht das Intervall auf den Klima-Topf, auch wenn nur die leere Zeile es meldet', () => {
    // Die Klima geht zwischen zwei ausgewerteten Messpunkten an UND wieder
    // aus, gemeldet nur auf Zeilen ohne `plugged`. Der Zustand an beiden
    // Enden des Intervalls ist damit „aus" — gelaufen ist sie trotzdem, und
    // der Verlust gehört nicht in den Ruhe-Topf.
    const rows = [
      at(0, { soc: 70 }),
      { ts: at(15).ts, soc: 69, climateOn: true },
      { ts: at(25).ts, soc: 68, climateOn: false },
      at(40, { soc: 68 }),
    ];
    const r = analyzeIdle(rows);
    expect(r.idleSocDrop).toBe(0);
    expect(r.climateSocDrop).toBe(2);
  });
});

describe('Lückenschwelle folgt dem Poll-Takt', () => {
  it('misst auch bei stündlichem Abfrageintervall', () => {
    // Das Poll-Intervall ist konfigurierbar. Eine fest auf 45 Minuten
    // verdrahtete Lückenschwelle ließe die Auswertung bei stündlicher
    // Abfrage für immer schweigen — jeder reguläre Abstand wäre eine
    // „Lücke". Die Schwelle muss dem folgen, was das System tatsächlich tut.
    const rows: ChargeLogSample[] = [];
    for (let h = 0; h <= 48; h++) {
      rows.push({
        ts: new Date(Date.UTC(2026, 6, 28, 0, 0) + h * 3600000).toISOString(),
        soc: Math.round(80 - (4 * h) / 48),
        odometerKm: 5000,
        plugged: false,
      });
    }
    const eng = analyzeIdle(rows);
    expect(eng.idleMinutes).toBe(0); // mit der Vorgabe von 45 min
    const weit = analyzeIdle(rows, { maxGapMin: 120 });
    expect(weit.idleMinutes).toBeGreaterThan(40 * 60);
    expect(weit.idleSocDrop).toBe(4);
  });
});

describe('SoC-Rauschen darf keinen Verlust erfinden', () => {
  it('bucht den NETTO-Verlust eines Ruhe-Laufs, nicht die Summe der Rückgänge', () => {
    // Der Ladestand kommt ganzzahlig und zittert an der Rundungsgrenze.
    // Wer die Beträge aller Rückgänge summiert, macht aus 80→81→80 einen
    // Prozentpunkt Verlust, obwohl netto nichts fehlt. Über 60 Stunden
    // Pendeln ergab das 60 Punkte — hochgerechnet 19,9 kWh/Tag aus reinem
    // Rauschen, und die Obergrenzen-Sicherung kippte gleich mit.
    const at = (m: number, soc: number): ChargeLogSample => ({
      ts: new Date(Date.UTC(2026, 6, 28, 0, 0, 0) + m * 60000).toISOString(),
      soc,
      plugged: false,
      odometerKm: 5000,
    });
    expect(analyzeIdle([at(0, 70), at(30, 71), at(60, 70)]).idleSocDrop).toBe(0);

    const pendeln: ChargeLogSample[] = [];
    for (let m = 0; m <= 3600; m += 30) pendeln.push(at(m, m % 60 === 0 ? 80 : 81));
    pendeln.push(at(3630, 80));
    const r = analyzeIdle(pendeln);
    expect(r.idleSocDrop).toBe(0);
    expect(idleStats(r, 83.7)?.obergrenze).toBe(true);
  });

  it('misst einen echten Verlust weiterhin, auch mit Zittern darin', () => {
    // Gegenprobe: Der Fix darf nicht einfach alles auf null setzen.
    const at = (m: number, soc: number): ChargeLogSample => ({
      ts: new Date(Date.UTC(2026, 6, 28, 0, 0, 0) + m * 60000).toISOString(),
      soc,
      plugged: false,
      odometerKm: 5000,
    });
    // 80 → 74 über zwölf Stunden im 30-Minuten-Takt, mit einem
    // Aufwärtszucker unterwegs. Der Takt muss unter der Lückenschwelle
    // bleiben, sonst zählt gar kein Intervall.
    const rows: ChargeLogSample[] = [];
    const verlauf = (m: number): number => {
      if (m === 240) return 79; // Zucker nach oben
      return Math.max(74, 80 - Math.floor(m / 120));
    };
    for (let m = 0; m <= 720; m += 30) rows.push(at(m, verlauf(m)));
    expect(analyzeIdle(rows).idleSocDrop).toBe(6);
  });

  it('summiert über MEHRERE Läufe, nicht nur über den letzten', () => {
    const at = (m: number, over: Partial<ChargeLogSample>): ChargeLogSample => ({
      ts: new Date(Date.UTC(2026, 6, 28, 0, 0, 0) + m * 60000).toISOString(),
      plugged: false,
      odometerKm: 5000,
      ...over,
    });
    const rows: ChargeLogSample[] = [];
    // Lauf 1: 80 → 78 über drei Stunden.
    for (let m = 0; m <= 180; m += 30) rows.push(at(m, { soc: m < 90 ? 80 : 78 }));
    // Eine Fahrt trennt die Läufe.
    rows.push(at(210, { soc: 78, odometerKm: 5030 }));
    // Lauf 2: 78 → 75, erst nach der Nachlaufstunde.
    for (let m = 280; m <= 600; m += 30) rows.push(at(m, { soc: m < 450 ? 78 : 75, odometerKm: 5030 }));
    expect(analyzeIdle(rows).idleSocDrop).toBe(5);
  });
});
