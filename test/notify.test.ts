import {
  buildDailyMessage,
  buildSessionMessage,
  buildStallMessage,
  buildIdleMessage,
  stalledToWarn,
  msUntilHour,
  sendNotification,
} from '../src/notify';
import { labelsFor } from '../src/i18n';

/** Die Alt-Tests prüfen deutsche Texte — sie behalten den deutschen Satz. */
const DE = labelsFor('de');
import type { Bucket, Efficiency } from '../src/aggregate';
import type { ChargeSession } from '../src/sessions';

const bucket = (over: Partial<Bucket> = {}): Bucket => ({
  key: '2026-07-26',
  from: '2026-07-26T08:00:00.000Z',
  label: 'So 26.07.',
  kwh: 0,
  cost: 0,
  costGross: 0,
  saved: 0,
  km: 0,
  rangeAdded: 0,
  usedKwh: 0,
  unratedKm: 0, unratedSocGain: 0,
  samples: 1,
  gapMinutes: 0,
  spanMinutes: 60,
  ...over,
});

const EFF: Efficiency = { kwh: 300, km: 1500, cost: 62, costGross: 98, saved: 36, kwhPer100km: 20, centPerKm: 4.1 };

describe('buildDailyMessage', () => {
  it('reports yesterday, not today', () => {
    const days = [
      bucket({ key: '2026-07-26', from: '', label: 'So 26.07.', kwh: 42.1, cost: 8.7 }),
      bucket({ key: '2026-07-27', from: '', label: 'Mo 27.07.', kwh: 5, cost: 1 }),
    ];
    const m = buildDailyMessage(days, undefined, EFF, DE, 'Taycan');
    expect(m.message).toContain('42.1 kWh');
    expect(m.message).not.toContain('5.0 kWh');
  });

  it('says so plainly when there was no charge', () => {
    const days = [bucket({ kwh: 0 }), bucket({ key: '2026-07-27', kwh: 0 })];
    expect(buildDailyMessage(days, undefined, EFF, DE, 'Taycan').message).toContain('keine Ladung');
  });

  it('includes the running month', () => {
    const days = [bucket(), bucket({ key: '2026-07-27' })];
    const month = bucket({ key: '2026-07', from: '', label: 'Juli 2026', kwh: 310, cost: 64.1 });
    expect(buildDailyMessage(days, month, EFF, DE, 'Taycan').message).toContain('Juli 2026: 310.0 kWh');
  });

  it('includes the efficiency figures', () => {
    const m = buildDailyMessage([bucket(), bucket()], undefined, EFF, DE, 'Taycan');
    expect(m.message).toContain('20.0 kWh/100 km');
    expect(m.message).toContain('4.1 ct/km');
  });

  it('omits efficiency when nothing was driven', () => {
    const m = buildDailyMessage([bucket(), bucket()], undefined, { kwh: 0, km: 0, cost: 0, costGross: 0, saved: 0 }, DE, 'Taycan');
    expect(m.message).not.toContain('Schnitt');
  });

  it('survives a single day of data without crashing', () => {
    expect(() => buildDailyMessage([bucket()], undefined, EFF, DE, 'Taycan')).not.toThrow();
  });
});

describe('buildSessionMessage', () => {
  const s: ChargeSession = {
    startedAt: '2026-07-26T20:00:00.000Z',
    endedAt: '2026-07-27T06:00:00.000Z',
    durationMin: 600,
    chargingMin: 180,
    startSoc: 34,
    endSoc: 80,
    energyKwh: 38.5,
    costEur: 7.96,
    socDropped: false,
    peakPowerKw: 11,
    complete: true,
    samples: 60,
    phases: [],
  };

  it('leads with energy and cost', () => {
    expect(buildSessionMessage(s, DE, 'Taycan').message).toContain('38.5 kWh für 7.96 €');
  });

  it('shows the state of charge range', () => {
    expect(buildSessionMessage(s, DE, 'Taycan').message).toContain('34 → 80 %');
  });

  it('separates cable time from actual charging time', () => {
    const m = buildSessionMessage(s, DE, 'Taycan').message;
    expect(m).toContain('10 h 0 min');
    expect(m).toContain('3 h 0 min geladen');
  });

  it('works on a session without energy data', () => {
    expect(() =>
      buildSessionMessage({ ...s, energyKwh: undefined, costEur: undefined }, DE, 'Taycan'),
    ).not.toThrow();
  });
});

describe('msUntilHour', () => {
  it('waits until later the same day', () => {
    const now = new Date(2026, 6, 27, 6, 0);
    expect(msUntilHour(8, now)).toBe(2 * 3600_000);
  });

  it('rolls over to the next day once the hour has passed', () => {
    const now = new Date(2026, 6, 27, 9, 0);
    expect(msUntilHour(8, now)).toBe(23 * 3600_000);
  });

  it('never returns zero or negative at exactly the hour', () => {
    expect(msUntilHour(8, new Date(2026, 6, 27, 8, 0, 0))).toBeGreaterThan(0);
  });
});

describe('sendNotification', () => {
  it('does nothing without a topic', async () => {
    await expect(sendNotification({ server: 'https://ntfy.sh', topic: '' }, 'a', 'b')).resolves.toBe(
      false,
    );
  });

  it('resolves false instead of throwing on an unreachable server', async () => {
    await expect(
      sendNotification({ server: 'http://127.0.0.1:1', topic: 'x' }, 'a', 'b'),
    ).resolves.toBe(false);
  });

  it('resolves false on a malformed server URL', async () => {
    await expect(sendNotification({ server: 'not a url', topic: 'x' }, 'a', 'b')).resolves.toBe(
      false,
    );
  });
});

