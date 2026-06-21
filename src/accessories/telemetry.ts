/**
 * Domänen-Modul „Telemetrie": die beiden rein lesenden Status-Accessories des
 * Taycan-Cockpits — Reifen und Fahrzeug-Status.
 *
 * Folgt dem {@link DomainModule}-Muster: nimmt das {@link Kit}, hängt seine
 * Services über die Kit-Fabriken an zwei PlatformAccessories und liefert eine
 * `update(state)`-Closure, die alle Characteristics aus dem {@link VehicleState}
 * aktualisiert.
 *
 * Dieses Modul ist READ-ONLY: alle Werte sind Sensoren, es gibt keine
 * steuerbaren Characteristics, daher KEIN `onSet` und KEIN `kit.command`. Die
 * Befehls-/Schalt-Accessories („Taycan", „Taycan Öffnungen") sind eigene Module.
 *
 * Accessories:
 * - **„Taycan Reifen"**: 4 Reifendrücke (TemperatureSensor, bar), 4
 *   Reifen-Warnungen (ContactSensor + StatusFault), 1 Sammel-Warnung.
 * - **„Taycan Status"**: km-Stand & Service-km (LightSensor), Service-Warnung
 *   (ContactSensor + StatusFault), Auto-zuhause (OccupancySensor), Distanz-zuhause
 *   in m & Heading in ° (LightSensor), Handbremse / Parklicht / Privacy /
 *   Remote-Access (ContactSensor), Daten-Aktualität (ContactSensor + StatusFault).
 *
 * HomeKit-Mapping siehe kit.ts. ContactSensor: 0=zu/ok, 1=offen/Warnung. Für
 * `{fault:true}`-Sensoren legt das Kit nur die StatusFault-Characteristic an —
 * den Wert setzt dieses Modul selbst (siehe {@link setFault}).
 */

import type { Service } from 'homebridge';

import type { PlatformAccessory } from 'homebridge';

import { isCarHome, distanceMeters, tireWarn } from './helpers';
import type { BoundService, ContactSensorOpts, DomainModule, Kit } from './kit';
import type { Corners, VehicleState } from '../api/measurements';

/**
 * Stabile Seed-Namen — EIN Accessory pro Sensor (eigene beschriftete Kachel).
 * Stabil (kein Datum/Zufall) → Cache-Matching + Orphan-Cleanup über Neustarts.
 */
const SEEDS = {
  // Reifen
  pressFl: 'taycan-tire-fl',
  pressFr: 'taycan-tire-fr',
  pressRl: 'taycan-tire-rl',
  pressRr: 'taycan-tire-rr',
  warnFl: 'taycan-tire-warn-fl',
  warnFr: 'taycan-tire-warn-fr',
  warnRl: 'taycan-tire-warn-rl',
  warnRr: 'taycan-tire-warn-rr',
  warnAny: 'taycan-tire-warn',
  // Status
  odometer: 'taycan-odometer',
  serviceKm: 'taycan-service-km',
  serviceWarn: 'taycan-service-warn',
  carHome: 'taycan-car-home',
  distHome: 'taycan-dist-home',
  heading: 'taycan-heading',
  parkingBrake: 'taycan-parking-brake',
  parkingLight: 'taycan-parking-light',
  privacy: 'taycan-privacy',
  remote: 'taycan-remote-access',
  dataStale: 'taycan-data-stale',
} as const;

/**
 * Setzt die StatusFault-Characteristic eines `{fault:true}`-ContactSensors.
 *
 * Das Kit legt die Characteristic an, aktualisiert sie aber nie selbst — daher
 * spiegeln wir hier den Warn-Zustand explizit (GENERAL_FAULT bzw. NO_FAULT).
 */
function setFault(kit: Kit, svc: Service, warn: boolean): void {
  const StatusFault = kit.hap.Characteristic.StatusFault;
  if (svc.testCharacteristic(StatusFault)) {
    svc
      .getCharacteristic(StatusFault)
      .updateValue(warn ? StatusFault.GENERAL_FAULT : StatusFault.NO_FAULT);
  }
}

/**
 * Aktualisiert einen Warn-ContactSensor inkl. seiner StatusFault-Characteristic.
 *
 * Toleriert `undefined` (gegateter Sensor im 'essential'-Modus nicht angelegt):
 * dann No-op. Im 'full'-Modus ist `bound` immer definiert → identisches Verhalten.
 */
function updateWarn(kit: Kit, bound: BoundService | undefined, warn: boolean): void {
  if (!bound) {
    return;
  }
  bound.update(warn);
  setFault(kit, bound.service, warn);
}

/**
 * Liest einen Eck-Wert defensiv aus einem Corners<T>-Objekt.
 * `undefined`, wenn das Corners-Objekt selbst fehlt.
 */
