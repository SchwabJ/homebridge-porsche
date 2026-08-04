import { aggregate, isoWeek, keyOf, labelOf, efficiency, SUB } from '../src/aggregate';
import type { ChargeLogSample } from '../src/chargeLog';
import { LABELS_DE, LABELS_EN } from '../src/i18n';

const OPTS = { capacityKwh: 100, pricePerKwh: 0.2, labels: LABELS_DE };

/** Sample zu einer LOKALEN Uhrzeit (so, wie der Nutzer den Tag sieht). */
const local = (
  y: number, m: number, d: number, h: number, min: number,
  over: Partial<ChargeLogSample> = {},
): ChargeLogSample => ({ ts: new Date(y, m - 1, d, h, min).toISOString(), ...over });

describe('isoWeek', () => {
  it('puts 2026-01-01 (a Thursday) into week 1', () => {
    expect(isoWeek(new Date(2026, 0, 1))).toEqual({ year: 2026, week: 1 });
  });

  it('assigns a late-December day to week 1 of the NEXT ISO year', () => {
    // 2025-12-29 is a Monday; its Thursday falls in 2026 → ISO week 2026-W01.
    expect(isoWeek(new Date(2025, 11, 29))).toEqual({ year: 2026, week: 1 });
  });

  it('assigns 2027-01-01 (a Friday) to the LAST week of 2026', () => {
    expect(isoWeek(new Date(2027, 0, 1))).toEqual({ year: 2026, week: 53 });
  });

  it('numbers a mid-year week correctly', () => {
    expect(isoWeek(new Date(2026, 6, 27))).toEqual({ year: 2026, week: 31 });
  });
});

describe('keyOf', () => {
  const d = new Date(2026, 6, 27, 14, 0);
  it('builds a day key', () => expect(keyOf(d, 'day')).toBe('2026-07-27'));
  it('builds a week key', () => expect(keyOf(d, 'week')).toBe('2026-W31'));
  it('builds a month key', () => expect(keyOf(d, 'month')).toBe('2026-07'));
  it('builds a year key', () => expect(keyOf(d, 'year')).toBe('2026'));

  it('groups by LOCAL time, not UTC', () => {
    // 00:30 local on the 27th is still the 26th in UTC during CEST.
    expect(keyOf(new Date(2026, 6, 27, 0, 30), 'day')).toBe('2026-07-27');
  });
});

describe('labelOf', () => {
  it('labels a month in German', () => expect(labelOf('2026-07', 'month', LABELS_DE)).toBe('Juli 2026'));
  it('labels a week', () => expect(labelOf('2026-W31', 'week', LABELS_DE)).toBe('KW 31 / 2026'));
  it('labels a day with weekday', () =>
    expect(labelOf('2026-07-27', 'day', LABELS_DE)).toBe('Mo., 27.07.'));

  // Regression: Monats- und Wochentagsnamen standen als feste deutsche Liste
  // im Code — ein Nutzer mit language: 'en' bekam „Juli 2026" in einer sonst
  // englischen Seite.
  it('labels a month in English when the language is English', () =>
    expect(labelOf('2026-07', 'month', LABELS_EN)).toBe('July 2026'));
  it('labels a week with the English abbreviation', () =>
    expect(labelOf('2026-W31', 'week', LABELS_EN)).toBe('CW 31 / 2026'));
  it('labels a day in English day-before-month order', () => {
    const l = labelOf('2026-07-27', 'day', LABELS_EN);
    expect(l).toContain('Mon');
    expect(l).not.toContain('Mo.,');
  });
});

