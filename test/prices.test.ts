import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPrices, writePrice, costFrom, sanitize } from '../src/prices';

describe('Preisablage', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preise-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('liefert eine leere Ablage, solange nichts eingetragen wurde', () => {
    expect(readPrices(dir)).toEqual({});
  });

  it('übersteht eine beschädigte Datei, statt das Dashboard mitzureißen', () => {
    fs.writeFileSync(path.join(dir, 'charge-prices.json'), '{ kaputt');
    expect(readPrices(dir)).toEqual({});
  });

  it('schreibt und liest einen Preis', () => {
    expect(writePrice(dir, '2026-07-28T10:00:00.000Z', { eur: 24.8 })).toBe(true);
    expect(readPrices(dir)['2026-07-28T10:00:00.000Z']).toEqual({ eur: 24.8 });
  });

  it('entfernt einen Eintrag bei leerer Angabe', () => {
    writePrice(dir, 'k', { eur: 10 });
    writePrice(dir, 'k', undefined);
    expect(readPrices(dir).k).toBeUndefined();
  });

  it('lässt andere Einträge beim Schreiben unangetastet', () => {
    writePrice(dir, 'a', { eur: 10 });
    writePrice(dir, 'b', { ct: 59 });
    expect(Object.keys(readPrices(dir)).sort()).toEqual(['a', 'b']);
  });

  it('hinterlässt keine temporäre Datei', () => {
    writePrice(dir, 'a', { eur: 10 });
    expect(fs.readdirSync(dir)).toEqual(['charge-prices.json']);
  });
});

describe('costFrom', () => {
  it('nimmt den Betrag, wenn er vorliegt', () => {
    expect(costFrom({ eur: 24.8 }, 40)).toBe(24.8);
  });

  it('rechnet aus ct/kWh und Energie', () => {
    expect(costFrom({ ct: 59 }, 40)).toBeCloseTo(23.6, 2);
  });

  it('bevorzugt den Betrag gegenüber dem Arbeitspreis', () => {
    // Der Betrag ist gemessen, der ct-Preis multipliziert unsere eigene
    // Energieschätzung mit — samt deren Unsicherheit.
    expect(costFrom({ eur: 30, ct: 59 }, 40)).toBe(30);
  });

  it('liefert nichts ohne Preis', () => {
    expect(costFrom(undefined, 40)).toBeUndefined();
  });

  it('liefert nichts, wenn zum ct-Preis die Energie fehlt', () => {
    expect(costFrom({ ct: 59 }, undefined)).toBeUndefined();
  });
});

describe('sanitize', () => {
  it('nimmt Zahlen und Zeichenketten', () => {
    expect(sanitize({ eur: 24.8 })).toEqual({ eur: 24.8 });
    expect(sanitize({ eur: '24.80' })).toEqual({ eur: 24.8 });
  });

  it('versteht das deutsche Komma', () => {
    expect(sanitize({ eur: '24,80' })).toEqual({ eur: 24.8 });
  });

  it('weist Unsinn und verrutschte Kommas ab', () => {
    expect(sanitize({ eur: -5 })).toBeUndefined();
    expect(sanitize({ eur: 9000 })).toBeUndefined();
    expect(sanitize({ ct: 5900 })).toBeUndefined();
    expect(sanitize({ eur: 'abc' })).toBeUndefined();
    expect(sanitize(null)).toBeUndefined();
    expect(sanitize('30')).toBeUndefined();
  });

  it('kürzt eine Notiz und wirft leere weg', () => {
    expect(sanitize({ eur: 10, note: '  Ionity  ' })?.note).toBe('Ionity');
    expect(sanitize({ eur: 10, note: '   ' })?.note).toBeUndefined();
    expect(sanitize({ eur: 10, note: 'x'.repeat(80) })?.note).toHaveLength(40);
  });

  it('nimmt keine Notiz ohne Preis an', () => {
    expect(sanitize({ note: 'Ionity' })).toBeUndefined();
  });
});
