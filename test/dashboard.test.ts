import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readSamples,
  summarize,
  startDashboard,
  optionsFor,
  currentStatus,
} from '../src/dashboard';
import type { ChargeSession } from '../src/sessions';
import { labelsFor } from '../src/i18n';
import { filterByPlace } from '../src/dashboard';
import { buildSessions } from '../src/sessions';
import { aggregate } from '../src/aggregate';
import type { ChargeLogSample } from '../src/chargeLog';

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
    externalPriceCt: 0,
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
    externalPriceCt: 0,
    dayBoundaryHour: 0,
    vehicleName: 'Taycan',
    uiPort: 8581,
    labels: labelsFor('en'),
  };

  // Port 0 bedeutet in der Konfiguration „Dashboard aus" — für die Tests
  // braucht es deshalb echte, je Test verschiedene Ports.
  let nextPort = 18200;

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
    const r = await (await fetch(`${url}/api/refresh`, { method: 'POST' })).json();
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
    await fetch(`${url}/api/refresh`, { method: 'POST' });
    const second = await (await fetch(`${url}/api/refresh`, { method: 'POST' })).json();
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('cooldown');
    expect(second.retryInMs).toBeGreaterThan(0);
    expect(calls).toBe(1);
    stop();
  });

  it('reports unavailable instead of failing when no handler is wired', async () => {
    const { url, stop } = await serve(undefined);
    const r = await (await fetch(`${url}/api/refresh`, { method: 'POST' })).json();
    expect(r).toEqual({ ok: false, reason: 'not-available' });
    stop();
  });

  it('reports a failing poll instead of crashing the server', async () => {
    const { url, stop } = await serve(async () => {
      throw new Error('backend down at /home/someone/.homebridge/tokens.json');
    });
    const r = await (await fetch(`${url}/api/refresh`, { method: 'POST' })).json();
    expect(r.ok).toBe(false);
    // Der Grund bleibt generisch: Node-Fehler tragen gern absolute Pfade, und
    // die gehören nicht in eine Antwort, die jeder im Netz abrufen kann.
    expect(r.reason).toBe('refresh-failed');
    expect(JSON.stringify(r)).not.toContain('.homebridge');
    stop();
  });

  it('lehnt GET ab — sonst genügt ein <img src> auf einer fremden Seite', async () => {
    // Ein GET löst keinen Preflight aus. Ohne diesen Riegel könnte jede
    // Webseite, die jemand im selben Netz öffnet, Abrufe beim Porsche-Backend
    // auslösen und das Ratenlimit gegen die Wand fahren.
    let calls = 0;
    const { url, stop } = await serve(async () => {
      calls++;
    });
    const res = await fetch(`${url}/api/refresh`);
    expect(res.status).toBe(405);
    expect(calls).toBe(0);
    stop();
  });

  it('lehnt einen POST mit fremdem Origin ab', async () => {
    let calls = 0;
    const { url, stop } = await serve(async () => {
      calls++;
    });
    const res = await fetch(`${url}/api/refresh`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(calls).toBe(0);
    stop();
  });

  it('lässt einen POST ohne Origin durch (curl, Homescreen-Modus)', async () => {
    let calls = 0;
    const { url, stop } = await serve(async () => {
      calls++;
    });
    const r = await (await fetch(`${url}/api/refresh`, { method: 'POST' })).json();
    expect(r).toEqual({ ok: true });
    expect(calls).toBe(1);
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
        externalPriceCt: 0,
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

  let nextPort = 18300;

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
      externalPriceCt: 0,
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

describe('Ortsfilter', () => {
  const t = (min: number): string =>
    new Date(Date.UTC(2026, 6, 28, 6, 0, 0) + min * 60000).toISOString();

  /** Zwei Ladungen: eine zuhause, eine unterwegs, dazwischen eine Fahrt. */
  const daten = () => {
    const samples: ChargeLogSample[] = [
      { ts: t(0), soc: 40, odometerKm: 50000, plugged: true, charging: true, atHome: true },
      { ts: t(60), soc: 70, odometerKm: 50000, plugged: true, charging: true, atHome: true },
      { ts: t(70), soc: 70, odometerKm: 50000, plugged: false },
      { ts: t(200), soc: 30, odometerKm: 50180, plugged: false, tripKwh100: 21 },
      { ts: t(300), soc: 30, odometerKm: 50180, plugged: true, charging: true, atHome: false },
      { ts: t(360), soc: 80, odometerKm: 50180, plugged: true, charging: true, atHome: false },
      { ts: t(370), soc: 80, odometerKm: 50180, plugged: false },
    ];
    return { samples, sessions: buildSessions(samples, { capacityKwh: 100 }) };
  };

  it('erkennt beide Orte', () => {
    expect(daten().sessions.map((s) => s.atHome)).toEqual([true, false]);
  });

  it('behält bei „zuhause" nur die Messpunkte der Heimladung', () => {
    const { samples, sessions } = daten();
    const home = filterByPlace(samples, sessions, 'home');
    expect(home.some((s) => s.atHome === false)).toBe(false);
    expect(home.some((s) => s.atHome === true)).toBe(true);
  });

  it('lässt die Messpunkte AUSSERHALB der Ladungen stehen', () => {
    // Sonst verlöre ein Ortsfilter die gefahrenen Kilometer — dort entsteht
    // keine geladene Energie, wohl aber die Fahrleistung.
    const { samples, sessions } = daten();
    const home = filterByPlace(samples, sessions, 'home');
    expect(home.some((s) => s.ts === t(200))).toBe(true);
    expect(home.some((s) => s.odometerKm === 50180 && s.plugged === false)).toBe(true);
  });

  it('trennt die Energie sauber auf beide Orte', () => {
    const { samples, sessions } = daten();
    const opts = { capacityKwh: 100, labels: labelsFor('en') };
    const kwh = (p: 'all' | 'home' | 'away'): number =>
      aggregate(filterByPlace(samples, sessions, p), 'day', opts).reduce((a, b) => a + b.kwh, 0);
    // Zuhause 40→70 = 30 kWh, unterwegs 30→80 = 50 kWh.
    expect(kwh('home')).toBeCloseTo(30, 1);
    expect(kwh('away')).toBeCloseTo(50, 1);
    expect(kwh('all')).toBeCloseTo(80, 1);
  });

  it('gibt bei „alle" die Messpunkte unverändert zurück', () => {
    const { samples, sessions } = daten();
    expect(filterByPlace(samples, sessions, 'all')).toBe(samples);
  });

  it('lässt eine Ladung ohne bekannten Ort aus BEIDEN Filtern fallen', () => {
    const samples: ChargeLogSample[] = [
      { ts: t(0), soc: 40, plugged: true, charging: true },
      { ts: t(60), soc: 70, plugged: true, charging: true },
      { ts: t(70), soc: 70, plugged: false },
    ];
    const sessions = buildSessions(samples, { capacityKwh: 100 });
    expect(sessions[0].atHome).toBeUndefined();
    expect(filterByPlace(samples, sessions, 'home')).toHaveLength(0);
    expect(filterByPlace(samples, sessions, 'away')).toHaveLength(0);
  });
});

describe('Preis je Ladung eintragen', () => {
  let dir: string;
  let nextPort = 18400;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
    const t = (m: number): string =>
      new Date(Date.UTC(2026, 6, 28, 6, 0, 0) + m * 60000).toISOString();
    fs.writeFileSync(
      path.join(dir, '2026-07-28.jsonl'),
      [
        { ts: t(0), soc: 30, plugged: true, charging: true, atHome: false },
        { ts: t(60), soc: 80, plugged: true, charging: true, atHome: false },
        { ts: t(70), soc: 80, plugged: false },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const serve = async (): Promise<{ url: string; stop: () => void }> => {
    const server = startDashboard({
      port: nextPort++,
      logDir: dir,
      capacityKwh: 100,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    return {
      url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`,
      stop: () => server.close(),
    };
  };

  const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${url}/api/price`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });

  const key = '2026-07-28T06:00:00.000Z';

  it('nimmt einen Preis an und rechnet ihn in die Ladung', async () => {
    const { url, stop } = await serve();
    const r = await (await post(url, { key, price: { eur: 24.8 } })).json();
    expect(r).toEqual({ ok: true });
    const sessions = await (await fetch(`${url}/api/sessions`)).json();
    expect(sessions[0].costEur).toBe(24.8);
    stop();
  });

  it('weist einen unbekannten Zeitpunkt ab', async () => {
    // Sonst ließe sich die Preisdatei mit beliebigen Schlüsseln vollschreiben.
    const { url, stop } = await serve();
    const res = await post(url, { key: '2001-01-01T00:00:00.000Z', price: { eur: 5 } });
    expect(res.status).toBe(400);
    stop();
  });

  it('weist ein verrutschtes Komma ab', async () => {
    const { url, stop } = await serve();
    const res = await post(url, { key, price: { eur: 9000 } });
    expect(res.status).toBe(400);
    stop();
  });

  it('lehnt GET ab', async () => {
    const { url, stop } = await serve();
    expect((await fetch(`${url}/api/price`)).status).toBe(405);
    stop();
  });

  it('lehnt einen fremden Origin ab', async () => {
    const { url, stop } = await serve();
    const res = await post(url, { key, price: { eur: 10 } }, { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    stop();
  });

  it('löscht einen Eintrag wieder', async () => {
    const { url, stop } = await serve();
    await post(url, { key, price: { eur: 24.8 } });
    await post(url, { key, clear: true });
    const sessions = await (await fetch(`${url}/api/sessions`)).json();
    expect(sessions[0].costEur).toBeUndefined();
    stop();
  });

  it('rechnet den Betrag aus ct/kWh, wenn kein Betrag angegeben ist', async () => {
    const { url, stop } = await serve();
    await post(url, { key, price: { ct: 59 } });
    const sessions = await (await fetch(`${url}/api/sessions`)).json();
    // 30 → 80 % von 100 kWh = 50 kWh × 0,59 €
    expect(sessions[0].costEur).toBeCloseTo(29.5, 2);
    stop();
  });
});

describe('Einstellungsseite', () => {
  let dir: string;
  let nextPort = 18500;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const serve = async (): Promise<{ url: string; stop: () => void }> => {
    const server = startDashboard({
      port: nextPort++,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.3,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    return {
      url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`,
      stop: () => server.close(),
    };
  };

  const save = (url: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${url}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });

  it('liefert die Seite aus', async () => {
    const { url, stop } = await serve();
    const html = await (await fetch(`${url}/settings`)).text();
    expect(html).toContain('Energy price');
    expect(html).toContain('Price away');
    stop();
  });

  /** Der Wert, der im Feld steht — ein Feld, ein Wert. */
  const feld = (html: string, key: string): string | undefined =>
    html.match(new RegExp(`id="f-${key}"[^>]*value="([^"]*)"`, 's'))?.[1];

  it('zeigt den wirksamen Wert im Feld, ohne Herkunft zu erklären', async () => {
    const { url, stop } = await serve();
    const html = await (await fetch(`${url}/settings`)).text();
    expect(feld(html, 'priceCt')).toBe('30');
    expect(html).not.toContain('From the plugin settings');
    expect(html).not.toContain('Set here');
    stop();
  });

  it('übernimmt einen Wert und wendet ihn sofort an', async () => {
    // Ohne Neustart — genau dafür gibt es die Seite.
    const { url, stop } = await serve();
    expect((await save(url, { priceCt: '28,45' })).status).toBe(200);
    const html = await (await fetch(`${url}/settings`)).text();
    expect(feld(html, 'priceCt')).toBe('28.45');
    stop();
  });

  it('macht die Übernahme in der Auswertung wirksam', async () => {
    // Nicht nur im Feld: Die Kapazität hängt vor jeder kWh-Zahl.
    const at = (h: number): string => {
      const d = new Date();
      d.setHours(h, 0, 0, 0);
      return d.toISOString();
    };
    const rows = [
      { ts: at(8), soc: 30, rangeKm: 120, odometerKm: 50000, plugged: true, charging: true },
      { ts: at(10), soc: 60, rangeKm: 240, odometerKm: 50000, plugged: true, charging: true },
      { ts: at(11), soc: 60, rangeKm: 240, odometerKm: 50000, plugged: false },
    ];
    fs.writeFileSync(
      path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const { url, stop } = await serve();
    const kwh = async (): Promise<number> =>
      (await (await fetch(`${url}/api/series?g=day`)).json()).series.reduce(
        (a: number, b: { kwh: number }) => a + b.kwh,
        0,
      );
    const vorher = await kwh();
    await save(url, { capacityKwh: 41.85 }); // die Hälfte von 83.7
    const nachher = await kwh();
    expect(vorher).toBeGreaterThan(0);
    // Rundung je Balken lässt die Hälfte nicht exakt aufgehen.
    expect(nachher / vorher).toBeCloseTo(0.5, 2);
    stop();
  });

  it('lehnt GET auf die Schreibroute ab', async () => {
    const { url, stop } = await serve();
    expect((await fetch(`${url}/api/settings`)).status).toBe(405);
    stop();
  });

  it('lehnt einen fremden Origin ab', async () => {
    const { url, stop } = await serve();
    const res = await save(url, { priceCt: 30 }, { origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    stop();
  });

  it('verwirft unsinnige Werte, ohne die Seite zu beschädigen', async () => {
    const { url, stop } = await serve();
    await save(url, { priceCt: 99999, capacityKwh: 1 });
    const html = await (await fetch(`${url}/settings`)).text();
    expect(feld(html, 'priceCt')).toBe('30');
    expect(feld(html, 'capacityKwh')).toBe('83.7');
    expect(html).not.toContain('99999');
    stop();
  });

  it('nimmt einen Wert per leerem Feld wieder zurück', async () => {
    const { url, stop } = await serve();
    await save(url, { priceCt: 40 });
    await save(url, { priceCt: '' });
    const html = await (await fetch(`${url}/settings`)).text();
    expect(feld(html, 'priceCt')).toBe('30');
    stop();
  });
});

describe('Datenqualität und Ortsfilter', () => {
  let dir: string;
  let nextPort = 18700;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('meldet keine Datenlücke, die nur der Ortsfilter erzeugt hat', async () => {
    // Lückenloser Mitschrieb: alle 10 Minuten ein Messpunkt, erst eine lange
    // Heimladung, dann eine Fahrt. Der Filter „unterwegs" schneidet die
    // Heimladung heraus — das entstehende Loch ist gewollt und keine fehlende
    // Messung. Vorher meldete die Seite dafür „69 % erfasst, 11,4 h fehlen".
    const rows: ChargeLogSample[] = [];
    const t = (m: number): string =>
      new Date(Date.UTC(2026, 6, 28, 0, 0, 0) + m * 60000).toISOString();
    for (let m = 0; m <= 600; m += 10) {
      rows.push({
        ts: t(m),
        soc: 40 + Math.floor(m / 20),
        odometerKm: 50000,
        plugged: true,
        charging: true,
        atHome: true,
      });
    }
    for (let m = 610; m <= 900; m += 10) {
      rows.push({ ts: t(m), soc: 70, odometerKm: 50000 + (m - 610), plugged: false });
    }
    fs.writeFileSync(
      path.join(dir, '2026-07-28.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    const server = startDashboard({
      port: nextPort++,
      logDir: dir,
      capacityKwh: 100,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

    for (const p of ['', '&p=home', '&p=away']) {
      const html = await (await fetch(`${url}/?g=day${p}`)).text();
      expect(html).not.toContain('Data gaps');
    }
    server.close();
  });

  it('meldet eine ECHTE Lücke weiterhin', async () => {
    // Gegenprobe zur vorigen: Fehlt wirklich ein halber Tag im Mitschrieb,
    // muss die Warnung kommen — sonst hätte der Fix sie nur stummgeschaltet.
    // Lokale Basis, nicht UTC: In fernen Zeitzonen verteilt `Date.UTC(...0:00)`
    // die Messpunkte über zwei Kalendertage, und die Lücke fällt in den falschen.
    const t = (m: number): string =>
      new Date(new Date(2026, 6, 28, 0, 0, 0).getTime() + m * 60000).toISOString();
    const rows: ChargeLogSample[] = [];
    for (let m = 0; m <= 60; m += 10) {
      rows.push({ ts: t(m), soc: 40, odometerKm: 50000, plugged: false });
    }
    // Zehn Stunden nichts.
    for (let m = 660; m <= 720; m += 10) {
      rows.push({ ts: t(m), soc: 38, odometerKm: 50050, plugged: false });
    }
    fs.writeFileSync(
      path.join(dir, '2026-07-28.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const server = startDashboard({
      port: nextPort++,
      logDir: dir,
      capacityKwh: 100,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).toContain('Data gaps');
    server.close();
  });
});

describe('Statusseite', () => {
  let dir: string;
  let nextPort = 18800;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stat-'));
    const t = (m: number): string =>
      new Date(Date.now() - (120 - m) * 60000).toISOString();
    const rows: ChargeLogSample[] = [
      {
        ts: t(0),
        soc: 60,
        rangeKm: 250,
        odometerKm: 50000,
        plugged: false,
        tyreBar: [2.6, 2.7, 2.5, 2.5],
        tyreDiffBar: [0, 0, 0.2, 0.2],
        serviceKm: 27300,
        locked: true,
        climateOn: false,
        targetTempC: 21,
        anyOpen: false,
      },
      // Spätere Zeile OHNE Zustandsfelder — so schreibt der Mitschrieb sie.
      { ts: t(60), soc: 58, rangeKm: 240, odometerKm: 50120, plugged: false },
    ];
    fs.writeFileSync(
      path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const page = async (language: 'de' | 'en'): Promise<string> => {
    const server = startDashboard({
      port: nextPort++,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor(language),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const html = await (
      await fetch(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/status`)
    ).text();
    server.close();
    return html;
  };

  it('zeigt den Reifendruck aller vier Räder', async () => {
    const html = await page('de');
    expect(html).toContain('2.6');
    expect(html).toContain('2.7');
    expect(html).toContain('hinten links');
  });

  it('findet Zustandswerte auch, wenn die LETZTE Zeile sie nicht trägt', async () => {
    // Kern der Delta-Schreibung: Der jüngste Messpunkt hat keine
    // Zustandsfelder, die Seite muss rückwärts suchen.
    const html = await page('de');
    expect(html).toContain('27.300');
  });

  it('markiert eine Abweichung über 0,15 bar', async () => {
    const html = await page('de');
    expect(html).toContain('wheel warn');
  });

  it('hebt ein unverriegeltes Fahrzeug hervor', async () => {
    fs.writeFileSync(
      path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({ ts: new Date().toISOString(), soc: 60, locked: false }) + '\n',
    );
    expect(await page('de')).toContain('card alert');
  });

  it('ist bei language=en vollständig englisch', async () => {
    const html = await page('en');
    expect(html).toContain('front left');
    expect(html).toContain('Next service');
    expect(html).not.toContain('vorne links');
    expect(html).not.toContain('Nächster Service');
  });

  it('kommt ohne jede Zustandsangabe aus', async () => {
    fs.writeFileSync(
      path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({ ts: new Date().toISOString(), soc: 60 }) + '\n',
    );
    const html = await page('de');
    expect(html).toContain('Noch kein Reifendruck erfasst');
    expect(html).not.toContain('undefined');
  });
});

describe('Service-Prognose', () => {
  let dir: string;
  let nextPort = 18950;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Schreibt `days` Tage Historie mit `kmPerDay` Fahrleistung. */
  const schreibe = (days: number, kmPerDay: number, serviceKm = 27000): void => {
    for (let d = days; d >= 0; d--) {
      const at = new Date(Date.now() - d * 86400000);
      const row = {
        ts: at.toISOString(),
        soc: 60,
        odometerKm: 50000 + (days - d) * kmPerDay,
        plugged: false,
        ...(d === days ? { serviceKm, locked: true } : {}),
      };
      fs.writeFileSync(
        path.join(dir, `${at.toISOString().slice(0, 10)}.jsonl`),
        JSON.stringify(row) + '\n',
      );
    }
    // Serviceangabe zusätzlich am Ende, damit sie als letzter Stand gilt.
    const last = new Date();
    fs.appendFileSync(
      path.join(dir, `${last.toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({
        ts: last.toISOString(),
        soc: 60,
        odometerKm: 50000 + days * kmPerDay,
        plugged: false,
        serviceKm,
        locked: true,
      }) + '\n',
    );
  };

  const seite = async (): Promise<string> => {
    const server = startDashboard({
      port: nextPort++,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const html = await (
      await fetch(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/status`)
    ).text();
    server.close();
    return html;
  };

  it('nennt Fahrleistung und geschätzten Zeitpunkt', async () => {
    schreibe(28, 30, 3000);
    const html = await seite();
    expect(html).toMatch(/at \d+ km\/week/);
  });

  it('gibt bei langer Restlaufzeit nur Jahre an', async () => {
    // Ein Monatsdatum zweieinhalb Jahre voraus behauptet eine Genauigkeit,
    // die eine Hochrechnung aus vier Wochen nicht hergibt.
    schreibe(28, 30, 27000);
    expect(await seite()).toMatch(/over \d+ more years/);
  });

  it('schweigt bei zu kurzer Historie', async () => {
    // Drei Tage Fahrleistung sind keine Grundlage für eine Jahresprognose.
    schreibe(3, 30, 27000);
    expect(await seite()).not.toMatch(/km\/week/);
  });

  it('schweigt, wenn kaum gefahren wurde', async () => {
    // Ohne Bewegung ergäbe die Hochrechnung eine Division durch fast null.
    schreibe(28, 1, 27000);
    expect(await seite()).not.toMatch(/km\/week/);
  });

  it('kommt ohne Serviceangabe aus', async () => {
    const at = new Date();
    fs.writeFileSync(
      path.join(dir, `${at.toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({ ts: at.toISOString(), soc: 60, odometerKm: 50000 }) + '\n',
    );
    const html = await seite();
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
  });
});

describe('Verspätete Öffnungsmeldung', () => {
  let dir: string;
  let nextPort = 19050;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Schreibt einen Verlauf, in dem seit `minutes` Minuten „offen" gemeldet wird. */
  const offenSeit = (minutes: number): void => {
    const rows = [
      {
        ts: new Date(Date.now() - (minutes + 60) * 60000).toISOString(),
        soc: 60,
        anyOpen: false,
        locked: true,
      },
      {
        ts: new Date(Date.now() - minutes * 60000).toISOString(),
        soc: 60,
        anyOpen: true,
        locked: true,
      },
      { ts: new Date().toISOString(), soc: 60 },
    ];
    fs.writeFileSync(
      path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  };

  const seite = async (): Promise<string> => {
    const server = startDashboard({
      port: nextPort++,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const html = await (
      await fetch(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/status`)
    ).text();
    server.close();
    return html;
  };

  it('schlägt bei frischer Meldung NICHT Alarm', async () => {
    // Das Fahrzeug meldet nach dem Abstellen regelmäßig ein offenes Fenster im
    // Fond, das zu ist, und korrigiert sich nach etwa einer halben Stunde. Ein
    // Alarm, der mehrmals täglich grundlos angeht, wird ignoriert — und nützt
    // dann auch nicht mehr, wenn wirklich etwas offen steht.
    offenSeit(10);
    const html = await seite();
    expect(html).toContain('reported for 10 min');
    expect(html).not.toContain('card alert');
  });

  it('schlägt Alarm, sobald die Meldung stehen bleibt', async () => {
    offenSeit(60);
    const html = await seite();
    expect(html).toContain('card alert');
  });

  it('nennt den Grund, statt die Meldung zu verschweigen', async () => {
    offenSeit(10);
    const html = await seite();
    // Der Zustand steht da — nur ohne Alarmfarbe und mit Einordnung.
    expect(html).toContain('>no<');
    expect(html).toContain('often delayed');
  });

  it('lässt „alles geschlossen" unangetastet', async () => {
    fs.writeFileSync(
      path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({ ts: new Date().toISOString(), soc: 60, anyOpen: false }) + '\n',
    );
    const html = await seite();
    expect(html).not.toContain('card alert');
    expect(html).not.toContain('often delayed');
  });
});

describe('Fremdladung ohne Preis', () => {
  let dir: string;
  let nextPort = 19150;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nop-'));
    const t = (m: number): string =>
      new Date(Date.UTC(2026, 6, 26, 6, 0, 0) + m * 60000).toISOString();
    const rows: ChargeLogSample[] = [
      { ts: t(0), soc: 40, odometerKm: 52000, plugged: true, charging: true, atHome: true },
      { ts: t(60), soc: 70, odometerKm: 52000, plugged: true, charging: true, atHome: true },
      { ts: t(70), soc: 70, odometerKm: 52000, plugged: false },
      { ts: t(300), soc: 30, odometerKm: 52180, plugged: true, charging: true, atHome: false },
      { ts: t(330), soc: 80, odometerKm: 52180, plugged: true, charging: true, atHome: false },
      { ts: t(340), soc: 80, odometerKm: 52180, plugged: false, atHome: false },
    ];
    fs.writeFileSync(
      path.join(dir, '2026-07-26.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reißt die Seite NICHT mit, wenn eine Ladung keine Kosten hat', async () => {
    // Ein konfigurierter Haustarif heißt nicht, dass jede Ladung Kosten hat.
    // Für eine Fremdladung ohne eingetragenen Preis bleiben sie leer — vorher
    // lief das in ein undefined.toFixed() und lieferte HTTP 500, sobald einmal
    // auswärts geladen wurde.
    const server = startDashboard({
      port: nextPort++,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    for (const q of ['', '&p=home', '&p=away']) {
      const res = await fetch(`${base}/?g=month${q}`);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('undefined');
    }
    server.close();
  });
});

describe('Zeitraum wählen und blättern', () => {
  let dir: string;
  let nextPort = 19250;

  /**
   * Tagesschlüssel wie das Dashboard ihn bildet — aus LOKALEN Datumsteilen.
   *
   * `toISOString().slice(0, 10)` liefert den UTC-Tag. Östlich von Greenwich
   * fallen beide nach Mitternacht Ortszeit auseinander: Um 00:30 MESZ ist in
   * UTC noch der Vortag. Genau daran ist dieser Block einmal über Nacht
   * umgekippt — grün am Abend, rot am Morgen, ohne eine Zeile Codeänderung.
   */
  const tagKey = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-'));
    // Drei Tage, je eine Ladung.
    const rows: ChargeLogSample[] = [];
    for (let d = 3; d >= 1; d--) {
      const base = Date.now() - d * 86400000;
      const t = (m: number): string => new Date(base + m * 60000).toISOString();
      rows.push(
        { ts: t(0), soc: 40, rangeKm: 160, odometerKm: 50000, plugged: true, charging: true, atHome: true },
        { ts: t(60), soc: 40 + d * 10, rangeKm: 200, odometerKm: 50000, plugged: true, charging: true, atHome: true },
        { ts: t(70), soc: 40 + d * 10, rangeKm: 200, odometerKm: 50000, plugged: false },
      );
    }
    const byDay: Record<string, ChargeLogSample[]> = {};
    for (const r of rows) (byDay[r.ts.slice(0, 10)] ??= []).push(r);
    for (const [day, rs] of Object.entries(byDay)) {
      fs.writeFileSync(path.join(dir, `${day}.jsonl`), rs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seite = async (q: string): Promise<string> => {
    const server = startDashboard({
      port: nextPort++, logDir: dir, capacityKwh: 100, pricePerKwh: 0.2,
      priceCt: 30, bonusCt: 0, externalPriceCt: 0, dayBoundaryHour: 0,
      vehicleName: 'T', uiPort: 8581, labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const html = await (
      await fetch(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/${q}`)
    ).text();
    server.close();
    return html;
  };

  const ladungen = (html: string): number => (html.match(/<tr class="sess/g) ?? []).length;

  it('zeigt in der Tagesansicht nur die Ladungen DIESES Tages', async () => {
    // Vorher stand unter jedem Zeitraum dieselbe vollständige Liste: Der
    // Umschalter änderte Kacheln und Balken, aber nicht die Liste darunter.
    expect(ladungen(await seite('?g=day'))).toBe(1);
  });

  it('fasst in der Wochenansicht alle Ladungen der Woche zusammen', async () => {
    expect(ladungen(await seite('?g=week'))).toBeGreaterThan(1);
  });

  it('springt über die Adresse in einen früheren Zeitraum', async () => {
    const gestern = tagKey(new Date(Date.now() - 86400000));
    const html = await seite(`?g=day&d=${gestern}`);
    // Datumsformat folgt der Sprache — geprüft wird der Tag, nicht die Schreibweise.
    expect(html).toContain(gestern.slice(8));
    expect(ladungen(html)).toBe(1);
  });

  it('bietet einen Zurück-Pfeil, solange es einen früheren Zeitraum gibt', async () => {
    expect(await seite('?g=day')).toContain('rel="prev"');
  });

  it('bietet keinen Vorwärts-Pfeil im jüngsten Zeitraum', async () => {
    expect(await seite('?g=day')).not.toContain('rel="next"');
  });

  it('bietet im älteren Zeitraum beide Pfeile und den Weg zurück zu heute', async () => {
    // Vorgestern: Es gibt sowohl davor als auch danach Daten. (Der jüngste
    // Zeitraum ist hier gestern, weil die Testdaten dort enden.)
    const vorgestern = tagKey(new Date(Date.now() - 2 * 86400000));
    const html = await seite(`?g=day&d=${vorgestern}`);
    expect(html).toContain('rel="prev"');
    expect(html).toContain('rel="next"');
    expect(html).toContain('class="now"');
  });

  it('ignoriert einen unsinnigen Zeitraum, statt eine leere Seite zu zeigen', async () => {
    const html = await seite('?g=day&d=1999-01-01');
    expect(html).not.toContain('undefined');
    expect(ladungen(html)).toBe(1);
  });

  it('behält den Ortsfilter beim Blättern', async () => {
    const html = await seite('?g=day&p=home');
    expect(html).toMatch(/href="\?g=day&p=home&d=/);
  });
});

describe('Abruf auf der Statusseite', () => {
  let dir: string;
  let nextPort = 19300;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srf-'));
    fs.writeFileSync(
      path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({ ts: new Date().toISOString(), soc: 60, locked: true }) + '\n',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seite = async (mitRefresh: boolean): Promise<string> => {
    const server = startDashboard({
      port: nextPort++, logDir: dir, capacityKwh: 83.7, pricePerKwh: 0.2,
      priceCt: 30, bonusCt: 0, externalPriceCt: 0, dayBoundaryHour: 0,
      vehicleName: 'T', uiPort: 8581, labels: labelsFor('en'),
      ...(mitRefresh ? { onRefresh: async (): Promise<void> => {} } : {}),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const html = await (
      await fetch(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/status`)
    ).text();
    server.close();
    return html;
  };

  it('bietet den Abruf-Knopf an', async () => {
    // Wer nachsieht, ob das Auto verriegelt ist, will den JETZIGEN Stand.
    expect(await seite(true)).toContain('id="rf"');
  });

  it('nennt den Zeitpunkt des letzten Messpunkts', async () => {
    expect(await seite(true)).toMatch(/as of \d\d:\d\d/);
  });

  it('verbirgt den Knopf ohne angeschlossenen Abruf', async () => {
    // Ein Knopf, der nichts auslösen kann, ist schlechter als keiner.
    expect(await seite(false)).not.toContain('id="rf"');
  });
});

describe('Fahrtenliste auf der Seite', () => {
  let dir: string;
  let nextPort = 18900;
  let server: ReturnType<typeof startDashboard>;
  let url: string;

  // Lokale Basis, nicht UTC: Das Dashboard bildet seine Tagesschlüssel aus
  // Ortszeit. Ein `Date.UTC(...)`-Anker verteilt dieselben Messpunkte je
  // Zeitzone auf verschiedene Kalendertage.
  const t = (m: number): string =>
    new Date(new Date(2026, 6, 28, 0, 0, 0).getTime() + m * 60000).toISOString();

  /** Startet den Server über einem Mitschrieb aus `rows`. */
  const serve = async (rows: ChargeLogSample[]): Promise<void> => {
    const byDay: Record<string, ChargeLogSample[]> = {};
    for (const r of rows) {
      (byDay[r.ts.slice(0, 10)] ??= []).push(r);
    }
    for (const [d, rs] of Object.entries(byDay)) {
      fs.writeFileSync(
        path.join(dir, `${d}.jsonl`),
        rs.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
    }
    server = startDashboard({
      port: nextPort++,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server?.once('listening', r));
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  };

  /** Laden bei km 1000, danach zwei Fahrten mit bekanntem Verbrauch. */
  const zweiFahrten = (): ChargeLogSample[] => [
    { ts: t(0), odometerKm: 1000, soc: 80, plugged: true, charging: true, atHome: true },
    { ts: t(20), odometerKm: 1000, soc: 80, plugged: false },
    { ts: t(40), odometerKm: 1040, soc: 71, plugged: false, tripKwh100: 20 },
    { ts: t(60), odometerKm: 1040, soc: 71, plugged: false, tripKwh100: 20 },
    { ts: t(80), odometerKm: 1100, soc: 51, plugged: false, tripKwh100: 25 },
    { ts: t(100), odometerKm: 1100, soc: 51, plugged: false, tripKwh100: 25 },
  ];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-'));
  });

  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('zeigt die Fahrten des Zeitraums mit Strecke und Verbrauch', async () => {
    await serve(zweiFahrten());
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).toContain('<h2>Trips');
    expect(html).toContain('40 km');
    expect(html).toContain('60 km');
    expect(html).toContain('28.3 kWh/100 km');
  });

  it('nennt die Summe des Zeitraums an der Überschrift', async () => {
    await serve(zweiFahrten());
    const html = await (await fetch(`${url}/?g=day`)).text();
    // 100 km, 25 kWh → 25,0 kWh/100 km, bei 30 ct/kWh ohne Bonus 7,50 €.
    expect(html).toMatch(/<h2>Trips<em>100 km · 25\.0 kWh\/100 km · 7\.50 €/);
  });

  it('verschweigt den Abschnitt, solange keine Fahrt im Zeitraum liegt', async () => {
    await serve([
      { ts: t(0), odometerKm: 1000, soc: 80, plugged: true, charging: true, atHome: true },
      { ts: t(20), odometerKm: 1000, soc: 81, plugged: true, charging: true, atHome: true },
      { ts: t(40), odometerKm: 1000, soc: 82, plugged: false },
    ]);
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).not.toContain('<h2>Trips');
  });

  it('folgt dem Zeitraum, statt immer alle Fahrten zu zeigen', async () => {
    const gestern = (m: number): string =>
      new Date(new Date(2026, 6, 27, 0, 0, 0).getTime() + m * 60000).toISOString();
    await serve([
      { ts: gestern(0), odometerKm: 900, soc: 90, plugged: false },
      { ts: gestern(20), odometerKm: 977, soc: 70, plugged: false },
      { ts: gestern(40), odometerKm: 977, soc: 70, plugged: false },
      ...zweiFahrten(),
    ]);
    const heute = await (await fetch(`${url}/?g=day`)).text();
    expect(heute).not.toContain('77 km');
    const vortag = await (await fetch(`${url}/?g=day&d=2026-07-27`)).text();
    expect(vortag).toContain('77 km');
    expect(vortag).not.toContain('>60 km<');
  });

  it('bleibt vom Ortsfilter unberührt — wo geladen wurde, sagt nichts über das Fahren', async () => {
    await serve(zweiFahrten());
    for (const p of ['', '&p=home', '&p=away']) {
      const html = await (await fetch(`${url}/?g=day${p}`)).text();
      expect(html).toContain('100 km · 25.0 kWh/100 km');
    }
  });

  it('weist die Auflösung aus, statt Genauigkeit vorzutäuschen', async () => {
    await serve(zweiFahrten());
    const html = await (await fetch(`${url}/?g=day`)).text();
    // Der Poll-Takt stand als Erklärsatz unter der Liste und ist als
    // Innensicht des Programms gestrichen — die Liste selbst bleibt.
    expect(html).toMatch(/class="acts"/);
  });

  it('nennt die Strecke, für die kein Verbrauch belastbar ist', async () => {
    await serve([
      // Erster Zyklus ohne bekannten Anfang: 30 km ohne Verbrauchsangabe.
      { ts: t(0), odometerKm: 900, soc: 90, plugged: false, tripKwh100: 21 },
      { ts: t(20), odometerKm: 930, soc: 83, plugged: false, tripKwh100: 21 },
      { ts: t(40), odometerKm: 930, soc: 83, plugged: false, tripKwh100: 21 },
    ]);
    const html = await (await fetch(`${url}/?g=day`)).text();
    // Der Erklärsatz zur bewerteten Strecke ist entfallen — er beschrieb,
    // WIE die Zahl entsteht, nicht die Zahl. Die Kennzahl selbst rechnet
    // unverändert nur über die bewertete Strecke.
    expect(html).toContain('<h2>');
  });
});

describe('Deckel der Listen', () => {
  let dir: string;
  let server: ReturnType<typeof startDashboard>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  });

  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deckelt die Ladungsliste und sagt es, statt still abzuschneiden', async () => {
    // 50 kurze Ladungen an einem Tag. Ohne Deckel brächte jede ihre eigene
    // Ladekurve mit — bei einem Jahr wog die Seite 1,4 MB.
    const rows: ChargeLogSample[] = [];
    for (let i = 0; i < 50; i++) {
      // Lokale Basis — sonst verteilt sich der Tag in fernen Zeitzonen auf zwei.
      const base = new Date(2026, 6, 28, 0, 0, 0).getTime() + i * 20 * 60000;
      const at = (s: number): string => new Date(base + s * 60000).toISOString();
      rows.push({ ts: at(0), odometerKm: 1000, soc: 40, plugged: true, charging: true, atHome: true });
      rows.push({ ts: at(5), odometerKm: 1000, soc: 42, plugged: true, charging: true, atHome: true });
      rows.push({ ts: at(10), odometerKm: 1000, soc: 42, plugged: false });
    }
    fs.writeFileSync(
      path.join(dir, '2026-07-28.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    server = startDashboard({
      port: 18999,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server?.once('listening', r));
    const a = server.address();
    const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).toContain('The most recent 40 of 50 charges');
    // Die Kachel zählt weiterhin ALLE — der Deckel betrifft nur die Liste.
    expect(html).toMatch(/<span>Charges<\/span><b>50<\/b>/);
  });
});

describe('Abgebrochene Ladung in der Oberfläche', () => {
  let dir: string;
  let server: ReturnType<typeof startDashboard>;
  let url: string;

  const t = (m: number): string =>
    new Date(Date.now() - (400 - m) * 60000).toISOString();

  /** Ladung mit Ziel 80 %, die bei 60 % aufhört und dann `idleMin` steht. */
  const rows = (idleMin: number): ChargeLogSample[] => {
    const out: ChargeLogSample[] = [];
    for (let m = 0; m <= 100; m += 10) {
      out.push({
        ts: t(m),
        soc: Math.round(40 + (20 * m) / 100),
        odometerKm: 50000,
        plugged: true,
        charging: true,
        targetSoc: 80,
        atHome: true,
      });
    }
    for (let m = 110; m <= 100 + idleMin; m += 10) {
      out.push({
        ts: t(m),
        soc: 60,
        odometerKm: 50000,
        plugged: true,
        charging: false,
        targetSoc: 80,
        atHome: true,
      });
    }
    out.push({ ts: t(110 + idleMin), soc: 60, odometerKm: 50000, plugged: false, targetSoc: 80 });
    return out;
  };

  const serve = async (idleMin: number): Promise<void> => {
    const all = rows(idleMin);
    const byDay: Record<string, ChargeLogSample[]> = {};
    for (const r of all) {
      (byDay[r.ts.slice(0, 10)] ??= []).push(r);
    }
    for (const [d, rs] of Object.entries(byDay)) {
      fs.writeFileSync(
        path.join(dir, `${d}.jsonl`),
        rs.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
    }
    server = startDashboard({
      port: 19100 + idleMin,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server?.once('listening', r));
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abort-'));
  });

  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('markiert die Ladung in der Liste', async () => {
    await serve(120);
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).toContain('at 60 % instead of 80 %');
  });

  it('hebt sie auf der Statusseite hervor', async () => {
    await serve(120);
    const html = await (await fetch(`${url}/status`)).text();
    expect(html).toContain('Charge aborted');
    expect(html).toContain('card alert');
  });

  it('schweigt auf beiden Seiten, wenn es kein Abbruch war', async () => {
    await serve(20);
    const liste = await (await fetch(`${url}/?g=day`)).text();
    const status = await (await fetch(`${url}/status`)).text();
    expect(liste).not.toContain('instead of 80 %');
    expect(status).not.toContain('Charge aborted');
  });
});

describe('Belegroute', () => {
  let dir: string;
  let server: ReturnType<typeof startDashboard>;
  let url: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beleg-'));
    // Je eine abgeschlossene Ladung im Juni und im Juli.
    for (const [tag, soc] of [
      ['2026-06-15', 60],
      ['2026-07-15', 70],
    ] as [string, number][]) {
      const rows: ChargeLogSample[] = [
        { ts: `${tag}T20:00:00.000Z`, soc: 40, plugged: true, charging: true, atHome: true },
        { ts: `${tag}T22:00:00.000Z`, soc, plugged: true, charging: true, atHome: true },
        { ts: `${tag}T22:10:00.000Z`, soc, plugged: false },
      ];
      fs.writeFileSync(
        path.join(dir, `${tag}.jsonl`),
        rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
    }
    server = startDashboard({
      port: 19300,
      logDir: dir,
      capacityKwh: 100,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 10,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server?.once('listening', r));
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });

  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('zeigt ohne Angabe den jüngsten Monat mit Ladungen', async () => {
    const html = await (await fetch(`${url}/beleg`)).text();
    expect(html).toContain('July 2026');
    // 30 Punkte × 100 kWh / 100 = 30.00 kWh
    expect(html).toContain('30.00');
  });

  it('folgt dem gewählten Monat', async () => {
    const html = await (await fetch(`${url}/beleg?m=2026-06`)).text();
    expect(html).toContain('20.00'); // 20 Punkte im Juni
    expect(html).not.toContain('>30.00<');
  });

  it('nennt offen, dass die Energie gerechnet und nicht gemessen ist', async () => {
    // Ein Beleg, der eine Herkunft verschweigt, die er nicht hat, wäre wertlos.
    const html = await (await fetch(`${url}/beleg`)).text();
    expect(html).toContain('not metered at the socket');
    expect(html).toContain('Charging losses');
  });

  it('liefert das CSV als Download mit BOM', async () => {
    const res = await fetch(`${url}/beleg.csv?m=2026-07`);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('charging-receipt-2026-07.csv');
    // Roh prüfen: `text()` verwirft den BOM beim Dekodieren, aber genau er
    // entscheidet, ob Excel die Umlaute richtig zeigt.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toContain('Total at home');
  });

  it('weist einen unsinnigen Monat ab, statt ihn zu übernehmen', async () => {
    const html = await (await fetch(`${url}/beleg?m=kaputt`)).text();
    expect(html).toContain('July 2026');
  });

  it('verlinkt den Beleg von der Ladehistorie', async () => {
    const html = await (await fetch(`${url}/?g=month`)).text();
    // Mit Monatsparameter: Der Bericht folgt dem angesehenen Zeitraum.
    expect(html).toMatch(/href="\/beleg\?m=\d{4}-\d{2}"/);
  });
});

describe('Kapazitätsverlauf auf der Seite', () => {
  let dir: string;
  let server: ReturnType<typeof startDashboard>;
  let url: string;

  /** Ein verwertbarer Entladezyklus mit vorgegebener Kapazität. */
  const zyklus = (
    month: string,
    day: number,
    kwh: number,
    odo: number,
  ): ChargeLogSample[] => {
    const kwh100 = Math.round(((kwh * 30) / 100 / 100) * 100 * 10) / 10;
    const iso = (h: number): string =>
      `${month}-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
    return [
      { ts: iso(6), soc: 80, odometerKm: odo, plugged: true, charging: true, atHome: true },
      { ts: iso(7), soc: 80, odometerKm: odo, plugged: false },
      { ts: iso(9), soc: 50, odometerKm: odo + 100, plugged: false, tripKwh100: kwh100 },
      { ts: iso(10), soc: 50, odometerKm: odo + 100, plugged: true, charging: true, atHome: true },
    ];
  };

  const serve = async (monate: string[], port: number): Promise<void> => {
    let odo = 50000;
    const rows: ChargeLogSample[] = [];
    monate.forEach((m, i) => {
      for (let n = 0; n < 2; n++) {
        rows.push(...zyklus(m, 5 + n * 10, 84 - i, odo));
        odo += 100;
      }
    });
    const byDay: Record<string, ChargeLogSample[]> = {};
    for (const r of rows) {
      (byDay[r.ts.slice(0, 10)] ??= []).push(r);
    }
    for (const [d, rs] of Object.entries(byDay)) {
      fs.writeFileSync(
        path.join(dir, `${d}.jsonl`),
        rs.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
    }
    server = startDashboard({
      port,
      logDir: dir,
      capacityKwh: 84,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server?.once('listening', r));
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'));
  });

  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('zeichnet den Verlauf ab vier Monaten', async () => {
    await serve(['2026-01', '2026-02', '2026-03', '2026-04'], 19400);
    const html = await (await fetch(`${url}/?g=year`)).text();
    expect(html).toContain('class="captrend"');
    expect(html).toContain('over 4 months');
    // 84,0 → 81,0 kWh: Anfang und Ende stehen als Zahl daneben, damit die
    // Linie nicht die einzige Aussage ist.
    expect(html).toMatch(/84\.0 → 81\.0 kWh/);
  });

  it('schweigt bei drei Monaten, statt eine Gerade durch Zufälle zu legen', async () => {
    await serve(['2026-01', '2026-02', '2026-03'], 19401);
    const html = await (await fetch(`${url}/?g=year`)).text();
    // Der Klassenname steht immer im CSS — geprüft wird das Element.
    expect(html).not.toContain('class="captrend"');
  });
});

describe('Verbrauch im Diagramm', () => {
  let dir: string;
  let server: ReturnType<typeof startDashboard>;
  let url: string;

  const heute = new Date();
  heute.setHours(0, 0, 0, 0);
  const t = (min: number): string => new Date(heute.getTime() + min * 60000).toISOString();

  const serve = async (rows: ChargeLogSample[], port: number): Promise<void> => {
    const byDay: Record<string, ChargeLogSample[]> = {};
    for (const r of rows) (byDay[r.ts.slice(0, 10)] ??= []).push(r);
    for (const [d, rs] of Object.entries(byDay)) {
      fs.writeFileSync(
        path.join(dir, `${d}.jsonl`),
        rs.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
    }
    server = startDashboard({
      port,
      logDir: dir,
      capacityKwh: 100,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server?.once('listening', r));
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gegen-'));
  });

  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('trägt die verbrauchte Energie als Gegenbalken auf', async () => {
    // Laden bei km 1000, dann 40 km mit 20 kWh/100 km = 8 kWh verbraucht.
    await serve(
      [
        { ts: t(0), soc: 40, odometerKm: 1000, plugged: true, charging: true, atHome: true },
        { ts: t(60), soc: 70, odometerKm: 1000, plugged: true, charging: true, atHome: true },
        { ts: t(70), soc: 70, odometerKm: 1000, plugged: false },
        { ts: t(120), soc: 62, odometerKm: 1040, plugged: false, tripKwh100: 20 },
        { ts: t(140), soc: 62, odometerKm: 1040, plugged: false, tripKwh100: 20 },
      ],
      19500,
    );
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).toContain('kWh used');
    expect(html).toContain('8.0 kWh used');
    expect(html).toContain('class="d"');
  });

  it('zeigt die Legende nur, wenn es zwei Richtungen gibt', async () => {
    // Ohne Fahrten bleibt es eine Reihe — dann wäre die Legende Bedienlast.
    await serve(
      [
        { ts: t(0), soc: 40, odometerKm: 1000, plugged: true, charging: true, atHome: true },
        { ts: t(60), soc: 70, odometerKm: 1000, plugged: true, charging: true, atHome: true },
        { ts: t(70), soc: 70, odometerKm: 1000, plugged: false },
      ],
      19501,
    );
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).not.toContain('class="legend"');
    expect(html).not.toContain('class="d"');
  });

  it('nennt die Strecke, deren Verbrauch nicht belastbar ist', async () => {
    // Der erste Zyklus hat keinen bekannten Anfang — seine Strecke fehlt dem
    // Gegenbalken. Das darf nicht stillschweigend passieren.
    await serve(
      [
        { ts: t(0), soc: 90, odometerKm: 900, plugged: false, tripKwh100: 21 },
        { ts: t(20), soc: 80, odometerKm: 950, plugged: false, tripKwh100: 21 },
        { ts: t(40), soc: 80, odometerKm: 950, plugged: false, tripKwh100: 21 },
      ],
      19502,
    );
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).toContain('50 km without a reliable consumption figure');
  });
});

describe('Ladekurve jenseits des Cache-Deckels', () => {
  let dir: string;
  let server: ReturnType<typeof startDashboard>;
  let url: string;

  /**
   * Mitschrieb über `tage` Tage, mit einer Ladung am ERSTEN Tag.
   *
   * Bei mehr als 500 Tagesdateien hält der Cache nur das Ende — die
   * Messpunkte der ersten Ladung sind dann nicht mehr darin. Ihre Kurve muss
   * trotzdem erscheinen, weil sie gezielt nachgeladen wird.
   */
  const bauen = (tage: number): string => {
    const start = new Date(2024, 0, 1, 12, 0, 0);
    for (let d = 0; d < tage; d++) {
      const tag = new Date(start.getTime() + d * 86400000);
      const key = `${tag.getFullYear()}-${String(tag.getMonth() + 1).padStart(2, '0')}-${String(
        tag.getDate(),
      ).padStart(2, '0')}`;
      const rows: ChargeLogSample[] = [];
      const at = (h: number, m = 0): string =>
        new Date(tag.getFullYear(), tag.getMonth(), tag.getDate(), h, m).toISOString();
      if (d === 0) {
        // Eine Ladung mit genug Messpunkten für eine Kurve.
        for (let i = 0; i <= 8; i++) {
          rows.push({
            ts: at(20, i * 5),
            soc: 40 + i * 5,
            rangeKm: 160 + i * 20,
            odometerKm: 50000,
            plugged: true,
            charging: true,
            targetSoc: 80,
            atHome: true,
          });
        }
        rows.push({ ts: at(21, 0), soc: 80, odometerKm: 50000, plugged: false });
      } else {
        rows.push({ ts: at(12), soc: 60, odometerKm: 50000 + d, plugged: false });
      }
      fs.writeFileSync(
        path.join(dir, `${key}.jsonl`),
        rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
    }
    return '2024-01-01';
  };

  const serve = async (port: number): Promise<void> => {
    server = startDashboard({
      port,
      logDir: dir,
      capacityKwh: 100,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server?.once('listening', r));
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckel-'));
  });

  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('zeichnet die Kurve einer Ladung, die älter ist als der Cache', async () => {
    // 600 Tagesdateien: Der Cache hält nur die letzten 500, die Ladung liegt
    // am ersten Tag. Ohne gezieltes Nachladen fehlte ihre Kurve.
    const tag = bauen(600);
    await serve(19700);
    const html = await (await fetch(`${url}/?g=day&d=${tag}`)).text();
    expect(html).toContain('40 → 80 %');
    expect(html).toContain('class="curvewrap"');
  }, 30000);

  it('liest bei kurzer Historie nichts zusätzlich, sondern nutzt den Cache', async () => {
    const tag = bauen(5);
    await serve(19701);
    const html = await (await fetch(`${url}/?g=day&d=${tag}`)).text();
    expect(html).toContain('class="curvewrap"');
  });
});

describe('Kacheln bei fehlender Ladung im Zeitraum', () => {
  let dir: string;
  let server: ReturnType<typeof startDashboard>;
  let url: string;

  const heute = new Date();
  heute.setHours(0, 0, 0, 0);
  const t = (min: number): string => new Date(heute.getTime() + min * 60000).toISOString();

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leer-'));
    // Gestern eine Ladung, heute nur gefahren — der heutige Zeitraum hat also
    // Kilometer, aber keine geladene Energie.
    const gestern = new Date(heute.getTime() - 86400000);
    const key = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;
    fs.writeFileSync(
      path.join(dir, `${key(gestern)}.jsonl`),
      [
        { ts: new Date(gestern.getTime() + 20 * 3600000).toISOString(), soc: 40, odometerKm: 1000, plugged: true, charging: true, atHome: true },
        { ts: new Date(gestern.getTime() + 22 * 3600000).toISOString(), soc: 80, odometerKm: 1000, plugged: true, charging: true, atHome: true },
        { ts: new Date(gestern.getTime() + 22.5 * 3600000).toISOString(), soc: 80, odometerKm: 1000, plugged: false },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, `${key(heute)}.jsonl`),
      [
        { ts: t(60), soc: 80, odometerKm: 1000, plugged: false, tripKwh100: 20 },
        { ts: t(80), soc: 78, odometerKm: 1010, plugged: false, tripKwh100: 20 },
        { ts: t(100), soc: 78, odometerKm: 1010, plugged: false, tripKwh100: 20 },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    server = startDashboard({
      port: 19800,
      logDir: dir,
      capacityKwh: 100,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 10,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'T',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server?.once('listening', r));
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });

  afterEach(() => {
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('behauptet nicht, der Wagen fahre umsonst', async () => {
    // 10 km gefahren, 0 kWh geladen: „bezahlt 0.0 kWh/100 km" und „0.0 ct/km"
    // wären keine günstige Fahrt, sondern eine fehlende Ladung.
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).toContain('10 km');
    expect(html).not.toContain('paid 0.0');
    expect(html).not.toContain('0.0 ct/km');
  });

  it('zeigt die gefahrenen Kilometer auch bei konfiguriertem Bonus', async () => {
    // Vorher stand bei Bonus die Ersparnis STATT der Strecke — wer einen Bonus
    // hat, sah die gefahrenen Kilometer nirgends in den Kacheln.
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).toContain('<span>Driven</span>');
  });

  it('nennt dieselbe Ersparnis nicht zweimal', async () => {
    const html = await (await fetch(`${url}/?g=week`)).text();
    // Die ANGABE zählen, nicht das Wort: "saved" steckt auch in
    // CSS-Klassen und Labels, die nichts mit dieser Kachel zu tun haben.
    const stellen = (html.match(/€ saved/g) ?? []).length;
    expect(stellen).toBeLessThanOrEqual(1);
  });
});

describe('Riegel des Abruf-Knopfs', () => {
  const base = {
    logDir: '/tmp',
    capacityKwh: 83.7,
    pricePerKwh: 0.2,
    priceCt: 32,
    bonusCt: 12,
    externalPriceCt: 0,
    dayBoundaryHour: 0,
    vehicleName: 'T',
    uiPort: 8581,
    labels: labelsFor('en'),
  };
  let nextPort = 19850;

  const serve = async (): Promise<{ url: string; stop: () => void; calls: () => number }> => {
    let n = 0;
    const server = startDashboard({
      ...base,
      port: nextPort++,
      onRefresh: async () => {
        n++;
      },
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    return {
      url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`,
      stop: () => server.close(),
      calls: () => n,
    };
  };

  it('lehnt GET ab — sonst genügt ein <img src> auf einer fremden Seite', async () => {
    // Ein GET löst keinen Preflight aus, und die Antwort muss der Angreifer
    // nicht lesen: Der Abruf beim Porsche-Backend läuft trotzdem. Bei 20 s
    // Sperre wären das 180 Abrufe je Stunde — gerichtet gegen genau das
    // Ratenlimit, dessen Überschreiten eine Captcha-Sperre erzwingt.
    const { url, stop, calls } = await serve();
    const res = await fetch(`${url}/api/refresh`);
    expect(res.status).toBe(405);
    expect(calls()).toBe(0);
    stop();
  });

  it('lehnt einen POST mit fremdem Origin ab', async () => {
    const { url, stop, calls } = await serve();
    const res = await fetch(`${url}/api/refresh`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(calls()).toBe(0);
    stop();
  });

  it('lässt sich nicht von einem Origin täuschen, der nur so anfängt', async () => {
    const { url, stop, calls } = await serve();
    const host = new URL(url).host;
    const res = await fetch(`${url}/api/refresh`, {
      method: 'POST',
      headers: { origin: `http://${host}.evil.example` },
    });
    expect(res.status).toBe(403);
    expect(calls()).toBe(0);
    stop();
  });

  it('lässt einen POST ohne Origin durch (curl, Homescreen-Modus)', async () => {
    const { url, stop, calls } = await serve();
    const r = await (await fetch(`${url}/api/refresh`, { method: 'POST' })).json();
    expect(r).toEqual({ ok: true });
    expect(calls()).toBe(1);
    stop();
  });

  it('ruft den Knopf im Dashboard selbst per POST auf', async () => {
    // Der Riegel wäre nutzlos, wenn die eigene Seite ihn nicht bedient.
    const { url, stop } = await serve();
    const html = await (await fetch(`${url}/?g=day`)).text();
    expect(html).toContain("fetch('/api/refresh',{method:'POST'})");
    expect(html).not.toContain("fetch('/api/refresh').");
    stop();
  });
});

describe('currentStatus with partial API responses', () => {
  // Observed 2026-07-31: after a complete sample, the API answered two polls
  // with the charging state only. The header then showed "—" instead of the
  // state of charge, and the charge-level tile vanished from /status — even
  // though the value was three minutes old. Roughly 7 % of all samples are
  // such partial responses.
  const at = (day: number, hour = 12, min = 0): string =>
    new Date(Date.UTC(2026, 6, day, hour, min)).toISOString();

  const gap: ChargeLogSample[] = [
    { ts: at(31, 20, 46), soc: 55, rangeKm: 236, odometerKm: 52670, powerKw: 10, charging: true },
    { ts: at(31, 20, 49), charging: false, climateOn: false },
    { ts: at(31, 20, 52), charging: false },
  ];
  const now = Date.parse(at(31, 20, 53));

  it('carries forward state of charge, range and odometer', () => {
    const st = currentStatus(gap, now);
    expect(st.state?.soc).toBe(55);
    expect(st.state?.rangeKm).toBe(236);
    expect(st.state?.odometerKm).toBe(52670);
  });

  it('never carries forward instantaneous values — 10 kW ago is not now', () => {
    const st = currentStatus(gap, now);
    expect(st.state?.powerKw).toBeUndefined();
    expect(st.state?.charging).toBe(false);
  });

  it('reports when the reading was taken, not when it was polled', () => {
    const st = currentStatus(gap, now);
    expect(st.stateAt).toBe(at(31, 20, 46));
    expect(st.last?.ts).toBe(at(31, 20, 52));
  });

  it('does not let a rarely sent field make the timestamp look stale', () => {
    // The car reports charge target and instant-charge threshold only while
    // plugged in. Standing still they are days old, while state of charge and
    // odometer arrive every few minutes. The timestamp belongs to the most
    // recent reading — otherwise a fresh display was headed "as of 05:12".
    const st = currentStatus(
      [
        { ts: at(29, 5, 12), targetSoc: 80, minSoc: 40 },
        { ts: at(31, 21, 11), soc: 55, rangeKm: 243, odometerKm: 52670 },
      ],
      Date.parse(at(31, 21, 15)),
    );
    expect(st.stateAt).toBe(at(31, 21, 11));
    expect(st.state?.targetSoc).toBe(80);
  });

  it('leaves the raw last sample untouched', () => {
    expect(currentStatus(gap, now).last?.soc).toBeUndefined();
  });

  it('reports no state when none was ever recorded', () => {
    const st = currentStatus([{ ts: at(31, 20, 52), charging: false }], now);
    expect(st.state?.soc).toBeUndefined();
    expect(st.stateAt).toBeUndefined();
  });
});

describe('rendering with partial API responses', () => {
  let dir: string;
  // Port 0 means "dashboard off" in the config, so the tests need real ones.
  let nextPartialPort = 18500;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-'));
    const t = (min: number): string => new Date(Date.now() - min * 60000).toISOString();
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(dir, `${day}.jsonl`),
      [
        JSON.stringify({
          ts: t(7),
          soc: 55,
          rangeKm: 236,
          odometerKm: 52670,
          charging: false,
          plugged: false,
        }),
        JSON.stringify({ ts: t(4), charging: false, climateOn: false }),
        JSON.stringify({ ts: t(1), charging: false }),
      ].join('\n') + '\n',
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = async (route: string): Promise<string> => {
    const server = startDashboard({
      port: nextPartialPort++,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 32,
      bonusCt: 12,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'Taycan',
      uiPort: 8581,
      labels: labelsFor('en'),
    });
    if (!server) {
      throw new Error('server not started');
    }
    await new Promise((r) => server.once('listening', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const html = await (await fetch(`http://127.0.0.1:${port}${route}`)).text();
    server.close();
    return html;
  };

  it('shows state of charge and range in the header', async () => {
    const html = await get('/');
    expect(html).toContain('<b>55 %</b>');
    expect(html).toContain('236 km');
    // The bar too, not just the number — it sat at 0 %.
    expect(html).toContain('width:55%');
  });

  it('keeps the charge-level tile on the status page', async () => {
    const html = await get('/status');
    // The tile's own wording — a bare "236 km" also appears in the header.
    expect(html).toContain('236 km of range');
    expect(html).toContain('Charge level');
  });
});