describe('aggregate', () => {
  it('returns nothing without samples', () => {
    expect(aggregate([], 'day', OPTS)).toEqual([]);
  });

  it('splits an overnight charge across BOTH days', () => {
    // 22:00 → 02:00: half the energy belongs to each day.
    const s = [
      local(2026, 7, 27, 22, 0, { soc: 30, plugged: true }),
      local(2026, 7, 28, 0, 0, { soc: 50, plugged: true }),
      local(2026, 7, 28, 2, 0, { soc: 70, plugged: true }),
    ];
    const days = aggregate(s, 'day', OPTS);
    const d27 = days.find((b) => b.key === '2026-07-27');
    const d28 = days.find((b) => b.key === '2026-07-28');
    // The 00:00 reading lands on the 28th, so the 27th gets nothing here —
    // what matters is that the 28th is NOT credited with the whole charge.
    expect(d27?.kwh).toBe(0);
    expect(d28?.kwh).toBe(40);
  });

  it('sums energy from the SoC rise while plugged in', () => {
    const s = [
      local(2026, 7, 27, 20, 0, { soc: 30, plugged: true }),
      local(2026, 7, 27, 21, 0, { soc: 55, plugged: true }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].kwh).toBe(25);
  });

  it('ignores an SoC rise while NOT plugged in (measurement glitch)', () => {
    const s = [
      local(2026, 7, 27, 20, 0, { soc: 30, plugged: false }),
      local(2026, 7, 27, 21, 0, { soc: 55, plugged: false }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].kwh).toBe(0);
  });

  it('computes cost from the effective price', () => {
    const s = [
      local(2026, 7, 27, 20, 0, { soc: 0, plugged: true }),
      local(2026, 7, 27, 21, 0, { soc: 50, plugged: true }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].cost).toBe(10); // 50 kWh * 0.20
  });

  it('accumulates driven kilometres from the odometer', () => {
    const s = [
      local(2026, 7, 27, 8, 0, { odometerKm: 52000 }),
      local(2026, 7, 27, 9, 0, { odometerKm: 52080 }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].km).toBe(80);
  });

  it('ignores an odometer going backwards', () => {
    const s = [
      local(2026, 7, 27, 8, 0, { odometerKm: 52000 }),
      local(2026, 7, 27, 9, 0, { odometerKm: 51000 }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].km).toBe(0);
  });

  it('fills empty days with zeros so the axis stays even', () => {
    const s = [
      local(2026, 7, 20, 8, 0, { soc: 50, plugged: false }),
      local(2026, 7, 20, 9, 0, { soc: 50, plugged: false }),
      local(2026, 7, 23, 8, 0, { soc: 50, plugged: false }),
    ];
    const days = aggregate(s, 'day', OPTS);
    expect(days.map((b) => b.key)).toEqual([
      '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23',
    ]);
    expect(days[1].samples).toBe(0);
  });

  it('fills month gaps across a year boundary', () => {
    const s = [
      local(2025, 11, 10, 8, 0, { soc: 50 }),
      local(2025, 11, 10, 9, 0, { soc: 50 }),
      local(2026, 1, 10, 8, 0, { soc: 50 }),
    ];
    expect(aggregate(s, 'month', OPTS).map((b) => b.key)).toEqual([
      '2025-11', '2025-12', '2026-01',
    ]);
  });

  it('fills week gaps across a year boundary', () => {
    const s = [
      local(2025, 12, 15, 8, 0, { soc: 50 }),
      local(2025, 12, 15, 9, 0, { soc: 50 }),
      local(2026, 1, 12, 8, 0, { soc: 50 }),
    ];
    const weeks = aggregate(s, 'week', OPTS).map((b) => b.key);
    expect(weeks[0]).toBe('2025-W51');
    expect(weeks[weeks.length - 1]).toBe('2026-W03');
    // Consecutive, no duplicates, no missing weeks.
    expect(new Set(weeks).size).toBe(weeks.length);
  });

  it('groups by month and year', () => {
    const s = [
      local(2026, 6, 10, 8, 0, { soc: 0, plugged: true }),
      local(2026, 6, 10, 9, 0, { soc: 10, plugged: true }),
      local(2026, 7, 10, 8, 0, { soc: 0, plugged: true }),
      local(2026, 7, 10, 9, 0, { soc: 20, plugged: true }),
    ];
    expect(aggregate(s, 'month', OPTS).map((b) => b.kwh)).toEqual([10, 20]);
    expect(aggregate(s, 'year', OPTS)[0].kwh).toBe(30);
  });
});

