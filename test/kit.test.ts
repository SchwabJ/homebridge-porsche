import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import * as hap from 'hap-nodejs';

import {
  createKit,
  resolveConfig,
  DEFAULT_CONFIG,
  KitContext,
  ResolvedPorscheConfig,
} from '../src/accessories/kit';
import { PorscheCommand } from '../src/api/commands';

/** Baut einen minimalen, aber funktionsfähigen API-Doppel auf Basis von echtem HAP. */
function makeApi() {
  const registered: PlatformAccessory[] = [];
  const api = {
    hap: hap as unknown as import('homebridge').HAP,
    platformAccessory: PlatformAccessory as unknown as typeof import('homebridge').PlatformAccessory,
    registerPlatformAccessories: (_p: string, _n: string, accs: PlatformAccessory[]) => {
      registered.push(...accs);
    },
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  } as unknown as import('homebridge').API;
  return { api, registered };
}

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  log: () => {},
  success: () => {},
} as unknown as import('homebridge').Logging;

function ctx(overrides: Partial<KitContext> = {}): {
  context: KitContext;
  registered: PlatformAccessory[];
  commands: PorscheCommand[];
} {
  const { api, registered } = makeApi();
  const commands: PorscheCommand[] = [];
  const context: KitContext = {
    api,
    log,
    config: DEFAULT_CONFIG,
    cachedAccessories: [],
    unlock: async () => {},
    command: async (cmd) => {
      commands.push(cmd);
    },
    ...overrides,
  };
  return { context, registered, commands };
}

describe('resolveConfig', () => {
  it('returns all defaults for empty input', () => {
    expect(resolveConfig({})).toEqual<ResolvedPorscheConfig>(DEFAULT_CONFIG);
    expect(resolveConfig(null)).toEqual<ResolvedPorscheConfig>(DEFAULT_CONFIG);
    expect(resolveConfig(undefined)).toEqual<ResolvedPorscheConfig>(DEFAULT_CONFIG);
  });

  it('uses spec defaults for home coords and thresholds', () => {
    const c = resolveConfig({});
    expect(c.homeLat).toBe(0);
    expect(c.homeLon).toBe(0);
    expect(c.homeRadiusM).toBe(150);
    expect(c.climateControlMode).toBe('both');
    expect(c.defaultTargetTemp).toBe(21);
    expect(c.lowBatteryThreshold).toBe(20);
    expect(c.serviceWarnKm).toBe(2000);
    expect(c.tireDiffThreshold).toBe(0.3);
    expect(c.staleMinutes).toBe(30);
    expect(c.heatingAutoOffMinutes).toBe(15);
    expect(c.honkAutoOffSeconds).toBe(3);
    expect(c.exposeClimateZones).toBe(true);
    expect(c.exposeTheftSensor).toBe(false);
  });

  it('overrides values and validates climateControlMode', () => {
    const c = resolveConfig({ homeLat: 1.5, climateControlMode: 'switch', exposeTheftSensor: true });
    expect(c.homeLat).toBe(1.5);
    expect(c.climateControlMode).toBe('switch');
    expect(c.exposeTheftSensor).toBe(true);
  });

  it('falls back to default on invalid climateControlMode', () => {
    expect(resolveConfig({ climateControlMode: 'nonsense' }).climateControlMode).toBe('both');
  });

  it('treats empty vin as undefined', () => {
    expect(resolveConfig({ vin: '' }).vin).toBeUndefined();
    expect(resolveConfig({ vin: 'WP0X' }).vin).toBe('WP0X');
  });
});

describe('Kit.accessory (get-or-create + register)', () => {
  it('creates and registers a new accessory once', () => {
    const { context, registered } = ctx();
    const { kit, registerNewAccessories } = createKit(context);

    const a1 = kit.accessory('Taycan', 'Taycan');
    const a2 = kit.accessory('Taycan', 'Taycan'); // same seed → same instance
    expect(a1).toBe(a2);

    registerNewAccessories();
    expect(registered).toHaveLength(1);
    expect(registered[0].UUID).toBe(hap.uuid.generate('Taycan'));

    // second call must not re-register.
    registerNewAccessories();
    expect(registered).toHaveLength(1);
  });

  it('reuses a cached accessory and does not register it', () => {
    const cached = new PlatformAccessory('Taycan', hap.uuid.generate('Taycan')) as unknown as PlatformAccessory;
    const { context, registered } = ctx({ cachedAccessories: [cached] });
    const { kit, registerNewAccessories } = createKit(context);

    const a = kit.accessory('Taycan', 'Taycan');
    expect(a).toBe(cached);
    registerNewAccessories();
    expect(registered).toHaveLength(0);
  });

  it('gives distinct seeds distinct UUIDs', () => {
    const { context } = ctx();
    const { kit } = createKit(context);
    const a = kit.accessory('Taycan', 'Taycan');
    const b = kit.accessory('Taycan Reifen', 'Taycan Reifen');
    expect(a.UUID).not.toBe(b.UUID);
  });
});

