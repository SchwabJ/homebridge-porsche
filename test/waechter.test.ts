import { PlatformAccessory } from 'homebridge/lib/platformAccessory';
import * as hap from 'hap-nodejs';

import {
  createWatchdog,
  isStale,
  CONNECTION_ACCESSORY_SEED,
  FRESHNESS_ACCESSORY_SEED,
  PlatformHealth,
} from '../src/accessories/watchdog';
import { createKit, DEFAULT_CONFIG, KitContext, Kit } from '../src/accessories/kit';
import { VehicleState } from '../src/api/measurements';

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  log: () => {},
  success: () => {},
} as unknown as import('homebridge').Logging;

/** Echter Kit auf Basis von hap-nodejs (kein Backend, keine HomeKit-Bridge). */
function makeKit(overrides: Partial<KitContext> = {}): Kit {
  const api = {
    hap: hap as unknown as import('homebridge').HAP,
    platformAccessory:
      PlatformAccessory as unknown as typeof import('homebridge').PlatformAccessory,
    registerPlatformAccessories: () => {},
    updatePlatformAccessories: () => {},
    unregisterPlatformAccessories: () => {},
  } as unknown as import('homebridge').API;
  const ctx: KitContext = {
    api,
    log,
    // Voll-Set-Tests prüfen das KOMPLETTE Cockpit (Verbindung + Daten-Aktualität).
    // Default-Config ist seit der detailLevel-Einführung 'essential' (nur Verbindung),
    // daher hier explizit auf 'full' anheben — das war das bisherige Verhalten.
    config: { ...DEFAULT_CONFIG, language: 'de', detailLevel: 'full' },
    cachedAccessories: [],
    unlock: async () => {},
    command: async () => {},
    ...overrides,
  };
  return createKit(ctx).kit;
}

const CSS = hap.Characteristic.ContactSensorState;
const FAULT = hap.Characteristic.StatusFault;

/**
 * Hilfsfunktion: liest die beiden Wächter-Services aus ihren EIGENEN
 * Accessories (Verbindung bzw. Daten-Aktualität).
 */
function services(kit: Kit) {
  const connAcc = kit.accessory(CONNECTION_ACCESSORY_SEED, 'Taycan Verbindung');
  const freshAcc = kit.accessory(FRESHNESS_ACCESSORY_SEED, 'Taycan Daten aktuell');
  const conn = connAcc.getServiceById(hap.Service.ContactSensor, 'connection')!;
  const fresh = freshAcc.getServiceById(hap.Service.ContactSensor, 'freshness')!;
  return { connAcc, freshAcc, conn, fresh };
}

describe('isStale (pure)', () => {
  const NOW = 1_700_000_000_000;

  it('treats missing timestamp as stale', () => {
    expect(isStale(undefined, 30, NOW)).toBe(true);
  });

  it('treats non-finite timestamp as stale', () => {
    expect(isStale(NaN, 30, NOW)).toBe(true);
  });

  it('fresh when within the window', () => {
    expect(isStale(NOW - 5 * 60000, 30, NOW)).toBe(false);
  });

  it('fresh exactly at the boundary (not strictly older)', () => {
    expect(isStale(NOW - 30 * 60000, 30, NOW)).toBe(false);
  });

  it('stale just past the window', () => {
    expect(isStale(NOW - 30 * 60000 - 1, 30, NOW)).toBe(true);
  });
});

describe('createWatchdog — accessory + service wiring', () => {
  it('creates connection + freshness on separate accessories at their documented seed UUIDs', () => {
    const kit = makeKit();
    createWatchdog(kit);
    const { connAcc, freshAcc } = services(kit);
    expect(connAcc.UUID).toBe(hap.uuid.generate(CONNECTION_ACCESSORY_SEED));
    expect(freshAcc.UUID).toBe(hap.uuid.generate(FRESHNESS_ACCESSORY_SEED));
    expect(connAcc.UUID).not.toBe(freshAcc.UUID);
  });

  it('uses the configured vehicleName for each accessory display name', () => {
    const kit = makeKit({
      config: { ...DEFAULT_CONFIG, language: 'de', detailLevel: 'full', vehicleName: 'Mein Taycan' },
    });
    // Beide Accessories so abgreifen, wie createWatchdog sie anlegt — per Seed,
    // damit ein zweiter kit.accessory(seed, 'ignored')-Aufruf den Name-Wert nicht
    // überschreibt (kit.accessory ruft ensureInfo(displayName) auch im get-Pfad).
    const orig = kit.accessory.bind(kit);
    const captured = new Map<string, PlatformAccessory>();
    kit.accessory = (seed: string, name: string) => {
      const a = orig(seed, name);
      captured.set(seed, a);
      return a;
    };
    createWatchdog(kit);
    const connInfo = captured
      .get(CONNECTION_ACCESSORY_SEED)!
      .getService(hap.Service.AccessoryInformation)!;
    expect(connInfo.getCharacteristic(hap.Characteristic.Name).value).toBe('Mein Taycan Verbindung');
    const freshInfo = captured
      .get(FRESHNESS_ACCESSORY_SEED)!
      .getService(hap.Service.AccessoryInformation)!;
    expect(freshInfo.getCharacteristic(hap.Characteristic.Name).value).toBe(
      'Mein Taycan Daten aktuell',
    );
  });

  it('adds StatusFault on the connection sensor and StatusActive on the freshness sensor', () => {
    const kit = makeKit();
    createWatchdog(kit);
    const { conn, fresh } = services(kit);
    expect(conn.testCharacteristic(FAULT)).toBe(true);
    expect(fresh.testCharacteristic(hap.Characteristic.StatusActive)).toBe(true);
    // connection has no StatusActive, freshness has no StatusFault.
    expect(conn.testCharacteristic(hap.Characteristic.StatusActive)).toBe(false);
    expect(fresh.testCharacteristic(FAULT)).toBe(false);
  });
});

