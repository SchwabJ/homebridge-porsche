/**
 * Parser für die measurements-Antwort der Porsche-PPA-API.
 *
 * Die ECHTE Antwort ist ein Objekt `{ vin, modelName, timestamp, measurements: [{key,status,value},…] }`
 * (NICHT ein Top-Level-Array). Feldnamen an der echten `api.ppa.porsche.com`-Antwort
 * verifiziert (Live am Fahrzeug, 2026). Reiner, seiteneffektfreier Parser — keine HTTP-Calls.
 *
 * Defensiv: fehlende Keys, `value: undefined`, unbekannte Keys oder eine ganz fehlende
 * `measurements`-Liste führen NIE zu einem Throw, sondern zu undefined/Default-Werten.
 */

/** Lade-Status-Werte, die als "aktiv ladend" gelten. */
const CHARGING_STATES = ['CHARGING', 'CHARGING_AC', 'CHARGING_DC'];

/** Vier-Eck-Werte (Türen, Fenster, Reifen, Klimazonen). */
export interface Corners<T> {
  fl: T;
  fr: T;
  rl: T;
  rr: T;
}

/** Typisierter Fahrzeugzustand, abgeleitet aus den Messwerten. */
export interface VehicleState {
  // --- Batterie / Reichweite / km-Stand -------------------------------------
  /** Ladezustand der Batterie in Prozent (BATTERY_LEVEL.percent) — nur E/PHEV. */
  soc?: number;
  /** Elektrische Restreichweite in km (E_RANGE.kilometers) — nur E/PHEV. */
  rangeKm?: number;
  /** Tankfüllstand in Prozent (FUEL_LEVEL.percent) — nur Verbrenner/PHEV.
   *  Hinweis: value-Struktur nach BATTERY_LEVEL-Konvention angenommen, nicht live verifiziert. */
  fuelLevel?: number;
  /** Gesamt-/Kraftstoff-Restreichweite in km (RANGE.kilometers) — Verbrenner/PHEV. */
  fuelRangeKm?: number;
  /** Gesamt-Kilometerstand (MILEAGE.kilometers). */
  odometerKm?: number;

  // --- Laden ----------------------------------------------------------------
  /** Lädt das Fahrzeug aktuell? (CHARGING_SUMMARY.status) */
  charging: boolean;
  /** Ladekabel eingesteckt? (aus Lade-Status / plugState abgeleitet). */
  plugged: boolean;
  /** Lade-Typ "AC" | "DC" (CHARGING_SUMMARY.type). */
  chargingType?: string;
  /** Aktuelle Ladeleistung in kW (CHARGING_RATE.chargingPowerkW). */
  chargingPowerKw?: number;
  /** Maximale Ladeleistung in kW (CHARGING_RATE.maxChargingPowerkW). */
  maxChargingPowerKw?: number;
  /** Laderate in km pro Minute (CHARGING_RATE.chargingRatekmPerMin). */
  chargeRateKmMin?: number;
  /** Geschätzte Restladezeit in Minuten (aus targetDateTimeWithOffset, ≥0). */
  chargeEtaMinutes?: number;
  /** Ziel-Ladestand in Prozent (CHARGING_SUMMARY.chargingProfile.minSoC). */
  targetSoc?: number;
  /** Name des aktiven Ladeprofils (CHARGING_PROFILES.list.find(isEnabled).name). */
  activeProfileName?: string;

  // --- Klima ----------------------------------------------------------------
  /** Läuft die Klimatisierung? (CLIMATIZER_STATE.isOn) */
  climateOn: boolean;
  /** Ziel-Temperatur in °C (CLIMATIZER_STATE.targetTemperature, Kelvin→°C). */
  targetTempC?: number;
  /** Aktive Klimazonen (CLIMATIZER_STATE.climateZonesEnabled). */
  climateZones?: Corners<boolean>;

