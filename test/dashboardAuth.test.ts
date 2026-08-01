import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startDashboard } from '../src/dashboard';
import { labelsFor } from '../src/i18n';

/**
 * Das Dashboard lauscht auf allen Schnittstellen und lieferte bisher jedem
 * ohne Rückfrage Ladehistorie, Kilometerstand und „zuhause ja/nein". Für ein
 * öffentlich verteiltes Plugin ist das kein Härtungsthema, sondern eine
 * Lücke: Ein Gast im WLAN, ein IoT-Gerät, ein kompromittierter Fernseher —
 * alle lesen mit, ohne etwas anzustellen.
 */
describe('Dashboard mit Passwort', () => {
  let dir: string;
  let port = 19710;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const serve = (password?: string): { url: string; stop: () => void } | undefined => {
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
    });
    if (!server) {
      return undefined;
    }
    const warten = new Promise((r) => server.once('listening', r));
    return {
      url: '',
      stop: () => server.close(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ server, warten } as any),
    };
  };

  const hole = async (
    password: string | undefined,
    header: Record<string, string> = {},
    pfad = '/',
  ): Promise<{ status: number; auth: string | null }> => {
    const s = serve(password) as unknown as {
      server: import('http').Server;
      warten: Promise<unknown>;
      stop: () => void;
    };
    await s.warten;
    const a = s.server.address();
    const p = typeof a === 'object' && a ? a.port : 0;
    const res = await fetch(`http://127.0.0.1:${p}${pfad}`, { headers: header });
    s.stop();
    return { status: res.status, auth: res.headers.get('www-authenticate') };
  };

  const basic = (user: string, pass: string): Record<string, string> => ({
    authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
  });

  it('lässt ohne gesetztes Passwort alles durch — bestehende Installationen brechen nicht', async () => {
    expect((await hole(undefined)).status).toBe(200);
  });

  it('verlangt mit Passwort eine Anmeldung', async () => {
    const r = await hole('geheim');
    expect(r.status).toBe(401);
    // Ohne diesen Header fragt der Browser nicht nach, sondern zeigt nur den Fehler.
    expect(r.auth).toMatch(/Basic/);
  });

  it('lässt das richtige Passwort durch', async () => {
    expect((await hole('geheim', basic('taycan', 'geheim'))).status).toBe(200);
  });

  it('weist ein falsches Passwort ab', async () => {
    expect((await hole('geheim', basic('taycan', 'falsch'))).status).toBe(401);
  });

  it('nimmt jeden Benutzernamen — geprüft wird das Passwort', async () => {
    // Ein zweites Geheimnis, das niemand vergisst, wäre nur eine Hürde mehr
    // beim Einrichten und keine zusätzliche Sicherheit.
    expect((await hole('geheim', basic('egal', 'geheim'))).status).toBe(200);
  });

  it('schützt auch die schreibenden Routen', async () => {
    // Sie sind die gefährlicheren: /api/refresh löst eine Fahrzeugabfrage aus,
    // /api/settings ändert die Konfiguration.
    expect((await hole('geheim', {}, '/settings')).status).toBe(401);
    expect((await hole('geheim', {}, '/beleg')).status).toBe(401);
  });

  it('verkraftet einen kaputten Authorization-Header, statt abzustürzen', async () => {
    expect((await hole('geheim', { authorization: 'Basic !!!nicht-base64' })).status).toBe(401);
    expect((await hole('geheim', { authorization: 'Bearer abc' })).status).toBe(401);
    expect((await hole('geheim', { authorization: '' })).status).toBe(401);
  });

  it('lässt das Manifest ungeschützt, damit der Homescreen-Eintrag funktioniert', async () => {
    // Das Manifest enthält keine Fahrzeugdaten, wird aber vom Browser ohne
    // Anmeldedaten geladen — mit 401 bliebe die Seite ohne Symbol und Namen.
    expect((await hole('geheim', {}, '/manifest.json')).status).toBe(200);
  });
});
