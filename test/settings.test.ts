import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSettings, writeSettings, sanitizeSettings, mergeSettings , rejectedSettings} from '../src/settings';

describe('Einstellungs-Ablage', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('liefert leer, solange nichts gesetzt wurde', () => {
    expect(readSettings(dir)).toEqual({});
  });

  it('übersteht eine beschädigte Datei', () => {
    fs.writeFileSync(path.join(dir, 'dashboard-settings.json'), 'kein json');
    expect(readSettings(dir)).toEqual({});
  });

  it('schreibt und liest zurück', () => {
    expect(writeSettings(dir, { priceCt: 31.5, bonusCt: 12 })).toBe(true);
    expect(readSettings(dir)).toEqual({ priceCt: 31.5, bonusCt: 12 });
  });

  it('hinterlässt keine temporäre Datei', () => {
    writeSettings(dir, { priceCt: 30 });
    expect(fs.readdirSync(dir)).toEqual(['dashboard-settings.json']);
  });
});

describe('sanitizeSettings', () => {
  it('nimmt Zahlen und Zeichenketten mit Komma', () => {
    expect(sanitizeSettings({ priceCt: '28,45' })).toEqual({ priceCt: 28.45 });
  });

  it('lässt ein leeres Feld weg, statt es auf 0 zu setzen', () => {
    // Leer heißt „nicht gesetzt" und fällt auf die Plugin-Einstellung zurück.
    expect(sanitizeSettings({ priceCt: '', bonusCt: 12 })).toEqual({ bonusCt: 12 });
  });

  it('nimmt eine ausdrückliche 0 an — sie schaltet die Kosten ab', () => {
    expect(sanitizeSettings({ priceCt: 0 })).toEqual({ priceCt: 0 });
  });

  it('verwirft Werte außerhalb der Grenzen', () => {
    expect(sanitizeSettings({ priceCt: -1 })).toEqual({});
    expect(sanitizeSettings({ priceCt: 5000 })).toEqual({});
    expect(sanitizeSettings({ capacityKwh: 2 })).toEqual({});
    expect(sanitizeSettings({ dayBoundaryHour: 23 })).toEqual({});
  });

  it('ignoriert unbekannte Felder', () => {
    expect(sanitizeSettings({ priceCt: 30, hack: 1, dashboardPort: 99 })).toEqual({ priceCt: 30 });
  });

  it('rundet auf die sinnvolle Stellenzahl', () => {
    expect(sanitizeSettings({ priceCt: 28.4589 })).toEqual({ priceCt: 28.46 });
    expect(sanitizeSettings({ dayBoundaryHour: 4.7 })).toEqual({ dayBoundaryHour: 5 });
  });
});

describe('mergeSettings', () => {
  const plugin = { priceCt: 30, bonusCt: 0, capacityKwh: 83.7 };

  it('lässt die Plugin-Werte stehen, wenn nichts gesetzt ist', () => {
    const { values, source } = mergeSettings(plugin, {});
    expect(values).toEqual(plugin);
    expect(source.priceCt).toBe('plugin');
  });

  it('überschreibt mit den Dashboard-Werten', () => {
    const { values, source } = mergeSettings(plugin, { priceCt: 28.45 });
    expect(values.priceCt).toBe(28.45);
    expect(values.capacityKwh).toBe(83.7);
    expect(source.priceCt).toBe('dashboard');
    expect(source.capacityKwh).toBe('plugin');
  });

  it('überschreibt auch mit einer 0', () => {
    // Sonst ließe sich die Kostenrechnung im Dashboard nicht abschalten.
    const { values, source } = mergeSettings({ priceCt: 30 }, { priceCt: 0 });
    expect(values.priceCt).toBe(0);
    expect(source.priceCt).toBe('dashboard');
  });

  it('verändert das Eingabeobjekt nicht', () => {
    mergeSettings(plugin, { priceCt: 99 });
    expect(plugin.priceCt).toBe(30);
  });
});

describe('rejectedSettings', () => {
  it('nennt die Schlüssel, deren Werte verworfen wurden', () => {
    // „gesichert" zu melden, während ein Wert stillschweigend fiel, ist die
    // schlechteste aller Rückmeldungen: Der Nutzer glaubt, es habe geklappt.
    expect(rejectedSettings({ priceCt: 99999, bonusCt: 12 })).toEqual(['priceCt']);
  });

  it('zählt ein leeres Feld NICHT als verworfen', () => {
    // Ein leeres Feld ist die gültige Art, einen Wert zurückzunehmen.
    expect(rejectedSettings({ priceCt: '' })).toEqual([]);
    expect(rejectedSettings({ priceCt: null })).toEqual([]);
  });

  it('meldet nichts, wenn alles übernommen wurde', () => {
    expect(rejectedSettings({ priceCt: 30, bonusCt: 10 })).toEqual([]);
  });

  it('ignoriert unbekannte Felder', () => {
    // Die kommen nicht vom eigenen Formular, sondern von einem fremden Aufruf.
    expect(rejectedSettings({ gibtsNicht: 5 })).toEqual([]);
  });
});
