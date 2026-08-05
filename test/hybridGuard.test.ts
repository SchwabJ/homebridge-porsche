import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startDashboard } from '../src/dashboard';
import { labelsFor } from '../src/i18n';

/**
 * Bei einem Plug-in-Hybrid fährt das Auto zwischen zwei Ladungen auch mit
 * Kraftstoff. Die Kapazitätsschätzung rechnet aber „Strecke mal Verbrauch =
 * Energie je Prozentpunkt" — und liefert dann nicht einen ungenauen Wert,
 * sondern einen falschen, der plausibel aussieht.
 *
 * Alles, was darauf aufsetzt, wäre still falsch: kWh je Ladung, Kosten,
 * Ersparnis, Verbrauchstrend und der Batterie-Nachweis, den jemand beim
 * Verkauf vorlegt. Deshalb schweigt es lieber.
 */
describe('Auswertungen bei nicht rein elektrischem Antrieb', () => {
  let dir: string;
  let port = 19965;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyb-'));
    // Eine Fahrstrecke zwischen zwei Ladungen — genug für eine Schätzung.
    const t = (h: number): string => new Date(Date.UTC(2026, 6, 20, h)).toISOString();
    fs.writeFileSync(
      path.join(dir, '2026-07-20.jsonl'),
      [
        // Eine Ladung MIT Leistungsangabe: Die Kapazität wird ladeseitig
        // gemessen. Dafür braucht es powerKw, einen Hub von mindestens zehn
        // Punkten UND einen feinen Takt — über Lücken von mehr als einer
        // Viertelstunde wird bewusst keine Energie gebucht.
        ...Array.from({ length: 13 }, (_, i) => ({
          ts: new Date(Date.UTC(2026, 6, 20, 0, i * 10)).toISOString(),
          soc: 60 + Math.round(i * (20 / 12)),
          odometerKm: 50000,
          plugged: true,
          charging: true,
          // 8 kW über zwei Stunden sind 16 kWh auf 20 Punkte = 80 kWh.
          powerKw: 8 + (i % 2) * 0.1,
          rangeKm: 200 + i * 7,
        })),
        { ts: t(3), soc: 80, odometerKm: 50000, plugged: false, tripKwh100: 20 },
        { ts: t(10), soc: 40, odometerKm: 50170, plugged: false, tripKwh100: 20 },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seite = async (pfad: string, pureElectric?: boolean): Promise<string> => {
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
      ...(pureElectric !== undefined ? { pureElectric } : {}),
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const p = typeof a === 'object' && a ? a.port : 0;
    const html = await (await fetch(`http://127.0.0.1:${p}${pfad}`)).text();
    server.close();
    return html;
  };

  it('zeigt die gemessene Kapazität bei einem Elektrofahrzeug', async () => {
    expect(await seite('/status', true)).toContain('Measured capacity');
  });

  it('zeigt sie NICHT, wenn der Antrieb nicht rein elektrisch ist', async () => {
    expect(await seite('/status', false)).not.toContain('Measured capacity');
  });

  it('zeigt sie NICHT bei unbekanntem Antrieb, statt zu raten', async () => {
    // Der wichtigste Fall: Ein älteres Konto liefert womöglich keine
    // Antriebsangabe. Dann ist Schweigen richtig — eine falsche Kapazität
    // fällt niemandem auf, weil sie plausibel aussieht.
    expect(await seite('/status')).not.toContain('Measured capacity');
  });

  it('erklärt auf dem Batterie-Nachweis, warum dort nichts steht', async () => {
    // Eine leere Seite ohne Grund wirkt wie ein Fehler. Der Nachweis muss
    // sagen, dass er für dieses Fahrzeug nichts aussagen KANN.
    const html = await seite('/batterie', false);
    expect(html).toMatch(/fuel|drivetrain|electricity alone/i);
  });
});

describe('Antriebsart, die erst nach dem Start feststeht', () => {
  // Das Dashboard startet, bevor die Fahrzeugliste abgerufen ist. Ein zum
  // Startzeitpunkt eingefrorener Wert wäre deshalb immer „unbekannt" — und
  // die gemessene Kapazität dauerhaft verborgen, auch bei einem Taycan.
  //
  // Genau das ist beim ersten Anlauf passiert: Alle Tests waren grün, und am
  // laufenden Fahrzeug fehlte die Kachel trotz erkanntem BEV.
  let dir: string;
  let port = 19980;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaet-'));
    const t = (h: number): string => new Date(Date.UTC(2026, 6, 20, h)).toISOString();
    fs.writeFileSync(
      path.join(dir, '2026-07-20.jsonl'),
      [
        // Eine Ladung MIT Leistungsangabe: Die Kapazität wird ladeseitig
        // gemessen. Dafür braucht es powerKw, einen Hub von mindestens zehn
        // Punkten UND einen feinen Takt — über Lücken von mehr als einer
        // Viertelstunde wird bewusst keine Energie gebucht.
        ...Array.from({ length: 13 }, (_, i) => ({
          ts: new Date(Date.UTC(2026, 6, 20, 0, i * 10)).toISOString(),
          soc: 60 + Math.round(i * (20 / 12)),
          odometerKm: 50000,
          plugged: true,
          charging: true,
          // 8 kW über zwei Stunden sind 16 kWh auf 20 Punkte = 80 kWh.
          powerKw: 8 + (i % 2) * 0.1,
          rangeKm: 200 + i * 7,
        })),
        { ts: t(3), soc: 80, odometerKm: 50000, plugged: false, tripKwh100: 20 },
        { ts: t(10), soc: 40, odometerKm: 50170, plugged: false, tripKwh100: 20 },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('wertet die Angabe bei JEDEM Seitenaufruf aus, nicht einmal beim Start', async () => {
    // Zum Startzeitpunkt unbekannt, danach als elektrisch erkannt.
    let elektrisch = false;
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
      pureElectric: () => elektrisch,
    });
    if (!server) {
      throw new Error('kein Server');
    }
    await new Promise((r) => server.once('listening', r));
    const a = server.address();
    const p = typeof a === 'object' && a ? a.port : 0;
    const vorher = await (await fetch(`http://127.0.0.1:${p}/status`)).text();
    expect(vorher).not.toContain('Measured capacity');

    elektrisch = true;
    const nachher = await (await fetch(`http://127.0.0.1:${p}/status`)).text();
    expect(nachher).toContain('Measured capacity');
    server.close();
  });
});
