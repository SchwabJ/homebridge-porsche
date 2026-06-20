/**
 * Domänen-Modul „Klima" für das Taycan-Cockpit.
 *
 * Die Vorklimatisierung wird als **Thermostat-Service** dargestellt (wie ein
 * Tado-Heizkörperthermostat): eine Kachel mit Soll-Temperatur-Regler + Aus/An.
 *
 * - Thermostat „Klima" (ESSENTIELL, immer):
 *   - TargetTemperature: Soll-Temperatur, setzbar → {@link climateStart}(temp).
 *     Läuft die Klima bereits, wird die neue Temperatur live nachgesendet.
 *   - TargetHeatingCoolingState: nur OFF / HEAT. HEAT = „auf Soll klimatisieren"
 *     (das Fahrzeug heizt ODER kühlt intern, um die Soll-Temperatur zu erreichen)
 *     → {@link climateStart}; OFF → {@link climateStop}.
 *   - CurrentTemperature: spiegelt die Soll-Temperatur — die PPA liefert KEINE
 *     echte Innentemperatur. CurrentHeatingCoolingState spiegelt den An/Aus-Ist.
 *
 * GEGATET (nur 'full'):
 * - Switch „Standheizung": momentaner Switch (Auto-Off) → {@link heatingStart}/
 *   {@link heatingStop}. Die separate Standheizung hat KEINEN Soll-Wert in der API.
 * - bei `exposeClimateZones`: vier Zonen-Switches (vorne/hinten links/rechts).
 *
 * Das Modul folgt dem {@link DomainModule}-Muster: es baut beim Aufruf seine
 * Services über die Kit-Helfer (bzw. HAP direkt für den Thermostat) auf,
 * verdrahtet onSet-Handler gegen `kit.command(...)` und liefert eine
 * `update(state)`-Funktion zurück, die alle Characteristics aus dem
 * {@link VehicleState} aktualisiert.
 */

import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  ClimateZones,
  climateStart,
  climateStop,
  heatingStart,
  heatingStop,
} from '../api/commands';
import { Corners, VehicleState } from '../api/measurements';
import { DomainModule, Kit } from './kit';

/**
 * Stabile Seed-Namen — EIN Accessory pro Klima-Service (eigene Kachel je
 * Funktion). Stabil (kein Datum/Zufall) → Cache-Matching + Orphan-Cleanup.
 *
 * `thermostat` ist ein NEUER Seed (vorher Switch 'taycan-standklima' /
 * HeaterCooler 'taycan-climate'): Apple Home übernimmt einen Service-Typ-Wechsel
 * an einem bestehenden Accessory nicht zuverlässig → frischer Seed erzwingt eine
 * neue, korrekt typisierte Thermostat-Kachel; die alten werden vom Orphan-Cleanup
 * entfernt.
 */
const SEEDS = {
  thermostat: 'taycan-thermostat',
  heating: 'taycan-heating',
  zoneFl: 'taycan-zone-fl',
  zoneFr: 'taycan-zone-fr',
  zoneRl: 'taycan-zone-rl',
  zoneRr: 'taycan-zone-rr',
} as const;

/** Alle vier Klimazonen aktiv — Default-Zustand der gewünschten Zonen. */
const ALL_ZONES_ON: ClimateZones = {
  frontLeft: true,
  frontRight: true,
  rearLeft: true,
  rearRight: true,
};

/**
 * Adapter: VehicleState-`Corners<boolean>` (`fl/fr/rl/rr`) →
 * Command-`ClimateZones` (`frontLeft/frontRight/rearLeft/rearRight`).
 */
function cornersToZones(c: Corners<boolean>): ClimateZones {
  return {
    frontLeft: c.fl,
    frontRight: c.fr,
    rearLeft: c.rl,
    rearRight: c.rr,
  };
}

/** Klemmt eine Zieltemperatur in die konfigurierten Grenzen. */
function clampTemp(tempC: number, min: number, max: number): number {
  if (!Number.isFinite(tempC)) {
    return min;
  }
  return Math.max(min, Math.min(max, tempC));
}

