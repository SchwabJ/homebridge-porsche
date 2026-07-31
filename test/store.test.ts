import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  signature,
  readSamples,
  streamSamples,
  readSamplesRange,
  statsFor,
  cachedAggregate,
  CACHE_MAX_FILES,
  type EffectiveOptions,
} from '../src/store';
import type { ChargeLogSample } from '../src/chargeLog';
import { LABELS_DE } from '../src/i18n';

const eff = (over: Partial<EffectiveOptions> = {}): EffectiveOptions => ({
  capacityKwh: 83.7,
  pricePerKwh: 0.2067,
  grossPricePerKwh: 0.3267,
  dayBoundaryHour: 4,
  priceFor: () => ({ pricePerKwh: 0.2067, grossPricePerKwh: 0.3267 }),
  priceSig: '[]',
  labels: LABELS_DE,
  ...over,
});

const line = (ts: string, rest = ''): string => `{"ts":"${ts}"${rest}}\n`;

describe('store', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('signature', () => {
    it('changes when a file grows', () => {
      fs.writeFileSync(path.join(dir, '2026-07-27.jsonl'), line('2026-07-27T10:00:00.000Z'));
      const before = signature(dir);
      fs.appendFileSync(path.join(dir, '2026-07-27.jsonl'), line('2026-07-27T11:00:00.000Z'));
      expect(signature(dir)).not.toBe(before);
    });

    it('is empty for a missing directory', () => {
      expect(signature(path.join(dir, 'nope'))).toBe('');
    });

    it('ignores files that are not day files', () => {
      fs.writeFileSync(path.join(dir, '2026-07-27.jsonl'), line('2026-07-27T10:00:00.000Z'));
      const before = signature(dir);
      fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
      expect(signature(dir)).toBe(before);
    });
  });

  describe('readSamples cache', () => {
    it('returns the cached array while the directory is unchanged', () => {
      fs.writeFileSync(path.join(dir, '2026-07-27.jsonl'), line('2026-07-27T10:00:00.000Z'));
      expect(readSamples(dir)).toBe(readSamples(dir));
    });

    it('rebuilds after the log grew', () => {
      fs.writeFileSync(path.join(dir, '2026-07-27.jsonl'), line('2026-07-27T10:00:00.000Z'));
      const before = readSamples(dir);
      fs.appendFileSync(path.join(dir, '2026-07-27.jsonl'), line('2026-07-27T11:00:00.000Z'));
      const after = readSamples(dir);
      expect(after).not.toBe(before);
      expect(after).toHaveLength(2);
    });
  });

  describe('long histories', () => {
    it('keeps only the tail in memory but streams everything', () => {
      // Eine Datei mehr, als der Cache hält — die älteste fällt aus dem
      // Cache, der Stream liefert sie trotzdem.
      for (let i = 0; i <= CACHE_MAX_FILES; i++) {
        const day = new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
        fs.writeFileSync(path.join(dir, `${day}.jsonl`), line(`${day}T12:00:00.000Z`));
      }
      expect(readSamples(dir)).toHaveLength(CACHE_MAX_FILES);
      const streamed = [...streamSamples(dir)];
      expect(streamed).toHaveLength(CACHE_MAX_FILES + 1);
      expect(streamed[0].ts).toBe('2020-01-01T12:00:00.000Z');
    });
  });

  describe('readSamplesRange', () => {
    it('reads only the window, both days inclusive, sorted', () => {
      fs.writeFileSync(path.join(dir, '2026-07-25.jsonl'), line('2026-07-25T10:00:00.000Z'));
      fs.writeFileSync(path.join(dir, '2026-07-26.jsonl'), line('2026-07-26T10:00:00.000Z'));
      fs.writeFileSync(path.join(dir, '2026-07-27.jsonl'), line('2026-07-27T10:00:00.000Z'));
      fs.writeFileSync(path.join(dir, '2026-07-28.jsonl'), line('2026-07-28T10:00:00.000Z'));
      const got = readSamplesRange(dir, '2026-07-26', '2026-07-27');
      expect(got.map((x) => x.ts)).toEqual([
        '2026-07-26T10:00:00.000Z',
        '2026-07-27T10:00:00.000Z',
      ]);
    });
  });

  describe('cachedAggregate key rules', () => {
    const writeDay = (): void => {
      fs.writeFileSync(
        path.join(dir, '2026-07-27.jsonl'),
        line('2026-07-27T10:00:00.000Z', ',"soc":50') + line('2026-07-27T11:00:00.000Z', ',"soc":60'),
      );
    };
    const producer = (): { produce: () => Iterable<ChargeLogSample>; calls: () => number } => {
      let n = 0;
      return {
        produce: () => {
          n++;
          return readSamples(dir);
        },
        calls: () => n,
      };
    };

    it('serves a repeat call from the cache without re-reading', () => {
      writeDay();
      const p = producer();
      const first = cachedAggregate(dir, eff(), 'day', 'all', p.produce);
      expect(cachedAggregate(dir, eff(), 'day', 'all', p.produce)).toBe(first);
      expect(p.calls()).toBe(1);
    });

    it('recomputes when the price changes', () => {
      writeDay();
      const p = producer();
      cachedAggregate(dir, eff(), 'day', 'all', p.produce);
      cachedAggregate(dir, eff({ pricePerKwh: 0.3 }), 'day', 'all', p.produce);
      expect(p.calls()).toBe(2);
    });

    it('recomputes when the tariff history changes, even at equal current price', () => {
      writeDay();
      const p = producer();
      cachedAggregate(dir, eff(), 'day', 'all', p.produce);
      cachedAggregate(dir, eff({ priceSig: '[{"until":"2026-01-01"}]' }), 'day', 'all', p.produce);
      expect(p.calls()).toBe(2);
    });

    it('recomputes when the log grew', () => {
      writeDay();
      const p = producer();
      cachedAggregate(dir, eff(), 'day', 'all', p.produce);
      fs.appendFileSync(path.join(dir, '2026-07-27.jsonl'), line('2026-07-27T12:00:00.000Z', ',"soc":70'));
      cachedAggregate(dir, eff(), 'day', 'all', p.produce);
      expect(p.calls()).toBe(2);
    });

    it('keeps granularities and place filters apart', () => {
      writeDay();
      const p = producer();
      cachedAggregate(dir, eff(), 'day', 'all', p.produce);
      cachedAggregate(dir, eff(), 'week', 'all', p.produce);
      cachedAggregate(dir, eff(), 'day', 'home', p.produce);
      expect(p.calls()).toBe(3);
    });
  });

  describe('statsFor key rules', () => {
    beforeEach(() => {
      fs.writeFileSync(
        path.join(dir, '2026-07-27.jsonl'),
        line('2026-07-27T10:00:00.000Z', ',"soc":50,"odometerKm":1000') +
          line('2026-07-27T11:00:00.000Z', ',"soc":45,"odometerKm":1050'),
      );
    });

    it('serves a repeat call from the cache', () => {
      expect(statsFor(dir, eff())).toBe(statsFor(dir, eff()));
    });

    it('recomputes when the price changes — trips carry costs', () => {
      const first = statsFor(dir, eff());
      expect(statsFor(dir, eff({ pricePerKwh: 0.3 }))).not.toBe(first);
    });

    it('recomputes when the log grew', () => {
      const first = statsFor(dir, eff());
      fs.appendFileSync(
        path.join(dir, '2026-07-27.jsonl'),
        line('2026-07-27T12:00:00.000Z', ',"soc":40,"odometerKm":1100'),
      );
      expect(statsFor(dir, eff())).not.toBe(first);
    });
  });
});

