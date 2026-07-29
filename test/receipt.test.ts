import { buildReceipt, receiptCsv, receiptMonths } from '../src/receipt';
import type { ChargeSession } from '../src/sessions';
import { labelsFor } from '../src/i18n';

const session = (over: Partial<ChargeSession> = {}): ChargeSession => ({
  startedAt: '2026-07-10T20:00:00.000Z',
  endedAt: '2026-07-11T06:00:00.000Z',
  durationMin: 600,
  chargingMin: 300,
  socDropped: false,
  complete: true,
  samples: 60,
  phases: [],
  energyKwh: 20,
  costEur: 4,
  pricePerKwh: 0.2,
  atHome: true,
  startSoc: 40,
  endSoc: 64,
  ...over,
});

describe('buildReceipt', () => {
  it('nimmt nur Ladungen des angeforderten Monats', () => {
    const r = buildReceipt(
      [
        session({ startedAt: '2026-06-30T20:00:00.000Z' }),
        session({ startedAt: '2026-07-10T20:00:00.000Z' }),
        session({ startedAt: '2026-08-01T20:00:00.000Z' }),
      ],
      '2026-07',
    );
    expect(r.lines).toHaveLength(1);
  });

  it('ordnet eine Nachtladung über den Monatswechsel dem Startmonat zu', () => {
    // Eine Ladung wird als Ganzes bezahlt — anders als die Energie in der
    // Zeitreihe, die sich über die Tage verteilt.
    const s = session({
      startedAt: '2026-07-31T22:00:00.000Z',
      endedAt: '2026-08-01T06:00:00.000Z',
    });
    expect(buildReceipt([s], '2026-07').lines).toHaveLength(1);
    expect(buildReceipt([s], '2026-08').lines).toHaveLength(0);
  });

  it('trennt zuhause von unterwegs', () => {
    const r = buildReceipt(
      [
        session({ atHome: true, energyKwh: 20, costEur: 4 }),
        session({ atHome: false, energyKwh: 30, costEur: 15 }),
        session({ atHome: undefined, energyKwh: 10, costEur: 2 }),
      ],
      '2026-07',
    );
    expect(r.home).toMatchObject({ kwh: 20, costEur: 4, count: 1 });
    expect(r.away).toMatchObject({ kwh: 30, costEur: 15, count: 1 });
    expect(r.unknown).toMatchObject({ kwh: 10, costEur: 2, count: 1 });
  });

  it('lässt laufende Ladungen draußen', () => {
    // Was noch am Kabel hängt, ist nicht abgerechnet.
    expect(buildReceipt([session({ complete: false })], '2026-07').lines).toHaveLength(0);
  });

  it('überspringt Ladungen ohne Energie', () => {
    expect(buildReceipt([session({ energyKwh: 0 })], '2026-07').lines).toHaveLength(0);
    expect(buildReceipt([session({ energyKwh: undefined })], '2026-07').lines).toHaveLength(0);
  });

  it('weist den ANGEWANDTEN Preis aus, nicht den zurückgerechneten', () => {
    // Aus 4,15 € / 20,09 kWh käme 20,66 ct heraus, aus 5,54 € / 26,78 kWh
    // 20,69 — bei ein und demselben Tarif. Auf einem Beleg sieht das nach
    // Fehler aus.
    const r = buildReceipt(
      [
        session({ energyKwh: 20.09, costEur: 4.15, pricePerKwh: 0.2067 }),
        session({ energyKwh: 26.78, costEur: 5.54, pricePerKwh: 0.2067 }),
      ],
      '2026-07',
    );
    expect(r.lines.map((l) => l.centPerKwh)).toEqual([20.67, 20.67]);
  });

  it('rechnet den Preis zurück, wenn nur ein Betrag eingetragen ist', () => {
    // Fremdladung mit von Hand eingetragenem Betrag: Dort gibt es keinen
    // angewandten Tarif, wohl aber eine Summe.
    const r = buildReceipt(
      [session({ atHome: false, energyKwh: 50, costEur: 25, pricePerKwh: undefined })],
      '2026-07',
    );
    expect(r.lines[0].centPerKwh).toBe(50);
  });

  it('bleibt ohne Kosten stumm, statt null zu behaupten', () => {
    const r = buildReceipt([session({ costEur: undefined, pricePerKwh: undefined })], '2026-07');
    expect(r.lines[0].costEur).toBeUndefined();
    expect(r.lines[0].centPerKwh).toBeUndefined();
    expect(r.lines[0].kwh).toBe(20);
  });
});

describe('receiptCsv', () => {
  const csv = (lang: 'en' | 'de', name = 'Porsche'): string =>
    receiptCsv(
      buildReceipt(
        [session({ energyKwh: 20.09, costEur: 4.15, pricePerKwh: 0.2067 })],
        '2026-07',
      ),
      name,
      labelsFor(lang),
    );

  // Die Konvention ist keine Übersetzung, sondern eine Frage der Lesbarkeit:
  // Ein Tabellenprogramm rät das Trennzeichen nicht, es nimmt das der
  // Systemsprache. Die falsche Kombination öffnet nicht unleserlich, sondern
  // FALSCH — aus `20,09` werden zwei Spalten.
  it('schreibt auf Deutsch Komma und trennt mit Semikolon', () => {
    expect(csv('de')).toContain(';20,09;');
    expect(csv('de')).not.toContain('20.09');
  });

  it('schreibt auf Englisch Punkt und trennt mit Komma', () => {
    expect(csv('en')).toContain(',20.09,');
    expect(csv('en')).not.toContain('20,09');
  });

  it('übersetzt die Spaltenköpfe', () => {
    expect(csv('en')).toContain('Start,Place,State of charge,kWh,ct/kWh,EUR');
    expect(csv('de')).toContain('Start;Ort;Ladestand;kWh;ct/kWh;EUR');
  });

  it('endet Zeilen nach CRLF', () => {
    expect(csv('en')).toContain('\r\n');
  });

  it('führt die Summe je Ort auf', () => {
    expect(csv('de')).toMatch(/Summe zuhause;1;;20,09;;4,15/);
    expect(csv('en')).toMatch(/Total at home,1,,20\.09,,4\.15/);
  });

  it('lässt eine leere Gruppe weg, statt eine Nullzeile zu schreiben', () => {
    expect(csv('de')).not.toContain('Summe unterwegs');
    expect(csv('en')).not.toContain('Total away');
  });

  it('maskiert das jeweilige Trennzeichen im Fahrzeugnamen', () => {
    // Ein Semikolon zerreißt die deutsche Datei, ein Komma die englische.
    expect(csv('de', 'Mein;Auto')).toContain('"Mein;Auto"');
    expect(csv('en', 'My,Car')).toContain('"My,Car"');
    // Und umgekehrt braucht es keine Anführungszeichen.
    expect(csv('de', 'Mein,Auto')).toContain(';Mein,Auto');
  });
});

describe('receiptMonths', () => {
  it('liefert die Monate mit Ladungen, jüngster zuerst', () => {
    expect(
      receiptMonths([
        session({ startedAt: '2026-05-01T20:00:00.000Z' }),
        session({ startedAt: '2026-07-01T20:00:00.000Z' }),
        session({ startedAt: '2026-07-20T20:00:00.000Z' }),
      ]),
    ).toEqual(['2026-07', '2026-05']);
  });

  it('zählt Monate ohne geladene Energie nicht mit', () => {
    expect(receiptMonths([session({ energyKwh: 0 })])).toEqual([]);
  });
});
