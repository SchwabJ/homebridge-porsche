/**
 * Reine, gemockte Tests für das Zugang-Modul (src/accessories/access.ts).
 *
 * Kein echtes Backend, keine echten HomeKit-Calls: das Kit wird durch ein
 * Fake-Kit ersetzt. Getestet werden (a) die Verdrahtung der onSet-Handler gegen
 * kit.command (Verriegeln, Hupe/Licht) und kit.unlock (Entriegeln per S-PIN),
 * sowie (b) die update(state)-Mapping-Logik (Schloss-Spiegelung, Fahrzeugstatus).
 */

import { accessModule } from '../src/accessories/access';
import type { Kit, BoundService, BoundSwitch, SwitchServiceOpts } from '../src/accessories/kit';
import { DEFAULT_CONFIG } from '../src/accessories/kit';
import type { PorscheCommand } from '../src/api/commands';
import type { VehicleState } from '../src/api/measurements';

// --- HAP-Konstanten-Stubs (nur die Werte, die das Modul liest) ---------------
const LockCurrentState = { SECURED: 1, UNSECURED: 0 } as const;
const LockTargetState = { SECURED: 1, UNSECURED: 0 } as const;

/** Ein aufgezeichneter Characteristic-Stub mit onSet-Hook und letztem Wert. */
class FakeChar {
  value: unknown = undefined;
  private handler?: (v: unknown) => void;
  updateValue(v: unknown): this {
    this.value = v;
    return this;
  }
  onSet(h: (v: unknown) => void): this {
    this.handler = h;
    return this;
  }
  /** Simuliert ein Set durch die Home-App. */
  set(v: unknown): void {
    this.value = v;
    this.handler?.(v);
  }
}

/** Ein Service-Stub mit einer Map benannter Characteristics. */
class FakeService {
  chars = new Map<string, FakeChar>();
  getCharacteristic(ctor: unknown): FakeChar {
    const key =
      typeof ctor === 'string' ? ctor : String((ctor as { name?: string }).name);
    let c = this.chars.get(key);
    if (!c) {
      c = new FakeChar();
      this.chars.set(key, c);
    }
    return c;
  }
  setCharacteristic(): this {
    return this;
  }
}

/** Eine Recorder-BoundService-Closure (merkt sich den letzten update-Wert). */
function makeBound(): BoundService & { last: () => number | boolean | undefined } {
  let last: number | boolean | undefined;
  const service = new FakeService() as unknown as BoundService['service'];
  return {
    service,
    update: (v) => {
      last = v;
    },
    last: () => last,
  };
}

interface Harness {
  apply: (state: VehicleState) => void;
  commands: PorscheCommand[];
  unlockCalls: number;
  contacts: Record<string, BoundService & { last: () => number | boolean | undefined }>;
  switches: Record<string, { opts: SwitchServiceOpts }>;
  lockTarget: FakeChar;
  lockCurrent: FakeChar;
  logs: string[];
}

