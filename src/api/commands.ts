/**
 * Builder-Funktionen für Fahrzeug-Befehle der Porsche-PPA-API.
 *
 * Befehle werden per POST an `/connect/v1/vehicles/{vin}/commands` gesendet,
 * mit Body `{ commandName, payload }`. Dieses Modul baut ausschließlich diese
 * Body-Objekte — keine HTTP-Calls, reine, seiteneffektfreie Funktionen.
 *
 * Hinweis: UNLOCK ist bewusst NICHT enthalten. Das Entriegeln erfordert eine
 * S-PIN (Security-PIN) und wird in dieser Version nicht unterstützt.
 */

/** Body eines PPA-Fahrzeugbefehls (`commandName` + `payload`). */
export interface PorscheCommand {
  commandName: string;
  payload: Record<string, unknown>;
}

/** Vier-Zonen-Flag der Klimatisierung (Format der echten CLIMATIZER-API). */
export interface ClimateZones {
  frontLeft: boolean;
  frontRight: boolean;
  rearLeft: boolean;
  rearRight: boolean;
}

/** Alle vier Klimazonen aktiv (Default). */
const ALL_CLIMATE_ZONES: ClimateZones = {
  frontLeft: true,
  frontRight: true,
  rearLeft: true,
  rearRight: true,
};

/** Wandelt °C in das von der PPA erwartete Kelvin (z. B. 21 °C → 294.15 K). */
function celsiusToKelvin(tempC: number): number {
  return Math.round((tempC + 273.15) * 100) / 100;
}

/**
 * Startet die Standklimatisierung.
 *
 * Payload-Format an der echten PPA-Antwort verifiziert: `targetTemperature` in
 * KELVIN, plus `climateZonesEnabled`. Ohne `tempC` wird keine Zieltemperatur
 * gesetzt (Fahrzeug nutzt die zuletzt konfigurierte).
 *
 * @param tempC Optionale Zieltemperatur in °C.
 * @param zones Optionale Klimazonen; Default: alle vier aktiv.
 */
export function climateStart(tempC?: number, zones?: ClimateZones): PorscheCommand {
  const payload: Record<string, unknown> = {
    climateZonesEnabled: { ...(zones ?? ALL_CLIMATE_ZONES) },
  };
  if (tempC !== undefined) {
    payload.targetTemperature = celsiusToKelvin(tempC);
  }
  return { commandName: 'REMOTE_CLIMATIZER_START', payload };
}

/** Stoppt die Standklimatisierung. */
export function climateStop(): PorscheCommand {
  return { commandName: 'REMOTE_CLIMATIZER_STOP', payload: {} };
}

/** Startet den (Direkt-)Ladevorgang. */
export function chargingStart(): PorscheCommand {
  return { commandName: 'DIRECT_CHARGING_START', payload: {} };
}

/** Stoppt den (Direkt-)Ladevorgang. */
export function chargingStop(): PorscheCommand {
  return { commandName: 'DIRECT_CHARGING_STOP', payload: {} };
}

/**
 * Verriegelt das Fahrzeug. (Entriegeln per UNLOCK ist nicht unterstützt, siehe
 * Datei-Header.)
 *
 * Payload exakt wie CJNE: `{ spin: null }` — LOCK braucht KEINE echte S-PIN
 * (nur UNLOCK macht den SPIN_CHALLENGE-Flow), aber das Feld `spin: null` muss
 * mitgesendet werden (leeres Payload weicht von der Referenz-Lib ab).
 */
export function lock(): PorscheCommand {
  return { commandName: 'LOCK', payload: { spin: null } };
}

/**
 * Setzt den Ziel-Ladestand (Target SoC).
 * @param percent Ziel-Ladestand in Prozent. Gültig nur 0–100.
 * @throws Error('targetSoc must be 0-100') bei Werten außerhalb 0–100.
 */
export function setTargetSoc(percent: number): PorscheCommand {
  if (!(percent >= 0 && percent <= 100)) {
    throw new Error('targetSoc must be 0-100');
  }
  return {
    commandName: 'CHARGING_SETTINGS_EDIT',
    payload: { targetSoc: percent },
  };
}

/** Startet die Standheizung. */
export function heatingStart(): PorscheCommand {
  return { commandName: 'REMOTE_HEATING_START', payload: {} };
}

/** Stoppt die Standheizung. */
export function heatingStop(): PorscheCommand {
  return { commandName: 'REMOTE_HEATING_STOP', payload: {} };
}

/**
 * Fordert eine S-PIN-Challenge an (Schritt 1 des Entriegelns).
 * Payload `{ spin: null }` wie CJNE. Die Antwort enthält die `challenge`.
 */
export function spinChallenge(): PorscheCommand {
  return { commandName: 'SPIN_CHALLENGE', payload: { spin: null } };
}

/**
 * Entriegelt das Fahrzeug (Schritt 2). `challenge` ist der rohe Wert aus der
 * SPIN_CHALLENGE-Antwort, `hash` der daraus + S-PIN berechnete SHA-512-Hash.
 */
export function unlock(challenge: string, hash: string): PorscheCommand {
  return { commandName: 'UNLOCK', payload: { spin: { challenge, hash } } };
}

/** Gültige Modi für {@link honkFlash}. */
export type HonkFlashMode = 'FLASH' | 'HONK_AND_FLASH';

/**
 * Hupen und/oder Blinken zum Auffinden des Fahrzeugs.
 * @param mode 'FLASH' (nur Lichthupe) oder 'HONK_AND_FLASH'. Default: 'FLASH'.
 */
export function honkFlash(mode: HonkFlashMode = 'FLASH'): PorscheCommand {
  return { commandName: 'HONK_FLASH', payload: { mode } };
}
