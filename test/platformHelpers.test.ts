import {
  distanceMeters,
  isCarHome,
  lowBattery,
  celsiusToKelvin,
  kelvinToCelsius,
  etaMinutes,
  tireWarn,
  anyOpenUnsecured,
} from '../src/accessories/helpers';
import { VehicleState } from '../src/api/measurements';

/** Baut einen minimalen VehicleState mit überschreibbaren Feldern. */
function state(partial: Partial<VehicleState> = {}): VehicleState {
  return { charging: false, plugged: false, climateOn: false, ...partial };
}

describe('distanceMeters (Haversine)', () => {
  it('returns 0 for identical points', () => {
    expect(distanceMeters(52.0, 13.0, 52.0, 13.0)).toBe(0);
  });

  it('returns roughly 1 km for two points ~1 km apart', () => {
    // 0.009° Breitengrad ≈ 1002 m.
    const d = distanceMeters(52.0, 13.0, 52.009, 13.0);
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1100);
  });

  it('is symmetric', () => {
    const a = distanceMeters(48.137, 11.575, 48.2, 11.6);
    const b = distanceMeters(48.2, 11.6, 48.137, 11.575);
    expect(Math.abs(a - b)).toBeLessThan(1e-6);
  });
});

describe('isCarHome', () => {
  it('is false when the car has no coordinates', () => {
    expect(isCarHome(state(), 52.0, 13.0)).toBe(false);
  });

  it('is false when no home coordinates are configured', () => {
    expect(isCarHome(state({ lat: 52.0, lon: 13.0 }))).toBe(false);
  });

  it('is true when the car is within the radius', () => {
    // ~11 m vom Zuhause entfernt → klar innerhalb 150 m.
    expect(isCarHome(state({ lat: 52.0001, lon: 13.0 }), 52.0, 13.0)).toBe(true);
  });

  it('is false when the car is outside the radius', () => {
    // ~1113 m entfernt → außerhalb 150 m.
    expect(isCarHome(state({ lat: 52.01, lon: 13.0 }), 52.0, 13.0)).toBe(false);
  });

  it('respects a custom radius', () => {
    const s = state({ lat: 52.0001, lon: 13.0 }); // ~11 m
    expect(isCarHome(s, 52.0, 13.0, 5)).toBe(false);
    expect(isCarHome(s, 52.0, 13.0, 50)).toBe(true);
  });
});

describe('lowBattery', () => {
  it('is false for undefined soc', () => {
    expect(lowBattery(undefined)).toBe(false);
  });

  it('is true below 15 %', () => {
    expect(lowBattery(14)).toBe(true);
    expect(lowBattery(0)).toBe(true);
  });

  it('is false at or above 15 %', () => {
    expect(lowBattery(15)).toBe(false);
    expect(lowBattery(80)).toBe(false);
  });
});

describe('celsiusToKelvin / kelvinToCelsius', () => {
  it('converts 21 °C → 294.15 K', () => {
    expect(celsiusToKelvin(21)).toBe(294.15);
  });
  it('converts 295.15 K → 22 °C', () => {
    expect(kelvinToCelsius(295.15)).toBe(22);
  });
  it('is roundtrip-stable on whole degrees', () => {
    expect(kelvinToCelsius(celsiusToKelvin(20))).toBe(20);
  });
});

describe('etaMinutes', () => {
  const now = Date.parse('2026-06-18T12:00:00Z');
  it('returns minutes until a future ISO time', () => {
    expect(etaMinutes('2026-06-18T13:30:00Z', now)).toBe(90);
  });
  it('clamps past times to 0', () => {
    expect(etaMinutes('2026-06-18T11:00:00Z', now)).toBe(0);
  });
  it('returns undefined for missing/invalid ISO', () => {
    expect(etaMinutes(undefined, now)).toBeUndefined();
    expect(etaMinutes('not-a-date', now)).toBeUndefined();
  });
});

describe('tireWarn', () => {
  it('warns when |diff| >= threshold', () => {
    expect(tireWarn(0.3, 0.3)).toBe(true);
    expect(tireWarn(-0.4, 0.3)).toBe(true);
  });
  it('does not warn below threshold', () => {
    expect(tireWarn(0.2, 0.3)).toBe(false);
    expect(tireWarn(-0.1, 0.3)).toBe(false);
  });
  it('does not warn for undefined/NaN', () => {
    expect(tireWarn(undefined, 0.3)).toBe(false);
    expect(tireWarn(NaN, 0.3)).toBe(false);
  });
});

describe('anyOpenUnsecured', () => {
  it('is false for a fully closed + locked car', () => {
    expect(
      anyOpenUnsecured(
        state({
          locked: true,
          doors: { fl: false, fr: false, rl: false, rr: false },
          windows: { fl: false, fr: false, rl: false, rr: false },
          frunkOpen: false,
          trunkOpen: false,
        }),
      ),
    ).toBe(false);
  });
  it('is true when a door is open', () => {
    expect(anyOpenUnsecured(state({ doors: { fl: true, fr: false, rl: false, rr: false } }))).toBe(true);
  });
  it('is true when a window is open', () => {
    expect(anyOpenUnsecured(state({ windows: { fl: false, fr: false, rl: false, rr: true } }))).toBe(true);
  });
  it('is true when frunk or trunk is open', () => {
    expect(anyOpenUnsecured(state({ frunkOpen: true }))).toBe(true);
    expect(anyOpenUnsecured(state({ trunkOpen: true }))).toBe(true);
  });
  it('is true when the car is unlocked', () => {
    expect(anyOpenUnsecured(state({ locked: false }))).toBe(true);
  });
  it('is false when nothing is known', () => {
    expect(anyOpenUnsecured(state())).toBe(false);
  });
});
