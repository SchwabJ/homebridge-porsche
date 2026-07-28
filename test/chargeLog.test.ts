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
