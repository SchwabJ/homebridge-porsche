import {
  clampPollInterval,
  buildMeasurementUrl,
  effectivePollMinutes,
} from '../src/wake';

describe('clampPollInterval', () => {
  it('raises a value below the floor up to 10', () => {
    expect(clampPollInterval(5)).toBe(10);
  });

  it('keeps a value above the floor unchanged', () => {
    expect(clampPollInterval(15)).toBe(15);
  });

  it('treats 0 as 10 (never poll faster than the 12V-safe floor)', () => {
    expect(clampPollInterval(0)).toBe(10);
  });

  it('keeps the floor value of 10 unchanged', () => {
    expect(clampPollInterval(10)).toBe(10);
  });
});

describe('effectivePollMinutes', () => {
  const fresh = { dataAgeMinutes: 1 };

  it('uses the plugged-in interval by default while charging', () => {
    expect(effectivePollMinutes(30, { ...fresh, charging: true, plugged: true })).toBe(1);
  });

  it('uses the SAME fast interval while merely plugged in, not charging', () => {
    // Tariff pauses can be 15 minutes; at the configured 30 an entire slot
    // would be missed. This is the case that matters most.
    expect(effectivePollMinutes(30, { ...fresh, charging: false, plugged: true })).toBe(1);
  });

  it('honours a custom plugged-in interval', () => {
    expect(effectivePollMinutes(30, { ...fresh, plugged: true, pluggedMinutes: 2 })).toBe(2);
  });

  it('caps the interval while actively charging', () => {
    // A lazily configured 10 must not slow down an active charge.
    expect(
      effectivePollMinutes(30, { ...fresh, charging: true, plugged: true, pluggedMinutes: 10 }),
    ).toBe(1);
  });

  it('never polls faster than once a minute', () => {
    expect(effectivePollMinutes(30, { ...fresh, plugged: true, pluggedMinutes: 0 })).toBe(1);
    expect(effectivePollMinutes(30, { ...fresh, plugged: true, pluggedMinutes: -5 })).toBe(1);
  });

  it('keeps the regular interval when unplugged', () => {
    expect(effectivePollMinutes(30, { ...fresh, charging: false, plugged: false })).toBe(30);
  });

  it('keeps the regular interval when the state is unknown', () => {
    expect(effectivePollMinutes(30, fresh)).toBe(30);
  });

  it('does NOT speed up on stale data, even while plugged in', () => {
    // Core guard: a frozen cache must not keep a parked car in fast-poll.
    expect(effectivePollMinutes(30, { charging: true, plugged: true, dataAgeMinutes: 60 })).toBe(30);
  });

  it('does NOT speed up when the data age is unknown', () => {
    expect(effectivePollMinutes(30, { charging: true, plugged: true })).toBe(30);
  });

  it('falls back to the regular interval while rate limited', () => {
    // Repeated 429s risk a captcha lockout, which would force a new login.
    expect(
      effectivePollMinutes(30, { ...fresh, charging: true, plugged: true, rateLimited: true }),
    ).toBe(30);
  });

  it('still speeds up right at the freshness boundary', () => {
    expect(effectivePollMinutes(30, { charging: true, dataAgeMinutes: 15 })).toBe(1);
  });

  it('never exceeds the configured interval', () => {
    // A 2-minute configured interval is clamped to 10 by the 12V floor first.
    expect(effectivePollMinutes(2, { ...fresh, plugged: true, pluggedMinutes: 30 })).toBe(10);
  });

  it('defaults to the regular interval with no state at all', () => {
    expect(effectivePollMinutes(30)).toBe(30);
  });
});

describe('buildMeasurementUrl', () => {
  it('builds the cached measurement URL with mf query params', () => {
    expect(buildMeasurementUrl('WP0ZZZ', ['BATTERY_LEVEL', 'E_RANGE'])).toBe(
      '/connect/v1/vehicles/WP0ZZZ?mf=BATTERY_LEVEL&mf=E_RANGE',
    );
  });

  it('NEVER contains wakeUpJob (core 12V safety guarantee)', () => {
    const url = buildMeasurementUrl('WP0ZZZ', ['BATTERY_LEVEL', 'E_RANGE']);
    expect(url).not.toContain('wakeUpJob');
  });

  it('throws on an empty key list', () => {
    expect(() => buildMeasurementUrl('WP0ZZZ', [])).toThrow();
  });
});
