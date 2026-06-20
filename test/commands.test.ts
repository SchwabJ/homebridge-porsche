import {
  climateStart,
  climateStop,
  chargingStart,
  chargingStop,
  lock,
  setTargetSoc,
  heatingStart,
  heatingStop,
  honkFlash,
  PorscheCommand,
} from '../src/api/commands';

describe('command builders', () => {
  it('climateStart() ohne Temperatur → nur Klimazonen', () => {
    expect(climateStart()).toEqual<PorscheCommand>({
      commandName: 'REMOTE_CLIMATIZER_START',
      payload: {
        climateZonesEnabled: { frontLeft: true, frontRight: true, rearLeft: true, rearRight: true },
      },
    });
  });

  it('climateStart(21) → Zieltemperatur in Kelvin (294.15) + Zonen', () => {
    expect(climateStart(21)).toEqual<PorscheCommand>({
      commandName: 'REMOTE_CLIMATIZER_START',
      payload: {
        targetTemperature: 294.15,
        climateZonesEnabled: { frontLeft: true, frontRight: true, rearLeft: true, rearRight: true },
      },
    });
  });

  it('climateStop() → leeres Payload', () => {
    expect(climateStop()).toEqual<PorscheCommand>({
      commandName: 'REMOTE_CLIMATIZER_STOP',
      payload: {},
    });
  });

  it('chargingStart() → leeres Payload', () => {
    expect(chargingStart()).toEqual<PorscheCommand>({
      commandName: 'DIRECT_CHARGING_START',
      payload: {},
    });
  });

  it('chargingStop() → leeres Payload', () => {
    expect(chargingStop()).toEqual<PorscheCommand>({
      commandName: 'DIRECT_CHARGING_STOP',
      payload: {},
    });
  });

  it('lock() → Payload { spin: null } (CJNE-konform, keine echte S-PIN)', () => {
    expect(lock()).toEqual<PorscheCommand>({
      commandName: 'LOCK',
      payload: { spin: null },
    });
  });

  it('setTargetSoc(80) → Payload mit targetSoc', () => {
    expect(setTargetSoc(80)).toEqual<PorscheCommand>({
      commandName: 'CHARGING_SETTINGS_EDIT',
      payload: { targetSoc: 80 },
    });
  });

  it('setTargetSoc akzeptiert Grenzwerte 0 und 100', () => {
    expect(setTargetSoc(0).payload).toEqual({ targetSoc: 0 });
    expect(setTargetSoc(100).payload).toEqual({ targetSoc: 100 });
  });

  it('setTargetSoc(150) wirft Error (über 100)', () => {
    expect(() => setTargetSoc(150)).toThrow('targetSoc must be 0-100');
  });

  it('setTargetSoc(-5) wirft Error (unter 0)', () => {
    expect(() => setTargetSoc(-5)).toThrow('targetSoc must be 0-100');
  });

  it('climateStart(21, übergebene Zonen) → genau diese Zonen', () => {
    expect(
      climateStart(21, { frontLeft: true, frontRight: false, rearLeft: false, rearRight: false }),
    ).toEqual<PorscheCommand>({
      commandName: 'REMOTE_CLIMATIZER_START',
      payload: {
        targetTemperature: 294.15,
        climateZonesEnabled: { frontLeft: true, frontRight: false, rearLeft: false, rearRight: false },
      },
    });
  });

  it('heatingStart() / heatingStop() → leeres Payload', () => {
    expect(heatingStart()).toEqual<PorscheCommand>({ commandName: 'REMOTE_HEATING_START', payload: {} });
    expect(heatingStop()).toEqual<PorscheCommand>({ commandName: 'REMOTE_HEATING_STOP', payload: {} });
  });

  it('honkFlash() default → FLASH', () => {
    expect(honkFlash()).toEqual<PorscheCommand>({
      commandName: 'HONK_FLASH',
      payload: { mode: 'FLASH' },
    });
  });

  it('honkFlash("HONK_AND_FLASH") → HONK_AND_FLASH', () => {
    expect(honkFlash('HONK_AND_FLASH')).toEqual<PorscheCommand>({
      commandName: 'HONK_FLASH',
      payload: { mode: 'HONK_AND_FLASH' },
    });
  });
});