function buildHarness(configOver: Partial<typeof DEFAULT_CONFIG> = {}): Harness {
  const commands: PorscheCommand[] = [];
  const contacts: Harness['contacts'] = {};
  const switches: Harness['switches'] = {};
  const logs: string[] = [];
  let unlockCalls = 0;

  const lockSvc = new FakeService();
  const lockAcc = {
    getServiceById: () => undefined,
    addService: () => lockSvc as unknown,
    getService: () => undefined,
  };
  const accs = new Map<string, unknown>();

  function LockCurrentStateCtor() {}
  Object.assign(LockCurrentStateCtor, LockCurrentState);
  function LockTargetStateCtor() {}
  Object.assign(LockTargetStateCtor, LockTargetState);

  const kit = {
    hap: {
      Characteristic: {
        LockCurrentState: LockCurrentStateCtor,
        LockTargetState: LockTargetStateCtor,
        Name: 'Name',
      },
      Service: {
        LockMechanism: 'LockMechanism',
      },
    },
    log: {
      info: (m: string) => {
        logs.push(m);
      },
      warn: (m: string) => {
        logs.push(m);
      },
    },
    config: { ...DEFAULT_CONFIG, ...configOver },
    command: async (cmd: PorscheCommand) => {
      commands.push(cmd);
    },
    unlock: async () => {
      unlockCalls += 1;
    },
    accessory: (seed: string) => {
      if (seed === 'taycan-lock-v2') {
        return lockAcc as never;
      }
      let a = accs.get(seed);
      if (!a) {
        a = {};
        accs.set(seed, a);
      }
      return a as never;
    },
    contactSensor: (_acc: unknown, _name: string, subtype: string) => {
      const b = makeBound();
      contacts[subtype] = b;
      return b;
    },
    switchService: (_acc: unknown, _name: string, subtype: string, opts: SwitchServiceOpts) => {
      switches[subtype] = { opts };
      const b: BoundSwitch = { service: new FakeService() as never, update: () => {} };
      return b;
    },
    nameService: () => {},
    percentSensor: () => makeBound() as never,
    luxSensor: () => makeBound() as never,
    tempSensor: () => makeBound() as never,
    occupancySensor: () => makeBound() as never,
  } as unknown as Kit;

  const apply = accessModule(kit);
  const lockCurrent = lockSvc.getCharacteristic(LockCurrentStateCtor);
  const lockTarget = lockSvc.getCharacteristic(LockTargetStateCtor);
  return {
    apply,
    commands,
    get unlockCalls() {
      return unlockCalls;
    },
    contacts,
    switches,
    lockTarget,
    lockCurrent,
    logs,
  } as Harness;
}

/** Minimaler State mit den Pflichtfeldern (charging/plugged/climateOn). */
function baseState(over: Partial<VehicleState> = {}): VehicleState {
  return { charging: false, plugged: false, climateOn: false, ...over };
}

describe('Zugang-Modul: Service-Anlage (full)', () => {
  it('legt 11 ContactSensoren an (4 Türen, 4 Fenster, Frunk, Kofferraum, Fahrzeugstatus)', () => {
    const h = buildHarness({ detailLevel: 'full' });
    expect(Object.keys(h.contacts).sort()).toEqual(
      ['any-open', 'door-fl', 'door-fr', 'door-rl', 'door-rr', 'frunk', 'trunk', 'window-fl', 'window-fr', 'window-rl', 'window-rr'].sort(),
    );
  });

  it('legt zwei momentane Switches an (Lichthupe + Hupe&Licht)', () => {
    const h = buildHarness({ detailLevel: 'full' });
    expect(Object.keys(h.switches).sort()).toEqual(['flash', 'honk']);
    expect(h.switches.flash.opts.momentaryMs).toBe(DEFAULT_CONFIG.honkAutoOffSeconds * 1000);
    expect(h.switches.honk.opts.momentaryMs).toBe(DEFAULT_CONFIG.honkAutoOffSeconds * 1000);
  });
});

describe('Zugang-Modul: detailLevel-Gating (essential)', () => {
  it('essential (Default): nur Fahrzeugstatus + Hupe/Licht, KEINE Einzel-Öffnungen', () => {
    const h = buildHarness();
    expect(Object.keys(h.contacts).sort()).toEqual(['any-open']);
    expect(Object.keys(h.switches).sort()).toEqual(['flash', 'honk']);
  });

  it("'essential': update(state) wirft nicht, obwohl gegatete Sensoren fehlen", () => {
    const h = buildHarness();
    expect(() =>
      h.apply(
        baseState({
          locked: false,
          doors: { fl: true, fr: false, rl: false, rr: false },
          frunkOpen: true,
        }),
      ),
    ).not.toThrow();
    expect(h.contacts['any-open'].last()).toBe(true);
  });
});

