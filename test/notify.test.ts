import {
  buildDailyMessage,
  buildSessionMessage,
  msUntilHour,
  sendNotification,
} from '../src/notify';
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
    const m = buildDailyMessage(days, undefined, EFF);
    expect(m.message).toContain('42.1 kWh');
    expect(m.message).not.toContain('5.0 kWh');
  });

  it('says so plainly when there was no charge', () => {
    const days = [bucket({ kwh: 0 }), bucket({ key: '2026-07-27', kwh: 0 })];
    expect(buildDailyMessage(days, undefined, EFF).message).toContain('keine Ladung');
  });

  it('includes the running month', () => {
    const days = [bucket(), bucket({ key: '2026-07-27' })];
    const month = bucket({ key: '2026-07', from: '', label: 'Juli 2026', kwh: 310, cost: 64.1 });
    expect(buildDailyMessage(days, month, EFF).message).toContain('Juli 2026: 310.0 kWh');
  });

  it('includes the efficiency figures', () => {
    const m = buildDailyMessage([bucket(), bucket()], undefined, EFF);
    expect(m.message).toContain('20.0 kWh/100 km');
    expect(m.message).toContain('4.1 ct/km');
  });

  it('omits efficiency when nothing was driven', () => {
    const m = buildDailyMessage([bucket(), bucket()], undefined, { kwh: 0, km: 0, cost: 0, costGross: 0, saved: 0 });
    expect(m.message).not.toContain('Schnitt');
  });

  it('survives a single day of data without crashing', () => {
    expect(() => buildDailyMessage([bucket()], undefined, EFF)).not.toThrow();
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
    expect(buildSessionMessage(s).message).toContain('38.5 kWh für 7.96 €');
  });

  it('shows the state of charge range', () => {
    expect(buildSessionMessage(s).message).toContain('34 → 80 %');
  });

  it('separates cable time from actual charging time', () => {
    const m = buildSessionMessage(s).message;
    expect(m).toContain('10 h 0 min');
    expect(m).toContain('3 h 0 min geladen');
  });

  it('works on a session without energy data', () => {
    expect(() =>
      buildSessionMessage({ ...s, energyKwh: undefined, costEur: undefined }),
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
