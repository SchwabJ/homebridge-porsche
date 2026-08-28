import { resolveCapacity, ADOPT_MAX_DISAGREEMENT } from '../src/capacity';

/**
 * Übernommen wird eine Messung nur, wenn BEIDE Wege übereinstimmen.
 *
 * ## Warum die Gegenprobe nötig ist
 *
 * Ab zehn Zyklen ersetzt die gemessene Kapazität die eingestellte — und ab
 * dann geht sie in jede kWh-, Kosten- und Ersparniszahl ein, rückwirkend über
 * die ganze Historie. Eine Zyklenzahl allein belegt aber nicht, dass die
 * Messung stimmt: Die beiden Messwege können weit auseinanderlaufen. Der
 * konstruierte Fall unten stellt genau das nach —
 *
 *     über die Fahrten    72,0 kWh
 *     über die Ladungen   80,0 kWh
 *
 * also 10 % Unterschied. Welches Verfahren dann näher an der wahren Kapazität
 * liegt, ist aus den Zahlen selbst nicht zu entscheiden — und solange das so
 * ist, darf keines von beiden still die Kostenrechnung übernehmen.
 *
 * Stimmen sie dagegen überein, stützen sich zwei Verfahren mit
 * unterschiedlichen systematischen Fehlern gegenseitig. Das ist ein weit
 * stärkerer Beleg als eine hohe Zyklenzahl.
 */
describe('resolveCapacity — Übernahme nur bei Übereinstimmung', () => {
  const basis = { configured: 83.7, auto: true, cycles: 12 };

  it('übernimmt, wenn beide Wege nah beieinander liegen', () => {
    const r = resolveCapacity({ ...basis, measured: 78.0, crossCheck: 79.5 });
    expect(r.source).toBe('gemessen');
    expect(r.capacityKwh).toBe(78.0);
  });

  it('übernimmt NICHT, wenn die Wege auseinanderlaufen', () => {
    // Konstruierter Gegenfall: 72,0 gegen 80,0 sind 10 % Unterschied.
    const r = resolveCapacity({ ...basis, measured: 72.0, crossCheck: 80.0 });
    expect(r.source).toBe('eingestellt');
    expect(r.capacityKwh).toBe(83.7);
  });

  it('übernimmt weiterhin, wenn es gar keine Gegenprobe gibt', () => {
    // Rückwärtskompatibel: Wer keine ladeseitigen Messungen hat (zu wenige
    // Ladungen, keine Leistungsangaben), verliert die Automatik nicht.
    const r = resolveCapacity({ ...basis, measured: 78.0 });
    expect(r.source).toBe('gemessen');
  });

  it('hält an der Zyklenschwelle fest', () => {
    const r = resolveCapacity({ ...basis, cycles: 4, measured: 78.0, crossCheck: 79.0 });
    expect(r.source).toBe('eingestellt');
  });

  it('hat eine Toleranz in der Größenordnung der Messfehler', () => {
    // Beide Verfahren tragen mehrere Prozent systematischen Fehler. Eine zu
    // enge Grenze verhinderte jede Übernahme, eine zu weite nähme auch
    // widersprüchliche Messungen an.
    expect(ADOPT_MAX_DISAGREEMENT).toBeGreaterThan(0.02);
    expect(ADOPT_MAX_DISAGREEMENT).toBeLessThan(0.10);
  });
});
