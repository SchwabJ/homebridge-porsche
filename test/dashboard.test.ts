import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSamples, summarize, startDashboard, optionsFor } from '../src/dashboard';
import type { ChargeSession } from '../src/sessions';
import { labelsFor } from '../src/i18n';

const session = (over: Partial<ChargeSession> = {}): ChargeSession => ({
  startedAt: '2026-07-27T20:00:00.000Z',
  durationMin: 60,
  chargingMin: 60,
  socDropped: false,
  complete: true,
  samples: 2,
  phases: [],
  ...over,
});

describe('readSamples', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns nothing for a missing directory instead of throwing', () => {
    expect(readSamples(path.join(dir, 'nope'))).toEqual([]);
  });

  it('merges all day files in chronological order', () => {
    fs.writeFileSync(path.join(dir, '2026-07-27.jsonl'), '{"ts":"2026-07-27T10:00:00.000Z"}\n');
    fs.writeFileSync(path.join(dir, '2026-07-26.jsonl'), '{"ts":"2026-07-26T10:00:00.000Z"}\n');
    const s = readSamples(dir);
    expect(s.map((x) => x.ts)).toEqual([
      '2026-07-26T10:00:00.000Z',
      '2026-07-27T10:00:00.000Z',
    ]);
  });

  it('skips a truncated last line instead of losing the whole file', () => {
    fs.writeFileSync(
      path.join(dir, '2026-07-27.jsonl'),
      '{"ts":"2026-07-27T10:00:00.000Z"}\n{"ts":"2026-07-27T10:1',
    );
    expect(readSamples(dir)).toHaveLength(1);
  });
});

describe('summarize', () => {
  it('groups by calendar month, newest first', () => {
    const m = summarize([
      session({ startedAt: '2026-06-10T20:00:00.000Z', energyKwh: 10, costEur: 2 }),
      session({ startedAt: '2026-07-10T20:00:00.000Z', energyKwh: 20, costEur: 4 }),
      session({ startedAt: '2026-07-20T20:00:00.000Z', energyKwh: 5, costEur: 1 }),
    ]);
    expect(m.map((x) => x.month)).toEqual(['2026-07', '2026-06']);
    expect(m[0]).toMatchObject({ kwh: 25, cost: 5, count: 2 });
  });

  it('tolerates sessions without energy or cost', () => {
    const m = summarize([session({ startedAt: '2026-07-10T20:00:00.000Z' })]);
    expect(m[0]).toMatchObject({ kwh: 0, cost: 0, count: 1 });
  });
});

describe('optionsFor', () => {
  const opts = {
    port: 0,
    logDir: '/tmp',
    capacityKwh: 83.7,
    pricePerKwh: 0.2,
    priceCt: 30,
    bonusCt: 10,
    dayBoundaryHour: 4,
    vehicleName: 'Taycan',
    uiPort: 8581,
    labels: labelsFor('en'),
  };

  it('derives the gross price from the configured cents', () => {
    expect(optionsFor(opts).grossPricePerKwh).toBeCloseTo(0.3, 4);
  });

  it('passes the day boundary through', () => {
    // Regression: the HTML page once built its own options and dropped this,
    // so the setting only took effect in the JSON API.
    expect(optionsFor(opts).dayBoundaryHour).toBe(4);
  });

  it('keeps gross above net so the saving is positive', () => {
    const o = optionsFor(opts);
    expect(o.grossPricePerKwh).toBeGreaterThan(o.pricePerKwh);
  });
});

