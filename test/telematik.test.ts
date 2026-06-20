import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import * as hap from 'hap-nodejs';

import { createKit, DEFAULT_CONFIG, KitContext, ResolvedPorscheConfig } from '../src/accessories/kit';
import { telemetryModule } from '../src/accessories/telemetry';
import { VehicleState } from '../src/api/measurements';

/** Minimaler API-Doppel auf Basis von echtem HAP (wie in kit.test.ts). */
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

/** Baut Kit + verdrahtetes Telemetrie-Modul; gibt die accessory-Lookup-Funktion zurück. */
function setup(configOverrides: Partial<ResolvedPorscheConfig> = {}) {
  // Voll-Set-Tests laufen im 'full'-Modus (Default-Config ist jetzt 'essential').
  // detailLevel VOR den Overrides → einzelne Tests können auf 'essential' umstellen.
  // Heim-Koordinaten = Test-Fahrzeugposition (München), da der Default 0/0 ist
  // („Auto zuhause" deaktiviert) — sonst schlügen die at-home-Tests fehl.
  const config: ResolvedPorscheConfig = {
    ...DEFAULT_CONFIG,
    detailLevel: 'full',
    homeLat: 48.137154,
    homeLon: 11.576124,
    ...configOverrides,
  };
  const { api, registered } = makeApi();
  const ctx: KitContext = {
    api,
    log,
    config,
    cachedAccessories: [],
    unlock: async () => {},
    command: async () => {},
  };
  const { kit, registerNewAccessories } = createKit(ctx);
  const apply = telemetryModule(kit);
  registerNewAccessories();

  const C = hap.Characteristic;
  // Jeder Sensor lebt auf SEINEM EIGENEN Accessory → über alle registrierten
  // Accessories nach dem Service suchen (Subtypen bleiben eindeutig).
  const get = (ctor: hap.WithUUID<typeof hap.Service>, subtype: string): hap.Service => {
    for (const a of registered) {
      const s = a.getServiceById(ctor, subtype);
      if (s) {
        return s;
      }
    }
    throw new Error(`Service ${subtype} nicht gefunden`);
  };
  const accBySeed = (seed: string): PlatformAccessory | undefined =>
    registered.find((a) => a.UUID === hap.uuid.generate(seed));

  return { kit, apply, C, get, registered, accBySeed };
}

/** Vollständiger State; einzelne Felder per Override anpassbar. */
function fullState(overrides: Partial<VehicleState> = {}): VehicleState {
  return {
    charging: false,
    plugged: false,
    climateOn: false,
    tirePressureBar: { fl: 2.5, fr: 2.6, rl: 2.7, rr: 2.8 },
    tireDiffBar: { fl: 0.0, fr: 0.1, rl: 0.4, rr: -0.5 },
    odometerKm: 12345,
    serviceKm: 5000,
    lat: 48.137154,
    lon: 11.576124,
    heading: 180,
    parkingBrake: true,
    parkingLight: false,
    privacyMode: false,
    remoteAccess: true,
    dataTimestamp: Date.now(),
    ...overrides,
  };
}

describe('telemetryModule: tire pressures', () => {
  it('maps the four pressures to TemperatureSensor values (bar, decimals kept)', () => {
    const { apply, C, get } = setup();
    apply(fullState());
    // HAP rundet CurrentTemperature auf den minStep (0.1) → Float-Artefakte, daher toBeCloseTo.
    expect(get(hap.Service.TemperatureSensor, 'tire-press-fl').getCharacteristic(C.CurrentTemperature).value as number).toBeCloseTo(2.5, 5);
    expect(get(hap.Service.TemperatureSensor, 'tire-press-fr').getCharacteristic(C.CurrentTemperature).value as number).toBeCloseTo(2.6, 5);
    expect(get(hap.Service.TemperatureSensor, 'tire-press-rl').getCharacteristic(C.CurrentTemperature).value as number).toBeCloseTo(2.7, 5);
    expect(get(hap.Service.TemperatureSensor, 'tire-press-rr').getCharacteristic(C.CurrentTemperature).value as number).toBeCloseTo(2.8, 5);
  });

  it('does not throw and keeps prior values when tire data missing', () => {
    const { apply, C, get } = setup();
    apply(fullState());
    expect(() => apply(fullState({ tirePressureBar: undefined, tireDiffBar: undefined }))).not.toThrow();
    // last value held
    expect(get(hap.Service.TemperatureSensor, 'tire-press-fl').getCharacteristic(C.CurrentTemperature).value).toBe(2.5);
  });
});