describe('Kit service factories', () => {
  function setup() {
    const { context, commands } = ctx();
    const { kit } = createKit(context);
    const acc = kit.accessory('Taycan', 'Taycan');
    return { kit, acc, commands };
  }

  it('percentSensor clamps and rounds 0..100', () => {
    const { kit, acc } = setup();
    const b = kit.percentSensor(acc, 'SoC', 'soc');
    const char = b.service.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity);
    b.update(52.6);
    expect(char.value).toBe(53);
    b.update(150);
    expect(char.value).toBe(100);
    b.update(-5);
    expect(char.value).toBe(0);
  });

  it('luxSensor clamps to >= 0.0001 and never 0', () => {
    const { kit, acc } = setup();
    const b = kit.luxSensor(acc, 'Range', 'range');
    const char = b.service.getCharacteristic(hap.Characteristic.CurrentAmbientLightLevel);
    b.update(199);
    expect(char.value).toBe(199);
    b.update(0);
    expect(char.value).toBe(0.0001);
  });

  it('tempSensor passes decimals through', () => {
    const { kit, acc } = setup();
    const b = kit.tempSensor(acc, 'Tire FL', 'tirefl');
    const char = b.service.getCharacteristic(hap.Characteristic.CurrentTemperature);
    b.update(2.5);
    expect(char.value).toBe(2.5);
  });

  it('contactSensor maps true=open=NOT_DETECTED, false=ok=DETECTED', () => {
    const { kit, acc } = setup();
    const b = kit.contactSensor(acc, 'Door FL', 'doorfl');
    const char = b.service.getCharacteristic(hap.Characteristic.ContactSensorState);
    b.update(true);
    expect(char.value).toBe(hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    b.update(false);
    expect(char.value).toBe(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
  });

  it('contactSensor with fault option adds StatusFault characteristic', () => {
    const { kit, acc } = setup();
    const b = kit.contactSensor(acc, 'Tire warn', 'tirewarn', { fault: true });
    expect(b.service.testCharacteristic(hap.Characteristic.StatusFault)).toBe(true);
  });

  it('occupancySensor maps presence', () => {
    const { kit, acc } = setup();
    const b = kit.occupancySensor(acc, 'Home', 'home');
    const char = b.service.getCharacteristic(hap.Characteristic.OccupancyDetected);
    b.update(true);
    expect(char.value).toBe(hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
    b.update(false);
    expect(char.value).toBe(hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  it('switchService onSet fires the handler', async () => {
    const { kit, acc } = setup();
    const seen: boolean[] = [];
    const b = kit.switchService(acc, 'Climate', 'climate', {
      onSet: (on) => {
        seen.push(on);
      },
    });
    const char = b.service.getCharacteristic(hap.Characteristic.On);
    char.setValue(true);
    char.setValue(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([true, false]);
  });

  it('momentary switch auto-resets to off after momentaryMs', async () => {
    // legacyFakeTimers lets us advanceTimersByTime while still awaiting real microtasks,
    // so we can both (a) let HAP commit the `true` value and (b) discriminate the reset.
    jest.useFakeTimers({ legacyFakeTimers: true } as never);
    try {
      const { kit, acc } = setup();
      const b = kit.switchService(acc, 'Honk', 'honk', { onSet: () => {}, momentaryMs: 3000 });
      const char = b.service.getCharacteristic(hap.Characteristic.On);
      // simulate the user flipping the switch on (triggers onSet + arms the reset timer).
      char.setValue(true);
      await Promise.resolve(); // let HAP commit the displayed value to true
      expect(char.value).toBe(true);
      jest.advanceTimersByTime(3000);
      // momentary auto-off must have written the displayed value back to false.
      expect(char.value).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('multiple services with distinct subtypes coexist on one accessory', () => {
    const { kit, acc } = setup();
    const a = kit.percentSensor(acc, 'SoC', 'soc');
    const b = kit.percentSensor(acc, 'Target SoC', 'targetsoc');
    expect(a.service).not.toBe(b.service);
    // re-creating with the same subtype returns the same service.
    const a2 = kit.percentSensor(acc, 'SoC', 'soc');
    expect(a2.service).toBe(a.service);
  });
});
