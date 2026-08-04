import * as fs from 'fs';
import * as path from 'path';

/**
 * Die HomeKit-Kennungen sind eingefroren — ohne Ausnahme.
 *
 * Jede UUID entsteht allein aus ihrem Seed-String (kit.ts, `uuid.generate`);
 * die Fahrgestellnummer geht nicht ein. Ändert sich ein Seed, ist das für
 * HomeKit ein ANDERES Gerät: Der Nutzer bekommt es neu und leer, und jede
 * Automation, jede Szene und jede Raumzuordnung, die auf dem alten lag, ist
 * weg. Wiederherstellen kann das niemand — HomeKit kennt keinen Umzug von
 * einer UUID auf eine andere.
 *
 * Alle Seeds beginnen mit `taycan-`, obwohl das Paket `homebridge-porsche`
 * heißt. Das sieht nach einem Aufräumrest aus und ist keiner: Es ist der
 * einzige Grund, warum bestehende Installationen ein Update überleben.
 *
 * Dieser Test hält das fest, damit es nicht von gutem Willen abhängt. Wer
 * einen Seed ändern will, ändert hier zuerst — und sieht dabei, was es kostet.
 */
describe('HomeKit-Kennungen bleiben eingefroren', () => {
  const seedsAus = (datei: string): string[] => {
    const quelle = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'accessories', datei),
      'utf8',
    );
    const block = /const SEEDS = \{([\s\S]*?)\n\} as const;/.exec(quelle);
    if (!block) {
      return [];
    }
    return [...block[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
  };

  it('Laden', () => {
    expect(seedsAus('charging.ts')).toEqual([
      'taycan-battery',
      'taycan-battery-low',
      'taycan-charge-eta',
      'taycan-charge-limit',
      'taycan-charge-profile',
      'taycan-charge-rate',
      'taycan-charge-switch',
      'taycan-charging-flag',
      'taycan-charging-power',
      'taycan-dc-flag',
      'taycan-fuel',
      'taycan-fuel-range',
      'taycan-max-charging-power',
      'taycan-range',
      'taycan-soc',
    ]);
  });

  it('Zugang', () => {
    expect(seedsAus('access.ts')).toEqual([
      'taycan-any-open',
      'taycan-door-fl',
      'taycan-door-fr',
      'taycan-door-rl',
      'taycan-door-rr',
      'taycan-flash',
      'taycan-frunk',
      'taycan-honk',
      'taycan-lock',
      'taycan-lock-button',
      'taycan-lock-v2',
      'taycan-trunk',
      'taycan-vehicle-status',
      'taycan-window-fl',
      'taycan-window-fr',
      'taycan-window-rl',
      'taycan-window-rr',
    ]);
  });

  it('Telemetrie', () => {
    const s = seedsAus('telemetry.ts');
    expect(s).toContain('taycan-odometer');
    expect(s).toContain('taycan-service-km');
    expect(s).toContain('taycan-tire-fl');
    expect(s.every((x) => x.startsWith('taycan-'))).toBe(true);
  });

  it('jede Kennung im ganzen Verzeichnis beginnt mit taycan-', () => {
    // Auch neue: Ein zweites Präfix wäre für bestehende Nutzer harmlos, für
    // die Übersicht aber Unfug — und der nächste Aufräumversuch träfe dann
    // beide Sorten unterschiedlich.
    const dir = path.join(__dirname, '..', 'src', 'accessories');
    for (const datei of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      for (const seed of seedsAus(datei)) {
        expect([datei, seed.startsWith('taycan-')]).toEqual([datei, true]);
      }
    }
  });
});
