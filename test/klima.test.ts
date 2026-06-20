import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import * as hap from 'hap-nodejs';

import { createKit, DEFAULT_CONFIG, KitContext, ResolvedTaycanConfig } from '../src/accessories/kit';
import { PorscheCommand } from '../src/api/commands';
import { VehicleState } from '../src/api/measurements';
import { climateModule } from '../src/accessories/climate';

/** Minimaler, funktionsfähiger API-Doppel auf Basis von echtem HAP (wie kit.test.ts). */
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

/** Baut Kit + Modul und liefert Zugriff auf die Accessories + gesendete Commands. */
function setup(configOverrides: Partial<ResolvedTaycanConfig> = {}) {
  const { api, registered } = makeApi();
  const commands: PorscheCommand[] = [];
  // Voll-Set-Tests laufen im 'full'-Modus (Default-Config ist 'essential').
  const config: ResolvedTaycanConfig = { ...DEFAULT_CONFIG, detailLevel: 'full', ...configOverrides };
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
  const update = climateModule(kit);
  registerNewAccessories();
  // Jeder Klima-Service lebt auf SEINEM EIGENEN Accessory; `acc` sucht über alle.
  const acc = {
    getServiceById: (
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
    },
  };
  return { acc, commands, update, config, registered };
}

const C = hap.Characteristic;
const S = hap.Service;
const OFF = C.TargetHeatingCoolingState.OFF;
const HEAT = C.TargetHeatingCoolingState.HEAT;

function state(overrides: Partial<VehicleState> = {}): VehicleState {
  return { charging: false, plugged: false, climateOn: false, ...overrides };
}

interface ClimateZonesLike {
  frontLeft: boolean;
  frontRight: boolean;
  rearLeft: boolean;
  rearRight: boolean;
}

describe('climateModule – Thermostat (immer, essential + full)', () => {
  it('legt den Thermostat „Klima" an (essential)', () => {
    const { acc, registered } = setup({ detailLevel: 'essential' });
    expect(acc.getServiceById(S.Thermostat, 'climate')).toBeDefined();
    // Essential: nur der Thermostat, sonst nichts.
    expect(acc.getServiceById(S.Switch, 'heating')).toBeUndefined();
    expect(acc.getServiceById(S.Switch, 'zone-fl')).toBeUndefined();
    expect(registered).toHaveLength(1);
  });

  it('Thermostat hat die Pflicht-Characteristics; TargetState nur OFF+HEAT', () => {
    const { acc } = setup();
    const t = acc.getServiceById(S.Thermostat, 'climate')!;
    expect(t.testCharacteristic(C.CurrentTemperature)).toBe(true);
    expect(t.testCharacteristic(C.TargetTemperature)).toBe(true);
    expect(t.testCharacteristic(C.CurrentHeatingCoolingState)).toBe(true);
    expect(t.testCharacteristic(C.TargetHeatingCoolingState)).toBe(true);
    expect(t.getCharacteristic(C.TargetHeatingCoolingState).props.validValues).toEqual([OFF, HEAT]);
    // Celsius
    expect(t.getCharacteristic(C.TemperatureDisplayUnits).value).toBe(C.TemperatureDisplayUnits.CELSIUS);
  });

  it('TargetTemperature übernimmt die Temp-Grenzen aus der Config', () => {
    const { acc } = setup({ tempMin: 16, tempMax: 28, tempStep: 1 });
    const tt = acc.getServiceById(S.Thermostat, 'climate')!.getCharacteristic(C.TargetTemperature);
    expect(tt.props.minValue).toBe(16);
    expect(tt.props.maxValue).toBe(28);
    expect(tt.props.minStep).toBe(1);
  });

  it('löst beim Setup KEINE HAP-„illegal value"-Warnung aus (auch warme Edge-Config)', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setup({ defaultTargetTemp: 30, tempMax: 30 });
    } finally {
      const calls = spy.mock.calls.map((c) => c.join(' '));
      spy.mockRestore();
      expect(calls.filter((m) => /illegal value/i.test(m))).toEqual([]);
    }
  });
});