  // --- Verriegelung / Öffnungen ---------------------------------------------
  /** Ist das Fahrzeug verriegelt? (LOCK_STATE_VEHICLE.isLocked) */
  locked?: boolean;
  /** Türen offen (OPEN_STATE_DOOR_*). */
  doors?: Corners<boolean>;
  /** Frunk (vorderer Kofferraum) offen (OPEN_STATE_LID_FRONT.isOpen). */
  frunkOpen?: boolean;
  /** Heck-Kofferraum offen (OPEN_STATE_LID_REAR.isOpen). */
  trunkOpen?: boolean;
  /** Fenster offen (OPEN_STATE_WINDOW_*). */
  windows?: Corners<boolean>;

  // --- Fahrzeug-Status ------------------------------------------------------
  /** Handbremse angezogen? (PARKING_BRAKE.isOn) */
  parkingBrake?: boolean;
  /** Parklicht an? (PARKING_LIGHT.isOn) */
  parkingLight?: boolean;

  // --- Reifen ---------------------------------------------------------------
  /** Reifendruck in bar je Rad (TIRE_PRESSURE.*.actualPressureBar). */
  tirePressureBar?: Corners<number>;
  /** Reifendruck-Differenz zum Sollwert in bar je Rad (TIRE_PRESSURE.*.differenceBar). */
  tireDiffBar?: Corners<number>;

  // --- Service / Position ---------------------------------------------------
  /** Reststrecke bis zum nächsten Service in km (MAIN_SERVICE_RANGE.kilometers). */
  serviceKm?: number;
  /** Breitengrad der letzten bekannten Position (aus GPS_LOCATION.location). */
  lat?: number;
  /** Längengrad der letzten bekannten Position (aus GPS_LOCATION.location). */
  lon?: number;
  /** Fahrtrichtung 0–360° (GPS_LOCATION.direction). */
  heading?: number;

  // --- Datenschutz / Konnektivität ------------------------------------------
  /** Privacy-Modus aktiv? (GLOBAL_PRIVACY_MODE.isEnabled) */
  privacyMode?: boolean;
  /** Remote-Zugriff autorisiert? (REMOTE_ACCESS_AUTHORIZATION.isEnabled) */
  remoteAccess?: boolean;
  /** Zeitstempel der Daten in ms seit Epoch (aus response.timestamp). */
  dataTimestamp?: number;
}

/** Ein einzelner Messwert-Eintrag aus der PPA-API. */
export interface MeasurementItem {
  key: string;
  status?: { isEnabled?: boolean };
  value?: unknown;
}

/**
 * Holt die measurements-Liste aus der PPA-Antwort. Akzeptiert das echte
 * Antwort-Objekt (`{ …, measurements: [...] }`) ODER direkt ein Array.
 */
function extractItems(response: unknown): MeasurementItem[] {
  if (Array.isArray(response)) {
    return response as MeasurementItem[];
  }
  const m = (response as { measurements?: unknown } | null)?.measurements;
  return Array.isArray(m) ? (m as MeasurementItem[]) : [];
}

/** Liest `response.timestamp` (ISO-String oder Zahl) als ms seit Epoch. */
function parseTimestamp(response: unknown): number | undefined {
  const ts = (response as { timestamp?: unknown } | null)?.timestamp;
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts;
  }
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/** Parst `"48.137,11.576"` → `{ lat, lon }` (oder `{}` bei ungültig). */
function parseLocation(location: unknown): { lat?: number; lon?: number } {
  if (typeof location !== 'string') {
    return {};
  }
  const parts = location.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
    return { lat: parts[0], lon: parts[1] };
  }
  return {};
}

