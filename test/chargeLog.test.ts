import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSample, fileNameFor, appendSample } from '../src/chargeLog';
import type { VehicleState } from '../src/api/measurements';

const state = (over: Partial<VehicleState> = {}): VehicleState =>
  ({ soc: 46, rangeKm: 178, charging: false, plugged: false, ...over }) as VehicleState;

describe('buildSample', () => {
  it('always carries a timestamp', () => {
    const s = buildSample(state(), new Date('2026-07-27T08:30:00Z'));
    expect(s.ts).toBe('2026-07-27T08:30:00.000Z');
  });

  it('keeps the charging fields needed to reconstruct a session', () => {
    const s = buildSample(
      state({ charging: true, plugged: true, chargingPowerKw: 10.8, chargingType: 'AC' }),
      new Date(),
    );
    expect(s).toMatchObject({ charging: true, plugged: true, powerKw: 10.8, chargingType: 'AC' });
  });

  it('omits undefined fields instead of writing nulls', () => {
    const s = buildSample({ soc: 50 } as VehicleState, new Date());
    expect(Object.prototype.hasOwnProperty.call(s, 'rangeKm')).toBe(false);
  });

  it('keeps false as a real value (not dropped as falsy)', () => {
    const s = buildSample(state({ charging: false }), new Date());
    expect(s.charging).toBe(false);
  });

  it('keeps a zero reading (not dropped as falsy)', () => {
    const s = buildSample(state({ soc: 0 }), new Date());
    expect(s.soc).toBe(0);
  });
});

describe('fileNameFor', () => {
  it('rotates per local day, zero padded', () => {
    expect(fileNameFor(new Date(2026, 6, 5))).toBe('2026-07-05.jsonl');
  });
});

describe('appendSample', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chargelog-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per call', () => {
    const now = new Date(2026, 6, 27, 8, 0, 0);
    appendSample(dir, state(), now);
    appendSample(dir, state({ soc: 47 }), now);

    const lines = fs
      .readFileSync(path.join(dir, fileNameFor(now)), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).soc).toBe(47);
  });

  it('creates the directory if missing', () => {
    const nested = path.join(dir, 'a', 'b');
    expect(appendSample(nested, state(), new Date())).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('never throws on an unwritable path — HomeKit must not be affected', () => {
    // A file where a directory is expected makes mkdir fail.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    expect(() => appendSample(path.join(blocker, 'sub'), state(), new Date())).not.toThrow();
    expect(appendSample(path.join(blocker, 'sub'), state(), new Date())).toBe(false);
  });
});

describe('Fahrzeugzustand im Mitschrieb', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const zustand = (over: Partial<VehicleState> = {}): VehicleState =>
    ({
      soc: 60,
      tirePressureBar: { fl: 2.7, fr: 2.7, rl: 2.9, rr: 2.9 },
      tireDiffBar: { fl: 0, fr: 0, rl: 0.1, rr: 0.1 },
      serviceKm: 12000,
      locked: true,
      climateOn: false,
      targetTempC: 21,
      doors: { fl: false, fr: false, rl: false, rr: false },
      windows: { fl: false, fr: false, rl: false, rr: false },
      frunkOpen: false,
      trunkOpen: false,
      ...over,
    }) as VehicleState;

  const zeilen = (): Record<string, unknown>[] =>
    fs
      .readFileSync(path.join(dir, fileNameFor(new Date())), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('schreibt Reifendruck als vier Werte in fester Reihenfolge', () => {
    appendSample(dir, zustand(), new Date());
    expect(zeilen()[0].tyreBar).toEqual([2.7, 2.7, 2.9, 2.9]);
  });

  it('schreibt Service, Verriegelung und Klima mit', () => {
    appendSample(dir, zustand(), new Date());
    expect(zeilen()[0]).toMatchObject({ serviceKm: 12000, locked: true, climateOn: false });
  });

  it('fasst offene Türen, Fenster und Klappen zu einem Kennzeichen zusammen', () => {
    appendSample(dir, zustand(), new Date());
    expect(zeilen()[0].anyOpen).toBe(false);
    appendSample(dir, zustand({ trunkOpen: true }), new Date());
    expect(zeilen()[1].anyOpen).toBe(true);
  });

  it('wiederholt unveränderte Zustandsfelder NICHT', () => {
    // Am Kabel läuft der Poll im Minutentakt. Ein Reifendruck, der sechzigmal
    // pro Stunde identisch dasteht, bläht die Datei ohne jede Aussage auf.
    appendSample(dir, zustand(), new Date());
    appendSample(dir, zustand({ soc: 61 }), new Date());
    const rows = zeilen();
    expect(rows[0].tyreBar).toBeDefined();
    expect(rows[1].tyreBar).toBeUndefined();
    expect(rows[1].soc).toBe(61);
  });

  it('schreibt sie wieder, sobald sich einer ändert', () => {
    appendSample(dir, zustand(), new Date());
    appendSample(dir, zustand(), new Date());
    appendSample(dir, zustand({ serviceKm: 11800 }), new Date());
    const rows = zeilen();
    expect(rows[1].serviceKm).toBeUndefined();
    expect(rows[2].serviceKm).toBe(11800);
    // Der Reifendruck gehört zum selben Block und wird mitgeschrieben —
    // sonst stünde eine Zeile mit halbem Zustand in der Datei.
    expect(rows[2].tyreBar).toBeDefined();
  });

  it('lässt die Ladefelder von der Sparsamkeit unberührt', () => {
    appendSample(dir, zustand(), new Date());
    appendSample(dir, zustand(), new Date());
    expect(zeilen()[1].soc).toBe(60);
  });
});
