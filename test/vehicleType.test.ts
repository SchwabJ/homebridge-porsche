import { parseVehicleEntry, isPluginHybrid, type VehicleListEntry } from '../src/api/porscheClient';

/**
 * Das Fahrzeug sagt in der Fahrzeugliste selbst, welchen Antrieb es hat —
 * am 01.08.2026 an einem Taycan gemessen:
 *
 *   modelType = { code: 'Y1BBD1', year: '2023', body: 'CUV',
 *                 generation: 'J1', model: 'TAYCAN', engine: 'BEV' }
 *
 * Diese eine Angabe entscheidet, ob mehrere Auswertungen überhaupt etwas
 * aussagen dürfen: Die Kapazitätsschätzung rechnet aus der Strecke zwischen
 * zwei Ladungen. Fährt ein Plug-in-Hybrid Teile davon mit Benzin, ist das
 * Ergebnis nicht ungenau, sondern falsch — und es sieht plausibel aus.
 */
describe('parseVehicleEntry', () => {
  const roh = {
    vin: 'WP0ZZZ',
    modelName: 'Taycan 4 Cross Turismo',
    modelType: {
      code: 'Y1BBD1',
      year: '2023',
      body: 'CUV',
      generation: 'J1',
      model: 'TAYCAN',
      engine: 'BEV',
    },
  };

  it('liest Antrieb, Modell und Baujahr aus', () => {
    const v = parseVehicleEntry(roh);
    expect(v.engine).toBe('BEV');
    expect(v.model).toBe('TAYCAN');
    expect(v.year).toBe('2023');
    expect(v.modelName).toBe('Taycan 4 Cross Turismo');
  });

  it('kommt mit einem Eintrag ohne modelType aus', () => {
    // Ältere Konten oder andere Regionen liefern womöglich weniger. Dann ist
    // der Antrieb UNBEKANNT — und nicht etwa elektrisch.
    const v = parseVehicleEntry({ vin: 'X', modelName: 'Cayenne' });
    expect(v.engine).toBeUndefined();
    expect(v.vin).toBe('X');
  });

  it('nimmt auch die Großschreibvariante der Fahrgestellnummer', () => {
    expect(parseVehicleEntry({ VIN: 'ABC' }).vin).toBe('ABC');
  });
});

describe('isPluginHybrid — die Frage, an der die Rechnungen hängen', () => {
  const mit = (engine?: string): VehicleListEntry => ({ vin: 'X', engine });

  it('erkennt einen Plug-in-Hybrid', () => {
    expect(isPluginHybrid(mit('PHEV'))).toBe(true);
    expect(isPluginHybrid(mit('HYBRID'))).toBe(true);
    expect(isPluginHybrid(mit('phev'))).toBe(true);
  });

  it('erkennt ein Elektrofahrzeug', () => {
    expect(isPluginHybrid(mit('BEV'))).toBe(false);
  });

  it('sagt bei UNBEKANNTEM Antrieb nichts, statt zu raten', () => {
    // Der wichtigste Fall. „Unbekannt" darf nicht stillschweigend zu
    // „elektrisch" werden — sonst rechnet das Plugin bei einem Hybrid weiter
    // munter falsch, und niemand merkt es. Die Auswertungen fragen deshalb
    // auf `=== false` und nicht auf `!isPluginHybrid(...)`.
    expect(isPluginHybrid(mit(undefined))).toBeUndefined();
    expect(isPluginHybrid(mit('SOMETHING_NEW'))).toBeUndefined();
    expect(isPluginHybrid(undefined)).toBeUndefined();
  });
});