describe('Push-Meldungen in der eingestellten Sprache', () => {
  // Die Push-Texte waren als einzige im Plugin fest deutsch: Ein Nutzer in
  // England bekam einen englischen Bildschirm und eine deutsche Meldung aufs
  // Telefon. Auch der Fahrzeugname stand hart auf „Taycan", obwohl er
  // konfigurierbar ist.
  const s: ChargeSession = {
    startedAt: '2026-07-26T20:00:00.000Z',
    endedAt: '2026-07-27T06:00:00.000Z',
    durationMin: 600,
    chargingMin: 180,
    startSoc: 34,
    endSoc: 80,
    energyKwh: 38.5,
    costEur: 7.96,
    socDropped: false,
    peakPowerKw: 11,
    complete: true,
    samples: 60,
    phases: [],
  };

  it('titelt die Ladeende-Meldung in beiden Sprachen', () => {
    expect(buildSessionMessage(s, labelsFor('en'), 'Taycan').title).toBe(
      'Taycan — charging finished',
    );
    expect(buildSessionMessage(s, labelsFor('de'), 'Taycan').title).toBe(
      'Taycan — Ladung beendet',
    );
  });

  it('nimmt den konfigurierten Fahrzeugnamen statt eines festen „Taycan"', () => {
    expect(buildSessionMessage(s, labelsFor('en'), 'Macan').title).toContain('Macan');
  });

  it('übersetzt auch den Nachrichtentext', () => {
    const en = buildSessionMessage(s, labelsFor('en'), 'T').message;
    expect(en).toContain('Charge level: 34 → 80 %');
    expect(en).toContain('Plugged in: 10 h 0 min, charging for 3 h 0 min');
    expect(en).not.toMatch(/Ladestand|Am Kabel|Spitze/);
  });
});

describe('Meldung bei misslungenem Laden', () => {
  // Unter Taycan-Fahrern der am häufigsten geäußerte Wunsch — die Porsche-App
  // schickt dazu nichts, auch nicht, wenn die Wallbox nachts aussteigt.
  const basis: ChargeSession = {
    startedAt: '2026-07-26T20:00:00.000Z',
    endedAt: '2026-07-27T06:00:00.000Z',
    durationMin: 600,
    chargingMin: 180,
    startSoc: 34,
    endSoc: 55,
    targetSoc: 80,
    energyKwh: 12.4,
    costEur: 2.56,
    socDropped: false,
    complete: true,
    samples: 60,
    phases: [],
  };

  it('nennt einen Abbruch als solchen, statt ihn „beendet" zu nennen', () => {
    const m = buildSessionMessage({ ...basis, aborted: true }, labelsFor('en'), 'T');
    expect(m.title).toBe('T — charging aborted');
    expect(m.message.split('\n')[0]).toContain('Only 55 % instead of 80 %');
    // Das steckende Kabel unterscheidet den Abbruch vom Ausstecken — und es
    // gehört in die erste Zeile, weil eine Push-Meldung überflogen wird.
    expect(m.message.split('\n')[0]).toMatch(/plugged in/);
  });

  it('lässt die normale Meldung unangetastet', () => {
    const m = buildSessionMessage(basis, labelsFor('en'), 'T');
    expect(m.title).toBe('T — charging finished');
    expect(m.message).not.toContain('instead of');
  });

  it('warnt bei hängender LAUFENDER Ladung, solange sie noch zu retten ist', () => {
    // Das Gegenstück zum rückblickenden Abbruch: Diese Meldung kommt in der
    // Nacht statt am Morgen. Im öffentlichen Zweig fehlte sie bisher ganz.
    const m = buildStallMessage(
      { ...basis, complete: false, stalled: true, durationMin: 200 },
      labelsFor('en'),
      'T',
    );
    expect(m.title).toBe('T — charging stalled');
    expect(m.message).toContain('At 55 %, target 80 %');
    expect(m.message).toContain('3 h 20 min');
  });

  it('findet die hängende Ladung genau einmal', () => {
    const offen = { ...basis, complete: false, stalled: true };
    expect(stalledToWarn([offen], undefined)?.startedAt).toBe(offen.startedAt);
    // Beim zweiten Poll darf sie nicht erneut melden.
    expect(stalledToWarn([offen], offen.startedAt)).toBeUndefined();
  });

  it('warnt nicht ohne hängende Ladung', () => {
    expect(stalledToWarn([basis], undefined)).toBeUndefined();
  });
});

describe('Warnung bei hohem Ruheverlust', () => {
  it('nennt Verlust, Energie und die Beobachtungsdauer', () => {
    // Ohne die Dauer ist die Zahl nicht einzuordnen — und eine Warnung, die
    // man nicht einordnen kann, ignoriert man beim zweiten Mal.
    const m = buildIdleMessage({ socPerDay: 3.4, kwhPerDay: 2.8 }, 6.2, labelsFor('en'), 'T');
    expect(m.title).toBe('T — high idle drain');
    expect(m.message).toContain('3.4 %');
    expect(m.message).toContain('2.8 kWh');
    expect(m.message).toContain('6.2 days');
  });

  it('sagt, was der Fahrer damit anfangen soll', () => {
    // Eine Zahl ohne Handlungshinweis ist eine Beunruhigung, keine Warnung.
    const m = buildIdleMessage({ socPerDay: 5, kwhPerDay: 4.2 }, 9, labelsFor('en'), 'T');
    expect(m.message).toMatch(/workshop/);
    expect(m.message).toMatch(/normal/i);
  });

  it('übersetzt die Warnung', () => {
    const m = buildIdleMessage({ socPerDay: 3.4, kwhPerDay: 2.8 }, 6.2, labelsFor('de'), 'T');
    expect(m.title).toBe('T — hoher Ruheverlust');
    expect(m.message).toContain('Werkstatt');
  });
});
