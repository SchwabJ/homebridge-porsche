/**
 * Domänen-Modul „Wächter" — Verbindung + Daten-Aktualität.
 *
 * Dieses Modul legt ZWEI Sensoren an, jeweils auf einem EIGENEN PlatformAccessory
 * (eigene beschriftete Kachel): „Taycan Verbindung" (Seed {@link CONNECTION_ACCESSORY_SEED})
 * und „Taycan Daten aktuell" (Seed {@link FRESHNESS_ACCESSORY_SEED}):
 *
 *  1. **Verbindung / Auth** — ContactSensor + StatusFault.
 *     Quelle ist NICHT der VehicleState, sondern ein von der Plattform übergebenes
 *     Health-Flag ({@link PlatformHealth}). Ein fehlgeschlagener Poll/Refresh oder
 *     ein Auth-Fehler erzeugt KEINEN VehicleState — der Wächter muss aber trotzdem
 *     in den Fehlerzustand kippen. Darum ist Health ein SEPARATER Kanal
 *     ({@link Watchdog.setHealth}), nicht Teil von `update(state)`.
 *       - `ok:false` → ContactSensorState NOT_DETECTED (1) + StatusFault GENERAL_FAULT (1)
 *       - `ok:true`  → ContactSensorState DETECTED (0)     + StatusFault NO_FAULT (0)
 *
 *  2. **Daten-Aktualität** — ContactSensor + StatusActive.
 *     Quelle ist `state.dataTimestamp`. Daten gelten als veraltet, wenn der
 *     Zeitstempel fehlt ODER älter als `config.staleMinutes` ist.
 *       - veraltet → ContactSensorState NOT_DETECTED (1) + StatusActive false
 *       - frisch   → ContactSensorState DETECTED (0)     + StatusActive true
 *
 * INTEGRATIONS-VERTRAG (für die Plattform, platform.ts):
 *   const wd = createWatchdog(kit);
 *   // bei JEDEM Poll-Zyklus — auch bei Fehlern — Health melden:
 *   wd.setHealth({ ok: false, message: 'token refresh failed' });   // bei Fehler
 *   wd.setHealth({ ok: true });                                     // bei Erfolg
 *   // nach erfolgreichem Poll zusätzlich den State durchreichen (wie jedes Modul):
 *   wd.update(state);
 *
 * `update(state)` hat exakt die Signatur der DomainModule-Apply-Funktion
 * (`(state: VehicleState) => void`), damit die Plattform alle Module einheitlich
 * mit `update` füttern kann; `setHealth` ist der dokumentierte Zusatzkanal.
 */

import type { PlatformAccessory } from 'homebridge';

import type { Kit } from './kit';
import type { VehicleState } from '../api/measurements';

/**
 * Stabile Seed-Namen der Wächter-Accessories — EIN Accessory pro Sensor
 * (eigene beschriftete Kachel). Stabil (kein Datum/Zufall) → Cache-Matching +
 * Orphan-Cleanup über Neustarts. NICHT aus der Config ableiten.
 */
export const CONNECTION_ACCESSORY_SEED = 'taycan-connection';
export const FRESHNESS_ACCESSORY_SEED = 'taycan-freshness';

/**
 * Schmale Health-Schnittstelle, die die Plattform an den Wächter übergibt.
 *
 * `ok:false` bedeutet: der letzte Poll/Refresh/Auth-Schritt ist fehlgeschlagen.
 * `message` ist optional und dient nur dem Log (HomeKit zeigt keinen Text).
 */
export interface PlatformHealth {
  /** true = letzter Poll/Refresh/Auth erfolgreich, false = fehlgeschlagen. */
  ok: boolean;
  /** Optionale Fehlermeldung (nur fürs Log). */
  message?: string;
}

/** Rückgabe von {@link createWatchdog}: DomainModule-konformes `update` + Health-Kanal. */
export interface Watchdog {
  /** Aktualisiert die Daten-Aktualität aus dem VehicleState (DomainModule-Apply-Signatur). */
  update: (state: VehicleState) => void;
  /** Meldet das Plattform-Health (Verbindungs-/Auth-Wächter). Bei JEDEM Zyklus aufrufen. */
  setHealth: (health: PlatformHealth) => void;
}