/**
 * Das Klima-Domänen-Modul. Beim Aufruf werden alle Services angelegt und die
 * onSet-Handler verdrahtet; der Rückgabewert ist die `update(state)`-Funktion.
 */
export const climateModule: DomainModule = (kit: Kit) => {
  const { hap, config, command, log } = kit;
  const Service = hap.Service;
  const Characteristic = hap.Characteristic;
  const displayName = config.vehicleName;

  // --- Interner, persistenter Zustand des Moduls ---------------------------
  /** Aktuell gewünschte Zieltemperatur in °C. */
  let currentTarget = clampTemp(config.defaultTargetTemp, config.tempMin, config.tempMax);
  /** Aktuell gewünschte Klimazonen (für jeden climateStart-Aufruf). */
  let desiredZones: ClimateZones = { ...ALL_ZONES_ON };
  /** Letzter bekannter Klima-An/Aus-Zustand. */
  let climateOn = false;

  // 'full' → zusätzlich Standheizung + Klimazonen. 'essential' → nur Thermostat.
  const full = config.detailLevel === 'full';

  const OFF = Characteristic.TargetHeatingCoolingState.OFF;
  const HEAT = Characteristic.TargetHeatingCoolingState.HEAT;
  const CUR_OFF = Characteristic.CurrentHeatingCoolingState.OFF;
  const CUR_HEAT = Characteristic.CurrentHeatingCoolingState.HEAT;

  // =========================================================================
  // Thermostat „Klima" (ESSENTIELL, immer) — Soll-Temperatur + Aus/An
  // =========================================================================
  const thermAcc: PlatformAccessory = kit.accessory(SEEDS.thermostat, `${displayName} Klima`);
  const therm: Service =
    thermAcc.getServiceById(Service.Thermostat, 'climate') ??
    thermAcc.addService(Service.Thermostat, `${displayName} Klima`, 'climate');
  kit.nameService(therm, `${displayName} Klima`);

  const currentTempChar = therm.getCharacteristic(Characteristic.CurrentTemperature);
  const targetTempChar = therm.getCharacteristic(Characteristic.TargetTemperature);
  const currentStateChar = therm.getCharacteristic(Characteristic.CurrentHeatingCoolingState);
  const targetStateChar = therm.getCharacteristic(Characteristic.TargetHeatingCoolingState);
  const unitsChar = therm.getCharacteristic(Characteristic.TemperatureDisplayUnits);

  // TargetTemperature: erst Wert in die (noch alten) Grenzen klemmen, DANN Props
  // verengen (sonst „illegal value"-Warnung beim setProps), siehe HeaterCooler-Historie.
  const lo0 = typeof targetTempChar.props.minValue === 'number' ? targetTempChar.props.minValue : config.tempMin;
  const hi0 = typeof targetTempChar.props.maxValue === 'number' ? targetTempChar.props.maxValue : config.tempMax;
  targetTempChar.updateValue(Math.max(lo0, Math.min(hi0, currentTarget)));
  targetTempChar.setProps({
    minValue: config.tempMin,
    maxValue: config.tempMax,
    minStep: config.tempStep,
  });

  // Nur OFF + HEAT zulassen (HEAT = „auf Soll klimatisieren"; Fahrzeug heizt/kühlt intern).
  targetStateChar.setProps({ validValues: [OFF, HEAT] });
  unitsChar.updateValue(Characteristic.TemperatureDisplayUnits.CELSIUS);

  /** Spiegelt `currentTarget` in Soll + (mangels Ist-Temp) auch in CurrentTemperature. */
  const reflectTemp = (): void => {
    currentTempChar.updateValue(currentTarget);
    targetTempChar.updateValue(currentTarget);
  };
  reflectTemp();
  currentStateChar.updateValue(CUR_OFF);
  targetStateChar.updateValue(OFF);

  // --- onSet: Modus (OFF/HEAT) → Stop/Start --------------------------------
  targetStateChar.onSet((value: CharacteristicValue) => {
    const on = value !== OFF;
    climateOn = on;
    void command(on ? climateStart(currentTarget, desiredZones) : climateStop());
    currentStateChar.updateValue(on ? CUR_HEAT : CUR_OFF);
    log.info(`${displayName}: Klima ${on ? `an (${currentTarget}°C)` : 'aus'}`);
  });

  // --- onSet: Soll-Temperatur → live nachsenden, wenn die Klima läuft ------
  targetTempChar.onSet((value: CharacteristicValue) => {
    currentTarget = clampTemp(Number(value), config.tempMin, config.tempMax);
    currentTempChar.updateValue(currentTarget);
    if (climateOn) {
      void command(climateStart(currentTarget, desiredZones));
    }
  });

  // =========================================================================
  // Switch „Standheizung" (momentaner Switch, nur 'full') — KEIN Soll-Wert
  // =========================================================================
  if (full) {
    const heatingAcc = kit.accessory(SEEDS.heating, `${displayName} Standheizung`);
    kit.switchService(heatingAcc, `${displayName} Standheizung`, 'heating', {
      onSet: (on) => {
        void command(on ? heatingStart() : heatingStop());
      },
      momentaryMs: Math.max(0, config.heatingAutoOffMinutes) * 60_000,
    });
  }

  // =========================================================================
  // Klimazonen-Switches (nur 'full')
  // =========================================================================
  const zoneUpdaters: Array<(state: VehicleState) => void> = [];

  if (full && config.exposeClimateZones) {
    const zoneDefs: Array<{ seed: string; name: string; subtype: string; key: keyof ClimateZones; corner: keyof Corners<boolean> }> = [
      { seed: SEEDS.zoneFl, name: 'Klimazone vorne links', subtype: 'zone-fl', key: 'frontLeft', corner: 'fl' },
      { seed: SEEDS.zoneFr, name: 'Klimazone vorne rechts', subtype: 'zone-fr', key: 'frontRight', corner: 'fr' },
      { seed: SEEDS.zoneRl, name: 'Klimazone hinten links', subtype: 'zone-rl', key: 'rearLeft', corner: 'rl' },
      { seed: SEEDS.zoneRr, name: 'Klimazone hinten rechts', subtype: 'zone-rr', key: 'rearRight', corner: 'rr' },
    ];

    for (const def of zoneDefs) {
      const zoneName = `${displayName} ${def.name}`;
      const zoneAcc = kit.accessory(def.seed, zoneName);
      const sw = kit.switchService(zoneAcc, zoneName, def.subtype, {
        onSet: (on) => {
          desiredZones = { ...desiredZones, [def.key]: on };
          if (climateOn) {
            void command(climateStart(currentTarget, desiredZones));
          }
        },
      });
      zoneUpdaters.push((state: VehicleState) => {
        if (state.climateZones !== undefined) {
          sw.update(state.climateZones[def.corner]);
        }
      });
    }
  }

  // =========================================================================
  // Apply-Funktion
  // =========================================================================
  return (state: VehicleState): void => {
    climateOn = state.climateOn;

    // Soll-Temperatur aus dem State übernehmen (falls bekannt).
    if (state.targetTempC !== undefined) {
      currentTarget = clampTemp(state.targetTempC, config.tempMin, config.tempMax);
    }
    // Gewünschte Zonen aus dem State übernehmen.
    if (state.climateZones !== undefined) {
      desiredZones = cornersToZones(state.climateZones);
    }

    // Thermostat spiegeln: Temperatur + An/Aus-Zustand.
    reflectTemp();
    currentStateChar.updateValue(state.climateOn ? CUR_HEAT : CUR_OFF);
    targetStateChar.updateValue(state.climateOn ? HEAT : OFF);

    for (const z of zoneUpdaters) {
      z(state);
    }

    log.debug(
      `Klima: on=${state.climateOn} target=${currentTarget}°C zones=` +
        `${desiredZones.frontLeft ? 1 : 0}${desiredZones.frontRight ? 1 : 0}` +
        `${desiredZones.rearLeft ? 1 : 0}${desiredZones.rearRight ? 1 : 0}`,
    );
  };
};

export default climateModule;
