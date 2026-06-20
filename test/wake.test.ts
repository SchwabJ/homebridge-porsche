import { clampPollInterval, buildMeasurementUrl } from '../src/wake';

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