describe('telemetryModule: tire warnings + StatusFault', () => {
  it('warns per tire when |differenceBar| >= tireDiffThreshold (0.3)', () => {
    const { apply, C, get } = setup(); // threshold 0.3
    apply(fullState()); // diffs: fl 0.0 ok, fr 0.1 ok, rl 0.4 warn, rr -0.5 warn
    const ND = C.ContactSensorState.CONTACT_NOT_DETECTED;
    const D = C.ContactSensorState.CONTACT_DETECTED;
    expect(get(hap.Service.ContactSensor, 'tire-warn-fl').getCharacteristic(C.ContactSensorState).value).toBe(D);
    expect(get(hap.Service.ContactSensor, 'tire-warn-fr').getCharacteristic(C.ContactSensorState).value).toBe(D);
    expect(get(hap.Service.ContactSensor, 'tire-warn-rl').getCharacteristic(C.ContactSensorState).value).toBe(ND);
    expect(get(hap.Service.ContactSensor, 'tire-warn-rr').getCharacteristic(C.ContactSensorState).value).toBe(ND);
  });

  it('sets StatusFault GENERAL_FAULT for a warning tire and NO_FAULT for an ok tire', () => {
    const { apply, C, get } = setup();
    apply(fullState());
    expect(get(hap.Service.ContactSensor, 'tire-warn-rl').getCharacteristic(C.StatusFault).value).toBe(C.StatusFault.GENERAL_FAULT);
    expect(get(hap.Service.ContactSensor, 'tire-warn-fl').getCharacteristic(C.StatusFault).value).toBe(C.StatusFault.NO_FAULT);
  });

  it('collective tire warning is the OR of the four', () => {
    const { apply, C, get } = setup();
    const ND = C.ContactSensorState.CONTACT_NOT_DETECTED;
    const D = C.ContactSensorState.CONTACT_DETECTED;
    apply(fullState()); // rl/rr warn → collective warn
    expect(get(hap.Service.ContactSensor, 'tire-warn-any').getCharacteristic(C.ContactSensorState).value).toBe(ND);
    apply(fullState({ tireDiffBar: { fl: 0.0, fr: 0.1, rl: 0.0, rr: 0.0 } })); // none warn
    expect(get(hap.Service.ContactSensor, 'tire-warn-any').getCharacteristic(C.ContactSensorState).value).toBe(D);
    expect(get(hap.Service.ContactSensor, 'tire-warn-any').getCharacteristic(C.StatusFault).value).toBe(C.StatusFault.NO_FAULT);
  });

  it('respects a custom tireDiffThreshold', () => {
    const { apply, C, get } = setup({ tireDiffThreshold: 0.05 });
    apply(fullState()); // fr 0.1 now warns
    expect(get(hap.Service.ContactSensor, 'tire-warn-fr').getCharacteristic(C.ContactSensorState).value).toBe(C.ContactSensorState.CONTACT_NOT_DETECTED);
  });
});

