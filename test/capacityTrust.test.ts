import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startDashboard } from '../src/dashboard';
import { labelsFor } from '../src/i18n';
import { capacityTrusted } from '../src/capacityTrust';

/**
 * Die Kapazitätsvorgabe ist ein Taycan-Datenblattwert (83,7 kWh) und fließt
 * in JEDE Energie- und Kostenrechnung. Bei einem Cayenne oder Panamera
 * E-Hybrid (rund 21,8 kWh netto) ist das Faktor 3,8:
 *
 *   Ladung 15 → 95 %: tatsächlich 17,4 kWh für 5,20 €
 *                     angezeigt   66,96 kWh für 20,09 €
 *   Monatsbeleg bei 20 Ladungen: rund 105 € gegen rund 400 €
 *
 * Nichts daran sieht kaputt aus. Genau deshalb ist es der schlimmste Fehler,
 * den dieses Plugin haben kann — und der Grund, warum die Zahl belegt sein
 * muss, bevor irgendetwas mit ihr gerechnet wird.
 */
describe('capacityTrusted — darf mit dieser Kapazität gerechnet werden?', () => {
  it('vertraut einer selbst eingetragenen Kapazität', () => {
    // Wer sie einträgt, hat sie nachgeschlagen. Das gilt für jedes Modell.
    expect(capacityTrusted({ fromUser: true })).toBe(true);
    expect(capacityTrusted({ fromUser: true, engine: 'PHEV', model: 'CAYENNE' })).toBe(true);
  });

  it('vertraut dem Vorgabewert bei einem bestätigten Taycan', () => {
    // Der Vorgabewert IST der Taycan-Wert — für dieses eine Modell stimmt er.
    expect(capacityTrusted({ fromUser: false, engine: 'BEV', model: 'TAYCAN' })).toBe(true);
  });

  it('vertraut ihm NICHT bei einem anderen Modell', () => {
    expect(capacityTrusted({ fromUser: false, engine: 'PHEV', model: 'CAYENNE' })).toBe(false);
    expect(capacityTrusted({ fromUser: false, engine: 'BEV', model: 'MACAN' })).toBe(false);
  });

  it('vertraut ihm NICHT bei unbekanntem Fahrzeug', () => {
    // Der häufigste Fall beim ersten Start und nach einem Netzfehler. Lieber
    // eine sichtbare Lücke als eine unsichtbar falsche Zahl.
    expect(capacityTrusted({ fromUser: false })).toBe(false);
    expect(capacityTrusted({ fromUser: false, model: 'TAYCAN' })).toBe(false);
    expect(capacityTrusted({ fromUser: false, engine: 'BEV' })).toBe(false);
  });

  it('nimmt Groß- und Kleinschreibung, wie die Schnittstelle sie liefert', () => {
    expect(capacityTrusted({ fromUser: false, engine: 'bev', model: 'taycan' })).toBe(true);
  });
});

describe('Die Warnung auf der Seite', () => {
  // Eine Zahl, die um Faktor 3,8 daneben liegt, ohne dass etwas kaputt
  // aussieht, ist der schlimmste Fehler dieses Plugins. Die Warnung muss
  // deshalb über allen Zahlen stehen und sagen, was zu tun ist — nicht nur,
  // dass etwas nicht stimmt.
  let dir: string;
  let port = 19945;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captrust-'));
    const t = new Date().toISOString();
    fs.writeFileSync(
      path.join(dir, `${t.slice(0, 10)}.jsonl`),
      JSON.stringify({ ts: t, soc: 60, rangeKm: 240, odometerKm: 50000, plugged: false }) + '\n',
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seite = async (trusted?: boolean): Promise<string> => {
    const server = startDashboard({
      port: port++,
      logDir: dir,
      capacityKwh: 83.7,
      pricePerKwh: 0.2,
      priceCt: 30,
      bonusCt: 0,
      externalPriceCt: 0,
      dayBoundaryHour: 0,
      vehicleName: 'Cayenne',
      uiPort: 8581,
      labels: labelsFor('en'),
      ...(trusted !== undefined ? { capacityTrusted: trusted } : {}),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const p = typeof a === 'object' && a ? a.port : 0;
    const html = await (await fetch(`http://127.0.0.1:${p}/`)).text();
    server.close();
    return html;
  };

  it('warnt, wenn die Kapazität nicht zum Fahrzeug gehört', async () => {
    const html = await seite(false);
    expect(html).toMatch(/not set for this vehicle/);
    expect(html).toContain('83.7 kWh');
    // Und sagt, was zu tun ist — eine Warnung ohne Ausweg ist eine Sackgasse.
    expect(html).toMatch(/Enter the correct value/);
  });

  it('schweigt, wenn sie passt', async () => {
    expect(await seite(true)).not.toMatch(/not set for this vehicle/);
  });

  it('schweigt ohne Angabe — bestehende Installationen bleiben unberührt', async () => {
    expect(await seite()).not.toMatch(/not set for this vehicle/);
  });
});
