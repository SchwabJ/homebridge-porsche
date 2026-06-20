/**
 * Reine, seiteneffektfreie Helfer für das Accessory-Mapping.
 *
 * Keine HomeKit- oder HTTP-Abhängigkeiten — nur Geometrie/Schwellwerte/Einheiten,
 * damit die Logik isoliert (TDD) getestet werden kann.
 */

import { VehicleState } from '../api/measurements';

/** Erdradius in Metern (mittlerer Radius, für Haversine ausreichend genau). */
const EARTH_RADIUS_M = 6371000;

/** Grad → Radiant. */
function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Distanz zwischen zwei WGS84-Koordinaten in Metern (Haversine-Formel).
 *
 * Für die hier benötigten Distanzen (≤ einige km) ausreichend genau; identische
 * Punkte liefern exakt 0.
 */
export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * Ist das Fahrzeug "zuhause"?
 *
 * `false`, wenn die Fahrzeug- ODER die Zuhause-Koordinaten fehlen; sonst `true`,
 * wenn die Distanz kleiner als `radiusM` (Default 150 m) ist.
 */
export function isCarHome(
  state: VehicleState,
  homeLat?: number,
  homeLon?: number,
  radiusM = 150,
): boolean {
  if (
    state.lat === undefined ||
    state.lon === undefined ||
    homeLat === undefined ||
    homeLon === undefined
  ) {
    return false;
  }
  return distanceMeters(state.lat, state.lon, homeLat, homeLon) < radiusM;
}

/** `true`, wenn ein Ladezustand bekannt und unter 15 % ist. */
export function lowBattery(soc?: number): boolean {
  return soc !== undefined && soc < 15;
}

/** °C → Kelvin, gerundet auf 2 Nachkommastellen (z. B. 21 → 294.15). */
export function celsiusToKelvin(celsius: number): number {
  return Math.round((celsius + 273.15) * 100) / 100;
}

/** Kelvin → °C, gerundet auf 1 Nachkommastelle (z. B. 295.15 → 22). */
export function kelvinToCelsius(kelvin: number): number {
  return Math.round((kelvin - 273.15) * 10) / 10;
}

/**
 * Restminuten bis zu einem ISO-Zeitpunkt, ab `nowMs`. Nie negativ.
 *
 * @returns gerundete Minuten ≥0, oder undefined bei fehlendem/ungültigem ISO.
 */
export function etaMinutes(iso: string | undefined, nowMs: number): number | undefined {
  if (typeof iso !== 'string') {
    return undefined;
  }
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) {
    return undefined;
  }
  return Math.max(0, Math.round((targetMs - nowMs) / 60000));
}

/**
 * Reifendruck-Warnung: `true`, wenn die Druck-Differenz (Betrag) den Schwellwert
 * erreicht oder überschreitet.
 *
 * @param diffBar    Differenz zum Sollwert in bar (kann negativ sein).
 * @param threshold  Warnschwelle in bar (z. B. 0.3).
 */
export function tireWarn(diffBar: number | undefined, threshold: number): boolean {
  if (diffBar === undefined || !Number.isFinite(diffBar)) {
    return false;
  }
  return Math.abs(diffBar) >= threshold;
}

/**
 * `true`, wenn irgendeine Tür / ein Fenster / Frunk / Kofferraum offen ist
 * ODER das Fahrzeug entriegelt ist (offen/ungesichert-Sammelmeldung).
 *
 * Nur bekannte (definierte) Zustände zählen; fehlende Daten lösen keine Meldung aus.
 */
export function anyOpenUnsecured(state: VehicleState): boolean {
  const cornersOpen = (c?: { fl: boolean; fr: boolean; rl: boolean; rr: boolean }): boolean =>
    c !== undefined && (c.fl || c.fr || c.rl || c.rr);

  if (cornersOpen(state.doors)) {
    return true;
  }
  if (cornersOpen(state.windows)) {
    return true;
  }
  if (state.frunkOpen === true || state.trunkOpen === true) {
    return true;
  }
  if (state.locked === false) {
    return true;
  }
  return false;
}