describe('Fremde und kaputte Dateien im Mitschrieb-Verzeichnis', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fremd-'));
    fs.writeFileSync(
      path.join(dir, '2026-07-28.jsonl'),
      JSON.stringify({ ts: '2026-07-28T10:00:00.000Z', soc: 50, plugged: false }) + '\n',
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('überliest eine Zeile ohne Zeitstempel, statt alles mitzureißen', () => {
    // Eine halb zurückgespielte Sicherung oder ein Export genügt: Ohne `ts`
    // warf der Sortiervergleich, und das riss JEDE Route auf 500 — dauerhaft,
    // weil die Datei liegen bleibt. Es gäbe dann keine Seite mehr, von der
    // aus sich das diagnostizieren ließe.
    fs.writeFileSync(
      path.join(dir, '2026-07-29.jsonl'),
      JSON.stringify({ soc: 50, plugged: false }) + '\n' +
        JSON.stringify({ ts: '2026-07-29T10:00:00.000Z', soc: 60, plugged: false }) + '\n',
    );
    expect(() => readSamples(dir)).not.toThrow();
    const rows = readSamples(dir);
    expect(rows.every((r) => typeof r.ts === 'string')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('liest nur Tagesdateien, keine fremden .jsonl im selben Ordner', () => {
    // Der Mitschrieb heißt YYYY-MM-DD.jsonl. Was anders heißt, gehört jemand
    // anderem — eine Sicherung, ein Export — und darf die Auswertung nicht
    // beeinflussen.
    fs.writeFileSync(path.join(dir, 'backup.jsonl'), JSON.stringify({ soc: 99 }) + '\n');
    const rows = readSamples(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].soc).toBe(50);
  });

  it('übersteht einen Zeitstempel, der kein Datum ergibt', () => {
    fs.writeFileSync(
      path.join(dir, '2026-07-30.jsonl'),
      JSON.stringify({ ts: 'kein Datum', soc: 70 }) + '\n',
    );
    expect(() => readSamples(dir)).not.toThrow();
  });
});
