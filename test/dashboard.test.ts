import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSamples, summarize, startDashboard, optionsFor } from '../src/dashboard';
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

  it('weist aus, dass ein Wert aus den Plugin-Einstellungen stammt', async () => {
    const { url, stop } = await serve();
    const html = await (await fetch(`${url}/settings`)).text();
    expect(html).toContain('From the plugin settings');
    stop();
  });

  it('übernimmt einen Wert und wendet ihn sofort an', async () => {
    // Ohne Neustart — genau dafür gibt es die Seite.
    const { url, stop } = await serve();
    expect((await save(url, { priceCt: '28,45' })).status).toBe(200);
    const html = await (await fetch(`${url}/settings`)).text();
    expect(html).toContain('Set here: 28.45');
    stop();
  });

  it('macht die Übernahme in der Auswertung wirksam', async () => {
    const { url, stop } = await serve();
    await save(url, { capacityKwh: 70 });
    const html = await (await fetch(`${url}/settings`)).text();
    expect(html).toContain('Set here: 70');
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
    expect(html).toContain('From the plugin settings');
    expect(html).not.toContain('99999');
    stop();
  });

  it('nimmt einen Wert per leerem Feld wieder zurück', async () => {
    const { url, stop } = await serve();
    await save(url, { priceCt: 40 });
    await save(url, { priceCt: '' });
    const html = await (await fetch(`${url}/settings`)).text();
    expect(html).toContain('From the plugin settings: 30');
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
    const t = (m: number): string =>
      new Date(Date.UTC(2026, 6, 28, 0, 0, 0) + m * 60000).toISOString();
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