describe('climateModule – detailLevel full: Standheizung + Zonen', () => {
  it('legt Standheizung + 4 Zonen an (full + exposeClimateZones)', () => {
    const { acc, registered } = setup({ exposeClimateZones: true });
    expect(acc.getServiceById(S.Switch, 'heating')).toBeDefined();
    expect(acc.getServiceById(S.Switch, 'zone-fl')).toBeDefined();
    expect(acc.getServiceById(S.Switch, 'zone-rr')).toBeDefined();
    // Thermostat + Standheizung + 4 Zonen = 6.
    expect(registered).toHaveLength(6);
  });

  it('ohne Zonen: Thermostat + Standheizung = 2', () => {
    const { acc, registered } = setup({ exposeClimateZones: false });
    expect(acc.getServiceById(S.Switch, 'zone-fl')).toBeUndefined();
    expect(registered).toHaveLength(2);
  });

  it('je Accessory genau ein funktionaler Service', () => {
    const { registered } = setup({ exposeClimateZones: true });
    const Info = S.AccessoryInformation.UUID;
    for (const a of registered) {
      expect(a.services.filter((s) => s.UUID !== Info)).toHaveLength(1);
    }
  });
});

describe('climateModule – onSet → Commands', () => {
  it('TargetState HEAT sendet REMOTE_CLIMATIZER_START mit Default-Temp + allen Zonen', () => {
    const { acc, commands } = setup({ defaultTargetTemp: 21 });
    const t = acc.getServiceById(S.Thermostat, 'climate')!;
    t.getCharacteristic(C.TargetHeatingCoolingState).setValue(HEAT);
    const cmd = commands.at(-1)!;
    expect(cmd.commandName).toBe('REMOTE_CLIMATIZER_START');
    expect(cmd.payload.targetTemperature).toBe(294.15); // 21 °C
    expect(cmd.payload.climateZonesEnabled).toEqual({
      frontLeft: true, frontRight: true, rearLeft: true, rearRight: true,
    });
  });

  it('TargetState OFF sendet REMOTE_CLIMATIZER_STOP', () => {
    const { acc, commands } = setup();
    const t = acc.getServiceById(S.Thermostat, 'climate')!;
    t.getCharacteristic(C.TargetHeatingCoolingState).setValue(OFF);
    expect(commands.at(-1)!.commandName).toBe('REMOTE_CLIMATIZER_STOP');
  });

  it('TargetTemperature-Set bei laufender Klima sendet START mit neuer Temp; aus → kein Command', () => {
    const { acc, commands } = setup();
    const t = acc.getServiceById(S.Thermostat, 'climate')!;
    // Aus → reine Temp-Änderung sendet nichts.
    t.getCharacteristic(C.TargetTemperature).setValue(23);
    expect(commands).toHaveLength(0);
    // An, dann Temp ändern → START mit 24 °C (297.15 K).
    t.getCharacteristic(C.TargetHeatingCoolingState).setValue(HEAT);
    commands.length = 0;
    t.getCharacteristic(C.TargetTemperature).setValue(24);
    const cmd = commands.at(-1)!;
    expect(cmd.commandName).toBe('REMOTE_CLIMATIZER_START');
    expect(cmd.payload.targetTemperature).toBe(297.15);
  });

  it('Standheizung-Switch sendet REMOTE_HEATING_START/STOP (full)', () => {
    const { acc, commands } = setup();
    const sw = acc.getServiceById(S.Switch, 'heating')!;
    sw.getCharacteristic(C.On).setValue(true);
    expect(commands.at(-1)!.commandName).toBe('REMOTE_HEATING_START');
    sw.getCharacteristic(C.On).setValue(false);
    expect(commands.at(-1)!.commandName).toBe('REMOTE_HEATING_STOP');
  });

  it('Zonen-Switch-Änderung bei laufender Klima sendet START mit angepassten Zonen', () => {
    const { acc, commands } = setup({ exposeClimateZones: true });
    const t = acc.getServiceById(S.Thermostat, 'climate')!;
    t.getCharacteristic(C.TargetHeatingCoolingState).setValue(HEAT); // climate on
    commands.length = 0;
    acc.getServiceById(S.Switch, 'zone-rr')!.getCharacteristic(C.On).setValue(false);
    const cmd = commands.at(-1)!;
    expect(cmd.commandName).toBe('REMOTE_CLIMATIZER_START');
    expect((cmd.payload.climateZonesEnabled as ClimateZonesLike).rearRight).toBe(false);
    expect((cmd.payload.climateZonesEnabled as ClimateZonesLike).frontLeft).toBe(true);
  });

  it('Zonen-Switch-Änderung bei AUS-Klima sendet kein Command', () => {
    const { acc, commands } = setup({ exposeClimateZones: true });
    acc.getServiceById(S.Switch, 'zone-fl')!.getCharacteristic(C.On).setValue(false);
    expect(commands).toHaveLength(0);
  });
});