describe('createWatchdog.setHealth — connection / auth guard', () => {
  it('ok:true → contact DETECTED + StatusFault NO_FAULT', () => {
    const kit = makeKit();
    const wd = createWatchdog(kit);
    const { conn } = services(kit);
    wd.setHealth({ ok: true });
    expect(conn.getCharacteristic(CSS).value).toBe(CSS.CONTACT_DETECTED);
    expect(conn.getCharacteristic(FAULT).value).toBe(FAULT.NO_FAULT);
  });

  it('ok:false → contact NOT_DETECTED + StatusFault GENERAL_FAULT', () => {
    const kit = makeKit();
    const wd = createWatchdog(kit);
    const { conn } = services(kit);
    wd.setHealth({ ok: false, message: 'token refresh failed' });
    expect(conn.getCharacteristic(CSS).value).toBe(CSS.CONTACT_NOT_DETECTED);
    expect(conn.getCharacteristic(FAULT).value).toBe(FAULT.GENERAL_FAULT);
  });

  it('logs a warning on failure including the message', () => {
    const warns: string[] = [];
    const noisyLog = { ...log, warn: (m: string) => warns.push(m) } as unknown as import('homebridge').Logging;
    const kit = makeKit({ log: noisyLog });
    const wd = createWatchdog(kit);
    wd.setHealth({ ok: false, message: 'boom' });
    expect(warns.some((w) => w.includes('boom'))).toBe(true);
  });

  it('recovers from fault back to ok', () => {
    const kit = makeKit();
    const wd = createWatchdog(kit);
    const { conn } = services(kit);
    wd.setHealth({ ok: false });
    wd.setHealth({ ok: true });
    expect(conn.getCharacteristic(CSS).value).toBe(CSS.CONTACT_DETECTED);
    expect(conn.getCharacteristic(FAULT).value).toBe(FAULT.NO_FAULT);
  });
});

describe('createWatchdog.update — data freshness guard', () => {
  const NOW = 1_700_000_000_000;

  function freshState(deltaMs: number): VehicleState {
    return { charging: false, plugged: false, climateOn: false, dataTimestamp: NOW - deltaMs };
  }

  it('fresh data → contact DETECTED + StatusActive true', () => {
    const kit = makeKit();
    const wd = createWatchdog(kit, () => NOW);
    const { fresh } = services(kit);
    wd.update(freshState(5 * 60000));
    expect(fresh.getCharacteristic(CSS).value).toBe(CSS.CONTACT_DETECTED);
    expect(fresh.getCharacteristic(hap.Characteristic.StatusActive).value).toBe(true);
  });

  it('stale data → contact NOT_DETECTED + StatusActive false', () => {
    const kit = makeKit();
    const wd = createWatchdog(kit, () => NOW);
    const { fresh } = services(kit);
    wd.update(freshState(60 * 60000)); // 60 min old, default stale=30
    expect(fresh.getCharacteristic(CSS).value).toBe(CSS.CONTACT_NOT_DETECTED);
    expect(fresh.getCharacteristic(hap.Characteristic.StatusActive).value).toBe(false);
  });

  it('missing dataTimestamp → stale', () => {
    const kit = makeKit();
    const wd = createWatchdog(kit, () => NOW);
    const { fresh } = services(kit);
    wd.update({ charging: false, plugged: false, climateOn: false });
    expect(fresh.getCharacteristic(CSS).value).toBe(CSS.CONTACT_NOT_DETECTED);
    expect(fresh.getCharacteristic(hap.Characteristic.StatusActive).value).toBe(false);
  });

  it('respects a custom staleMinutes from config', () => {
    const kit = makeKit({ config: { ...DEFAULT_CONFIG, language: 'de', detailLevel: 'full', staleMinutes: 120 } });
    const wd = createWatchdog(kit, () => NOW);
    const { fresh } = services(kit);
    wd.update(freshState(90 * 60000)); // 90 min old, stale=120 → still fresh
    expect(fresh.getCharacteristic(CSS).value).toBe(CSS.CONTACT_DETECTED);
  });

  it('connection and freshness guards are independent', () => {
    const kit = makeKit();
    const wd = createWatchdog(kit, () => NOW);
    const { conn, fresh } = services(kit);
    wd.setHealth({ ok: true });
    wd.update(freshState(60 * 60000)); // stale
    // connection ok, freshness stale → independent characteristics.
    expect(conn.getCharacteristic(FAULT).value).toBe(FAULT.NO_FAULT);
    expect(fresh.getCharacteristic(CSS).value).toBe(CSS.CONTACT_NOT_DETECTED);
  });
});

