/**
 * Nutzbare Batteriekapazität aus echten Fahrdaten schätzen.
 *
 * ## Warum überhaupt
 *
 * Die geladene Energie wird als `SoC-Delta × Kapazität` gerechnet — die
 * Kapazität ist damit der empfindlichste Parameter der ganzen Auswertung.
 * Konfiguriert wird üblicherweise der Datenblattwert des Neufahrzeugs. Eine
 * gealterte Batterie mit 90 % Gesundheitszustand hat aber ein Zehntel weniger,
 * und dieses Zehntel schlägt auf JEDE Zahl im Dashboard durch — auf die kWh,
 * die Kosten und die Ersparnis gleichermaßen.
 *
 * ## Wie
 *
 * Beim Fahren liefert das Fahrzeug seinen eigenen Verbrauch
 * (`avgKwhPerHundredKm`). Mit der gefahrenen Strecke ergibt das die
 * entnommene Energie; zusammen mit dem beobachteten Ladestand-Abfall folgt
 * daraus die Kapazität:
 *
 *     Kapazität = (km × kWh/100km / 100) / (SoC-Abfall / 100)
 *
 * Das ist die einzige Größe hier, die weder Datenblatt noch Zertifikat
 * braucht — sie kommt aus dem Fahrzeug selbst.
 *
 * ## Grenzen (bewusst offengelegt)
 *
 * `avgKwhPerHundredKm` ist der Durchschnitt des laufenden Ladezyklus, nicht
 * der des einzelnen Fahrabschnitts. Über viele Abschnitte mittelt sich das
 * heraus, im Einzelwert nicht. Deshalb wird der MEDIAN genommen (unempfindlich
 * gegen Ausreißer) und die Streuung mit ausgewiesen — eine Schätzung ohne
 * Angabe ihrer Unsicherheit wäre hier gefährlicher als gar keine.
 */

import type { ChargeLogSample } from './chargeLog';

/** Mindeststrecke eines verwertbaren Abschnitts in km. */
const MIN_KM = 5;
/** Mindest-Ladestandsabfall in Prozentpunkten (unter 3 dominiert die Rundung). */
const MIN_SOC_DROP = 3;
/** Verwerfen, was außerhalb dieses Bereichs liegt — dort steckt ein Datenfehler. */
const PLAUSIBLE_MIN_KWH = 40;
const PLAUSIBLE_MAX_KWH = 120;

export interface CapacityEstimate {
  /** Geschätzte nutzbare Kapazität in kWh (Median). */
  capacityKwh?: number;
  /** Anzahl verwertbarer Fahrabschnitte. */
  samples: number;
  /** Streuung als Spanne zwischen dem 25. und 75. Perzentil, in kWh. */
  spreadKwh?: number;
  /** Zurückgelegte Strecke aller verwerteten Abschnitte. */
  km: number;
  /** Einzelschätzungen, aufsteigend — für Diagnose und Diagramme. */
  values: number[];
}

const median = (sorted: number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Schätzt die Kapazität aus den Fahrabschnitten des Mitschriebs.
 *
 * Ein Abschnitt läuft von einem Messpunkt zum nächsten, in dem das Fahrzeug
 * NICHT am Kabel hing, Strecke zurückgelegt UND Ladestand verloren hat.
 * Abschnitte am Kabel scheiden aus: Dort kann gleichzeitig geladen werden,
 * was den Ladestandsabfall verfälscht.
 */
export function estimateCapacity(samples: ChargeLogSample[]): CapacityEstimate {
  const values: number[] = [];
  let km = 0;

  let prev: ChargeLogSample | undefined;
  for (const cur of samples) {
    // Nur Messpunkte mit vollständiger Information verketten.
    if (
      cur.soc === undefined ||
      cur.odometerKm === undefined ||
      cur.tripKwh100 === undefined
    ) {
      continue;
    }
    if (
      prev &&
      prev.soc !== undefined &&
      prev.odometerKm !== undefined &&
      // Beide Enden ohne Kabel — sonst könnte zwischendurch geladen worden sein.
      prev.plugged !== true &&
      cur.plugged !== true
    ) {
      const drivenKm = cur.odometerKm - prev.odometerKm;
      const socDrop = prev.soc - cur.soc;
      if (drivenKm >= MIN_KM && socDrop >= MIN_SOC_DROP) {
        const usedKwh = (drivenKm * cur.tripKwh100) / 100;
        const capacity = usedKwh / (socDrop / 100);
        if (capacity >= PLAUSIBLE_MIN_KWH && capacity <= PLAUSIBLE_MAX_KWH) {
          values.push(capacity);
          km += drivenKm;
        }
      }
    }
    prev = cur;
  }

  const est: CapacityEstimate = { samples: values.length, km, values: [...values].sort((a, b) => a - b) };
  if (values.length === 0) {
    return est;
  }
  est.capacityKwh = Math.round(median(est.values) * 10) / 10;
  if (values.length >= 4) {
    const q = (p: number): number => est.values[Math.floor((est.values.length - 1) * p)];
    est.spreadKwh = Math.round((q(0.75) - q(0.25)) * 10) / 10;
  }
  return est;
}

/**
 * Gesundheitszustand gegenüber der Werkskapazität, in Prozent.
 *
 * Bewusst getrennt von der Schätzung selbst: Der Bezugswert ist eine Annahme
 * über das Neufahrzeug, die Schätzung dagegen eine Messung.
 */
export function stateOfHealth(
  estimated: number | undefined,
  factoryKwh: number,
): number | undefined {
  if (estimated === undefined || factoryKwh <= 0) {
    return undefined;
  }
  return Math.round((estimated / factoryKwh) * 1000) / 10;
}