function corner<T>(c: Corners<T> | undefined, key: keyof Corners<T>): T | undefined {
  return c ? c[key] : undefined;
}

/**
 * Das Telemetrie-Modul. Baut die beiden Status-Accessories auf und liefert die
 * Apply-Funktion zurück, die bei jedem Poll mit dem frischen State läuft.
 */
export const telemetryModule: DomainModule = (kit: Kit) => {
  const { config } = kit;
  const displayName = config.vehicleName;

  // Jeder Sensor lebt auf SEINEM EIGENEN Accessory (eigene Kachel). Die
  // Kit-Factory-Signaturen bleiben unverändert — wir übergeben nur pro Service
  // ein frisches Accessory (seed→stabile UUID, name→Kachel-Beschriftung).
  const sensor = (
    factory: (acc: PlatformAccessory, name: string, subtype: string) => BoundService,
    seed: string,
    name: string,
    subtype: string,
  ): BoundService => factory(kit.accessory(seed, name), name, subtype);

  const contact = (
    seed: string,
    name: string,
    subtype: string,
    opts?: ContactSensorOpts,
  ): BoundService => kit.contactSensor(kit.accessory(seed, name), name, subtype, opts);

  const fault: ContactSensorOpts = { fault: true };

  // detailLevel === 'full' → das komplette Status-/Reifen-Cockpit (bisheriges
  // Verhalten, 1:1 erhalten). 'essential' → NUR „Auto zuhause". Alle anderen
  // Sensoren sind dann `undefined` und werden nicht angelegt.
  const full = config.detailLevel === 'full';

  // === Reifen: 4 Drücke + 4 Warnungen + Sammel-Warnung (gegatet) =============
  // Vier Reifendrücke (bar → TemperatureSensor, erlaubt Dezimal).
  const pressFl = full ? sensor(kit.tempSensor, SEEDS.pressFl, `${displayName} ${kit.labels.tirePressureFrontLeft}`, 'tire-press-fl') : undefined;
  const pressFr = full ? sensor(kit.tempSensor, SEEDS.pressFr, `${displayName} ${kit.labels.tirePressureFrontRight}`, 'tire-press-fr') : undefined;
  const pressRl = full ? sensor(kit.tempSensor, SEEDS.pressRl, `${displayName} ${kit.labels.tirePressureRearLeft}`, 'tire-press-rl') : undefined;
  const pressRr = full ? sensor(kit.tempSensor, SEEDS.pressRr, `${displayName} ${kit.labels.tirePressureRearRight}`, 'tire-press-rr') : undefined;

  // Vier Reifen-Warnungen (ContactSensor + StatusFault), Schwelle = tireDiffThreshold.
  const warnFl = full ? contact(SEEDS.warnFl, `${displayName} ${kit.labels.tireWarningFrontLeft}`, 'tire-warn-fl', fault) : undefined;
  const warnFr = full ? contact(SEEDS.warnFr, `${displayName} ${kit.labels.tireWarningFrontRight}`, 'tire-warn-fr', fault) : undefined;
  const warnRl = full ? contact(SEEDS.warnRl, `${displayName} ${kit.labels.tireWarningRearLeft}`, 'tire-warn-rl', fault) : undefined;
  const warnRr = full ? contact(SEEDS.warnRr, `${displayName} ${kit.labels.tireWarningRearRight}`, 'tire-warn-rr', fault) : undefined;

  // Sammel-Warnung über alle vier Reifen.
  const warnTires = full ? contact(SEEDS.warnAny, `${displayName} ${kit.labels.tireWarning}`, 'tire-warn-any', fault) : undefined;

  // === Status: km/Service/Position/diskrete Zustände/Aktualität ==============
  // km-Stand & Service-Reststrecke (km, >1 → LightSensor). Gegatet.
  const odometer = full ? sensor(kit.luxSensor, SEEDS.odometer, `${displayName} ${kit.labels.odometer}`, 'odometer') : undefined;
  const serviceKm = full ? sensor(kit.luxSensor, SEEDS.serviceKm, `${displayName} ${kit.labels.serviceInKm}`, 'service-km') : undefined;

  // Service-Warnung (ContactSensor + StatusFault), wenn Reststrecke ≤ serviceWarnKm. Gegatet.
  const warnService = full ? contact(SEEDS.serviceWarn, `${displayName} ${kit.labels.serviceWarning}`, 'service-warn', fault) : undefined;

  // Auto-zuhause (OccupancySensor) — ESSENTIELL, wird IMMER angelegt.
  const carHome = sensor(kit.occupancySensor, SEEDS.carHome, `${displayName} ${kit.labels.carAtHome}`, 'car-home');
  // Distanz-zuhause in m (LightSensor). Gegatet.
  const distHome = full ? sensor(kit.luxSensor, SEEDS.distHome, `${displayName} ${kit.labels.distanceHome}`, 'dist-home') : undefined;

  // Heading 0–360° (LightSensor). Gegatet.
  const heading = full ? sensor(kit.luxSensor, SEEDS.heading, `${displayName} ${kit.labels.heading}`, 'heading') : undefined;

  // Diskrete Zustände (ContactSensor, true → NOT_DETECTED). Gegatet.
  const parkingBrake = full ? contact(SEEDS.parkingBrake, `${displayName} ${kit.labels.parkingBrake}`, 'parking-brake') : undefined;
  const parkingLight = full ? contact(SEEDS.parkingLight, `${displayName} ${kit.labels.parkingLight}`, 'parking-light') : undefined;
  const privacy = full ? contact(SEEDS.privacy, `${displayName} ${kit.labels.privacyMode}`, 'privacy') : undefined;
  const remote = full ? contact(SEEDS.remote, `${displayName} ${kit.labels.remoteAccess}`, 'remote-access') : undefined;

  // Daten-Aktualität (ContactSensor + StatusFault): Warnung, wenn Daten zu alt. Gegatet.
  const dataStale = full ? contact(SEEDS.dataStale, `${displayName} ${kit.labels.dataStale}`, 'data-stale', fault) : undefined;

  // === Apply-Funktion =======================================================
  return (state: VehicleState): void => {
    // --- Reifendrücke -------------------------------------------------------
    // Fehlt der Wert, lassen wir die letzte Anzeige stehen (kein 0-Sprung).
    const pFl = corner(state.tirePressureBar, 'fl');
    const pFr = corner(state.tirePressureBar, 'fr');
    const pRl = corner(state.tirePressureBar, 'rl');
    const pRr = corner(state.tirePressureBar, 'rr');
    if (pFl !== undefined) {
      pressFl?.update(pFl);
    }
    if (pFr !== undefined) {
      pressFr?.update(pFr);
    }
    if (pRl !== undefined) {
      pressRl?.update(pRl);
    }
    if (pRr !== undefined) {
      pressRr?.update(pRr);
    }

    // --- Reifen-Warnungen (Schwelle: tireDiffThreshold) ---------------------
    const wFl = tireWarn(corner(state.tireDiffBar, 'fl'), config.tireDiffThreshold);
    const wFr = tireWarn(corner(state.tireDiffBar, 'fr'), config.tireDiffThreshold);
    const wRl = tireWarn(corner(state.tireDiffBar, 'rl'), config.tireDiffThreshold);
    const wRr = tireWarn(corner(state.tireDiffBar, 'rr'), config.tireDiffThreshold);
    updateWarn(kit, warnFl, wFl);
    updateWarn(kit, warnFr, wFr);
    updateWarn(kit, warnRl, wRl);
    updateWarn(kit, warnRr, wRr);
    updateWarn(kit, warnTires, wFl || wFr || wRl || wRr);

    // --- km-Stand / Service -------------------------------------------------
    if (state.odometerKm !== undefined) {
      odometer?.update(state.odometerKm);
    }
    if (state.serviceKm !== undefined) {
      serviceKm?.update(state.serviceKm);
    }
    const serviceWarn = state.serviceKm !== undefined && state.serviceKm <= config.serviceWarnKm;
    updateWarn(kit, warnService, serviceWarn);

    // --- Position / Zuhause -------------------------------------------------
    const home = isCarHome(state, config.homeLat, config.homeLon, config.homeRadiusM);
    carHome.update(home); // ESSENTIELL: immer angelegt, immer aktualisiert.
    // Distanz nur berechnen, wenn alle Koordinaten vorliegen (sonst Anzeige halten).
    if (state.lat !== undefined && state.lon !== undefined) {
      distHome?.update(distanceMeters(state.lat, state.lon, config.homeLat, config.homeLon));
    }
    if (state.heading !== undefined) {
      heading?.update(state.heading);
    }

    // --- Diskrete Zustände (undefined → keine Warnung) ----------------------
    parkingBrake?.update(state.parkingBrake === true);
    parkingLight?.update(state.parkingLight === true);
    privacy?.update(state.privacyMode === true);
    remote?.update(state.remoteAccess === true);

    // --- Daten-Aktualität ---------------------------------------------------
    // Warnung, wenn ein Zeitstempel vorliegt und älter als staleMinutes ist.
    const stale =
      state.dataTimestamp !== undefined &&
      Date.now() - state.dataTimestamp > config.staleMinutes * 60000;
    updateWarn(kit, dataStale, stale);
  };
};

export default telemetryModule;
