import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startDashboard } from '../src/dashboard';
import { labelsFor } from '../src/i18n';

/**
 * Die JSONL-Dateien sind das eigentliche Kapital dieses Plugins: Sie sind die
 * einzige Quelle für Kapazität, Verbrauch, Ladehistorie und jeden Nachweis,
 * und sie lassen sich nicht nachträglich beschaffen. Es gab aber keinen
 * Download, kein Backup und keinen Umzugsweg auf einen neuen Pi — wer den
 * Rechner wechselte, fing bei null an.
 */
describe('Sicherung des Mitschriebs', () => {
  let dir: string;
  let port = 19910;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'));
    fs.writeFileSync(
      path.join(dir, '2026-07-27.jsonl'),
      JSON.stringify({ ts: '2026-07-27T10:00:00.000Z', soc: 60 }) + '\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, '2026-07-28.jsonl'),
      JSON.stringify({ ts: '2026-07-28T10:00:00.000Z', soc: 55 }) + '\n',
      'utf8',
    );
    // Fremde Datei — sie hat im Backup nichts verloren.
    fs.writeFileSync(path.join(dir, 'notizen.txt'), 'privat', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hole = async (
    pfad: string,
  ): Promise<{ status: number; typ: string; body: string; anhang: string }> => {
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
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const p = typeof a === 'object' && a ? a.port : 0;
    const res = await fetch(`http://127.0.0.1:${p}${pfad}`);
    const body = await res.text();
    server.close();
    return {
      status: res.status,
      typ: res.headers.get('content-type') ?? '',
      anhang: res.headers.get('content-disposition') ?? '',
      body,
    };
  };

  it('liefert den ganzen Mitschrieb als eine Datei', async () => {
    const r = await hole('/mitschrieb.jsonl');
    expect(r.status).toBe(200);
    expect(r.body).toContain('2026-07-27T10:00:00.000Z');
    expect(r.body).toContain('2026-07-28T10:00:00.000Z');
  });

  it('nimmt nur Tagesdateien mit, nichts anderes aus dem Verzeichnis', async () => {
    // Dasselbe Muster, das den Leser schützt: Eine fremde Datei im
    // Log-Verzeichnis hat das Dashboard schon einmal komplett lahmgelegt.
    expect((await hole('/mitschrieb.jsonl')).body).not.toContain('privat');
  });

  it('bietet die Datei zum Herunterladen an, statt sie anzuzeigen', async () => {
    // Ein Backup, das der Browser als Textwand rendert, lädt niemand herunter.
    // Den Download macht der Content-Disposition-Header, nicht der Medientyp —
    // mein erster Test prüfte den falschen und wäre auch bei einer im Browser
    // angezeigten Seite grün geblieben.
    const r = await hole('/mitschrieb.jsonl');
    expect(r.anhang).toMatch(/attachment/);
    expect(r.anhang).toMatch(/\.jsonl/);
  });

  it('bleibt in zeitlicher Reihenfolge', async () => {
    // Die Auswertung sortiert selbst, aber eine Sicherung, die man von Hand
    // ansieht, soll lesbar sein.
    const body = (await hole('/mitschrieb.jsonl')).body;
    expect(body.indexOf('07-27')).toBeLessThan(body.indexOf('07-28'));
  });
});

describe('Fremde Dateien im Log-Verzeichnis', () => {
  // Eine einzige fremde Datei hat das Dashboard schon einmal komplett
  // lahmgelegt: Eine Zeile ohne `ts` genügte, um alle Routen dauerhaft auf
  // HTTP 500 zu setzen — ohne eine Seite, von der aus man das hätte
  // diagnostizieren können.
  //
  // Der Download unter /mitschrieb.jsonl erzeugt genau so eine Datei. Damit
  // ist die Namensregel keine Vorsichtsmaßnahme mehr, sondern notwendig: Wer
  // seine Sicherung zurück ins Verzeichnis legt, ohne sie nach Tagen zu
  // teilen, darf das Plugin nicht zerlegen.
  let dir: string;
  let port = 19930;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fremd-'));
    fs.writeFileSync(
      path.join(dir, '2026-07-27.jsonl'),
      JSON.stringify({ ts: '2026-07-27T10:00:00.000Z', soc: 60, odometerKm: 50000 }) + '\n',
      'utf8',
    );
    // Genau das, was der eigene Download erzeugt.
    fs.writeFileSync(
      path.join(dir, 'taycan-mitschrieb-2026-08-01.jsonl'),
      JSON.stringify({ soc: 50 }) + '\n',
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bleibt bedienbar, wenn eine zurückgespielte Sicherung danebenliegt', async () => {
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
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const p = typeof a === 'object' && a ? a.port : 0;
    for (const route of ['/', '/status', '/beleg', '/batterie']) {
      const res = await fetch(`http://127.0.0.1:${p}${route}`);
      expect([route, res.status]).toEqual([route, 200]);
    }
    server.close();
  });
});
