/**
 * Domänen-Modul „Laden" für das Taycan-Cockpit.
 *
 * Legt am Accessory „Taycan" alle lade-/batteriebezogenen Services an und liefert
 * eine `update(state)`-Funktion, die deren Characteristics aus dem {@link VehicleState}
 * setzt. Folgt exakt dem {@link DomainModule}-Muster aus {@link kit}.
 *
 * HomeKit-Darstellung (Stock Apple Home), siehe Spec:
 * - SoC (0–100) → HumiditySensor (percentSensor)
 * - Reichweite / Ladeleistung / Max-Ladeleistung / Restzeit (>1, evtl. >100) → LightSensor (luxSensor)
 * - Laderate km/min (Dezimal) → TemperatureSensor (tempSensor)
 * - Lade-Flag / DC-Flag / aktives-Profil-Flag → ContactSensor
 * - Laden an/aus → Switch (DIRECT_CHARGING_START / _STOP)
 * - Ladelimit → Lightbulb (On + Brightness 0–100 = Ziel-SoC → CHARGING_SETTINGS_EDIT)
 * - Batterie → Battery-Service (BatteryLevel=SoC, ChargingState, StatusLowBattery)
 *
 * Der Lightbulb- und der Battery-Service haben im Kit keine Fabrik (sie sind
 * lade-spezifisch), darum werden sie hier direkt über `kit.hap` gebaut. Alle
 * generischen Sensor-/Switch-Typen kommen aus den Kit-Fabriken.
 */

import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { chargingStart, chargingStop, setTargetSoc } from '../api/commands';
import { VehicleState } from '../api/measurements';
import { BoundService, Kit } from './kit';

/**
 * Stabile Seed-Namen — EIN Accessory pro Service. Jeder Seed erzeugt eine
 * eigene, beschriftete Kachel in Stock Apple Home (statt einer Sammel-Kachel).
 * Seeds sind stabil (kein Datum/Zufall) → Cache-Matching + Orphan-Cleanup
 * funktionieren über Neustarts hinweg.
 */
const SEEDS = {
  soc: 'taycan-soc',
  range: 'taycan-range',
  power: 'taycan-charging-power',
  maxPower: 'taycan-max-charging-power',
  eta: 'taycan-charge-eta',
  rate: 'taycan-charge-rate',
  chargingFlag: 'taycan-charging-flag',
  dcFlag: 'taycan-dc-flag',
  profileFlag: 'taycan-charge-profile',
  chargeSwitch: 'taycan-charge-switch',
  chargeLimit: 'taycan-charge-limit',
  battery: 'taycan-battery',
  lowBattery: 'taycan-battery-low',
} as const;

/** Untere Klemme für LightSensor (Characteristic erlaubt 0 nicht). Spiegelt kit.ts. */
const LUX_MIN = 0.0001;

/**
 * Lade-Modul. Baut die Services auf und gibt die Apply-Funktion zurück.
 *
 * Exportierte Signatur entspricht {@link DomainModule}:
 *   `(kit: Kit) => (state: VehicleState) => void`
 */