describe('Zugang-Modul: Schloss (LockMechanism)', () => {
  it('SECURED-Target sendet LOCK {spin:null}', () => {
    const h = buildHarness();
    h.lockTarget.set(LockTargetState.SECURED);
    expect(h.commands).toEqual([{ commandName: 'LOCK', payload: { spin: null } }]);
  });

  it('UNSECURED-Target MIT S-PIN ruft kit.unlock()', () => {
    const h = buildHarness({ spin: '1234' });
    h.lockTarget.set(LockTargetState.UNSECURED);
    expect(h.commands).toHaveLength(0);
    expect(h.unlockCalls).toBe(1);
  });

  it('UNSECURED-Target OHNE S-PIN ruft NICHT unlock, loggt Hinweis und setzt Target zurück', () => {
    jest.useFakeTimers();
    try {
      const h = buildHarness(); // keine spin
      h.lockTarget.set(LockTargetState.UNSECURED);
      expect(h.unlockCalls).toBe(0);
      expect(h.commands).toHaveLength(0);
      expect(h.logs.some((l) => l.includes('S-PIN'))).toBe(true);
      jest.runAllTimers();
      expect(h.lockTarget.value).toBe(LockTargetState.SECURED);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Zugang-Modul: Aktions-Befehle (Hupe/Licht onSet)', () => {
  it('Lichthupe sendet HONK_FLASH mode FLASH nur beim Einschalten', () => {
    const h = buildHarness();
    void h.switches.flash.opts.onSet(false);
    expect(h.commands).toHaveLength(0);
    void h.switches.flash.opts.onSet(true);
    expect(h.commands).toEqual([{ commandName: 'HONK_FLASH', payload: { mode: 'FLASH' } }]);
  });

  it('Hupe&Licht sendet HONK_FLASH mode HONK_AND_FLASH', () => {
    const h = buildHarness();
    void h.switches.honk.opts.onSet(true);
    expect(h.commands).toEqual([{ commandName: 'HONK_FLASH', payload: { mode: 'HONK_AND_FLASH' } }]);
  });
});

describe('Zugang-Modul: update(state) Mapping', () => {
  it('spiegelt Schloss: locked=true → SECURED, locked=false → UNSECURED', () => {
    const h = buildHarness();
    h.apply(baseState({ locked: true }));
    expect(h.lockCurrent.value).toBe(LockCurrentState.SECURED);
    h.apply(baseState({ locked: false }));
    expect(h.lockCurrent.value).toBe(LockCurrentState.UNSECURED);
  });

  it('unbekannter locked-Zustand → konservativ SECURED', () => {
    const h = buildHarness();
    h.apply(baseState({ locked: undefined }));
    expect(h.lockCurrent.value).toBe(LockCurrentState.SECURED);
  });

  it('Türen/Fenster (full): true=offen, false/undefined=zu', () => {
    const h = buildHarness({ detailLevel: 'full' });
    h.apply(
      baseState({
        doors: { fl: true, fr: false, rl: false, rr: false },
        windows: { fl: false, fr: true, rl: false, rr: false },
      }),
    );
    expect(h.contacts['door-fl'].last()).toBe(true);
    expect(h.contacts['door-fr'].last()).toBe(false);
    expect(h.contacts['window-fr'].last()).toBe(true);
    expect(h.contacts['trunk'].last()).toBe(false);
  });

  it('Fahrzeugstatus „nicht OK" (offen) bei offener Tür', () => {
    const h = buildHarness();
    h.apply(baseState({ doors: { fl: true, fr: false, rl: false, rr: false } }));
    expect(h.contacts['any-open'].last()).toBe(true);
  });

  it('Fahrzeugstatus „nicht OK" (offen) bei entriegeltem Fahrzeug', () => {
    const h = buildHarness();
    h.apply(baseState({ locked: false }));
    expect(h.contacts['any-open'].last()).toBe(true);
  });

  it('Fahrzeugstatus „OK" (geschlossen) wenn alles zu & verriegelt', () => {
    const h = buildHarness();
    h.apply(
      baseState({
        locked: true,
        doors: { fl: false, fr: false, rl: false, rr: false },
        windows: { fl: false, fr: false, rl: false, rr: false },
        frunkOpen: false,
        trunkOpen: false,
      }),
    );
    expect(h.contacts['any-open'].last()).toBe(false);
  });
});
