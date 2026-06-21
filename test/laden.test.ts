import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import * as hap from 'hap-nodejs';

import { createKit, DEFAULT_CONFIG, KitContext, ResolvedPorscheConfig } from '../src/accessories/kit';
import { chargingModule, __testing } from '../src/accessories/charging';
import { PorscheCommand } from '../src/api/commands';
import { VehicleState } from '../src/api/measurements';

/** Minimaler API-Doppel auf Basis von echtem HAP (analog kit.test.ts). */
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

function setup(config: ResolvedPorscheConfig = { ...DEFAULT_CONFIG, language: 'de', detailLevel: 'full' }) {
  const { api, registered } = makeApi();
  const commands: PorscheCommand[] = [];
  const context: KitContext = {
    api,
    log,
    config,
    cachedAccessories: [],
    unlock: async () => {},
    command: async (cmd) => {
      commands.push(cmd);
    },
  };
  const { kit, registerNewAccessories } = createKit(context);
  const apply = chargingModule(kit);
  registerNewAccessories();
  // Jeder Service lebt jetzt auf SEINEM EIGENEN Accessory → über alle
  // registrierten Accessories suchen (statt auf einem geteilten acc).
  const svc = (
    ctor: hap.WithUUID<typeof hap.Service>,
    subtype: string,
  ): hap.Service | undefined => {
    for (const a of registered) {
      const s = a.getServiceById(ctor, subtype);
      if (s) {
        return s;
      }
    }
    return undefined;
  };
  const svcByType = (ctor: hap.WithUUID<typeof hap.Service>): hap.Service | undefined => {
    for (const a of registered) {
      const s = a.getService(ctor);
      if (s) {
        return s;
      }
    }
    return undefined;
  };
  return { kit, apply, commands, registered, svc, svcByType };
}

const C = hap.Characteristic;
const S = hap.Service;

const emptyState = (over: Partial<VehicleState> = {}): VehicleState => ({
  charging: false,
  plugged: false,
  climateOn: false,
  ...over,
});

describe('chargingModule signature + accessory shape', () => {
  it('exposes the DomainModule signature and registers one accessory PER service (13)', () => {
    const { apply, registered, svc } = setup();
    expect(typeof apply).toBe('function');
    // Ein Accessory pro Service: SoC-Dimmer + 5 Sensoren + 3 Flags + Switch +
    // Ladelimit-Lightbulb + Battery + Akku-niedrig-ContactSensor.
    expect(registered).toHaveLength(13);
    // SoC lebt auf seinem eigenen, beschrifteten Accessory.
    const socAcc = registered.find((a) => a.UUID === hap.uuid.generate('taycan-soc'))!;
    expect(socAcc).toBeDefined();
    expect(socAcc.displayName).toBe('Porsche Ladestand');
    expect(socAcc.getServiceById(S.Lightbulb, 'soc')).toBeDefined();
    // Jedes Accessory hat genau EINEN funktionalen Service (+ AccessoryInformation).
    for (const a of registered) {
      const functional = a.services.filter((s) => s.UUID !== S.AccessoryInformation.UUID);
      expect(functional).toHaveLength(1);
    }
    // Der Battery-Service ist via Typ erreichbar (kein Subtyp).
    expect(svc(S.Lightbulb, 'soc')).toBeDefined();
  });

  it('creates all expected charging services (each on its own accessory)', () => {
    const { svc, svcByType } = setup();
    expect(svc(S.Lightbulb, 'soc')).toBeDefined();
    expect(svc(S.LightSensor, 'range')).toBeDefined();
    expect(svc(S.LightSensor, 'chargepower')).toBeDefined();
    expect(svc(S.LightSensor, 'maxchargepower')).toBeDefined();
    expect(svc(S.LightSensor, 'chargeeta')).toBeDefined();
    expect(svc(S.TemperatureSensor, 'chargerate')).toBeDefined();
    expect(svc(S.ContactSensor, 'chargingflag')).toBeDefined();
    expect(svc(S.ContactSensor, 'dcflag')).toBeDefined();
    expect(svc(S.ContactSensor, 'profileflag')).toBeDefined();
    expect(svc(S.Switch, 'chargeswitch')).toBeDefined();
    expect(svc(S.Lightbulb, 'chargelimit')).toBeDefined();
    expect(svcByType(S.Battery)).toBeDefined();
    expect(svc(S.ContactSensor, 'batterylow')).toBeDefined();
  });
});

