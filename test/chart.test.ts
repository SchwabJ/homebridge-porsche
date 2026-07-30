import { chargeCurve, barChart, sparkline } from '../src/chart';
import type { ChargeLogSample } from '../src/chargeLog';
import type { ChargePhase } from '../src/sessions';
import { LABELS_DE, LABELS_EN } from '../src/i18n';

/** Kurzform: Die Diagramme brauchen immer einen Label-Satz. */
const L = { labels: LABELS_DE };

const at = (min: number, soc: number, kw?: number): ChargeLogSample => ({
  ts: new Date(Date.UTC(2026, 6, 27, 20, 0, 0) + min * 60000).toISOString(),
  soc,
  ...(kw !== undefined ? { powerKw: kw } : {}),
});

const phase = (fromMin: number, toMin: number): ChargePhase => ({
  startedAt: new Date(Date.UTC(2026, 6, 27, 20, 0, 0) + fromMin * 60000).toISOString(),
  endedAt: new Date(Date.UTC(2026, 6, 27, 20, 0, 0) + toMin * 60000).toISOString(),
  durationMin: toMin - fromMin,
});

describe('chargeCurve', () => {
  it('liefert nichts bei zu wenigen Messpunkten', () => {
    expect(chargeCurve([at(0, 50), at(10, 55)], [], L)).toBe('');
  });

  it('endet beim Erreichen des Ladeziels, nicht beim Ausstecken', () => {
    // 10 h am Kabel, Ziel nach 140 min erreicht: die Stunden danach dürfen
    // den Ladevorgang nicht auf einen Bruchteil der Breite stauchen.
    const samples = [
      at(0, 50), at(60, 50), at(120, 60), at(140, 80),
      at(400, 80), at(600, 80),
    ];
    const svg = chargeCurve(samples, [phase(60, 140)], { targetSoc: 80, ...L });
    const points = (svg.match(/data-pts="([^"]*)"/)?.[1] ?? '').split(';').length;
    expect(points).toBeLessThan(samples.length);
    expect(points).toBeGreaterThanOrEqual(4);
  });

  it('endet an der letzten Ladephase, wenn das Ziel nie erreicht wurde', () => {
    const samples = [at(0, 50), at(60, 55), at(120, 60), at(600, 60)];
    const svg = chargeCurve(samples, [phase(0, 120)], { targetSoc: 90, ...L });
    const points = (svg.match(/data-pts="([^"]*)"/)?.[1] ?? '').split(';').length;
    expect(points).toBeLessThan(samples.length);
  });

  it('nutzt alle Punkte, wenn weder Ziel noch Phase bekannt sind', () => {
    const svg = chargeCurve([at(0, 50), at(10, 55), at(20, 60)], [], L);
    expect((svg.match(/data-pts="([^"]*)"/)?.[1] ?? '').split(';')).toHaveLength(3);
  });

  it('zeichnet die Grenzlinien mit Beschriftung', () => {
    const svg = chargeCurve([at(0, 50), at(10, 55), at(20, 60)], [], {
      ...L,
      targetSoc: 80,
      minSoc: 60,
    });
    expect(svg).toContain('60% sofort');
    expect(svg).toContain('80% Ziel');
  });

  it('zeigt die Y-Achse IMMER von 0 bis 100 %', () => {
    // Feste Skala: Eine mitwandernde Achse ließe 56→80 % und 5→100 %
    // gleich steil aussehen.
    const svg = chargeCurve([at(0, 53), at(10, 57), at(20, 61)], [], L);
    expect(svg).toContain('>100%<');
    expect(svg).toContain('>50%<');
    expect(svg).toContain('>0%<');
  });

  it('liefert die Messpunkte für den Crosshair mit', () => {
    const svg = chargeCurve([at(0, 50, 11), at(10, 55, 11), at(20, 60)], [], L);
    const pts = (svg.match(/data-pts="([^"]*)"/)?.[1] ?? '').split(';');
    expect(pts).toHaveLength(3);
    // Aufbau: x,y,soc,kW,Uhrzeit
    expect(pts[0].split(',')).toHaveLength(5);
    expect(pts[0].split(',')[2]).toBe('50');
  });
});

describe('barChart', () => {
  it('liefert nichts ohne Datenpunkte', () => {
    expect(barChart([], LABELS_DE)).toBe('');
  });

  it('begrenzt die Balkenbreite bei wenigen Punkten', () => {
    const svg = barChart([{ label: 'A', value: 10 }, { label: 'B', value: 20 }], LABELS_DE);
    const widths = [...svg.matchAll(/class="v"[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.max(...widths)).toBeLessThanOrEqual(38);
  });

  it('definiert den Farbverlauf, den der aktuelle Balken nutzt', () => {
    // Ein toter Verweis machte den Balken unsichtbar.
    const svg = barChart([{ label: 'A', value: 10, current: true }], LABELS_DE);
    expect(svg).toContain('id="bg1"');
  });

  it('zeichnet Nullwerte als flachen Strich statt als Lücke', () => {
    expect(barChart([{ label: 'A', value: 0 }], LABELS_DE)).toContain('class="v0"');
  });
});

describe('Sprache der Diagramme', () => {
  const pts = [at(0, 50), at(10, 55), at(20, 60)];

  it('beschriftet die Zielmarken in der gewählten Sprache', () => {
    const de = chargeCurve(pts, [], { targetSoc: 80, minSoc: 60, labels: LABELS_DE });
    expect(de).toContain('80% Ziel');
    expect(de).toContain('60% sofort');

    const en = chargeCurve(pts, [], { targetSoc: 80, minSoc: 60, labels: LABELS_EN });
    expect(en).toContain('80% target');
    expect(en).toContain('60% instant');
    // Regression: die Marken waren fest deutsch, auch bei language=en.
    expect(en).not.toContain('Ziel');
    expect(en).not.toContain('sofort');
  });

  it('übersetzt auch die Beschreibung für Screenreader', () => {
    expect(chargeCurve(pts, [], { labels: LABELS_EN })).toContain('state of charge over time');
    expect(barChart([{ label: 'A', value: 1 }], LABELS_EN)).toContain('Energy charged per period');
  });

  it('formatiert die Uhrzeiten der Messpunkte nach der Sprache', () => {
    // en-GB liefert 24-Stunden-Zeit wie de-DE, aber die Trennung und die
    // Datumsreihenfolge unterscheiden sich anderswo — hier zählt vor allem,
    // dass die Locale überhaupt durchgereicht wird und nicht 'de-DE' klebt.
    const en = chargeCurve([at(0, 50, 11), at(10, 55, 11), at(20, 60)], [], { labels: LABELS_EN });
    expect(en).toContain('data-pts=');
    expect(en).not.toContain('undefined');
  });
});

describe('sparkline', () => {
  const pts = (vals: number[]): { t: number; v: number }[] =>
    vals.map((v, i) => ({ t: Date.UTC(2026, 6, 1 + i), v }));

  it('liefert nichts bei zu wenigen Punkten', () => {
    // Zwei oder drei Messwerte ergeben immer eine Gerade und behaupten einen
    // Trend, den niemand belegen kann.
    expect(sparkline(pts([2.7, 2.6]))).toBe('');
    expect(sparkline(pts([2.7, 2.6, 2.6]))).toBe('');
  });

  it('zeichnet ab vier Punkten', () => {
    expect(sparkline(pts([2.7, 2.7, 2.6, 2.6]))).toContain('<path');
  });

  it('markiert einen fallenden Verlauf', () => {
    expect(sparkline(pts([2.9, 2.8, 2.7, 2.5]))).toContain('spark down');
  });

  it('markiert einen steigenden Verlauf', () => {
    expect(sparkline(pts([2.5, 2.6, 2.8, 2.9]))).toContain('spark up');
  });

  it('lässt einen ruhigen Verlauf neutral', () => {
    const svg = sparkline(pts([2.7, 2.7, 2.71, 2.7]));
    expect(svg).not.toContain('down');
    expect(svg).not.toContain('up');
  });

  it('skaliert nach den Daten, nicht ab null', () => {
    // Ein Abfall von 2,7 auf 2,5 bar wäre auf einer Achse ab 0 eine
    // waagerechte Linie — genau die Bewegung ist hier aber die Aussage.
    const svg = sparkline(pts([2.7, 2.65, 2.6, 2.5]));
    const ys = [...svg.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(15);
  });

  it('bläht einen ruhigen Verlauf NICHT zum Beben auf', () => {
    // Ohne Mindestspanne würde eine Schwankung von 0,01 bar den ganzen
    // Kasten füllen und wie ein Defekt aussehen.
    const svg = sparkline(pts([2.7, 2.71, 2.7, 2.71]), { minSpan: 0.2 });
    const ys = [...svg.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(4);
  });
});

describe('Gegenbalken: geladen nach oben, verbraucht nach unten', () => {
  /** Alle `rect`-Höhen einer Klasse aus dem SVG. */
  const hoehen = (svg: string, cls: string): number[] =>
    [...svg.matchAll(new RegExp(`class="${cls}"[^>]*height="([\\d.]+)"`, 'g'))].map((m) =>
      Number(m[1]),
    );

  it('zeichnet ohne Verbrauchsdaten genau wie vorher — eine Richtung', () => {
    const svg = barChart([
      { label: 'Mo', value: 10 },
      { label: 'Di', value: 20 },
    ], LABELS_DE);
    expect(svg).toContain('viewBox="0 0 640 132"');
    expect(hoehen(svg, 'd')).toHaveLength(0);
  });

  it('macht das Bild höher, sobald es zwei Richtungen gibt', () => {
    // Sonst schrumpfen beide Richtungen auf die Hälfte der bisherigen Höhe.
    const svg = barChart([{ label: 'Mo', value: 10, down: 8 }], LABELS_DE);
    expect(svg).toContain('viewBox="0 0 640 176"');
  });

  it('gibt beiden Richtungen DIESELBE Skala', () => {
    // Bei gleichem Wert oben und unten müssen beide Balken gleich hoch sein.
    // Eine feste Flächenaufteilung würde hier zwei Maßstäbe ergeben.
    const svg = barChart([
      { label: 'Mo', value: 20, down: 20 },
      { label: 'Di', value: 10, down: 5 },
    ], LABELS_DE);
    const up = hoehen(svg, 'v');
    const down = hoehen(svg, 'd');
    expect(up[0]).toBeCloseTo(down[0], 0);
    // Und das Verhältnis innerhalb einer Richtung bleibt erhalten.
    expect(up[1] / up[0]).toBeCloseTo(0.5, 1);
    expect(down[1] / down[0]).toBeCloseTo(0.25, 1);
  });

  it('behält die Skala auch bei ungleichen Maxima', () => {
    // Oben 40, unten 10: Der Gegenbalken darf nicht auf die halbe Fläche
    // gestreckt werden, sonst sähe ein Viertel wie die Hälfte aus.
    const svg = barChart([{ label: 'Mo', value: 40, down: 10 }], LABELS_DE);
    const up = hoehen(svg, 'v')[0];
    const down = hoehen(svg, 'd')[0];
    expect(down / up).toBeCloseTo(0.25, 1);
  });

  it('beschriftet die Gegenachse ohne Minuszeichen', () => {
    // Es ist ein Betrag in der anderen Richtung, keine negative Energie.
    const svg = barChart([{ label: 'Mo', value: 20, down: 15 }], LABELS_DE);
    expect(svg).not.toContain('>-20<');
    expect(svg).not.toContain('>-15<');
    expect(svg).toMatch(/>20</);
  });

  it('zieht die Nulllinie als eigene Linie, nicht als Hilfslinie', () => {
    const svg = barChart([{ label: 'Mo', value: 20, down: 15 }], LABELS_DE);
    expect(svg).toContain('class="zl"');
  });

  it('nennt in einem Tooltip beide Richtungen', () => {
    const svg = barChart([
      { label: 'Di', value: 20.1, down: 22.1, downDetail: '88 km ohne belastbaren Verbrauch' },
    ], LABELS_DE);
    expect(svg).toContain('20.1 kWh geladen');
    expect(svg).toContain('22.1 kWh verbraucht');
    expect(svg).toContain('88 km ohne belastbaren Verbrauch');
  });

  it('lässt zwischen den Füllungen Luft, statt sie zu verschmelzen', () => {
    // Ein durchgehender Block wäre als ein Balken lesbar.
    const svg = barChart([{ label: 'Mo', value: 20, down: 20 }], LABELS_DE);
    const yUp = Number((svg.match(/class="v"[^>]*y="([\d.]+)"/) as string[])[1]);
    const hUp = hoehen(svg, 'v')[0];
    const yDown = Number((svg.match(/class="d"[^>]*y="([\d.]+)"/) as string[])[1]);
    expect(yDown).toBeGreaterThan(yUp + hUp);
  });

  it('zeigt einen Gegenbalken auch bei null Ladung', () => {
    // Ein Tag, an dem gefahren, aber nicht geladen wurde, ist genau der Fall,
    // für den es die zweite Richtung gibt.
    const svg = barChart([{ label: 'Mo', value: 0, down: 12 }], LABELS_DE);
    expect(hoehen(svg, 'd')).toHaveLength(1);
    expect(svg).toContain('12.0 kWh verbraucht');
  });
});

describe('Achse des Gegenbalkens', () => {
  it('kennzeichnet die untere Beschriftung farblich statt mit einem Minus', () => {
    // Ohne Kennzeichnung stand an der Achse zweimal dieselbe Zahl („30 · 15 ·
    // 0 · 30") — mathematisch richtig, aber nicht lesbar. Ein Minuszeichen
    // wäre falsch: Es ist ein Betrag in der anderen Richtung, keine negative
    // Energie.
    const svg = barChart([{ label: 'Mo', value: 30, down: 30 }], LABELS_DE);
    expect(svg).toMatch(/class="ax dn"[^>]*>30</);
    expect(svg).not.toContain('>-30<');
    // Und oben ohne die Kennzeichnung.
    expect(svg).toMatch(/class="ax"[^>]*>30</);
  });

  it('zieht auch unten eine Mittellinie, wenn dort Platz ist', () => {
    const svg = barChart([{ label: 'Mo', value: 30, down: 30 }], LABELS_DE);
    // 0, 30 oben, 15 oben, 30 unten, 15 unten
    const werte = [...svg.matchAll(/class="ax(?: dn)?"[^>]*>([\d.]+)</g)].map((m) => m[1]);
    expect(werte.filter((x) => x === '15')).toHaveLength(2);
  });

  it('lässt die untere Kennzeichnung weg, wenn es keinen Gegenbalken gibt', () => {
    const svg = barChart([{ label: 'Mo', value: 30 }], LABELS_DE);
    expect(svg).not.toContain('class="ax dn"');
  });
});