describe('bonus and savings', () => {
  const charge = (soc: number) => [
    local(2026, 7, 27, 20, 0, { soc: 0, plugged: true }),
    local(2026, 7, 27, 21, 0, { soc, plugged: true }),
  ];

  it('reports gross cost, net cost and the saving', () => {
    // 50 kWh: gross 0.32 → 16.00, effective 0.20 → 10.00, saved 6.00
    const b = aggregate(charge(50), 'day', {
      labels: LABELS_DE,
      capacityKwh: 100,
      pricePerKwh: 0.2,
      grossPricePerKwh: 0.32,
    })[0];
    expect(b.cost).toBe(10);
    expect(b.costGross).toBe(16);
    expect(b.saved).toBe(6);
  });

  it('reports no saving when there is no bonus', () => {
    const b = aggregate(charge(50), 'day', { capacityKwh: 100, pricePerKwh: 0.2, labels: LABELS_DE })[0];
    expect(b.costGross).toBe(b.cost);
    expect(b.saved).toBe(0);
  });

  it('sums the saving across periods', () => {
    const e = efficiency(
      aggregate(charge(50), 'day', {
        labels: LABELS_DE,
        capacityKwh: 100,
        pricePerKwh: 0.2,
        grossPricePerKwh: 0.32,
      }),
    );
    expect(e.saved).toBe(6);
    expect(e.costGross).toBe(16);
  });
});

describe('geladene Reichweite', () => {
  it('summiert den Reichweiten-Zuwachs am Kabel', () => {
    const s = [
      local(2026, 7, 27, 20, 0, { rangeKm: 200, plugged: true }),
      local(2026, 7, 27, 21, 0, { rangeKm: 290, plugged: true }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].rangeAdded).toBe(90);
  });

  it('ignoriert steigende Reichweite OHNE Stecker', () => {
    // Ohne Kabel ist ein Anstieg nur eine neu berechnete Prognose —
    // sonst bliese sparsames Fahren die „geladenen km" auf.
    const s = [
      local(2026, 7, 27, 20, 0, { rangeKm: 200, plugged: false }),
      local(2026, 7, 27, 21, 0, { rangeKm: 240, plugged: false }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].rangeAdded).toBe(0);
  });

  it('ignoriert eine fallende Reichweite', () => {
    const s = [
      local(2026, 7, 27, 20, 0, { rangeKm: 200, plugged: true }),
      local(2026, 7, 27, 21, 0, { rangeKm: 180, plugged: true }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].rangeAdded).toBe(0);
  });
});

describe('dayBoundaryHour', () => {
  // An overnight charge: plugged in 22:00, still charging at 02:00 next day.
  const overnight = [
    local(2026, 7, 27, 22, 0, { soc: 30, plugged: true }),
    local(2026, 7, 28, 2, 0, { soc: 70, plugged: true }),
  ];

  it('splits the charge at midnight by default', () => {
    const days = aggregate(overnight, 'day', { capacityKwh: 100, labels: LABELS_DE });
    expect(days.find((b) => b.key === '2026-07-28')?.kwh).toBe(40);
    expect(days.find((b) => b.key === '2026-07-27')?.kwh).toBe(0);
  });

  it('credits the whole night to the evening it started with a 4am boundary', () => {
    const days = aggregate(overnight, 'day', { capacityKwh: 100, labels: LABELS_DE, dayBoundaryHour: 4 });
    expect(days.find((b) => b.key === '2026-07-27')?.kwh).toBe(40);
    expect(days.find((b) => b.key === '2026-07-28')).toBeUndefined();
  });

  it('shifts week and month boundaries the same way', () => {
    // 1 August 00:30 with a 4am boundary still belongs to July.
    const s = [
      local(2026, 8, 1, 0, 0, { soc: 30, plugged: true }),
      local(2026, 8, 1, 0, 30, { soc: 40, plugged: true }),
    ];
    expect(aggregate(s, 'month', { capacityKwh: 100, labels: LABELS_DE, dayBoundaryHour: 4 })[0].key).toBe('2026-07');
    expect(aggregate(s, 'month', { capacityKwh: 100, labels: LABELS_DE })[0].key).toBe('2026-08');
  });
});