describe('climateModule – update(state) Mapping', () => {
  it('spiegelt climateOn auf Current/TargetHeatingCoolingState', () => {
    const { acc, update } = setup({ exposeClimateZones: false });
    const t = acc.getServiceById(S.Thermostat, 'climate')!;
    update(state({ climateOn: true }));
    expect(t.getCharacteristic(C.TargetHeatingCoolingState).value).toBe(HEAT);
    expect(t.getCharacteristic(C.CurrentHeatingCoolingState).value).toBe(C.CurrentHeatingCoolingState.HEAT);
    update(state({ climateOn: false }));
    expect(t.getCharacteristic(C.TargetHeatingCoolingState).value).toBe(OFF);
    expect(t.getCharacteristic(C.CurrentHeatingCoolingState).value).toBe(C.CurrentHeatingCoolingState.OFF);
  });

  it('spiegelt targetTempC auf Current + TargetTemperature', () => {
    const { acc, update } = setup();
    const t = acc.getServiceById(S.Thermostat, 'climate')!;
    update(state({ targetTempC: 22 }));
    expect(t.getCharacteristic(C.CurrentTemperature).value).toBe(22);
    expect(t.getCharacteristic(C.TargetTemperature).value).toBe(22);
  });

  it('klemmt targetTempC aus dem State in die Config-Grenzen', () => {
    const { acc, update } = setup({ tempMin: 18, tempMax: 26 });
    const t = acc.getServiceById(S.Thermostat, 'climate')!;
    update(state({ targetTempC: 40 }));
    expect(t.getCharacteristic(C.TargetTemperature).value).toBe(26);
    update(state({ targetTempC: 5 }));
    expect(t.getCharacteristic(C.TargetTemperature).value).toBe(18);
  });

  it('spiegelt climateZones auf die Zonen-Switches (full)', () => {
    const { acc, update } = setup({ exposeClimateZones: true });
    update(state({ climateZones: { fl: true, fr: false, rl: true, rr: false } }));
    expect(acc.getServiceById(S.Switch, 'zone-fl')!.getCharacteristic(C.On).value).toBe(true);
    expect(acc.getServiceById(S.Switch, 'zone-fr')!.getCharacteristic(C.On).value).toBe(false);
    expect(acc.getServiceById(S.Switch, 'zone-rl')!.getCharacteristic(C.On).value).toBe(true);
    expect(acc.getServiceById(S.Switch, 'zone-rr')!.getCharacteristic(C.On).value).toBe(false);
  });

  it('update mit fehlenden Klimadaten wirft nicht und hält Default-Temp', () => {
    const { acc, update } = setup();
    const t = acc.getServiceById(S.Thermostat, 'climate')!;
    expect(() => update(state())).not.toThrow();
    expect(t.getCharacteristic(C.TargetTemperature).value).toBe(21); // Default
  });

  it('update(state) wirft in essential nicht (keine Zonen/Standheizung)', () => {
    const { update } = setup({ detailLevel: 'essential' });
    expect(() =>
      update(state({ climateOn: true, targetTempC: 22, climateZones: { fl: true, fr: false, rl: true, rr: false } })),
    ).not.toThrow();
  });

  it('nach update(climateZones) nutzt ein neuer climateStart die State-Zonen', () => {
    const { acc, commands, update } = setup({ exposeClimateZones: false });
    update(state({ climateZones: { fl: true, fr: false, rl: false, rr: false }, climateOn: false }));
    acc.getServiceById(S.Thermostat, 'climate')!.getCharacteristic(C.TargetHeatingCoolingState).setValue(HEAT);
    const cmd = commands.at(-1)!;
    expect(cmd.payload.climateZonesEnabled as ClimateZonesLike).toEqual({
      frontLeft: true, frontRight: false, rearLeft: false, rearRight: false,
    });
  });
});