export function chargingModule(kit: Kit): (state: VehicleState) => void {
  const { config } = kit;
  const displayName = config.vehicleName;
  /** Voll-Cockpit (alle Kacheln) vs. essentiell (nur die genutzten). */
  const full = config.detailLevel === 'full';

  /**
   * Legt einen Sensor an seinem EIGENEN Accessory an: erst ein frisches
   * PlatformAccessory (seed→stabile UUID, name→Kachel-Beschriftung), dann genau
   * diesen einen Service. Kit-Factory-Signatur bleibt unverändert.
   */
  const solo = (
    factory: (acc: PlatformAccessory, name: string, subtype: string) => BoundService,
    seed: string,
    name: string,
    subtype: string,
  ): BoundService => factory(kit.accessory(seed, name), name, subtype);

  // --- Sensoren (je ein eigenes Accessory) ----------------------------------
  // Essentiell (immer): SoC als Schieberegler (Lightbulb-Dimmer, read-only) +
  // Reichweite. Der SoC-Dimmer zeigt den Ladestand direkt als Balken in der
  // Kachel (statt eines Sensor-Symbols, das man erst antippen müsste).
  const soc = makeSocDisplay(
    kit,
    kit.accessory(SEEDS.soc, `${displayName} Ladestand`),
    `${displayName} Ladestand`,
    'soc',
  );
  const range = solo(kit.luxSensor, SEEDS.range, `${displayName} Reichweite`, 'range');
  // Gegatet (nur full): Leistungen, Restzeit, Laderate.
  const power = full ? solo(kit.luxSensor, SEEDS.power, `${displayName} Ladeleistung`, 'chargepower') : undefined;
  const maxPower = full ? solo(kit.luxSensor, SEEDS.maxPower, `${displayName} Max-Ladeleistung`, 'maxchargepower') : undefined;
  const eta = full ? solo(kit.luxSensor, SEEDS.eta, `${displayName} Restzeit Laden`, 'chargeeta') : undefined;
  const rate = full ? solo(kit.tempSensor, SEEDS.rate, `${displayName} Laderate`, 'chargerate') : undefined;

  // Gegatet (nur full): Lade-/DC-/Profil-Flags.
  const chargingFlag = full ? solo(kit.contactSensor, SEEDS.chargingFlag, `${displayName} Lädt`, 'chargingflag') : undefined;
  const dcFlag = full ? solo(kit.contactSensor, SEEDS.dcFlag, `${displayName} DC-Laden`, 'dcflag') : undefined;
  const profileFlag = full ? solo(kit.contactSensor, SEEDS.profileFlag, `${displayName} Ladeprofil aktiv`, 'profileflag') : undefined;

  // --- Laden an/aus (Switch → DIRECT_CHARGING_START / _STOP) ----------------
  const chargeSwitch = kit.switchService(
    kit.accessory(SEEDS.chargeSwitch, `${displayName} Laden`),
    `${displayName} Laden`,
    'chargeswitch',
    {
      onSet: async (on) => {
        await kit.command(on ? chargingStart() : chargingStop());
      },
    },
  );

  // --- Ladelimit (Lightbulb On+Brightness = Ziel-SoC → CHARGING_SETTINGS_EDIT)
  // Essentiell (immer): einmal das Ziel-Ladelimit setzen, schont den Akku.
  const chargeLimit = makeChargeLimit(
    kit,
    kit.accessory(SEEDS.chargeLimit, `${displayName} Ladelimit`),
    `${displayName} Ladelimit`,
    'chargelimit',
  );

  // --- Batterie-Service (eigenes „Taycan Akku"-Accessory, Lade-/Akkustatus) -
  // Essentiell (immer): Batterie-Indikator (zeigt %, lädt/lädt-nicht).
  const battery = makeBattery(kit, kit.accessory(SEEDS.battery, `${displayName} Akku`), `${displayName} Akku`);

  // --- „Akku niedrig"-Alert (ContactSensor) ---------------------------------
  // Essentiell (immer): öffnet (NOT_DETECTED), sobald der Ladestand ≤ Schwelle
  // ist. Als ECHTER Ereignis-Sensor kann Apple Home daran nativ Push-Benach-
  // richtigungen aktivieren („Akku niedrig" → Mitteilung) — ohne Workaround.
  // Der SoC-Dimmer (Lightbulb) taugt dafür NICHT (keine Sensor-Schwelle).
  const lowBattery = solo(
    kit.contactSensor,
    SEEDS.lowBattery,
    `${displayName} Akku niedrig`,
    'batterylow',
  );

  /** Aktualisiert ALLE von diesem Modul angelegten Characteristics aus dem State. */
  return (state: VehicleState): void => {
    // SoC: HumiditySensor + Batterie-Level (Fabrik klemmt/rundet 0..100).
    if (state.soc !== undefined) {
      soc.update(state.soc);
    }

    // Reichweite / Leistungen / Restzeit: LightSensor (Fabrik klemmt auf ≥0.0001).
    if (state.rangeKm !== undefined) {
      range.update(state.rangeKm);
    }
    if (state.chargingPowerKw !== undefined) {
      power?.update(state.chargingPowerKw);
    }
    if (state.maxChargingPowerKw !== undefined) {
      maxPower?.update(state.maxChargingPowerKw);
    }
    if (state.chargeEtaMinutes !== undefined) {
      eta?.update(state.chargeEtaMinutes);
    }

    // Laderate km/min: TemperatureSensor (Dezimal).
    if (state.chargeRateKmMin !== undefined) {
      rate?.update(state.chargeRateKmMin);
    }

    // Flags: ContactSensor (true = NOT_DETECTED = „Warnung/aktiv", false = ok/zu).
    chargingFlag?.update(state.charging === true);
    dcFlag?.update((state.chargingType ?? '').toUpperCase() === 'DC');
    profileFlag?.update(typeof state.activeProfileName === 'string' && state.activeProfileName.length > 0);

    // Laden-Switch spiegelt den realen Lade-Zustand wider.
    chargeSwitch.update(state.charging === true);

    // Ladelimit: On=true wenn ein Ziel-SoC bekannt ist; Brightness=Ziel-SoC.
    chargeLimit.update(state.targetSoc);

    // Batterie: Level + Charging-State + Low-Battery.
    battery.update(state);

    // „Akku niedrig"-Alert: ContactSensor öffnet, sobald SoC ≤ Schwelle. Bei
    // unbekanntem SoC bleibt er geschlossen (kein Fehlalarm).
    lowBattery.update(state.soc !== undefined && state.soc <= config.lowBatteryThreshold);
  };
}