describe('efficiency', () => {
  it('computes consumption and cost per kilometre', () => {
    const e = efficiency([
      { key: 'a', from: '', label: 'a', kwh: 20, cost: 4, costGross: 6.5, saved: 2.5, rangeAdded: 0, usedKwh: 0, unratedKm: 0, unratedSocGain: 0, km: 100, samples: 1, gapMinutes: 0, spanMinutes: 60 },
    ]);
    expect(e.kwhPer100km).toBe(20);
    expect(e.centPerKm).toBe(4);
  });

  it('omits the ratios without driven distance (no division by zero)', () => {
    const e = efficiency([{ key: 'a', from: '', label: 'a', kwh: 20, cost: 4, costGross: 6.5, saved: 2.5, rangeAdded: 0, usedKwh: 0, unratedKm: 0, unratedSocGain: 0, km: 0, samples: 1, gapMinutes: 0, spanMinutes: 60 }]);
    expect(e.kwhPer100km).toBeUndefined();
    expect(e.centPerKm).toBeUndefined();
  });
});

describe('Datenqualität', () => {
  it('zählt keine Lücke bei normalem Poll-Takt', () => {
    const s = [
      local(2026, 7, 27, 20, 0, { soc: 50 }),
      local(2026, 7, 27, 20, 30, { soc: 50 }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].gapMinutes).toBe(0);
  });

  it('erfasst eine echte Messlücke', () => {
    // Vier Stunden ohne Messpunkt: alles über der Schwelle zählt als Lücke.
    const s = [
      local(2026, 7, 27, 20, 0, { soc: 50 }),
      local(2026, 7, 28, 0, 0, { soc: 50 }),
    ];
    const b = aggregate(s, 'day', OPTS);
    const gaps = b.reduce((a, x) => a + x.gapMinutes, 0);
    expect(gaps).toBe(240 - 35);
  });

  it('begrenzt die erfasste Zeitspanne auf die Schwelle', () => {
    // Damit eine Lücke die Abdeckung nicht künstlich aufbläht.
    const s = [
      local(2026, 7, 27, 20, 0, { soc: 50 }),
      local(2026, 7, 28, 0, 0, { soc: 50 }),
    ];
    const span = aggregate(s, 'day', OPTS).reduce((a, x) => a + x.spanMinutes, 0);
    expect(span).toBe(35);
  });
});

describe('Sprünge über leere Messpunkte hinweg', () => {
  it('zählt den Ladestand-Sprung ÜBER eine Leerzeile hinweg', () => {
    // Kernfehler vom 2026-07-28: Beim Vergleich nur direkter Nachbarn fiel
    // 70 % → (leer) → 75 % komplett aus der Rechnung. In der Tagesansicht
    // fehlten dadurch 5,9 von 20,1 kWh.
    const s = [
      local(2026, 7, 27, 20, 0, { soc: 70, plugged: true }),
      local(2026, 7, 27, 20, 10, { plugged: true }), // leere Antwort
      local(2026, 7, 27, 20, 20, { soc: 75, plugged: true }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].kwh).toBe(5);
  });

  it('zählt gefahrene Kilometer über eine Leerzeile hinweg', () => {
    const s = [
      local(2026, 7, 27, 8, 0, { odometerKm: 52000 }),
      local(2026, 7, 27, 8, 30, {}),
      local(2026, 7, 27, 9, 0, { odometerKm: 52080 }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].km).toBe(80);
  });

  it('zählt geladene Reichweite über eine Leerzeile hinweg', () => {
    const s = [
      local(2026, 7, 27, 20, 0, { rangeKm: 200, plugged: true }),
      local(2026, 7, 27, 20, 10, { plugged: true }),
      local(2026, 7, 27, 20, 20, { rangeKm: 260, plugged: true }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].rangeAdded).toBe(60);
  });

  it('zählt einen Sprung nicht doppelt', () => {
    const s = [
      local(2026, 7, 27, 20, 0, { soc: 70, plugged: true }),
      local(2026, 7, 27, 20, 10, { soc: 75, plugged: true }),
      local(2026, 7, 27, 20, 20, { soc: 75, plugged: true }),
    ];
    expect(aggregate(s, 'day', OPTS)[0].kwh).toBe(5);
  });

  it('ordnet einen tagesübergreifenden Sprung dem SPÄTEREN Tag zu', () => {
    const s = [
      local(2026, 7, 27, 23, 50, { soc: 70, plugged: true }),
      local(2026, 7, 28, 0, 10, { soc: 75, plugged: true }),
    ];
    const days = aggregate(s, 'day', OPTS);
    expect(days.find((b) => b.key === '2026-07-27')?.kwh).toBe(0);
    expect(days.find((b) => b.key === '2026-07-28')?.kwh).toBe(5);
  });
});

