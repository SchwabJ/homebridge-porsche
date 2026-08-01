import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startDashboard } from '../src/dashboard';
import { labelsFor } from '../src/i18n';

/**
 * Vom Dashboard aus liess sich dem Auto bisher nichts sagen: Die Befehle sind
 * seit Langem gebaut, aber nur über HomeKit erreichbar. Wer die Seite auf dem
 * Homescreen hat, sieht alles und kann nichts.
 *
 * Der Unterschied zum Mitlesen ist qualitativ, deshalb hängt diese Route an
 * einer zusätzlichen Bedingung: OHNE gesetztes Passwort gibt es sie nicht.
 * Ladehistorie mitzulesen ist unangenehm; ein fremdes Auto aufzuschließen
 * oder nachts die Klimaanlage zu starten ist etwas anderes.
 */
describe('Befehle vom Dashboard', () => {
  let dir: string;
  let port = 19810;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const serve = (
    password: string | undefined,
    onCommand?: (c: string) => Promise<void>,
  ): { url: string; stop: () => void; warten: Promise<unknown>; server: import('http').Server } => {
    const server = startDashboard({
      port: port++,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'Taycan',
      uiPort: 8581,
      labels: labelsFor('en'),
      ...(password !== undefined ? { password } : {}),
      ...(onCommand !== undefined ? { onCommand } : {}),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    return {
      url: '',
      stop: () => server.close(),
      warten: new Promise((r) => server.once('listening', r)),
      server,
    };
  };

  const post = async (
    password: string | undefined,
    body: unknown,
    onCommand?: (c: string) => Promise<void>,
  ): Promise<{ status: number; json: { ok?: boolean; reason?: string } }> => {
    const s = serve(password, onCommand);
    await s.warten;
    const a = s.server.address();
    const p = typeof a === 'object' && a ? a.port : 0;
    const kopf: Record<string, string> = { 'content-type': 'application/json' };
    if (password) {
      kopf.authorization = 'Basic ' + Buffer.from(`x:${password}`).toString('base64');
    }
    const res = await fetch(`http://127.0.0.1:${p}/api/command`, {
      method: 'POST',
      headers: kopf,
      body: JSON.stringify(body),
    });
    const j = (await res.json()) as { ok?: boolean; reason?: string };
    s.stop();
    return { status: res.status, json: j };
  };

  it('führt einen bekannten Befehl aus', async () => {
    let gerufen = '';
    const r = await post('geheim', { command: 'climate-start' }, async (c) => {
      gerufen = c;
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(gerufen).toBe('climate-start');
  });

  it('VERWEIGERT ohne gesetztes Passwort, auch wenn ein Handler da ist', async () => {
    // Der Kern dieser Route: Wer das Auto aus dem Browser steuern will, muss
    // die Seite vorher zugesperrt haben. Sonst fährt jeder im WLAN mit.
    let gerufen = false;
    const r = await post(undefined, { command: 'climate-start' }, async () => {
      gerufen = true;
    });
    expect(r.status).toBe(403);
    expect(r.json.reason).toBe('no-password');
    expect(gerufen).toBe(false);
  });

  it('nimmt nur Befehle von der festen Liste', async () => {
    // Kein Durchreichen beliebiger Zeichenketten an das Fahrzeug: Was hier
    // nicht steht, existiert für das Dashboard nicht.
    let gerufen = false;
    const r = await post('geheim', { command: 'unlock' }, async () => {
      gerufen = true;
    });
    expect(r.status).toBe(400);
    expect(r.json.reason).toBe('unknown-command');
    expect(gerufen).toBe(false);
  });

  it('weist einen fehlenden oder unpassenden Befehl ab', async () => {
    expect((await post('geheim', {}, async () => {})).status).toBe(400);
    expect((await post('geheim', { command: 42 }, async () => {})).status).toBe(400);
  });

  it('antwortet sauber, wenn das Plugin keine Befehle annimmt', async () => {
    const r = await post('geheim', { command: 'climate-start' });
    expect(r.status).toBe(503);
    expect(r.json.reason).toBe('unavailable');
  });

  it('meldet einen gescheiterten Befehl, statt Erfolg zu behaupten', async () => {
    const r = await post('geheim', { command: 'charge-start' }, async () => {
      throw new Error('Fahrzeug antwortet nicht');
    });
    expect(r.status).toBe(502);
    expect(r.json.ok).toBe(false);
  });
});

describe('Knöpfe auf der Seite', () => {
  let dir: string;
  let port = 19860;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btn-'));
    // Ein Messpunkt, damit die Statuszeile überhaupt etwas zeigt.
    const t = new Date().toISOString();
    fs.writeFileSync(
      path.join(dir, `${t.slice(0, 10)}.jsonl`),
      JSON.stringify({ ts: t, soc: 60, rangeKm: 240, odometerKm: 50000, plugged: false, charging: false, locked: true, climateOn: false }) + '\n',
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seite = async (opts: { password?: string; mitHandler: boolean }): Promise<string> => {
    const server = startDashboard({
      port: port++,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'Taycan',
      uiPort: 8581,
      labels: labelsFor('en'),
      ...(opts.password !== undefined ? { password: opts.password } : {}),
      ...(opts.mitHandler ? { onCommand: async () => {} } : {}),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const p = typeof a === 'object' && a ? a.port : 0;
    const kopf: Record<string, string> = {};
    if (opts.password) {
      kopf.authorization = 'Basic ' + Buffer.from(`x:${opts.password}`).toString('base64');
    }
    const html = await (await fetch(`http://127.0.0.1:${p}/`, { headers: kopf })).text();
    server.close();
    return html;
  };

  it('zeigt die Knöpfe nur mit Handler UND Passwort', async () => {
    expect(await seite({ password: 'geheim', mitHandler: true })).toContain('data-cmd=');
    // Ohne Passwort gäbe die Route sie ohnehin nicht frei — sie trotzdem zu
    // zeigen hieße, eine Enttäuschung anzubieten.
    expect(await seite({ mitHandler: true })).not.toContain('data-cmd=');
    expect(await seite({ password: 'geheim', mitHandler: false })).not.toContain('data-cmd=');
  });

  it('bietet nur den passenden Gegenknopf an', async () => {
    // Das Auto steht verriegelt, ohne Kabel, ohne Klima: also
    // Vorklimatisieren, kein Laden (kein Kabel), kein Verriegeln (schon zu).
    const html = await seite({ password: 'geheim', mitHandler: true });
    expect(html).toContain('data-cmd="climate-start"');
    expect(html).not.toContain('data-cmd="charge-start"');
    expect(html).not.toContain('data-cmd="lock"');
  });

  it('fragt vor dem Stoppen einer Ladung nach', async () => {
    // Nachts versehentlich gedrückt heißt morgens ein Auto, das nicht weit
    // kommt. Die anderen Knöpfe kosten im Zweifel etwas Strom und sonst nichts.
    const t = new Date().toISOString();
    fs.writeFileSync(
      path.join(dir, `${t.slice(0, 10)}.jsonl`),
      JSON.stringify({ ts: t, soc: 60, rangeKm: 240, odometerKm: 50000, plugged: true, charging: true, locked: true, climateOn: false }) + '\n',
      'utf8',
    );
    const html = await seite({ password: 'geheim', mitHandler: true });
    expect(html).toMatch(/data-cmd="charge-stop"[^>]*data-ask=/);
  });

  it('erzeugt gültiges JavaScript', async () => {
    // Ein `\n` im Quelltext dieser Vorlage wird zu einem echten Umbruch
    // mitten in einem JS-String und legt die ganze Seite lahm — genau so ist
    // das hier schon einmal passiert.
    const html = await seite({ password: 'geheim', mitHandler: true });
    const skripte = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(skripte.length).toBeGreaterThan(0);
    for (const code of skripte) {
      expect(() => new Function(code)).not.toThrow();
    }
  });
});