describe('telemetryModule: status accessory', () => {
  it('maps odometer and service-km to LightSensor', () => {
    const { apply, C, get } = setup();
    apply(fullState({ odometerKm: 12345, serviceKm: 5000 }));
    expect(get(hap.Service.LightSensor, 'odometer').getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(12345);
    expect(get(hap.Service.LightSensor, 'service-km').getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(5000);
  });

  it('service warning fires when serviceKm <= serviceWarnKm and sets StatusFault', () => {
    const { apply, C, get } = setup({ serviceWarnKm: 2000 });
    const svc = () => get(hap.Service.ContactSensor, 'service-warn');
    apply(fullState({ serviceKm: 5000 })); // ok
    expect(svc().getCharacteristic(C.ContactSensorState).value).toBe(C.ContactSensorState.CONTACT_DETECTED);
    expect(svc().getCharacteristic(C.StatusFault).value).toBe(C.StatusFault.NO_FAULT);
    apply(fullState({ serviceKm: 1500 })); // warn
    expect(svc().getCharacteristic(C.ContactSensorState).value).toBe(C.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(svc().getCharacteristic(C.StatusFault).value).toBe(C.StatusFault.GENERAL_FAULT);
  });

  it('car-home occupancy + distance: at home', () => {
    const { apply, C, get } = setup();
    apply(fullState({ lat: 48.137154, lon: 11.576124 }));
    expect(get(hap.Service.OccupancySensor, 'car-home').getCharacteristic(C.OccupancyDetected).value).toBe(C.OccupancyDetected.OCCUPANCY_DETECTED);
    // distance ~0 → clamped to lux minimum
    expect(get(hap.Service.LightSensor, 'dist-home').getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(0.0001);
  });

  it('car-home occupancy: away and distance > 0', () => {
    const { apply, C, get } = setup();
    apply(fullState({ lat: 50.0, lon: 8.0 }));
    expect(get(hap.Service.OccupancySensor, 'car-home').getCharacteristic(C.OccupancyDetected).value).toBe(C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    expect((get(hap.Service.LightSensor, 'dist-home').getCharacteristic(C.CurrentAmbientLightLevel).value as number)).toBeGreaterThan(1000);
  });

  it('car-home is not-detected when position missing', () => {
    const { apply, C, get } = setup();
    apply(fullState({ lat: undefined, lon: undefined }));
    expect(get(hap.Service.OccupancySensor, 'car-home').getCharacteristic(C.OccupancyDetected).value).toBe(C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  it('heading maps to LightSensor (and clamps 0 to lux minimum)', () => {
    const { apply, C, get } = setup();
    apply(fullState({ heading: 180 }));
    expect(get(hap.Service.LightSensor, 'heading').getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(180);
    apply(fullState({ heading: 0 }));
    expect(get(hap.Service.LightSensor, 'heading').getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(0.0001);
  });

  it('discrete flags map true->NOT_DETECTED, false/undefined->DETECTED', () => {
    const { apply, C, get } = setup();
    const D = C.ContactSensorState.CONTACT_DETECTED;
    const ND = C.ContactSensorState.CONTACT_NOT_DETECTED;
    apply(fullState({ parkingBrake: true, parkingLight: false, privacyMode: undefined, remoteAccess: true }));
    expect(get(hap.Service.ContactSensor, 'parking-brake').getCharacteristic(C.ContactSensorState).value).toBe(ND);
    expect(get(hap.Service.ContactSensor, 'parking-light').getCharacteristic(C.ContactSensorState).value).toBe(D);
    expect(get(hap.Service.ContactSensor, 'privacy').getCharacteristic(C.ContactSensorState).value).toBe(D);
    expect(get(hap.Service.ContactSensor, 'remote-access').getCharacteristic(C.ContactSensorState).value).toBe(ND);
  });

  it('data-stale warns when timestamp older than staleMinutes', () => {
    const { apply, C, get } = setup({ staleMinutes: 30 });
    const svc = () => get(hap.Service.ContactSensor, 'data-stale');
    apply(fullState({ dataTimestamp: Date.now() }));
    expect(svc().getCharacteristic(C.ContactSensorState).value).toBe(C.ContactSensorState.CONTACT_DETECTED);
    expect(svc().getCharacteristic(C.StatusFault).value).toBe(C.StatusFault.NO_FAULT);
    apply(fullState({ dataTimestamp: Date.now() - 60 * 60000 })); // 60 min old
    expect(svc().getCharacteristic(C.ContactSensorState).value).toBe(C.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(svc().getCharacteristic(C.StatusFault).value).toBe(C.StatusFault.GENERAL_FAULT);
  });
});

describe('telemetryModule: structure + robustness', () => {
  it('uses vehicleName prefix for per-service accessory display names', () => {
    const { accBySeed } = setup({ vehicleName: 'Mein Taycan' });
    // Jeder Sensor hat ein eigenes, beschriftetes Accessory (eigene Kachel).
    expect(accBySeed('taycan-tire-fl')!.displayName).toBe('Mein Taycan Reifendruck VL');
    expect(accBySeed('taycan-odometer')!.displayName).toBe('Mein Taycan Kilometerstand');
    expect(accBySeed('taycan-car-home')!.displayName).toBe('Mein Taycan Auto zuhause');
  });

  it('registers exactly one accessory per sensor (20), each with one functional service', () => {
    const { registered } = setup();
    expect(registered).toHaveLength(20);
    const Info = hap.Service.AccessoryInformation.UUID;
    for (const a of registered) {
      const functional = a.services.filter((s) => s.UUID !== Info);
      expect(functional).toHaveLength(1);
    }
  });

  it('handles a near-empty state without throwing', () => {
    const { apply } = setup();
    const minimal: VehicleState = { charging: false, plugged: false, climateOn: false };
    expect(() => apply(minimal)).not.toThrow();
  });
});

describe('telemetryModule: detailLevel gating', () => {
  it("essential mode registers ONLY the car-home occupancy accessory (1), gated sensors absent", () => {
    const { registered, accBySeed } = setup({ detailLevel: 'essential' });
    // Essentiell: genau ein Accessory (Auto zuhause).
    expect(registered).toHaveLength(1);
    expect(accBySeed('taycan-car-home')).toBeDefined();
    // Gegatet → NICHT angelegt (Stichproben über alle Gruppen).
    expect(accBySeed('taycan-tire-fl')).toBeUndefined();
    expect(accBySeed('taycan-tire-warn-fl')).toBeUndefined();
    expect(accBySeed('taycan-tire-warn')).toBeUndefined();
    expect(accBySeed('taycan-odometer')).toBeUndefined();
    expect(accBySeed('taycan-service-km')).toBeUndefined();
    expect(accBySeed('taycan-service-warn')).toBeUndefined();
    expect(accBySeed('taycan-dist-home')).toBeUndefined();
    expect(accBySeed('taycan-heading')).toBeUndefined();
    expect(accBySeed('taycan-parking-brake')).toBeUndefined();
    expect(accBySeed('taycan-parking-light')).toBeUndefined();
    expect(accBySeed('taycan-privacy')).toBeUndefined();
    expect(accBySeed('taycan-remote-access')).toBeUndefined();
    expect(accBySeed('taycan-data-stale')).toBeUndefined();
  });

  it('essential mode: car-home still updates and apply() does not throw (optional-chaining guards)', () => {
    const { apply, C, get } = setup({ detailLevel: 'essential' });
    // apply() referenziert die gegateten (undefined) Variablen — Guards müssen greifen.
    expect(() => apply(fullState({ lat: 48.137154, lon: 11.576124 }))).not.toThrow();
    // carHome bleibt funktional.
    expect(get(hap.Service.OccupancySensor, 'car-home').getCharacteristic(C.OccupancyDetected).value).toBe(C.OccupancyDetected.OCCUPANCY_DETECTED);
    // Auch ein Away-State darf nicht werfen.
    expect(() => apply(fullState({ lat: 50.0, lon: 8.0 }))).not.toThrow();
    expect(get(hap.Service.OccupancySensor, 'car-home').getCharacteristic(C.OccupancyDetected).value).toBe(C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  it('essential mode: a near-empty state also does not throw', () => {
    const { apply } = setup({ detailLevel: 'essential' });
    const minimal: VehicleState = { charging: false, plugged: false, climateOn: false };
    expect(() => apply(minimal)).not.toThrow();
  });
});
