import { externallyPaced } from '../src/chargeWindow';
import type { ChargeSession, ChargePhase } from '../src/sessions';

const phase = (vonMin: number, bisMin: number, endSoc?: number): ChargePhase => ({
  startedAt: new Date(Date.UTC(2026, 6, 29, 0, vonMin)).toISOString(),
  endedAt: new Date(Date.UTC(2026, 6, 29, 0, bisMin)).toISOString(),
  durationMin: bisMin - vonMin,
  ...(endSoc !== undefined ? { endSoc } : {}),
});

const ladung = (phases: ChargePhase[], over: Partial<ChargeSession> = {}): ChargeSession => ({
  startedAt: '2026-07-29T00:00:00.000Z',
  endedAt: '2026-07-29T08:00:00.000Z',
  durationMin: 480,
  chargingMin: phases.reduce((a, p) => a + p.durationMin, 0),
  socDropped: false,
  complete: true,
  samples: 60,
  startSoc: 40,
  endSoc: 80,
  targetSoc: 80,
  phases,
  ...over,
});

describe('externallyPaced — taktet schon jemand anders?', () => {
  it('erkennt die Taktung an Ladepausen, die das Fahrzeug nicht selbst beendet hat', () => {
    // Eine tarifgesteuerte Nacht: vier Ladeabschnitte, dazwischen Pausen von
    // je 40 Minuten — zu lang für einen Aussetzer — und der Ladestand davor
    // (50, 60, 70 %) liegt jedes Mal unter dem Ziel. So sieht es aus, wenn ein
    // Tarifanbieter oder eine Wallbox den Takt vorgibt.
    // Wichtig: Diese Ladung ERREICHT ihr Ziel. Genau so sieht es aus, wenn
    // ein Tarifanbieter bis zum eingestellten Ziel lädt — die Taktung zeigt
    // sich an den Pausen davor, nicht am Endergebnis.
    const paced = ladung([
      phase(0, 20, 50),
      phase(60, 120, 60),
      phase(160, 220, 70),
      phase(260, 300, 80),
    ]);
    expect(externallyPaced([paced])).toBe(true);
  });

  it('hält eine durchgehende Ladung nicht für fremdgesteuert', () => {
    expect(externallyPaced([ladung([phase(0, 300, 80)])])).toBe(false);
  });

  it('verwechselt kurze Unterbrechungen nicht mit einem Tarif-Takt', () => {
    // Ein Aussetzer von wenigen Minuten entsteht auch ohne fremde Steuerung —
    // ein Slot-Wechsel dauert länger.
    expect(externallyPaced([ladung([phase(0, 120, 60), phase(124, 300, 80)])])).toBe(false);
  });

  it('wertet eine Pause am erreichten Ziel nicht als Taktung', () => {
    // Am Ladeziel hört das Fahrzeug von selbst auf. Steht danach noch ein
    // kurzer Nachschlag, ist das kein Anbieter, sondern Physik.
    const amZiel = ladung([phase(0, 200, 80), phase(260, 265, 80)], {
      endSoc: 80,
      targetSoc: 80,
    });
    expect(externallyPaced([amZiel])).toBe(false);
  });

  it('sieht nur auf die jüngsten Ladungen', () => {
    // Wer den Tarif wechselt, soll das Fenster wieder nutzen können, ohne dass
    // eine halbjahresalte Ladung es dauerhaft blockiert.
    const alt = ladung([phase(0, 20, 50), phase(60, 120, 60), phase(160, 220, 70)]);
    const neu = Array.from({ length: 6 }, () => ladung([phase(0, 300, 80)]));
    expect(externallyPaced([alt, ...neu])).toBe(false);
  });

  it('greift nicht auf laufende Ladungen zurück', () => {
    // Eine laufende Ladung hat ihre Pausen noch vor sich; sie zu bewerten
    // hieße raten.
    const offen = ladung([phase(0, 20, 50), phase(60, 120, 60), phase(160, 220, 70)], {
      complete: false,
    });
    const abgeschlossen = ladung([phase(0, 300, 80)]);
    expect(externallyPaced([offen, abgeschlossen])).toBe(false);
  });

  it('sagt ohne Historie nichts', () => {
    // Kein Wissen ist kein Freibrief: Ohne Ladungen ist unbekannt, ob jemand
    // taktet — und dann greift das Fenster erst, wenn es etwas weiß.
    expect(externallyPaced([])).toBe(true);
  });
});
