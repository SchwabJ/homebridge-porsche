import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readSettings,
  writeSettings,
  sanitizeSettings,
  mergeSettings,
  rejectedSettings,
  tariffAt,
  archivePrice,
  localDay,
} from '../src/settings';

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

describe('tariffAt', () => {
  const current = { priceCt: 35, bonusCt: 5 };

  it('liefert ohne Historie den aktuellen Tarif', () => {
    expect(tariffAt(undefined, current, '2026-07-15T10:00:00.000Z')).toEqual(current);
    expect(tariffAt([], current, '2026-07-15T10:00:00.000Z')).toEqual(current);
  });

  it('wählt für alte Ladungen den damals gültigen Preis', () => {
    // Bis zum 1. August galten 30 ct — eine Juli-Ladung rechnet damit,
    // auch wenn heute 35 ct eingestellt sind.
    const history = [{ until: '2026-08-01', priceCt: 30, bonusCt: 0 }];
    expect(tariffAt(history, current, '2026-07-15T10:00:00.000Z')).toEqual({
      priceCt: 30,
      bonusCt: 0,
    });
  });

  it('liefert nach dem letzten Wechsel den aktuellen Tarif', () => {
    const history = [{ until: '2026-08-01', priceCt: 30, bonusCt: 0 }];
    expect(tariffAt(history, current, '2026-08-02T10:00:00.000Z')).toEqual(current);
  });

  it('wählt bei mehreren Perioden die richtige', () => {
    const history = [
      { until: '2025-01-01', priceCt: 25, bonusCt: 0 },
      { until: '2026-08-01', priceCt: 30, bonusCt: 5 },
    ];
    expect(tariffAt(history, current, '2024-06-01T10:00:00.000Z').priceCt).toBe(25);
    expect(tariffAt(history, current, '2025-06-01T10:00:00.000Z').priceCt).toBe(30);
    expect(tariffAt(history, current, '2026-09-01T10:00:00.000Z').priceCt).toBe(35);
  });

  it('vergleicht nach LOKALEM Datum, nicht nach UTC', () => {
    // Eine Ladung um 01:00 Ortszeit am 1. August ist in UTC noch der 31. Juli.
    // Sie gehört trotzdem zum neuen Tarif — dieselbe Regel wie beim Beleg.
    const history = [{ until: '2026-08-01', priceCt: 30, bonusCt: 0 }];
    const lokalErsterAugust = new Date(2026, 7, 1, 1, 0).toISOString();
    expect(tariffAt(history, current, lokalErsterAugust)).toEqual(current);
  });
});

describe('archivePrice', () => {
  const alt = { priceCt: 30, bonusCt: 0 };
  const neu = { priceCt: 35, bonusCt: 0 };

  it('archiviert den alten Tarif beim ersten Wechsel', () => {
    expect(archivePrice(undefined, alt, neu, '2026-08-01')).toEqual([
      { until: '2026-08-01', priceCt: 30, bonusCt: 0 },
    ]);
  });

  it('tut nichts, wenn sich der Tarif nicht ändert', () => {
    expect(archivePrice([], alt, { ...alt }, '2026-08-01')).toEqual([]);
  });

  it('hängt einen weiteren Wechsel chronologisch an', () => {
    const history = [{ until: '2025-01-01', priceCt: 25, bonusCt: 0 }];
    expect(archivePrice(history, alt, neu, '2026-08-01')).toEqual([
      { until: '2025-01-01', priceCt: 25, bonusCt: 0 },
      { until: '2026-08-01', priceCt: 30, bonusCt: 0 },
    ]);
  });

  it('räumt eine Rücknahme am selben Tag wieder auf', () => {
    // Tippfehler: 30 → 55 eingetragen, sofort zurück auf 30. Danach darf
    // keine Periode mit 55 ct in der Historie stehen — sonst rechneten alle
    // alten Ladungen mit dem Tippfehler.
    const nachTippfehler = archivePrice([], alt, { priceCt: 55, bonusCt: 0 }, '2026-07-30');
    expect(nachTippfehler).toEqual([{ until: '2026-07-30', priceCt: 30, bonusCt: 0 }]);
    const zurueck = archivePrice(nachTippfehler, { priceCt: 55, bonusCt: 0 }, alt, '2026-07-30');
    expect(zurueck).toEqual([]);
  });

  it('überschreibt spätere Einträge bei einer rückwirkenden Korrektur', () => {
    // Wer den Wechsel nachträglich auf ein früheres Datum legt, ersetzt die
    // Zukunft ab diesem Datum — zwei sich widersprechende Perioden darf es
    // nicht geben.
    const history = [{ until: '2026-09-01', priceCt: 30, bonusCt: 0 }];
    expect(archivePrice(history, alt, neu, '2026-08-01')).toEqual([
      { until: '2026-08-01', priceCt: 30, bonusCt: 0 },
    ]);
  });
});

describe('Tarifhistorie in den Einstellungen', () => {
  it('übersteht Schreiben und Lesen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-'));
    try {
      const history = [{ until: '2026-08-01', priceCt: 30, bonusCt: 0 }];
      writeSettings(dir, { priceCt: 35, priceHistory: history });
      expect(readSettings(dir)).toEqual({ priceCt: 35, priceHistory: history });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verwirft kaputte Einträge und sortiert den Rest', () => {
    const raw = {
      priceCt: 35,
      priceHistory: [
        { until: '2026-08-01', priceCt: 30, bonusCt: 0 },
        { until: 'quatsch', priceCt: 30, bonusCt: 0 },
        { until: '2025-01-01', priceCt: 25 },
        { until: '2026-13-01', priceCt: 30, bonusCt: 0 },
        { until: '2024-01-01', priceCt: 9999, bonusCt: 0 },
      ],
    };
    expect(sanitizeSettings(raw)).toEqual({
      priceCt: 35,
      priceHistory: [
        { until: '2025-01-01', priceCt: 25, bonusCt: 0 },
        { until: '2026-08-01', priceCt: 30, bonusCt: 0 },
      ],
    });
  });
});

describe('Standardansicht in den Einstellungen', () => {
  it('nimmt eine gültige Ansicht an', () => {
    expect(sanitizeSettings({ defaultView: 'day' })).toEqual({ defaultView: 'day' });
    expect(sanitizeSettings({ defaultView: 'year' })).toEqual({ defaultView: 'year' });
  });

  it('verwirft Unsinn, statt ihn an die Adresszeile weiterzureichen', () => {
    expect(sanitizeSettings({ defaultView: 'quatsch' })).toEqual({});
    expect(sanitizeSettings({ defaultView: 7 })).toEqual({});
  });

  it('übersteht Schreiben und Lesen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-'));
    try {
      writeSettings(dir, { defaultView: 'week' });
      expect(readSettings(dir)).toEqual({ defaultView: 'week' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('localDay', () => {
  it('liefert das lokale Datum eines Zeitpunkts', () => {
    const lokal = new Date(2026, 6, 31, 23, 30).toISOString();
    expect(localDay(lokal)).toBe('2026-07-31');
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
    expect(rejectedSettings({ priceCt: 28.45, bonusCt: 12 })).toEqual([]);
  });

  it('ignoriert unbekannte Felder', () => {
    // Die kommen nicht vom eigenen Formular, sondern von einem fremden Aufruf.
    expect(rejectedSettings({ gibtsNicht: 5 })).toEqual([]);
  });
});
