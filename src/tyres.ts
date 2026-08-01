/**
 * Reifendruck über die Zeit — der schleichende Plattfuß.
 *
 * Der Druck wird seit jeher mitgeschrieben, aber nur als letzter Wert
 * angezeigt. Ein Reifen, der über Wochen gleichmäßig Luft verliert, ist damit
 * unsichtbar: Jede Einzelmessung sieht harmlos aus, erst die Kurve zeigt es.
 * Und genau dieser Fall ist der, den man früh bemerken will — ein Nagel im
 * Reifen kündigt sich so an, lange bevor die Warnleuchte angeht.
 *
 * ## Warum der Vergleich der Räder untereinander entscheidend ist
 *
 * Reifendruck hängt an der Temperatur: Zwischen einer kalten Nacht und einem
 * warmen Nachmittag liegen leicht 0,1 bar, über die Jahreszeiten mehr. Wer
 * allein den absoluten Verlauf eines Rades betrachtet, meldet im Herbst vier
 * Plattfüße.
 *
 * Ein Loch dagegen betrifft EIN Rad. Deshalb zählt hier nicht der Verlust
 * selbst, sondern der Verlust im Vergleich zu den anderen dreien: Fallen alle
 * gemeinsam, war es das Wetter.
 */
import type { ChargeLogSample } from './chargeLog';

/**
 * Ab welchem Druckverlust gegenüber den anderen Rädern gemeldet wird, in bar.
 *
 * Über der üblichen Temperaturschwankung von rund 0,1 bar, damit nicht jede
 * Wetterlage einen Alarm auslöst — und deutlich unter dem, was ein Fahrer
 * selbst bemerkt.
 */
export const TYRE_DROP_BAR = 0.25;

/** Mindestzeitraum, bevor überhaupt etwas behauptet wird. */
const MIN_DAYS = 5;

export interface TyrePoint {
  at: string;
  bar: number;
}

export interface TyreDrop {
  /** 0 = vorne links, 1 = vorne rechts, 2 = hinten links, 3 = hinten rechts. */
  wheel: number;
  fromBar: number;
  toBar: number;
  days: number;
}

export interface TyreTrend {
  /** Verlauf je Rad, in der Reihenfolge vl, vr, hl, hr. */
  series: TyrePoint[][];
  /** Räder, die gegenüber den anderen Druck verloren haben. */
  dropping: TyreDrop[];
}

/** Wertet den Reifendruck-Verlauf aus. */
export function tyreTrend(samples: Iterable<ChargeLogSample>): TyreTrend {
  const series: TyrePoint[][] = [[], [], [], []];
  for (const s of samples) {
    if (!s.tyreBar) {
      continue;
    }
    for (let i = 0; i < 4; i++) {
      series[i].push({ at: s.ts, bar: s.tyreBar[i] });
    }
  }

  const dropping: TyreDrop[] = [];
  const erste = series[0][0];
  const letzte = series[0][series[0].length - 1];
  if (!erste || !letzte) {
    return { series, dropping };
  }
  const days = (Date.parse(letzte.at) - Date.parse(erste.at)) / 86400000;
  if (days < MIN_DAYS) {
    return { series, dropping };
  }

  // Verlust je Rad, dann jedes gegen den MITTLEREN Verlust der anderen drei.
  // Das ist der Kern: Was alle vier gleichermaßen betrifft, ist Temperatur.
  const verluste = series.map((p) => p[0].bar - p[p.length - 1].bar);
  for (let i = 0; i < 4; i++) {
    const andere = verluste.filter((_, j) => j !== i);
    const mittel = andere.reduce((a, b) => a + b, 0) / andere.length;
    if (verluste[i] - mittel >= TYRE_DROP_BAR) {
      dropping.push({
        wheel: i,
        fromBar: series[i][0].bar,
        toBar: series[i][series[i].length - 1].bar,
        days: Math.round(days),
      });
    }
  }
  return { series, dropping };
}

/** Radbezeichnungen in der Reihenfolge des Mitschriebs. */
export const WHEEL_NAMES = ['vorne links', 'vorne rechts', 'hinten links', 'hinten rechts'];
