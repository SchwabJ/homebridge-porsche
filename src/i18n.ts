/**
 * Lokalisierung der HomeKit-Kachel-Labels (Englisch/Deutsch).
 *
 * Die Kachel-Namen setzen sich aus `vehicleName` (Config, z. B. „Porsche",
 * „Macan", „911") + einem lokalisierten Label zusammen, z. B. `Porsche Range`
 * bzw. `Porsche Reichweite`. Die Sprache steuert die Config-Option `language`
 * (Default `en`). Diese Datei ist die EINZIGE Quelle der Wahrheit für sichtbare
 * Label-Texte — Module referenzieren `kit.labels.<key>`, nie String-Literale.
 *
 * Log-Meldungen sind bewusst Englisch (Homebridge-Konvention) und NICHT hier.
 */

/** Unterstützte UI-Sprachen für die Kachel-Labels. */
export type Language = 'en' | 'de';

/** Alle lokalisierbaren Kachel-Labels (Suffix nach dem `vehicleName`-Präfix). */
export interface Labels {
  // --- Laden / Batterie (charging.ts) ---
  chargeLevel: string;
  range: string;
  electricRange: string;
  totalRange: string;
  chargingPower: string;
  maxChargingPower: string;
  chargingTimeLeft: string;
  chargeRate: string;
  chargingNow: string;
  dcCharging: string;
  chargingProfileActive: string;
  charging: string;
  chargeLimit: string;
  battery: string;
  batteryLow: string;
  fuelLevel: string;

  // --- Klima (climate.ts) ---
  climate: string;
  heating: string;
  climateZoneFrontLeft: string;
  climateZoneFrontRight: string;
  climateZoneRearLeft: string;
  climateZoneRearRight: string;

  // --- Zugang / Schloss (access.ts) ---
  lock: string;
  flashLights: string;
  honkAndFlash: string;
  doorFrontLeft: string;
  doorFrontRight: string;
  doorRearLeft: string;
  doorRearRight: string;
  windowFrontLeft: string;
  windowFrontRight: string;
  windowRearLeft: string;
  windowRearRight: string;
  frunk: string;
  trunk: string;
  vehicleStatus: string;

  // --- Telemetrie (telemetry.ts) ---
  tirePressureFrontLeft: string;
  tirePressureFrontRight: string;
  tirePressureRearLeft: string;
  tirePressureRearRight: string;
  tireWarningFrontLeft: string;
  tireWarningFrontRight: string;
  tireWarningRearLeft: string;
  tireWarningRearRight: string;
  tireWarning: string;
  odometer: string;
  serviceInKm: string;
  serviceWarning: string;
  carAtHome: string;
  distanceHome: string;
  heading: string;
  parkingBrake: string;
  parkingLight: string;
  privacyMode: string;
  remoteAccess: string;
  dataStale: string;

  // --- Wächter (watchdog.ts) ---
  connection: string;
  dataFresh: string;
}

/** Englische Labels (Default). */
export const LABELS_EN: Labels = {
  chargeLevel: 'Charge level',
  range: 'Range',
  electricRange: 'Electric range',
  totalRange: 'Total range',
  chargingPower: 'Charging power',
  maxChargingPower: 'Max charging power',
  chargingTimeLeft: 'Charging time left',
  chargeRate: 'Charge rate',
  chargingNow: 'Charging now',
  dcCharging: 'DC charging',
  chargingProfileActive: 'Charging profile active',
  charging: 'Charging',
  chargeLimit: 'Charge limit',
  battery: 'Battery',
  batteryLow: 'Battery low',
  fuelLevel: 'Fuel level',

  climate: 'Climate',
  heating: 'Heating',
  climateZoneFrontLeft: 'Climate zone front left',
  climateZoneFrontRight: 'Climate zone front right',
  climateZoneRearLeft: 'Climate zone rear left',
  climateZoneRearRight: 'Climate zone rear right',

  lock: 'Lock',
  flashLights: 'Flash lights',
  honkAndFlash: 'Honk & flash',
  doorFrontLeft: 'Door front left',
  doorFrontRight: 'Door front right',
  doorRearLeft: 'Door rear left',
  doorRearRight: 'Door rear right',
  windowFrontLeft: 'Window front left',
  windowFrontRight: 'Window front right',
  windowRearLeft: 'Window rear left',
  windowRearRight: 'Window rear right',
  frunk: 'Frunk',
  trunk: 'Trunk',
  vehicleStatus: 'Vehicle status',

  tirePressureFrontLeft: 'Tire pressure FL',
  tirePressureFrontRight: 'Tire pressure FR',
  tirePressureRearLeft: 'Tire pressure RL',
  tirePressureRearRight: 'Tire pressure RR',
  tireWarningFrontLeft: 'Tire warning FL',
  tireWarningFrontRight: 'Tire warning FR',
  tireWarningRearLeft: 'Tire warning RL',
  tireWarningRearRight: 'Tire warning RR',
  tireWarning: 'Tire warning',
  odometer: 'Odometer',
  serviceInKm: 'Service in km',
  serviceWarning: 'Service warning',
  carAtHome: 'Car at home',
  distanceHome: 'Distance home',
  heading: 'Heading',
  parkingBrake: 'Parking brake',
  parkingLight: 'Parking light',
  privacyMode: 'Privacy mode',
  remoteAccess: 'Remote access',
  dataStale: 'Data stale',

  connection: 'Connection',
  dataFresh: 'Data fresh',
};