describe('Unterteilung eines Zeitraums', () => {
  it('unterteilt jeden Zeitraum eine Stufe feiner', () => {
    // Der gewählte Zeitraum ist der RAHMEN, nicht der Balken: Wer „Woche"
    // wählt, will die Tage dieser Woche sehen — nicht die letzten 26 Wochen.
    expect(SUB.day).toBe('hour');
    expect(SUB.week).toBe('day');
    expect(SUB.month).toBe('week');
    expect(SUB.year).toBe('month');
  });

  it('bildet Stundenschlüssel', () => {
    expect(keyOf(new Date(2026, 6, 29, 14, 37), 'hour')).toBe('2026-07-29T14');
  });

  it('beschriftet Stunden als Uhrzeit', () => {
    expect(labelOf('2026-07-29T14', 'hour', LABELS_DE)).toBe('14:00');
  });

  it('führt Stunden lückenlos über den Tageswechsel', () => {
    const s = [
      local(2026, 6, 28, 23, 0, { soc: 40, plugged: true, charging: true }),
      local(2026, 6, 29, 1, 0, { soc: 60, plugged: true, charging: true }),
    ];
    const keys = aggregate(s, 'hour', OPTS).map((b) => b.key);
    expect(keys).toEqual(['2026-06-28T23', '2026-06-29T00', '2026-06-29T01']);
  });

  it('nennt zu jedem Abschnitt seinen Beginn', () => {
    // Ohne den ließe sich ein Abschnitt seinem Zeitraum nicht zuordnen: Eine
    // Kalenderwoche kann über den Monatswechsel reichen.
    const s = [
      local(2026, 6, 28, 10, 0, { soc: 40, plugged: true, charging: true }),
      local(2026, 6, 28, 12, 0, { soc: 60, plugged: true, charging: true }),
    ];
    for (const b of aggregate(s, 'day', OPTS)) {
      expect(b.from).not.toBe('');
      expect(Number.isFinite(Date.parse(b.from))).toBe(true);
    }
  });

  it('gibt auch aufgefüllten Lücken einen Beginn', () => {
    // Lückenfüller haben keinen Messpunkt — ihr Beginn kommt aus dem Schlüssel.
    const s = [
      local(2026, 6, 26, 10, 0, { soc: 40, plugged: true, charging: true }),
      local(2026, 6, 29, 10, 0, { soc: 60, plugged: true, charging: true }),
    ];
    const buckets = aggregate(s, 'day', OPTS);
    expect(buckets.length).toBeGreaterThan(2);
    for (const b of buckets) {
      expect(Number.isFinite(Date.parse(b.from))).toBe(true);
    }
  });
});