/** Default-Export für den Loader (DomainModule-Signatur). */
export default chargingModule;

// ---------------------------------------------------------------------------
// Lade-spezifische Services ohne Kit-Fabrik (Lightbulb, Battery)
// ---------------------------------------------------------------------------

/** Ein an den State gebundener Updater für den Batterie-Service. */
interface BatteryBinding {
  service: Service;
  update: (state: VehicleState) => void;
}

/** Ein an den Ziel-SoC gebundener Updater für das Ladelimit (Lightbulb). */
interface ChargeLimitBinding {
  service: Service;
  update: (targetSoc: number | undefined) => void;
}

/**
 * Baut den Ladelimit-Service als Lightbulb (On + Brightness 0–100 = Ziel-SoC).
 *
 * - Brightness-onSet → CHARGING_SETTINGS_EDIT{targetSoc} (geklemmt 0..100).
 * - On-onSet false → Lightbulb wieder einschalten (ein „Limit" lässt sich nicht
 *   abschalten; wir spiegeln nur den Wert) + Log; On-onSet true ohne Brightness
 *   tut nichts weiter (Brightness bleibt unverändert).
 */
function makeChargeLimit(
  kit: Kit,
  acc: PlatformAccessory,
  name: string,
  subtype: string,
): ChargeLimitBinding {
  const { hap, log } = kit;
  const Service = hap.Service;
  const Characteristic = hap.Characteristic;

  const svc =
    acc.getServiceById(Service.Lightbulb, subtype) ??
    acc.addService(Service.Lightbulb, name, subtype);
  kit.nameService(svc, name);

  const onChar = svc.getCharacteristic(Characteristic.On);
  const brightnessChar = svc.testCharacteristic(Characteristic.Brightness)
    ? svc.getCharacteristic(Characteristic.Brightness)
    : svc.addCharacteristic(Characteristic.Brightness);

  /** Sendet den (geklemmten) Ziel-SoC ans Fahrzeug. */
  const sendTarget = (value: number): void => {
    const pct = Math.max(0, Math.min(100, Math.round(value)));
    void kit
      .command(setTargetSoc(pct))
      .catch((err) => log.warn(`${name}: setTargetSoc fehlgeschlagen: ${String(err)}`));
  };

  brightnessChar.onSet((value: CharacteristicValue) => {
    sendTarget(Number(value));
  });

  onChar.onSet((value: CharacteristicValue) => {
    if (value === true) {
      // Beim Einschalten den aktuell angezeigten Brightness-Wert übernehmen.
      sendTarget(Number(brightnessChar.value ?? 0));
    } else {
      // Ladelimit lässt sich nicht „aus"-schalten — nach HAP-Commit wieder anzeigen.
      log.info(`${name}: Aus-Schalten ignoriert (Ladelimit ist immer aktiv).`);
      setImmediate(() => onChar.updateValue(true));
    }
  });

  return {
    service: svc,
    update: (targetSoc) => {
      if (targetSoc === undefined || !Number.isFinite(targetSoc)) {
        // Unbekanntes Limit → Lampe aus (kein Wert), Brightness unverändert.
        onChar.updateValue(false);
        return;
      }
      const pct = Math.max(0, Math.min(100, Math.round(targetSoc)));
      onChar.updateValue(pct > 0);
      brightnessChar.updateValue(pct);
    },
  };
}

/**
 * Baut die SoC-Anzeige als Lightbulb-Dimmer (On + Brightness 0–100 = Ladestand).
 *
 * HomeKit hat KEINEN nativen read-only-Prozent-Schieberegler. Stock Apple Home
 * stellt einen Lightbulb-Dimmer aber als Balken/Schieberegler direkt in der
 * Kachel dar (Ladestand auf einen Blick, ohne Antippen). Da der Ladestand nicht
 * gesetzt werden kann, ist dieser Dimmer „read-only": jeder Bedien-Versuch
 * (On/Brightness) wird sofort auf den zuletzt gepollten SoC zurückgesetzt.
 *
 * Wechsel des Service-Typs: Frühere Versionen nutzten hier einen HumiditySensor
 * (gleicher Seed/UUID). Liegt der noch am Accessory, wird er entfernt, damit das
 * Accessory genau EINEN funktionalen Service (die Lightbulb) trägt.
 */