describe('createWatchdog — detailLevel gating (essential default)', () => {
  const NOW = 1_700_000_000_000;

  /** Spioniert kit.accessory, um die tatsächlich angeforderten Seeds zu erfassen. */
  function spyOnAccessory(kit: Kit): string[] {
    const orig = kit.accessory.bind(kit);
    const seenSeeds: string[] = [];
    kit.accessory = (seed: string, name: string) => {
      seenSeeds.push(seed);
      return orig(seed, name);
    };
    return seenSeeds;
  }

  it('essential: legt NUR den Verbindungs-Sensor an, NICHT den Daten-Aktualität-Sensor', () => {
    const kit = makeKit({ config: { ...DEFAULT_CONFIG, language: 'de', detailLevel: 'essential' } });
    const seenSeeds = spyOnAccessory(kit);
    createWatchdog(kit, () => NOW);
    // ESSENTIELL: Verbindung wird immer angefordert.
    expect(seenSeeds).toContain(CONNECTION_ACCESSORY_SEED);
    // GEGATET: Daten-Aktualität darf im essential-Modus NICHT angelegt werden.
    expect(seenSeeds).not.toContain(FRESHNESS_ACCESSORY_SEED);
  });

  it('essential: das Freshness-Accessory existiert ohne ContactSensor-Service', () => {
    const kit = makeKit({ config: { ...DEFAULT_CONFIG, language: 'de', detailLevel: 'essential' } });
    createWatchdog(kit, () => NOW);
    // get-or-create: hier neu (createWatchdog hat es NICHT angelegt) → kein Service.
    const freshAcc = kit.accessory(FRESHNESS_ACCESSORY_SEED, 'Taycan Daten aktuell');
    expect(freshAcc.getServiceById(hap.Service.ContactSensor, 'freshness')).toBeUndefined();
  });

  it('essential: setHealth funktioniert weiter (Verbindung ist essentiell)', () => {
    const kit = makeKit({ config: { ...DEFAULT_CONFIG, language: 'de', detailLevel: 'essential' } });
    const wd = createWatchdog(kit, () => NOW);
    const connAcc = kit.accessory(CONNECTION_ACCESSORY_SEED, 'Taycan Verbindung');
    const conn = connAcc.getServiceById(hap.Service.ContactSensor, 'connection')!;
    wd.setHealth({ ok: false, message: 'token refresh failed' });
    expect(conn.getCharacteristic(CSS).value).toBe(CSS.CONTACT_NOT_DETECTED);
    expect(conn.getCharacteristic(FAULT).value).toBe(FAULT.GENERAL_FAULT);
    wd.setHealth({ ok: true });
    expect(conn.getCharacteristic(CSS).value).toBe(CSS.CONTACT_DETECTED);
    expect(conn.getCharacteristic(FAULT).value).toBe(FAULT.NO_FAULT);
  });

  it('essential: update(state) ist ein No-Op für Freshness und wirft NICHT (guard-Pfad)', () => {
    const kit = makeKit({ config: { ...DEFAULT_CONFIG, language: 'de', detailLevel: 'essential' } });
    const wd = createWatchdog(kit, () => NOW);
    // Regression-Guard für den Optional-Chaining-Pfad: freshBound/freshActiveChar
    // sind undefined → update darf nicht crashen.
    expect(() =>
      wd.update({ charging: false, plugged: false, climateOn: false, dataTimestamp: NOW }),
    ).not.toThrow();
    expect(() =>
      wd.update({ charging: false, plugged: false, climateOn: false }),
    ).not.toThrow();
  });
});

// Typ-Assertion: PlatformHealth ist die schmale dokumentierte Schnittstelle.
const _sample: PlatformHealth = { ok: true };
void _sample;