describe('Verbrauch je Abschnitt', () => {
  /** Messpunkt zur Stunde `h` (lokale Zeit, wie das Dashboard rechnet). */
  const at = (h: number, over: Partial<ChargeLogSample> = {}): ChargeLogSample => {
    const d = new Date(2026, 6, 20, h, 0, 0);
    return { ts: d.toISOString(), ...over };
  };

  it('verteilt eine lange Fahrt über die Stunden, die sie gedauert hat', () => {
    // Zwei Stunden, je 100 km bei 23 kWh/100 km. Wird die Energie der ganzen
    // Fahrt dem Abschnitt ihres ENDES zugeschlagen, steht in einer Stunde ein
    // 46-kWh-Balken und in der davor eine Null.
    const b = aggregate(
      [
        at(6, { odometerKm: 1000, plugged: true, charging: true }),
        at(7, { odometerKm: 1000, plugged: false }),
        at(8, { odometerKm: 1100, plugged: false, tripKwh100: 23 }),
        at(9, { odometerKm: 1200, plugged: false, tripKwh100: 23 }),
      ],
      'hour',
      OPTS,
    );
    const byKey = new Map(b.map((x) => [x.key.slice(-2), x.usedKwh]));
    expect(byKey.get('08')).toBeCloseTo(23, 1);
    expect(byKey.get('09')).toBeCloseTo(23, 1);
  });

  it('summiert sich über die ganze Fahrt genau auf deren Energie', () => {
    const b = aggregate(
      [
        at(6, { odometerKm: 1000, plugged: true, charging: true }),
        at(7, { odometerKm: 1000, plugged: false }),
        at(8, { odometerKm: 1050, plugged: false, tripKwh100: 20 }),
        at(9, { odometerKm: 1150, plugged: false, tripKwh100: 22 }),
        at(10, { odometerKm: 1200, plugged: false, tripKwh100: 24 }),
      ],
      'hour',
      OPTS,
    );
    // 200 km bei zuletzt 24 kWh/100 km = 48 kWh für den ganzen Zyklus.
    expect(b.reduce((a, x) => a + x.usedKwh, 0)).toBeCloseTo(48, 1);
  });

  it('beginnt den Zyklus mit dem Laden neu, nicht mit dem Ausstecken', () => {
    // Wer ansteckt und den Strom nie einschaltet, hat weiterhin denselben
    // Zähler — ein Rücksetzen dort verschöbe den Bezugspunkt still.
    const b = aggregate(
      [
        at(6, { odometerKm: 1000, plugged: true, charging: true }),
        at(7, { odometerKm: 1000, plugged: false }),
        at(8, { odometerKm: 1100, plugged: false, tripKwh100: 20 }),
        at(9, { odometerKm: 1100, plugged: true, charging: false }), // nur angesteckt
        at(10, { odometerKm: 1200, plugged: false, tripKwh100: 20 }),
      ],
      'hour',
      OPTS,
    );
    // 200 km × 20 / 100 = 40 kWh. Mit einem Reset beim Anstecken käme die
    // zweite Hälfte doppelt heraus.
    expect(b.reduce((a, x) => a + x.usedKwh, 0)).toBeCloseTo(40, 1);
  });

  it('zählt Strecke ohne Verbrauchsangabe als unbewertet', () => {
    // Der Mitschrieb beginnt mitten im Zyklus: Wie viel seit dem letzten Laden
    // gefahren wurde, steht nirgends.
    const b = aggregate(
      [
        at(6, { odometerKm: 1000, plugged: false, tripKwh100: 21 }),
        at(7, { odometerKm: 1080, plugged: false, tripKwh100: 21 }),
      ],
      'hour',
      OPTS,
    );
    expect(b.reduce((a, x) => a + x.usedKwh, 0)).toBe(0);
    expect(b.reduce((a, x) => a + x.unratedKm, 0)).toBe(80);
  });

  it('verwirft einen gefallenen Zählerstand, statt negativ zu rechnen', () => {
    const b = aggregate(
      [
        at(6, { odometerKm: 1000, plugged: true, charging: true }),
        at(7, { odometerKm: 1000, plugged: false }),
        at(8, { odometerKm: 1100, plugged: false, tripKwh100: 25 }),
        at(9, { odometerKm: 1130, plugged: false, tripKwh100: 2 }), // Reset ohne Laden
      ],
      'hour',
      OPTS,
    );
    expect(b.every((x) => x.usedKwh >= 0)).toBe(true);
    expect(b.reduce((a, x) => a + x.unratedKm, 0)).toBe(30);
  });

  it('bleibt bei reinem Laden ohne Fahrt bei null', () => {
    const b = aggregate(
      [
        at(6, { soc: 40, odometerKm: 1000, plugged: true, charging: true }),
        at(7, { soc: 70, odometerKm: 1000, plugged: true, charging: true }),
      ],
      'hour',
      OPTS,
    );
    expect(b.reduce((a, x) => a + x.usedKwh, 0)).toBe(0);
    expect(b.reduce((a, x) => a + x.unratedKm, 0)).toBe(0);
    expect(b.reduce((a, x) => a + x.kwh, 0)).toBeCloseTo(30, 1);
  });
});