/**
 * Reine Veraltet-Prüfung (isoliert testbar, keine HomeKit-/HTTP-Abhängigkeit).
 *
 * @param dataTimestamp ms seit Epoch des letzten Datenstands (oder undefined).
 * @param staleMinutes  Schwelle in Minuten.
 * @param nowMs         „Jetzt" in ms seit Epoch.
 * @returns `true`, wenn der Zeitstempel fehlt ODER älter als `staleMinutes` ist.
 */
export function isStale(
  dataTimestamp: number | undefined,
  staleMinutes: number,
  nowMs: number,
): boolean {
  if (dataTimestamp === undefined || !Number.isFinite(dataTimestamp)) {
    return true;
  }
  return nowMs - dataTimestamp > staleMinutes * 60000;
}

/**
 * Baut die Wächter-Sensoren am geteilten „Taycan Status"-Accessory auf.
 *
 * @param kit Accessory-Toolkit der Plattform.
 * @param now Zeitquelle (DI für Tests); Default `Date.now`.
 */
export function createWatchdog(kit: Kit, now: () => number = Date.now): Watchdog {
  const { hap, log, config } = kit;
  const Characteristic = hap.Characteristic;

  // 'full' = komplettes Cockpit (bisheriges Verhalten 1:1); 'essential' = nur
  // die wirklich genutzten Kacheln. Der Daten-Aktualität-Sensor ist gegatet.
  const full = config.detailLevel === 'full';

  // --- 1) Verbindungs-/Auth-Wächter: ContactSensor + StatusFault (eig. Acc) --
  // ESSENTIELL — wird immer angelegt (egal welcher detailLevel).
  const connAcc: PlatformAccessory = kit.accessory(
    CONNECTION_ACCESSORY_SEED,
    `${config.vehicleName} Verbindung`,
  );
  const connBound = kit.contactSensor(connAcc, `${config.vehicleName} Verbindung`, 'connection', {
    fault: true,
  });
  const connService = connBound.service;
  // StatusFault wurde durch { fault: true } sichergestellt — defensiv nochmals prüfen.
  if (!connService.testCharacteristic(Characteristic.StatusFault)) {
    connService.addCharacteristic(Characteristic.StatusFault);
  }
  const connFaultChar = connService.getCharacteristic(Characteristic.StatusFault);

  // --- 2) Daten-Aktualität: ContactSensor + StatusActive (eigenes Accessory) -
  // GEGATET — nur im 'full'-Modus. Sonst bleiben die Variablen undefined.
  let freshBound: ReturnType<Kit['contactSensor']> | undefined;
  let freshActiveChar:
    | ReturnType<ReturnType<Kit['contactSensor']>['service']['getCharacteristic']>
    | undefined;
  if (full) {
    const freshAcc: PlatformAccessory = kit.accessory(
      FRESHNESS_ACCESSORY_SEED,
      `${config.vehicleName} Daten aktuell`,
    );
    freshBound = kit.contactSensor(freshAcc, `${config.vehicleName} Daten aktuell`, 'freshness');
    const freshService = freshBound.service;
    if (!freshService.testCharacteristic(Characteristic.StatusActive)) {
      freshService.addCharacteristic(Characteristic.StatusActive);
    }
    freshActiveChar = freshService.getCharacteristic(Characteristic.StatusActive);
  }

  const setHealth = (health: PlatformHealth): void => {
    const ok = health.ok === true;
    // ContactSensor: false=ok=DETECTED(0), true=Warnung=NOT_DETECTED(1).
    connBound.update(!ok);
    connFaultChar.updateValue(
      ok
        ? Characteristic.StatusFault.NO_FAULT
        : Characteristic.StatusFault.GENERAL_FAULT,
    );
    if (!ok) {
      log.warn(`Taycan Status: Verbindung gestört${health.message ? ` (${health.message})` : ''}`);
    }
  };

  const update = (state: VehicleState): void => {
    const stale = isStale(state.dataTimestamp, config.staleMinutes, now());
    // GEGATET: nur im 'full'-Modus existiert der Daten-Aktualität-Sensor. Im
    // 'essential'-Modus bleiben freshBound/freshActiveChar undefined → guarden.
    // ContactSensor: stale → Warnung → NOT_DETECTED(1); frisch → DETECTED(0).
    freshBound?.update(stale);
    // StatusActive: true = Werte aktuell/gültig, false = veraltet.
    freshActiveChar?.updateValue(!stale);
  };

  return { update, setHealth };
}
