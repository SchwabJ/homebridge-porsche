/**
 * Tests für die Lokalisierung (src/i18n.ts) + die neuen Config-Felder
 * `language` / `vehicleModel` (src/accessories/kit.ts).
 */

import { LABELS_EN, LABELS_DE, labelsFor, Labels } from '../src/i18n';
import { resolveConfig, DEFAULT_CONFIG } from '../src/accessories/kit';

describe('i18n: labelsFor', () => {
  it('liefert Englisch für "en" (Default-Sprache)', () => {
    expect(labelsFor('en')).toBe(LABELS_EN);
    expect(labelsFor('en').chargeLevel).toBe('Charge level');
    expect(labelsFor('en').chargeLimit).toBe('Charge limit');
    expect(labelsFor('en').lock).toBe('Lock');
  });

  it('liefert Deutsch für "de"', () => {
    expect(labelsFor('de')).toBe(LABELS_DE);
    expect(labelsFor('de').chargeLevel).toBe('Ladestand');
    expect(labelsFor('de').chargeLimit).toBe('Ladelimit');
    expect(labelsFor('de').lock).toBe('Schloss');
  });
});

describe('i18n: Label-Sätze sind vollständig & deckungsgleich', () => {
  it('EN und DE haben exakt dieselben Schlüssel', () => {
    expect(Object.keys(LABELS_EN).sort()).toEqual(Object.keys(LABELS_DE).sort());
  });

  it('kein Label ist leer (EN und DE)', () => {
    for (const key of Object.keys(LABELS_EN) as Array<keyof Labels>) {
      expect(LABELS_EN[key].length).toBeGreaterThan(0);
      expect(LABELS_DE[key].length).toBeGreaterThan(0);
    }
  });

  it('EN-Labels enthalten keine deutschen Umlaute/ß', () => {
    for (const key of Object.keys(LABELS_EN) as Array<keyof Labels>) {
      expect(LABELS_EN[key]).not.toMatch(/[äöüÄÖÜß]/);
    }
  });
});

describe('config: language', () => {
  it('Default ist "en"', () => {
    expect(DEFAULT_CONFIG.language).toBe('en');
    expect(resolveConfig({}).language).toBe('en');
    expect(resolveConfig(undefined).language).toBe('en');
  });

  it('akzeptiert "de"', () => {
    expect(resolveConfig({ language: 'de' }).language).toBe('de');
  });

  it('fällt bei ungültigem Wert auf "en" zurück', () => {
    expect(resolveConfig({ language: 'fr' }).language).toBe('en');
    expect(resolveConfig({ language: 123 }).language).toBe('en');
  });
});

describe('config: vehicleModel', () => {
  it('Default ist "Porsche" (nicht mehr hart "Taycan")', () => {
    expect(DEFAULT_CONFIG.vehicleModel).toBe('Porsche');
    expect(resolveConfig({}).vehicleModel).toBe('Porsche');
  });

  it('übernimmt einen eigenen Wert', () => {
    expect(resolveConfig({ vehicleModel: 'Macan' }).vehicleModel).toBe('Macan');
    expect(resolveConfig({ vehicleModel: 'Taycan' }).vehicleModel).toBe('Taycan');
  });

  it('leerer String fällt auf Default zurück', () => {
    expect(resolveConfig({ vehicleModel: '' }).vehicleModel).toBe('Porsche');
  });
});