/** Liest eine endliche Zahl aus einem Feld, sonst undefined. */
function num(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = obj?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Liest einen Boolean aus einem Feld (strikt === true), sonst undefined wenn obj fehlt. */
function bool(obj: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (obj === undefined) {
    return undefined;
  }
  return obj[key] === true;
}

/** Kelvin → °C, gerundet auf 1 Nachkommastelle (z. B. 295.15 → 22). */
function kelvinToCelsius(kelvin: number): number {
  return Math.round((kelvin - 273.15) * 10) / 10;
}

/**
 * Baut ein Corners<boolean>-Objekt aus vier `isOpen`/`isOn`-Einzel-Messwerten.
 * Gibt undefined zurück, wenn KEIN einziges Eck verfügbar ist.
 */
function cornerBools(
  byKey: Map<string, Record<string, unknown>>,
  flKey: string,
  frKey: string,
  rlKey: string,
  rrKey: string,
  field: string,
): Corners<boolean> | undefined {
  const fl = bool(byKey.get(flKey), field);
  const fr = bool(byKey.get(frKey), field);
  const rl = bool(byKey.get(rlKey), field);
  const rr = bool(byKey.get(rrKey), field);
  if (fl === undefined && fr === undefined && rl === undefined && rr === undefined) {
    return undefined;
  }
  return { fl: fl ?? false, fr: fr ?? false, rl: rl ?? false, rr: rr ?? false };
}

/**
 * Übersetzt die rohe PPA-Antwort in einen `VehicleState`.
 *
 * Defensiv: fehlende Felder, unbekannte Keys, leere/fehlende `measurements`
 * führen niemals zu einem Throw, sondern zu undefined/Default-Werten.
 *
 * @param response Rohe PPA-Antwort (Objekt oder Array).
 * @param nowMs    "Jetzt" in ms seit Epoch (für ETA-Berechnung, Default Date.now()).
 */
export function parseMeasurements(response: unknown, nowMs: number = Date.now()): VehicleState {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const item of extractItems(response)) {
    if (item && typeof item.key === 'string' && item.value && typeof item.value === 'object') {
      byKey.set(item.key, item.value as Record<string, unknown>);
    }
  }

  const battery = byKey.get('BATTERY_LEVEL');
  const range = byKey.get('E_RANGE');
  const fuel = byKey.get('FUEL_LEVEL');
  const totalRange = byKey.get('RANGE');
  const mileage = byKey.get('MILEAGE');
  const charge = byKey.get('CHARGING_SUMMARY');
  const rate = byKey.get('CHARGING_RATE');
  const profiles = byKey.get('CHARGING_PROFILES');
  const climate = byKey.get('CLIMATIZER_STATE');
  const lock = byKey.get('LOCK_STATE_VEHICLE');
  const frunk = byKey.get('OPEN_STATE_LID_FRONT');
  const trunk = byKey.get('OPEN_STATE_LID_REAR');
  const parkingBrake = byKey.get('PARKING_BRAKE');
  const parkingLight = byKey.get('PARKING_LIGHT');
  const tires = byKey.get('TIRE_PRESSURE');
  const service = byKey.get('MAIN_SERVICE_RANGE');
  const gps = byKey.get('GPS_LOCATION');
  const privacy = byKey.get('GLOBAL_PRIVACY_MODE');
  const remote = byKey.get('REMOTE_ACCESS_AUTHORIZATION');

  // --- Laden ----------------------------------------------------------------
  const chargeStatus = charge?.['status'] as string | undefined;
  const charging = chargeStatus !== undefined && CHARGING_STATES.includes(chargeStatus);
  const chargingProfile = charge?.['chargingProfile'] as { minSoC?: number } | undefined;

  // ETA: Differenz targetDateTimeWithOffset - jetzt, in Minuten, ≥0.
  let chargeEtaMinutes: number | undefined;
  const targetIso = charge?.['targetDateTimeWithOffset'];
  if (typeof targetIso === 'string') {
    const targetMs = Date.parse(targetIso);
    if (Number.isFinite(targetMs)) {
      chargeEtaMinutes = Math.max(0, Math.round((targetMs - nowMs) / 60000));
    }
  }

  // --- aktives Ladeprofil ---------------------------------------------------
  let activeProfileName: string | undefined;
  const list = profiles?.['list'];
  if (Array.isArray(list)) {
    const active = list.find(
      (p) => p && typeof p === 'object' && (p as { isEnabled?: unknown }).isEnabled === true,
    ) as { name?: unknown } | undefined;
    if (active && typeof active.name === 'string') {
      activeProfileName = active.name;
    }
  }

  // --- Klima ----------------------------------------------------------------
  const targetTempK = num(climate, 'targetTemperature');
  const zonesRaw = climate?.['climateZonesEnabled'] as Record<string, unknown> | undefined;
  const climateZones: Corners<boolean> | undefined = zonesRaw
    ? {
        fl: zonesRaw['frontLeft'] === true,
        fr: zonesRaw['frontRight'] === true,
        rl: zonesRaw['rearLeft'] === true,
        rr: zonesRaw['rearRight'] === true,
      }
    : undefined;

  // --- Öffnungen ------------------------------------------------------------
  const doors = cornerBools(
    byKey,
    'OPEN_STATE_DOOR_FRONT_LEFT',
    'OPEN_STATE_DOOR_FRONT_RIGHT',
    'OPEN_STATE_DOOR_REAR_LEFT',
    'OPEN_STATE_DOOR_REAR_RIGHT',
    'isOpen',
  );
  const windows = cornerBools(
    byKey,
    'OPEN_STATE_WINDOW_FRONT_LEFT',
    'OPEN_STATE_WINDOW_FRONT_RIGHT',
    'OPEN_STATE_WINDOW_REAR_LEFT',
    'OPEN_STATE_WINDOW_REAR_RIGHT',
    'isOpen',
  );

  // --- Reifen ---------------------------------------------------------------
  let tirePressureBar: Corners<number> | undefined;
  let tireDiffBar: Corners<number> | undefined;
  if (tires) {
    const fl = tires['frontLeftTire'] as Record<string, unknown> | undefined;
    const fr = tires['frontRightTire'] as Record<string, unknown> | undefined;
    const rl = tires['rearLeftTire'] as Record<string, unknown> | undefined;
    const rr = tires['rearRightTire'] as Record<string, unknown> | undefined;
    const pFl = num(fl, 'actualPressureBar');
    const pFr = num(fr, 'actualPressureBar');
    const pRl = num(rl, 'actualPressureBar');
    const pRr = num(rr, 'actualPressureBar');
    if (pFl !== undefined || pFr !== undefined || pRl !== undefined || pRr !== undefined) {
      tirePressureBar = { fl: pFl ?? 0, fr: pFr ?? 0, rl: pRl ?? 0, rr: pRr ?? 0 };
    }
    const dFl = num(fl, 'differenceBar');
    const dFr = num(fr, 'differenceBar');
    const dRl = num(rl, 'differenceBar');
    const dRr = num(rr, 'differenceBar');
    if (dFl !== undefined || dFr !== undefined || dRl !== undefined || dRr !== undefined) {
      tireDiffBar = { fl: dFl ?? 0, fr: dFr ?? 0, rl: dRl ?? 0, rr: dRr ?? 0 };
    }
  }

  const { lat, lon } = parseLocation(gps?.['location']);

  return {
    soc: num(battery, 'percent'),
    rangeKm: num(range, 'kilometers'),
    fuelLevel: num(fuel, 'percent'),
    fuelRangeKm: num(totalRange, 'kilometers'),
    odometerKm: num(mileage, 'kilometers'),

    charging,
    plugged: charging || charge?.['plugState'] === 'CONNECTED',
    chargingType: charge?.['type'] as string | undefined,
    chargingPowerKw: num(rate, 'chargingPowerkW'),
    maxChargingPowerKw: num(rate, 'maxChargingPowerkW'),
    chargeRateKmMin: num(rate, 'chargingRatekmPerMin'),
    chargeEtaMinutes,
    targetSoc: num(charge, 'targetSoc') ?? chargingProfile?.minSoC,
    activeProfileName,

    climateOn: climate?.['isOn'] === true,
    targetTempC: targetTempK !== undefined ? kelvinToCelsius(targetTempK) : undefined,
    climateZones,

    locked: bool(lock, 'isLocked'),
    doors,
    frunkOpen: bool(frunk, 'isOpen'),
    trunkOpen: bool(trunk, 'isOpen'),
    windows,

    parkingBrake: bool(parkingBrake, 'isOn'),
    parkingLight: bool(parkingLight, 'isOn'),

    tirePressureBar,
    tireDiffBar,

    serviceKm: num(service, 'kilometers'),
    lat,
    lon,
    heading: num(gps, 'direction'),

    privacyMode: bool(privacy, 'isEnabled'),
    remoteAccess: bool(remote, 'isEnabled'),
    dataTimestamp: parseTimestamp(response),
  };
}