/** Deutsche Labels (entspricht dem bisherigen, deutschsprachigen Stand). */
export const LABELS_DE: Labels = {
  chargeLevel: 'Ladestand',
  range: 'Reichweite',
  electricRange: 'E-Reichweite',
  totalRange: 'Reichweite gesamt',
  chargingPower: 'Ladeleistung',
  maxChargingPower: 'Max-Ladeleistung',
  chargingTimeLeft: 'Restzeit Laden',
  chargeRate: 'Laderate',
  chargingNow: 'Lädt',
  dcCharging: 'DC-Laden',
  chargingProfileActive: 'Ladeprofil aktiv',
  charging: 'Laden',
  chargeLimit: 'Ladelimit',
  battery: 'Akku',
  batteryLow: 'Akku niedrig',
  fuelLevel: 'Tankstand',

  climate: 'Klima',
  heating: 'Standheizung',
  climateZoneFrontLeft: 'Klimazone vorne links',
  climateZoneFrontRight: 'Klimazone vorne rechts',
  climateZoneRearLeft: 'Klimazone hinten links',
  climateZoneRearRight: 'Klimazone hinten rechts',

  lock: 'Schloss',
  flashLights: 'Lichthupe',
  honkAndFlash: 'Hupe & Licht',
  doorFrontLeft: 'Tür vorne links',
  doorFrontRight: 'Tür vorne rechts',
  doorRearLeft: 'Tür hinten links',
  doorRearRight: 'Tür hinten rechts',
  windowFrontLeft: 'Fenster vorne links',
  windowFrontRight: 'Fenster vorne rechts',
  windowRearLeft: 'Fenster hinten links',
  windowRearRight: 'Fenster hinten rechts',
  frunk: 'Frunk',
  trunk: 'Kofferraum',
  vehicleStatus: 'Fahrzeugstatus',

  tirePressureFrontLeft: 'Reifendruck VL',
  tirePressureFrontRight: 'Reifendruck VR',
  tirePressureRearLeft: 'Reifendruck HL',
  tirePressureRearRight: 'Reifendruck HR',
  tireWarningFrontLeft: 'Reifenwarnung VL',
  tireWarningFrontRight: 'Reifenwarnung VR',
  tireWarningRearLeft: 'Reifenwarnung HL',
  tireWarningRearRight: 'Reifenwarnung HR',
  tireWarning: 'Reifenwarnung',
  odometer: 'Kilometerstand',
  serviceInKm: 'Service in km',
  serviceWarning: 'Servicewarnung',
  carAtHome: 'Auto zuhause',
  distanceHome: 'Distanz zuhause',
  heading: 'Fahrtrichtung',
  parkingBrake: 'Handbremse',
  parkingLight: 'Parklicht',
  privacyMode: 'Privatmodus',
  remoteAccess: 'Fernzugriff',
  dataStale: 'Daten veraltet',

  connection: 'Verbindung',
  dataFresh: 'Daten aktuell',
};

/** Liefert den Label-Satz für die gewählte Sprache (Fallback Englisch). */
export function labelsFor(language: Language): Labels {
  return language === 'de' ? LABELS_DE : LABELS_EN;
}