describe('manual refresh', () => {
  const base = {
    logDir: '/tmp',
    capacityKwh: 83.7,
    pricePerKwh: 0.2,
    priceCt: 32,
    bonusCt: 12,
    dayBoundaryHour: 0,
    vehicleName: 'Taycan',
    uiPort: 8581,
    labels: labelsFor('en'),
  };

  // Port 0 bedeutet in der Konfiguration „Dashboard aus" — für die Tests
  // braucht es deshalb echte, je Test verschiedene Ports.
  let nextPort = 8200;

  /** Startet das Dashboard und liefert Adresse + Stopper. */
  const serve = async (
    onRefresh?: () => Promise<void>,
  ): Promise<{ url: string; stop: () => void }> => {
    const server = startDashboard({ ...base, port: nextPort++, onRefresh });
    if (!server) {
      throw new Error('server not started');
    }
    await new Promise((r) => server.once('listening', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return { url: `http://127.0.0.1:${port}`, stop: () => server.close() };
  };

  it('triggers the poll and reports success', async () => {
    let calls = 0;
    const { url, stop } = await serve(async () => {
      calls++;
    });
    const r = await (await fetch(`${url}/api/refresh`)).json();
    expect(r).toEqual({ ok: true });
    expect(calls).toBe(1);
    stop();
  });

  it('refuses a second refresh within the cooldown', async () => {
    // Guard against hammering the button into an API rate limit.
    let calls = 0;
    const { url, stop } = await serve(async () => {
      calls++;
    });
    await fetch(`${url}/api/refresh`);
    const second = await (await fetch(`${url}/api/refresh`)).json();
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('cooldown');
    expect(second.retryInMs).toBeGreaterThan(0);
    expect(calls).toBe(1);
    stop();
  });

  it('reports unavailable instead of failing when no handler is wired', async () => {
    const { url, stop } = await serve(undefined);
    const r = await (await fetch(`${url}/api/refresh`)).json();
    expect(r).toEqual({ ok: false, reason: 'not-available' });
    stop();
  });

  it('reports a failing poll instead of crashing the server', async () => {
    const { url, stop } = await serve(async () => {
      throw new Error('backend down');
    });
    const r = await (await fetch(`${url}/api/refresh`)).json();
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain('backend down');
    stop();
  });
});

describe('startDashboard', () => {
  it('stays off when the port is 0', () => {
    expect(
      startDashboard({
        port: 0,
        logDir: '/nonexistent',
        capacityKwh: 83.7,
        pricePerKwh: 0.2,
        priceCt: 32,
        bonusCt: 12,
        dayBoundaryHour: 0,
        vehicleName: 'Taycan',
        uiPort: 8581,
        labels: labelsFor('en'),
      }),
    ).toBeUndefined();
  });
});

describe('Altdaten-Reparatur', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (lines: string[]): void =>
    fs.writeFileSync(path.join(dir, '2026-07-28.jsonl'), lines.join('\n') + '\n');

  it('entfernt ein plugged:false aus einer LEEREN Altantwort', () => {
    // Diese Zeilen zerschnitten rückwirkend jede Nachtladung.
    write(['{"ts":"2026-07-28T02:59:00.000Z","dataTs":1,"charging":false,"plugged":false}']);
    expect(readSamples(dir)[0].plugged).toBeUndefined();
  });

  it('lässt ein echtes Ausstecken MIT Messwerten unangetastet', () => {
    write(['{"ts":"2026-07-28T02:59:00.000Z","soc":80,"charging":false,"plugged":false}']);
    expect(readSamples(dir)[0].plugged).toBe(false);
  });

  it('lässt plugged:true unangetastet', () => {
    write(['{"ts":"2026-07-28T02:59:00.000Z","plugged":true}']);
    expect(readSamples(dir)[0].plugged).toBe(true);
  });
});

describe('Zielmarke je Ladung', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ziel-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let nextPort = 8300;

  /** Rendert die Seite über den echten Server — prüft also auch die Verdrahtung. */
  const page = async (lines: object[], language: 'de' | 'en' = 'de'): Promise<string> => {
    fs.writeFileSync(
      path.join(dir, '2026-07-28.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    const server = startDashboard({
      port: nextPort++,
      logDir: dir,
      capacityKwh: 100,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 10,
      dayBoundaryHour: 0,
      vehicleName: 'Testwagen',
      uiPort: 8581,
      labels: labelsFor(language),
    });
    if (!server) {
      throw new Error('server not started');
    }
    await new Promise((r) => server.once('listening', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    server.close();
    return html;
  };

  const t = (min: number): string =>
    new Date(Date.UTC(2026, 6, 28, 6, 0, 0) + min * 60000).toISOString();

  it('nimmt das Ziel der jeweiligen Ladung, nicht das aktuelle', async () => {
    // Ladung 1 lief gegen 100 %, danach steht das Fahrzeug mit Ziel 60 % da.
    // Vorher malte die Seite BEIDEN Ladungen die 60 % von jetzt auf — und
    // schnitt die erste Kurve mitten im Verlauf ab, weil chargeCurve endet,
    // sobald das Ziel erreicht ist.
    const html = await page([
      { ts: t(0), soc: 40, plugged: true, charging: true, targetSoc: 100 },
      { ts: t(20), soc: 60, plugged: true, charging: true, targetSoc: 100 },
      { ts: t(40), soc: 80, plugged: true, charging: true, targetSoc: 100 },
      { ts: t(60), soc: 100, plugged: true, charging: true, targetSoc: 100 },
      { ts: t(70), soc: 100, plugged: false, targetSoc: 100 },
      { ts: t(200), soc: 30, plugged: true, charging: true, targetSoc: 60 },
      { ts: t(220), soc: 45, plugged: true, charging: true, targetSoc: 60 },
      { ts: t(240), soc: 60, plugged: true, charging: true, targetSoc: 60 },
      { ts: t(250), soc: 60, plugged: false, targetSoc: 60 },
    ]);
    expect(html).toContain('100% Ziel');
    expect(html).toContain('60% Ziel');
  });

  it('behält die Marke, wenn die Ladung mit einer LEEREN Antwort endet', async () => {
    // Die API liefert etwa stündlich eine Zeile nur mit ts. Träfe sie ans Ende
    // einer Ladung, verlöre ein naives "letzter Messpunkt" die Marke ganz.
    const html = await page([
      { ts: t(0), soc: 40, plugged: true, charging: true, targetSoc: 90 },
      { ts: t(20), soc: 55, plugged: true, charging: true, targetSoc: 90 },
      { ts: t(40), soc: 70, plugged: true, charging: true, targetSoc: 90 },
      { ts: t(50), dataTs: 1 },
      { ts: t(60), soc: 70, plugged: false },
    ]);
    expect(html).toContain('90% Ziel');
  });

  it('kommt ohne jede Zielangabe aus', async () => {
    const html = await page([
      { ts: t(0), soc: 40, plugged: true, charging: true },
      { ts: t(20), soc: 55, plugged: true, charging: true },
      { ts: t(40), soc: 70, plugged: true, charging: true },
      { ts: t(50), soc: 70, plugged: false },
    ]);
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
  });

  it('zeigt in der Kopfzeile weiterhin den AKTUELLEN Zustand', async () => {
    // Gegenprobe zur Korrektur: Oben gehört das Ziel von jetzt hin, nicht das
    // einer vergangenen Ladung.
    const html = await page([
      { ts: t(0), soc: 40, plugged: true, charging: true, targetSoc: 100 },
      { ts: t(20), soc: 60, plugged: true, charging: true, targetSoc: 100 },
      { ts: t(40), soc: 60, plugged: false, targetSoc: 100 },
      { ts: t(300), soc: 62, plugged: false, targetSoc: 55 },
    ]);
    expect(html).toContain('55 %');
  });
});
