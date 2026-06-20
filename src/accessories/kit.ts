/**
 * Accessory-Toolkit für das Taycan-Cockpit.
 *
 * Ein {@link Kit} bündelt alles, was ein Domänen-Modul ({@link DomainModule})
 * braucht, um Services an PlatformAccessories zu hängen: HAP-Konstruktoren,
 * Logger, aufgelöste Config, eine `command`-Funktion zum Senden von Befehlen,
 * sowie `accessory()` (get-or-create + Registrierung). Dazu kommen Fabriken für
 * die wiederkehrenden Service-Typen, die jeweils eine `update(value)`-Closure
 * zurückliefern — so trennen die Domänen-Module „Service bauen" von „Wert setzen".
 *
 * HomeKit-Mapping (Stock Apple Home), siehe Spec:
 * - SoC/Ziel-SoC (0–100 ganzzahlig) → HumiditySensor (percentSensor)
 * - Reichweite/km/kW/Restminuten/Distanz/Heading (>1) → LightSensor (luxSensor, MIN 0.0001)
 * - Reifendruck bar / Laderate km/min (Dezimal) → TemperatureSensor (tempSensor)
 * - Offen-Zustände / Lade-Flag / Warnungen → ContactSensor (+ optional StatusFault)
 * - Auto-zuhause → OccupancySensor
 */