describe('chargingModule detailLevel gating (essential)', () => {
  const essential = (): ResolvedPorscheConfig => ({ ...DEFAULT_CONFIG, language: 'de', detailLevel: 'essential' });

  it('registers ONLY the essential accessories (soc + range + switch + limit + battery + low-alert)', () => {
    const { registered, svc, svcByType } = setup(essential());
    // 6 Accessories: Ladestand + Reichweite + Laden-Switch + Ladelimit + Akku + Akku-niedrig.
    expect(registered).toHaveLength(6);
    // Essentiell vorhanden.
    expect(svc(S.Lightbulb, 'soc')).toBeDefined();
    expect(svc(S.LightSensor, 'range')).toBeDefined();
    expect(svc(S.Switch, 'chargeswitch')).toBeDefined();
    // Ladelimit + Akku + Akku-niedrig-Alert sind ebenfalls essentiell (Alltags-Automationen).
    expect(svc(S.Lightbulb, 'chargelimit')).toBeDefined();
    expect(svcByType(S.Battery)).toBeDefined();
    expect(svc(S.ContactSensor, 'batterylow')).toBeDefined();
    // Gegatet → im essential-Modus NICHT angelegt.
    expect(svc(S.LightSensor, 'chargepower')).toBeUndefined();
    expect(svc(S.LightSensor, 'maxchargepower')).toBeUndefined();
    expect(svc(S.LightSensor, 'chargeeta')).toBeUndefined();
    expect(svc(S.TemperatureSensor, 'chargerate')).toBeUndefined();
    expect(svc(S.ContactSensor, 'chargingflag')).toBeUndefined();
    expect(svc(S.ContactSensor, 'dcflag')).toBeUndefined();
    expect(svc(S.ContactSensor, 'profileflag')).toBeUndefined();
  });

  it('apply() does not throw when gated services are undefined and updates the essential ones', () => {
    const { apply, svc } = setup(essential());
    // Voller State inkl. der gegateten Felder: Optional-Chaining muss greifen.
    expect(() =>
      apply(
        emptyState({
          soc: 50,
          rangeKm: 300,
          charging: true,
          chargingPowerKw: 11,
          maxChargingPowerKw: 270,
          chargeEtaMinutes: 30,
          chargeRateKmMin: 4.5,
          chargingType: 'DC',
          activeProfileName: 'Zuhause',
          targetSoc: 80,
        }),
      ),
    ).not.toThrow();
    // Essentielle Characteristics wurden trotzdem gesetzt.
    expect(svc(S.Lightbulb, 'soc')!.getCharacteristic(C.Brightness).value).toBe(50);
    expect(svc(S.LightSensor, 'range')!.getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(300);
    expect(svc(S.Switch, 'chargeswitch')!.getCharacteristic(C.On).value).toBe(true);
  });
});

describe('chargingModule update mapping', () => {
  it('maps SoC to HumiditySensor and Battery level', () => {
    const { apply, svc, svcByType } = setup();
    apply(emptyState({ soc: 73.6 }));
    expect(svc(S.Lightbulb, 'soc')!.getCharacteristic(C.Brightness).value).toBe(74);
    expect(svcByType(S.Battery)!.getCharacteristic(C.BatteryLevel).value).toBe(74);
  });

  it('maps range/power/maxPower/eta to LightSensor (>=0.0001)', () => {
    const { apply, svc } = setup();
    apply(emptyState({ rangeKm: 312, chargingPowerKw: 11, maxChargingPowerKw: 270, chargeEtaMinutes: 0 }));
    expect(svc(S.LightSensor, 'range')!.getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(312);
    expect(svc(S.LightSensor, 'chargepower')!.getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(11);
    expect(svc(S.LightSensor, 'maxchargepower')!.getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(270);
    // eta 0 must clamp to 0.0001 (LightSensor cannot be 0).
    expect(svc(S.LightSensor, 'chargeeta')!.getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(0.0001);
  });

  it('maps charge rate (decimal) to TemperatureSensor', () => {
    const { apply, svc } = setup();
    apply(emptyState({ chargeRateKmMin: 4.5 }));
    expect(svc(S.TemperatureSensor, 'chargerate')!.getCharacteristic(C.CurrentTemperature).value).toBe(4.5);
  });

  it('maps charging flag + DC flag + profile flag to ContactSensor states', () => {
    const { apply, svc } = setup();
    apply(emptyState({ charging: true, chargingType: 'DC', activeProfileName: 'Zuhause' }));
    expect(svc(S.ContactSensor, 'chargingflag')!.getCharacteristic(C.ContactSensorState).value)
      .toBe(C.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(svc(S.ContactSensor, 'dcflag')!.getCharacteristic(C.ContactSensorState).value)
      .toBe(C.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(svc(S.ContactSensor, 'profileflag')!.getCharacteristic(C.ContactSensorState).value)
      .toBe(C.ContactSensorState.CONTACT_NOT_DETECTED);

    apply(emptyState({ charging: false, chargingType: 'AC', activeProfileName: undefined }));
    expect(svc(S.ContactSensor, 'chargingflag')!.getCharacteristic(C.ContactSensorState).value)
      .toBe(C.ContactSensorState.CONTACT_DETECTED);
    expect(svc(S.ContactSensor, 'dcflag')!.getCharacteristic(C.ContactSensorState).value)
      .toBe(C.ContactSensorState.CONTACT_DETECTED);
    expect(svc(S.ContactSensor, 'profileflag')!.getCharacteristic(C.ContactSensorState).value)
      .toBe(C.ContactSensorState.CONTACT_DETECTED);
  });

  it('mirrors charging state onto the charge switch', () => {
    const { apply, svc } = setup();
    apply(emptyState({ charging: true }));
    expect(svc(S.Switch, 'chargeswitch')!.getCharacteristic(C.On).value).toBe(true);
    apply(emptyState({ charging: false }));
    expect(svc(S.Switch, 'chargeswitch')!.getCharacteristic(C.On).value).toBe(false);
  });

  it('maps target SoC onto Lightbulb On+Brightness', () => {
    const { apply, svc } = setup();
    const lb = svc(S.Lightbulb, 'chargelimit')!;
    apply(emptyState({ targetSoc: 80 }));
    expect(lb.getCharacteristic(C.On).value).toBe(true);
    expect(lb.getCharacteristic(C.Brightness).value).toBe(80);
    // unknown target → off
    apply(emptyState({ targetSoc: undefined }));
    expect(lb.getCharacteristic(C.On).value).toBe(false);
  });

  it('sets Battery ChargingState + StatusLowBattery from threshold', () => {
    const { apply, svcByType } = setup();
    const bat = svcByType(S.Battery)!;
    apply(emptyState({ soc: 10, charging: true })); // 10 <= 20 default threshold
    expect(bat.getCharacteristic(C.ChargingState).value).toBe(C.ChargingState.CHARGING);
    expect(bat.getCharacteristic(C.StatusLowBattery).value).toBe(C.StatusLowBattery.BATTERY_LEVEL_LOW);
    apply(emptyState({ soc: 55, charging: false }));
    expect(bat.getCharacteristic(C.ChargingState).value).toBe(C.ChargingState.NOT_CHARGING);
    expect(bat.getCharacteristic(C.StatusLowBattery).value).toBe(C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  });

  it('opens the low-battery ContactSensor at/below threshold, closes above', () => {
    const { apply, svc } = setup();
    const cs = svc(S.ContactSensor, 'batterylow')!;
    // 20 <= 20 (default threshold) → offen (NOT_DETECTED = Alert).
    apply(emptyState({ soc: 20 }));
    expect(cs.getCharacteristic(C.ContactSensorState).value).toBe(C.ContactSensorState.CONTACT_NOT_DETECTED);
    // 21 > 20 → geschlossen (DETECTED = ok).
    apply(emptyState({ soc: 21 }));
    expect(cs.getCharacteristic(C.ContactSensorState).value).toBe(C.ContactSensorState.CONTACT_DETECTED);
    // unbekannter SoC → kein Fehlalarm (geschlossen).
    apply(emptyState({ soc: undefined }));
    expect(cs.getCharacteristic(C.ContactSensorState).value).toBe(C.ContactSensorState.CONTACT_DETECTED);
  });
});

describe('chargingModule command wiring', () => {
  it('charge switch on/off sends DIRECT_CHARGING_START / _STOP', async () => {
    const { svc, commands } = setup();
    const on = svc(S.Switch, 'chargeswitch')!.getCharacteristic(C.On);
    on.setValue(true);
    on.setValue(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(commands.map((c) => c.commandName)).toEqual(['DIRECT_CHARGING_START', 'DIRECT_CHARGING_STOP']);
  });

  it('charge limit brightness sends CHARGING_SETTINGS_EDIT{targetSoc}', async () => {
    const { svc, commands } = setup();
    const br = svc(S.Lightbulb, 'chargelimit')!.getCharacteristic(C.Brightness);
    br.setValue(85);
    await new Promise((r) => setTimeout(r, 0));
    const cmd = commands.find((c) => c.commandName === 'CHARGING_SETTINGS_EDIT');
    expect(cmd).toBeDefined();
    expect(cmd!.payload).toEqual({ targetSoc: 85 });
  });

  it('charge limit cannot be switched off (re-enables itself)', async () => {
    const { svc } = setup();
    const onChar = svc(S.Lightbulb, 'chargelimit')!.getCharacteristic(C.On);
    onChar.setValue(false);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(onChar.value).toBe(true);
  });
});

describe('__testing pure helpers', () => {
  it('clampSoc rounds + clamps 0..100', () => {
    expect(__testing.clampSoc(85.4)).toBe(85);
    expect(__testing.clampSoc(150)).toBe(100);
    expect(__testing.clampSoc(-5)).toBe(0);
  });
  it('isDc is case-insensitive and defensive', () => {
    expect(__testing.isDc('DC')).toBe(true);
    expect(__testing.isDc('dc')).toBe(true);
    expect(__testing.isDc('AC')).toBe(false);
    expect(__testing.isDc(undefined)).toBe(false);
  });
  it('hasActiveProfile detects non-empty names', () => {
    expect(__testing.hasActiveProfile('Zuhause')).toBe(true);
    expect(__testing.hasActiveProfile('')).toBe(false);
    expect(__testing.hasActiveProfile(undefined)).toBe(false);
  });
  it('isLow respects threshold boundary (<=)', () => {
    expect(__testing.isLow(20, 20)).toBe(true);
    expect(__testing.isLow(21, 20)).toBe(false);
    expect(__testing.isLow(undefined, 20)).toBe(false);
  });
});

describe('chargingModule vehicleType gating (Strom vs. Sprit)', () => {
  const combustion = (): ResolvedPorscheConfig => ({ ...DEFAULT_CONFIG, language: 'de', vehicleType: 'combustion' });
  const phev = (): ResolvedPorscheConfig => ({ ...DEFAULT_CONFIG, language: 'de', vehicleType: 'phev' });

  it('combustion: Tankstand + Kraftstoff-Reichweite, KEINE Strom-Kacheln', () => {
    const { svc, svcByType } = setup(combustion());
    // Sprit-Kacheln da.
    expect(svc(S.Lightbulb, 'fuel')).toBeDefined();
    expect(svc(S.LightSensor, 'fuelrange')).toBeDefined();
    // Strom-Kacheln fehlen.
    expect(svc(S.Lightbulb, 'soc')).toBeUndefined();
    expect(svc(S.LightSensor, 'range')).toBeUndefined();
    expect(svc(S.Switch, 'chargeswitch')).toBeUndefined();
    expect(svc(S.Lightbulb, 'chargelimit')).toBeUndefined();
    expect(svcByType(S.Battery)).toBeUndefined();
    expect(svc(S.ContactSensor, 'batterylow')).toBeUndefined();
  });

  it('combustion: update spiegelt fuelLevel + fuelRangeKm, wirft nicht ohne EV-Felder', () => {
    const { apply, svc } = setup(combustion());
    expect(() => apply(emptyState({ fuelLevel: 64, fuelRangeKm: 540, soc: undefined }))).not.toThrow();
    expect(svc(S.Lightbulb, 'fuel')!.getCharacteristic(C.Brightness).value).toBe(64);
    expect(svc(S.LightSensor, 'fuelrange')!.getCharacteristic(C.CurrentAmbientLightLevel).value).toBe(540);
  });

  it('phev: sowohl Strom- als auch Sprit-Kacheln vorhanden', () => {
    const { svc, svcByType } = setup(phev());
    expect(svc(S.Lightbulb, 'soc')).toBeDefined();
    expect(svc(S.LightSensor, 'range')).toBeDefined();
    expect(svc(S.Switch, 'chargeswitch')).toBeDefined();
    expect(svcByType(S.Battery)).toBeDefined();
    expect(svc(S.Lightbulb, 'fuel')).toBeDefined();
    expect(svc(S.LightSensor, 'fuelrange')).toBeDefined();
  });
});
