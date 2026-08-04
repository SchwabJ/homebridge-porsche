import * as fs from 'fs';
import * as path from 'path';

/**
 * Über der Schlüsselliste in platform.ts steht eine Zusage: Sie deckt 1:1
 * jeden Schlüssel ab, den der Parser aus der Antwort herausliest. Fehlt einer,
 * bleiben die davon gespeisten Anzeigen dauerhaft leer.
 *
 * Die Zusage war gebrochen: `FUEL_LEVEL` und `RANGE` wurden gelesen und in
 * Kacheln angezeigt, aber nie abgefragt — ein Cayenne- oder Panamera-E-Hybrid
 * bekam zwei Kacheln, die nie einen Wert bekamen. Aufgefallen ist das erst bei
 * einer gezielten Durchsicht, nicht im Betrieb: Eine leere Kachel sieht aus
 * wie „noch keine Daten".
 *
 * Ein Kommentar, der eine Invariante behauptet, hält sie nicht. Ein Test tut es.
 */
describe('STATE_KEYS deckt ab, was der Parser liest', () => {
  const lies = (rel: string): string =>
    fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

  it('fragt jeden Schlüssel ab, den measurements.ts dereferenziert', () => {
    const parser = lies('api/measurements.ts');
    const platform = lies('platform.ts');

    // Alles, was der Parser über byKey.get('…') anfasst.
    const gelesen = new Set(
      [...parser.matchAll(/byKey\.get\('([A-Z0-9_]+)'\)/g)].map((m) => m[1]),
    );
    expect(gelesen.size).toBeGreaterThan(10);

    // Die Liste selbst — nur der Block, nicht der ganze Quelltext.
    const block = /const STATE_KEYS: string\[\] = \[([\s\S]*?)\n\];/.exec(platform);
    expect(block).not.toBeNull();
    const abgefragt = new Set(
      [...(block as RegExpExecArray)[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]),
    );

    const fehlend = [...gelesen].filter((k) => !abgefragt.has(k)).sort();
    expect(fehlend).toEqual([]);
  });
});