import type {
  API,
  Characteristic,
  CharacteristicValue,
  HAP,
  Logging,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';

import { PorscheCommand } from '../api/commands';
import { VehicleState } from '../api/measurements';

/** npm-Paketname — erster Parameter von `registerPlatformAccessories` (Cache-Matching!). */
export const PLUGIN_NAME = 'homebridge-taycan';
/** Plattform-Name (muss zur `index.ts`-Registrierung und config.json passen). */
export const PLATFORM_NAME = 'Taycan';

/** Untere Klemme für LightSensor-Werte (Characteristic erlaubt 0 nicht). */
const LUX_MIN = 0.0001;

/**
 * Vollständig aufgelöste Plugin-Konfiguration mit allen Defaults aus dem Spec.
 * Domänen-Module lesen ausschließlich diese (nie das rohe PlatformConfig).
 */
export interface ResolvedTaycanConfig {
  /** Anzeigename-Präfix der Accessory-Gruppen (z. B. "Taycan"). */
  vehicleName: string;
  /** Optionale feste VIN; leer = erstes Fahrzeug des Kontos. */
  vin?: string;
  /**
   * Detailgrad der exponierten Accessories:
   * - 'essential' (Default): nur die wenigen wirklich genutzten Kacheln
   *   (Standklima, Ladestand, Reichweite, Laden, Schloss, „offen?",
   *   Auto-zuhause, Verbindung).
   * - 'full': das komplette Cockpit (alle ~55 Kacheln inkl. Reifen, Service,
   *   Klimazonen, Einzeltüren, Diagnose usw.).
   * Nicht mehr genutzte Accessories entfernt der Orphan-Cleanup beim Neustart.
   */
  detailLevel: 'essential' | 'full';
  /**
   * Porsche S-PIN (4-stellige Sicherheits-PIN aus der My-Porsche-App), nötig
   * fürs ENTRIEGELN (SPIN_CHALLENGE → UNLOCK). Leer = Entriegeln deaktiviert
   * (Schloss kann dann nur verriegeln). Wird im Klartext in der Config gehalten.
   */
  spin?: string;
  /** Poll-Intervall in Minuten (≥10, 12V-Schutz). */
  pollIntervalMinutes: number;
  /** Heim-Koordinaten + Radius für „Auto zuhause". */
  homeLat: number;
  homeLon: number;
  homeRadiusM: number;
  /** Klima-Darstellung: 'heatercooler' | 'switch' | 'both'. */
  climateControlMode: 'heatercooler' | 'switch' | 'both';
  /** Default-Zieltemperatur der Vorklimatisierung in °C. */
  defaultTargetTemp: number;
  /** Grenzen/Schrittweite für die Ziel-Temperatur (HeaterCooler). */
  tempMin: number;
  tempMax: number;
  tempStep: number;
  /** Schwelle für „Batterie niedrig" in % (StatusLowBattery). */
  lowBatteryThreshold: number;
  /** Service-Warnung, wenn Reststrecke ≤ diesem Wert in km. */
  serviceWarnKm: number;
  /** Reifendruck-Warnschwelle (Betrag der Differenz) in bar. */
  tireDiffThreshold: number;
  /** Daten gelten als veraltet, wenn älter als so viele Minuten. */
  staleMinutes: number;
  /** Auto-Off-Timer der Standheizung in Minuten. */
  heatingAutoOffMinutes: number;
  /** Auto-Off-Timer von Hupe/Licht in Sekunden. */
  honkAutoOffSeconds: number;
  /** Klimazonen-Sensoren exponieren? */
  exposeClimateZones: boolean;
  /** Diebstahl-/Theft-Sensor exponieren? */
  exposeTheftSensor: boolean;
}

/** Defaults. Heim-Koordinaten 0 = „Auto zuhause" deaktiviert (in der Config setzen). */
export const DEFAULT_CONFIG: ResolvedTaycanConfig = {
  vehicleName: 'Taycan',
  vin: undefined,
  detailLevel: 'essential',
  spin: undefined,
  pollIntervalMinutes: 15,
  homeLat: 0,
  homeLon: 0,
  homeRadiusM: 150,
  climateControlMode: 'both',
  defaultTargetTemp: 21,
  tempMin: 15,
  tempMax: 30,
  tempStep: 0.5,
  lowBatteryThreshold: 20,
  serviceWarnKm: 2000,
  tireDiffThreshold: 0.3,
  staleMinutes: 30,
  heatingAutoOffMinutes: 15,
  honkAutoOffSeconds: 3,
  exposeClimateZones: true,
  exposeTheftSensor: false,
};

/**
 * Löst ein rohes Plugin-Config-Objekt zu einer {@link ResolvedTaycanConfig} auf.
 * Fehlende/ungültige Werte fallen auf {@link DEFAULT_CONFIG} zurück. Das
 * Poll-Intervall wird HIER NICHT geklemmt (das macht der Aufrufer via wake.ts).
 */
export function resolveConfig(raw: Record<string, unknown> | undefined | null): ResolvedTaycanConfig {
  const c = raw ?? {};
  const numOr = (key: string, dflt: number): number => {
    const v = c[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  };
  const boolOr = (key: string, dflt: boolean): boolean => {
    const v = c[key];
    return typeof v === 'boolean' ? v : dflt;
  };
  const strOr = (key: string, dflt: string): string => {
    const v = c[key];
    return typeof v === 'string' && v.length > 0 ? v : dflt;
  };

  const modeRaw = c['climateControlMode'];
  const climateControlMode: ResolvedTaycanConfig['climateControlMode'] =
    modeRaw === 'heatercooler' || modeRaw === 'switch' || modeRaw === 'both'
      ? modeRaw
      : DEFAULT_CONFIG.climateControlMode;

  const vinRaw = c['vin'];
  const vin = typeof vinRaw === 'string' && vinRaw.length > 0 ? vinRaw : undefined;

  const detailRaw = c['detailLevel'];
  const detailLevel: ResolvedTaycanConfig['detailLevel'] =
    detailRaw === 'full' || detailRaw === 'essential' ? detailRaw : DEFAULT_CONFIG.detailLevel;

  // S-PIN: nur nicht-leere Strings übernehmen (auf Ziffern reduzieren wäre zu
  // streng — manche PINs könnten anders aussehen; Trim reicht).
  const spinRaw = c['spin'];
  const spin = typeof spinRaw === 'string' && spinRaw.trim().length > 0 ? spinRaw.trim() : undefined;

  return {
    vehicleName: strOr('vehicleName', DEFAULT_CONFIG.vehicleName),
    vin,
    detailLevel,
    spin,
    pollIntervalMinutes: numOr('pollIntervalMinutes', DEFAULT_CONFIG.pollIntervalMinutes),
    homeLat: numOr('homeLat', DEFAULT_CONFIG.homeLat),
    homeLon: numOr('homeLon', DEFAULT_CONFIG.homeLon),
    homeRadiusM: numOr('homeRadiusM', DEFAULT_CONFIG.homeRadiusM),
    climateControlMode,
    defaultTargetTemp: numOr('defaultTargetTemp', DEFAULT_CONFIG.defaultTargetTemp),
    tempMin: numOr('tempMin', DEFAULT_CONFIG.tempMin),
    tempMax: numOr('tempMax', DEFAULT_CONFIG.tempMax),
    tempStep: numOr('tempStep', DEFAULT_CONFIG.tempStep),
    lowBatteryThreshold: numOr('lowBatteryThreshold', DEFAULT_CONFIG.lowBatteryThreshold),
    serviceWarnKm: numOr('serviceWarnKm', DEFAULT_CONFIG.serviceWarnKm),
    tireDiffThreshold: numOr('tireDiffThreshold', DEFAULT_CONFIG.tireDiffThreshold),
    staleMinutes: numOr('staleMinutes', DEFAULT_CONFIG.staleMinutes),
    heatingAutoOffMinutes: numOr('heatingAutoOffMinutes', DEFAULT_CONFIG.heatingAutoOffMinutes),
    honkAutoOffSeconds: numOr('honkAutoOffSeconds', DEFAULT_CONFIG.honkAutoOffSeconds),
    exposeClimateZones: boolOr('exposeClimateZones', DEFAULT_CONFIG.exposeClimateZones),
    exposeTheftSensor: boolOr('exposeTheftSensor', DEFAULT_CONFIG.exposeTheftSensor),
  };
}

/** Optionen für {@link Kit.contactSensor}. */
export interface ContactSensorOpts {
  /** Wenn true, wird zusätzlich eine StatusFault-Characteristic angelegt. */
  fault?: boolean;
}

/** Optionen für {@link Kit.switchService}. */
export interface SwitchServiceOpts {
  /** Wird beim Setzen von On aufgerufen (true=ein, false=aus). */
  onSet: (on: boolean) => void | Promise<void>;
  /**
   * Wenn gesetzt, ist der Switch „momentan": nach `momentaryMs` schaltet er
   * automatisch auf aus zurück (Hupe/Licht/Heizung). `onSet` wird bei JEDER
   * Flanke (true UND false) aufgerufen — der Modul-Autor muss `onSet(false)`
   * selbst ignorieren, falls nur die Einschalt-Flanke relevant ist.
   */
  momentaryMs?: number;
}

/** Eine an einen Service gebundene Update-Closure plus Service-Referenz. */
export interface BoundService {
  service: Service;
  update: (value: number | boolean) => void;
}

/** Ein Switch mit zusätzlicher `setOn`-Closure (für momentary-Reset von außen). */
export interface BoundSwitch {
  service: Service;
  update: (on: boolean) => void;
}

/**
 * Das Toolkit, das Domänen-Module nutzen. Wird einmal pro Plattform gebaut und
 * an alle Module gereicht.
 */
export interface Kit {
  /** HAP-Namespace (Service + Characteristic + uuid). */
  hap: HAP;
  /** Homebridge-Logger. */
  log: Logging;
  /** Aufgelöste Konfiguration mit Defaults. */
  config: ResolvedTaycanConfig;
  /** Sendet einen Fahrzeugbefehl (defensiv, niemals throw nach außen). */
  command: (cmd: PorscheCommand) => Promise<void>;
  /**
   * Entriegelt das Fahrzeug über den S-PIN-Challenge-Flow (SPIN_CHALLENGE →
   * UNLOCK). Wirft, wenn keine S-PIN konfiguriert ist oder der Flow scheitert —
   * der Aufrufer (Schloss) fängt das ab und setzt den Target zurück.
   */
  unlock: () => Promise<void>;

  /**
   * Setzt Name UND ConfiguredName eines Service. Stock Apple Home beschriftet
   * Unter-Services NUR über ConfiguredName — ohne erben alle den Accessory-Namen.
   * Module MÜSSEN das für jeden direkt erzeugten Service aufrufen.
   */
  nameService: (svc: Service, name: string) => void;

  /**
   * Get-or-create eines PlatformAccessory anhand eines stabilen Seed-Namens.
   * Neue Accessories werden via `registerPlatformAccessories` registriert,
   * gecachte werden gematcht. UUID = uuid.generate(seedName).
   */
  accessory: (seedName: string, displayName: string) => PlatformAccessory;

  // --- Service-Fabriken: jeweils Service anhängen + update()-Closure ---------
  /** HumiditySensor für ganzzahlige Prozente (SoC, Ziel-SoC). */
  percentSensor: (acc: PlatformAccessory, name: string, subtype: string) => BoundService;
  /** LightSensor für Werte >1 (km, kW, Minuten, Meter, Heading); min 0.0001. */
  luxSensor: (acc: PlatformAccessory, name: string, subtype: string) => BoundService;
  /** TemperatureSensor für Dezimalwerte (bar, km/min). */
  tempSensor: (acc: PlatformAccessory, name: string, subtype: string) => BoundService;
  /** ContactSensor (0=zu/ok, 1=offen/Warnung); optional mit StatusFault. */
  contactSensor: (
    acc: PlatformAccessory,
    name: string,
    subtype: string,
    opts?: ContactSensorOpts,
  ) => BoundService;
  /** OccupancySensor (z. B. „Auto zuhause"). */
  occupancySensor: (acc: PlatformAccessory, name: string, subtype: string) => BoundService;
  /** Switch mit onSet-Handler und optionalem momentary-Auto-Off. */
  switchService: (
    acc: PlatformAccessory,
    name: string,
    subtype: string,
    opts: SwitchServiceOpts,
  ) => BoundSwitch;
}

/** Ein Domänen-Modul: baut Services am Kit auf und liefert eine Apply-Funktion. */
export type DomainModule = (kit: Kit) => (state: VehicleState) => void;

/** Interner Kontext, den {@link createKit} braucht (DI für Tests). */
export interface KitContext {
  api: API;
  log: Logging;
  config: ResolvedTaycanConfig;
  /** Aus dem Cache wiederhergestellte Accessories (DynamicPlatform). */
  cachedAccessories: PlatformAccessory[];
  /** Sendet einen Fahrzeugbefehl (von der Plattform bereitgestellt). */
  command: (cmd: PorscheCommand) => Promise<void>;
  /** Entriegelt via S-PIN-Challenge-Flow (von der Plattform bereitgestellt). */
  unlock: () => Promise<void>;
}

/**
 * Baut ein {@link Kit} aus dem {@link KitContext}.
 *
 * Verwaltet ein internes Set neu erzeugter Accessories; `registerNewAccessories()`
 * registriert sie gesammelt bei Homebridge (der Aufrufer ruft das nach dem
 * Modul-Setup auf — ein einziger `registerPlatformAccessories`-Call).
 */
export function createKit(ctx: KitContext): {
  kit: Kit;
  registerNewAccessories: () => void;
  /**
   * UUIDs aller Accessories, die in dieser Session über `accessory()` angefordert
   * wurden (Cache-Treffer ODER neu erzeugt). Die Plattform nutzt dieses Set, um
   * verwaiste gecachte Accessories (nie angefordert) sauber zu entfernen.
   */
  touchedUuids: Set<string>;
} {
  const { api, log, config } = ctx;
  const hap = api.hap;
  const Service = hap.Service;
  const Characteristic = hap.Characteristic;

  /** Accessories, die in dieser Session erzeugt (nicht aus Cache geladen) wurden. */
  const newAccessories: PlatformAccessory[] = [];
  /** Alle aktuell „lebenden" Accessories (Cache + neu), per UUID. */
  const live = new Map<string, PlatformAccessory>();
  for (const a of ctx.cachedAccessories) {
    live.set(a.UUID, a);
  }
  /** UUIDs, die in dieser Session tatsächlich angefordert wurden (für Orphan-Cleanup). */
  const touchedUuids = new Set<string>();

  const accessory = (seedName: string, displayName: string): PlatformAccessory => {
    const uuid = hap.uuid.generate(seedName);
    touchedUuids.add(uuid);
    const existing = live.get(uuid);
    if (existing) {
      // Anzeigename aktualisieren (falls Spec sich änderte), AccessoryInformation sicherstellen.
      ensureInfo(existing, displayName, seedName);
      return existing;
    }
    const acc = new api.platformAccessory(displayName, uuid);
    ensureInfo(acc, displayName, seedName);
    live.set(uuid, acc);
    newAccessories.push(acc);
    return acc;
  };

  function ensureInfo(acc: PlatformAccessory, displayName: string, seedName: string): void {
    const info =
      acc.getService(Service.AccessoryInformation) ??
      acc.addService(Service.AccessoryInformation);
    // SerialNumber MUSS pro Accessory eindeutig sein. Bei „ein Accessory pro
    // Service" teilen sich sonst ~55 Accessories denselben VIN-Serial — Stock
    // Apple Home würde sie dann zu EINER Kachel zusammenfassen (genau das, was
    // dieser Aufbau vermeiden will). Darum den stabilen Seed in den Serial
    // mischen (mit VIN-Präfix, falls vorhanden), so bleibt er eindeutig+stabil.
    const serial = config.vin ? `${config.vin}-${seedName}` : seedName;
    info
      .setCharacteristic(Characteristic.Manufacturer, 'Porsche')
      .setCharacteristic(Characteristic.Model, 'Taycan')
      .setCharacteristic(Characteristic.Name, displayName)
      .setCharacteristic(Characteristic.SerialNumber, serial);
  }

  /**
   * Setzt Name UND ConfiguredName. Stock Apple Home nutzt ConfiguredName fürs
   * Label von Unter-Services; ohne erben alle den Accessory-Namen ("Taycan").
   */
  const nameService = (svc: Service, name: string): void => {
    if (!svc.testCharacteristic(Characteristic.Name)) {
      svc.addCharacteristic(Characteristic.Name);
    }
    svc.getCharacteristic(Characteristic.Name).updateValue(name);
    if (!svc.testCharacteristic(Characteristic.ConfiguredName)) {
      svc.addCharacteristic(Characteristic.ConfiguredName);
    }
    svc.getCharacteristic(Characteristic.ConfiguredName).updateValue(name);
  };

  /** Get-or-create eines Service per Konstruktor + Subtyp; setzt Name + ConfiguredName. */
  function getOrAddService(
    acc: PlatformAccessory,
    ctor: WithUUID<typeof Service>,
    name: string,
    subtype: string,
  ): Service {
    const svc =
      acc.getServiceById(ctor, subtype) ?? acc.addService(ctor, name, subtype);
    nameService(svc, name);
    return svc;
  }

  const percentSensor = (acc: PlatformAccessory, name: string, subtype: string): BoundService => {
    const svc = getOrAddService(acc, Service.HumiditySensor, name, subtype);
    const char = svc.getCharacteristic(Characteristic.CurrentRelativeHumidity);
    return {
      service: svc,
      update: (value) => {
        const v = Math.max(0, Math.min(100, Math.round(Number(value))));
        char.updateValue(v);
      },
    };
  };

  const luxSensor = (acc: PlatformAccessory, name: string, subtype: string): BoundService => {
    const svc = getOrAddService(acc, Service.LightSensor, name, subtype);
    const char = svc.getCharacteristic(Characteristic.CurrentAmbientLightLevel);
    return {
      service: svc,
      update: (value) => {
        const n = Number(value);
        char.updateValue(Number.isFinite(n) && n > LUX_MIN ? n : LUX_MIN);
      },
    };
  };

  const tempSensor = (acc: PlatformAccessory, name: string, subtype: string): BoundService => {
    const svc = getOrAddService(acc, Service.TemperatureSensor, name, subtype);
    const char = svc.getCharacteristic(Characteristic.CurrentTemperature);
    return {
      service: svc,
      update: (value) => {
        const n = Number(value);
        char.updateValue(Number.isFinite(n) ? n : 0);
      },
    };
  };

  const contactSensor = (
    acc: PlatformAccessory,
    name: string,
    subtype: string,
    opts?: ContactSensorOpts,
  ): BoundService => {
    const svc = getOrAddService(acc, Service.ContactSensor, name, subtype);
    const char = svc.getCharacteristic(Characteristic.ContactSensorState);
    if (opts?.fault) {
      // StatusFault-Characteristic sicherstellen (optionale Char hinzufügen).
      if (!svc.testCharacteristic(Characteristic.StatusFault)) {
        svc.addCharacteristic(Characteristic.StatusFault);
      }
    }
    return {
      service: svc,
      // value true/1 = offen/Warnung = NOT_DETECTED; false/0 = zu/ok = DETECTED.
      update: (value) => {
        const open = value === true || value === 1;
        char.updateValue(
          open
            ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : Characteristic.ContactSensorState.CONTACT_DETECTED,
        );
      },
    };
  };

  const occupancySensor = (acc: PlatformAccessory, name: string, subtype: string): BoundService => {
    const svc = getOrAddService(acc, Service.OccupancySensor, name, subtype);
    const char = svc.getCharacteristic(Characteristic.OccupancyDetected);
    return {
      service: svc,
      update: (value) => {
        const present = value === true || value === 1;
        char.updateValue(
          present
            ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
            : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        );
      },
    };
  };

  const switchService = (
    acc: PlatformAccessory,
    name: string,
    subtype: string,
    opts: SwitchServiceOpts,
  ): BoundSwitch => {
    const svc = getOrAddService(acc, Service.Switch, name, subtype);
    const onChar = svc.getCharacteristic(Characteristic.On);
    let resetTimer: NodeJS.Timeout | undefined;

    onChar.onSet((value: CharacteristicValue) => {
      const on = value === true;
      void Promise.resolve(opts.onSet(on)).catch((err) => {
        log.warn(`${name}: onSet fehlgeschlagen: ${String(err)}`);
      });
      if (opts.momentaryMs !== undefined && on) {
        if (resetTimer) {
          clearTimeout(resetTimer);
        }
        resetTimer = setTimeout(() => {
          onChar.updateValue(false);
        }, opts.momentaryMs);
        if (typeof resetTimer.unref === 'function') {
          resetTimer.unref();
        }
      }
    });

    return {
      service: svc,
      update: (on) => onChar.updateValue(on),
    };
  };

  const kit: Kit = {
    hap,
    log,
    config,
    command: ctx.command,
    unlock: ctx.unlock,
    nameService,
    accessory,
    percentSensor,
    luxSensor,
    tempSensor,
    contactSensor,
    occupancySensor,
    switchService,
  };

  const registerNewAccessories = (): void => {
    if (newAccessories.length > 0) {
      api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessories);
      newAccessories.length = 0;
    }
  };

  return { kit, registerNewAccessories, touchedUuids };
}

/** Re-Export für Convenience (Module brauchen oft beide Typen). */
export type { PorscheCommand } from '../api/commands';
export type { VehicleState } from '../api/measurements';