function makeSocDisplay(
  kit: Kit,
  acc: PlatformAccessory,
  name: string,
  subtype: string,
): BoundService {
  const { hap } = kit;
  const Service = hap.Service;
  const Characteristic = hap.Characteristic;

  // Alten HumiditySensor (Vorgänger-Darstellung, gleicher Seed) entfernen.
  const legacy = acc.getServiceById(Service.HumiditySensor, subtype);
  if (legacy) {
    acc.removeService(legacy);
  }

  const svc =
    acc.getServiceById(Service.Lightbulb, subtype) ??
    acc.addService(Service.Lightbulb, name, subtype);
  kit.nameService(svc, name);

  const onChar = svc.getCharacteristic(Characteristic.On);
  const brightnessChar = svc.testCharacteristic(Characteristic.Brightness)
    ? svc.getCharacteristic(Characteristic.Brightness)
    : svc.addCharacteristic(Characteristic.Brightness);

  /** Zuletzt gepollter Ladestand (für read-only-Rücksetzen). */
  let lastSoc = 0;

  // Read-only: Bedien-Versuche sofort auf den Ist-Ladestand zurücksetzen.
  brightnessChar.onSet(() => {
    setImmediate(() => brightnessChar.updateValue(lastSoc));
  });
  onChar.onSet(() => {
    setImmediate(() => onChar.updateValue(lastSoc > 0));
  });

  return {
    service: svc,
    update: (value) => {
      lastSoc = Math.max(0, Math.min(100, Math.round(Number(value))));
      onChar.updateValue(lastSoc > 0);
      brightnessChar.updateValue(lastSoc);
    },
  };
}

/**
 * Baut den Batterie-Service (BatteryLevel = SoC, ChargingState, StatusLowBattery).
 *
 * StatusLowBattery nutzt die `lowBatteryThreshold` aus der Config; ChargingState
 * spiegelt `state.charging`. Fehlender SoC → Level 0 + NOT_CHARGING (defensiv).
 */
function makeBattery(kit: Kit, acc: PlatformAccessory, name: string): BatteryBinding {
  const { hap, config } = kit;
  const Service = hap.Service;
  const Characteristic = hap.Characteristic;

  const svc = acc.getService(Service.Battery) ?? acc.addService(Service.Battery, name);
  kit.nameService(svc, name);

  const levelChar = svc.getCharacteristic(Characteristic.BatteryLevel);
  const chargingChar = svc.getCharacteristic(Characteristic.ChargingState);
  const lowChar = svc.getCharacteristic(Characteristic.StatusLowBattery);

  return {
    service: svc,
    update: (state) => {
      const soc = state.soc;
      const level =
        soc !== undefined && Number.isFinite(soc)
          ? Math.max(0, Math.min(100, Math.round(soc)))
          : 0;
      levelChar.updateValue(level);

      chargingChar.updateValue(
        state.charging === true
          ? Characteristic.ChargingState.CHARGING
          : Characteristic.ChargingState.NOT_CHARGING,
      );

      const low =
        soc !== undefined && Number.isFinite(soc) && soc <= config.lowBatteryThreshold;
      lowChar.updateValue(
        low
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    },
  };
}

/** Exportiert für Tests (reine Klemm-/Mapping-Helfer ohne HomeKit). */
export const __testing = {
  SEEDS,
  LUX_MIN,
  /** Brightness/Ziel-SoC-Klemmung wie im Lightbulb-onSet. */
  clampSoc: (v: number): number => Math.max(0, Math.min(100, Math.round(v))),
  /** DC-Flag-Ableitung wie im update(). */
  isDc: (chargingType: string | undefined): boolean =>
    (chargingType ?? '').toUpperCase() === 'DC',
  /** Profil-aktiv-Flag wie im update(). */
  hasActiveProfile: (name: string | undefined): boolean =>
    typeof name === 'string' && name.length > 0,
  /** Low-Battery-Ableitung wie im Battery-Service. */
  isLow: (soc: number | undefined, threshold: number): boolean =>
    soc !== undefined && Number.isFinite(soc) && soc <= threshold,
};
