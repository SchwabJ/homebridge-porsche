/**
 * Monatsbericht der Fahrten — das Gegenstück zum Ladebeleg.
 *
 * ## Warum dieselbe Form wie der Beleg
 *
 * Beides sind Monatsaufstellungen über dieselbe Historie, nur von der
 * anderen Seite: Der Beleg zeigt, was hineinging, der Fahrtenbericht, was
 * herauskam. Zwei verschiedene Bedienmuster für dieselbe Sache wären
 * Willkür — deshalb dieselbe Monatswahl, dieselbe Tabelle, derselbe
 * CSV-Knopf, dieselbe Druckansicht.
 *
 * ## Warum nach dem ENDE zugeordnet
 *
 * Wie in der Fahrtenliste des Dashboards: Eine Fahrt gehört dem Zeitpunkt,
 * an dem sie abgeschlossen war — dort steht auch ihr Verbrauch fest. Der
 * Ladebeleg ordnet dagegen nach dem BEGINN, weil eine Ladung als Ganzes
 * bezahlt wird. Beide Regeln sind bewusst verschieden und je Seite einheitlich.
 */
import type { Trip } from './trips';
import { monthKey } from './format';

export interface TripReportLine {
  startedAt: string;
  endedAt: string;
  km: number;
  minutes: number;
  odometerKm?: number;
  energyKwh?: number;
  kwhPer100km?: number;
  costEur?: number;
}

export interface TripReport {
  /** Monat als `YYYY-MM`. */
  month: string;
  lines: TripReportLine[];
  /** Gefahrene Kilometer im Monat. */
  km: number;
  /** Strecke MIT belastbarer Verbrauchsangabe. */
  ratedKm: number;
  energyKwh: number;
  costEur: number;
  /** Verbrauch über die bewertete Strecke; fehlt ohne solche. */
  kwhPer100km?: number;
}


const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Baut den Fahrtenbericht eines Monats. */
export function buildTripReport(trips: Trip[], month: string): TripReport {
  const out: TripReport = {
    month,
    lines: [],
    km: 0,
    ratedKm: 0,
    energyKwh: 0,
    costEur: 0,
  };
  for (const t of trips) {
    if (monthKey(t.endedAt) !== month || t.km <= 0) {
      continue;
    }
    out.lines.push({
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      km: t.km,
      minutes: t.minutes,
      odometerKm: t.odometerKm,
      energyKwh: t.energyKwh,
      kwhPer100km: t.kwhPer100km,
      costEur: t.costEur,
    });
    out.km += t.km;
    if (t.energyKwh !== undefined) {
      // Nur Fahrten MIT Verbrauchsangabe zählen in die Kennzahl. Sonst
      // teilte man bekannte Energie durch unbekannt große Strecke und
      // rechnete den Verbrauch klein.
      out.ratedKm += t.km;
      out.energyKwh += t.energyKwh;
    }
    out.costEur += t.costEur ?? 0;
  }
  out.energyKwh = round2(out.energyKwh);
  out.costEur = round2(out.costEur);
  if (out.ratedKm > 0 && out.energyKwh > 0) {
    out.kwhPer100km = Math.round((out.energyKwh / out.ratedKm) * 1000) / 10;
  }
  return out;
}

/** Die Monate mit Fahrten, jüngster zuerst. */
export function tripMonths(trips: Trip[]): string[] {
  const set = new Set<string>();
  for (const t of trips) {
    if (t.km > 0) {
      set.add(monthKey(t.endedAt));
    }
  }
  return [...set].sort().reverse();
}
