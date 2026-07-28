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
  /**
   * BCP-47-Kennung für Datums-, Zeit- und Zahlenformate im Dashboard.
   *
   * Gehört hierher und nicht in die Konfiguration: Wer `language: 'en'` setzt,
   * meint die ganze Oberfläche — deutsche Datumsformate und deutsche
   * Tausenderpunkte in einer englischen Seite sind schlicht ein Fehler. Für
   * Englisch bewusst `en-GB`: 24-Stunden-Zeit und Tag vor Monat, was zu einem
   * Fahrzeug-Dashboard besser passt als AM/PM.
   */
  locale: string;

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

  // --- Ladehistorie-Dashboard (dashboard.ts, chart.ts) ---
  dashTitle: string;
  dashAsOf: string;
  dashRefresh: string;
  dashSettings: string;
  dashInstantTo: string;
  dashTarget: string;
  dashNotPlugged: string;
  dashPluggedWaiting: string;
  dashCharging: string;
  dashAtHome: string;
  dashAway: string;
  dashMonitorOk: string;
  /**
   * Alter des letzten Messpunkts, `%s` = die fertige Dauer.
   *
   * Als MUSTER und nicht als Einzelwort: Im Deutschen steht „vor" davor, im
   * Englischen „ago" dahinter. Ein übersetztes Einzelwort ergab „ago 11 min".
   */
  dashMonitorAge: string;
  dashNoDataFor: string;
  dashNoDataYet: string;
  dashDay: string;
  dashWeek: string;
  dashMonth: string;
  dashYear: string;
  dashCost: string;
  dashInsteadOf: string;
  dashSaved: string;
  dashBonus: string;
  dashTotal: string;
  dashChargedRange: string;
  dashRange: string;
  dashConsumption: string;
  dashPerVehicle: string;
  dashCalculated: string;
  dashPaid: string;
  dashDriven: string;
  dashChargeTime: string;
  dashRecorded: string;
  dashCharges: string;
  dashNone: string;
  dashAvgPerCharge: string;
  dashRunning: string;
  dashSince: string;
  dashFrom: string;
  dashMeasuredCapacity: string;
  dashTrips: string;
  dashHealth: string;
  dashConfigured: string;
  dashMeasurement: string;
  dashSpread: string;
  dashTooFewPoints: string;
  dashGaps: string;
  dashStart: string;
  dashDuration: string;
  dashOfWhichCharging: string;
  dashChargeState: string;
  dashEnergy: string;
  dashPhase: string;
  dashPhases: string;
  dashInDetail: string;
  aggWeek: string;
  dashActive: string;
  dashComparedTo: string;
  dashInProgress: string;
  chartInstantTo: string;
  chartTargetMark: string;
  chartCurveAria: string;
  chartBarsAria: string;
  dashSocDropped: string;
  dashWaitSeconds: string;
  dashRefreshFailed: string;
  dashNoCharges: string;
  dashNoChargesHint: string;

}

/** Englische Labels (Default). */
export const LABELS_EN: Labels = {
  locale: 'en-GB',
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

  // --- Charging history dashboard ---
  dashTitle: 'Charging history',
  dashAsOf: 'as of',
  dashRefresh: 'Refresh now',
  dashSettings: 'Settings',
  dashInstantTo: 'instant to',
  dashTarget: 'target',
  dashNotPlugged: 'Not plugged in',
  dashPluggedWaiting: 'Plugged in, waiting',
  dashCharging: 'Charging',
  dashAtHome: 'at home',
  dashAway: 'away',
  dashMonitorOk: 'Monitoring active',
  dashMonitorAge: '%s ago',
  dashNoDataFor: 'No data for',
  dashNoDataYet: 'No data yet',
  dashDay: 'Day',
  dashWeek: 'Week',
  dashMonth: 'Month',
  dashYear: 'Year',
  dashCost: 'Cost',
  dashInsteadOf: 'instead of',
  dashSaved: 'Saved',
  dashBonus: 'bonus',
  dashTotal: 'total',
  dashChargedRange: 'Charged',
  dashRange: 'range',
  dashConsumption: 'Consumption',
  dashPerVehicle: 'per vehicle',
  dashCalculated: 'calculated',
  dashPaid: 'paid',
  dashDriven: 'Driven',
  dashChargeTime: 'Plugged in',
  dashRecorded: 'recorded',
  dashCharges: 'Charges',
  dashNone: 'none',
  dashAvgPerCharge: 'avg per charge',
  dashRunning: 'Running now',
  dashSince: 'since',
  dashFrom: 'from',
  dashMeasuredCapacity: 'Measured capacity',
  dashTrips: 'trips',
  dashHealth: 'health',
  dashConfigured: 'Configured',
  dashMeasurement: 'measurement',
  dashSpread: 'spread',
  dashTooFewPoints: 'Too little data (%n readings) — figures not yet reliable',
  dashGaps: 'Data gaps: %p % recorded, %h h missing — energy may be understated',
  dashStart: 'Start',
  dashDuration: 'Duration',
  dashOfWhichCharging: 'of which charging',
  dashChargeState: 'State of charge',
  dashEnergy: 'Energy',
  dashPhase: 'phase',
  dashPhases: 'phases',
  dashInDetail: 'in detail',
  aggWeek: 'CW',
  dashActive: 'active',
  dashComparedTo: 'vs.',
  dashInProgress: 'in progress',
  chartInstantTo: 'instant',
  chartTargetMark: 'target',
  chartCurveAria: 'Charging curve: state of charge over time',
  chartBarsAria: 'Energy charged per period',
  dashSocDropped: 'charge dropped',
  dashWaitSeconds: 'Wait %n s',
  dashRefreshFailed: 'Refresh failed',
  dashNoCharges: 'No charge recorded yet.',
  dashNoChargesHint: 'It will appear here as soon as the car is plugged in.',

};

/** Deutsche Labels (entspricht dem bisherigen, deutschsprachigen Stand). */
export const LABELS_DE: Labels = {
  locale: 'de-DE',
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

  // --- Charging history dashboard ---
  dashTitle: 'Ladehistorie',
  dashAsOf: 'Stand',
  dashRefresh: 'Jetzt abrufen',
  dashSettings: 'Einstellungen',
  dashInstantTo: 'sofort bis',
  dashTarget: 'Ziel',
  dashNotPlugged: 'Nicht eingesteckt',
  dashPluggedWaiting: 'Eingesteckt, wartet',
  dashCharging: 'Lädt',
  dashAtHome: 'zuhause',
  dashAway: 'auswärts',
  dashMonitorOk: 'Überwachung aktiv',
  dashMonitorAge: 'vor %s',
  dashNoDataFor: 'Keine Daten seit',
  dashNoDataYet: 'Noch keine Daten',
  dashDay: 'Tag',
  dashWeek: 'Woche',
  dashMonth: 'Monat',
  dashYear: 'Jahr',
  dashCost: 'Kosten',
  dashInsteadOf: 'statt',
  dashSaved: 'Gespart',
  dashBonus: 'Bonus',
  dashTotal: 'ges.',
  dashChargedRange: 'Geladen',
  dashRange: 'Reichw.',
  dashConsumption: 'Verbrauch',
  dashPerVehicle: 'lt. Auto',
  dashCalculated: 'gerechnet',
  dashPaid: 'bezahlt',
  dashDriven: 'Gefahren',
  dashChargeTime: 'Ladezeit',
  dashRecorded: 'erfasst',
  dashCharges: 'Ladungen',
  dashNone: 'keine',
  dashAvgPerCharge: 'Ø je Ladung',
  dashRunning: 'Läuft gerade',
  dashSince: 'seit',
  dashFrom: 'ab',
  dashMeasuredCapacity: 'Gemessene Kapazität',
  dashTrips: 'Fahrten',
  dashHealth: 'Gesundheit',
  dashConfigured: 'Eingestellt',
  dashMeasurement: 'Messung',
  dashSpread: 'Streuung',
  dashTooFewPoints: 'Zu wenig Daten (%n Messpunkte) — Zahlen noch nicht belastbar',
  dashGaps: 'Datenlücken: %p % erfasst, %h h fehlen — Energie kann zu niedrig sein',
  dashStart: 'Start',
  dashDuration: 'Dauer',
  dashOfWhichCharging: 'davon laden',
  dashChargeState: 'Ladestand',
  dashEnergy: 'Energie',
  dashPhase: 'Phase',
  dashPhases: 'Phasen',
  dashInDetail: 'im Detail',
  aggWeek: 'KW',
  dashActive: 'aktiv',
  dashComparedTo: 'ggü.',
  dashInProgress: 'laufend',
  chartInstantTo: 'sofort',
  chartTargetMark: 'Ziel',
  chartCurveAria: 'Ladeverlauf: Ladestand über die Zeit',
  chartBarsAria: 'Geladene Energie je Zeitraum',
  dashSocDropped: 'SoC gefallen',
  dashWaitSeconds: 'Noch %n s warten',
  dashRefreshFailed: 'Abruf fehlgeschlagen',
  dashNoCharges: 'Noch kein Ladevorgang erfasst.',
  dashNoChargesHint: 'Sobald das Auto ansteckt, erscheint er hier.',

};

/** Liefert den Label-Satz für die gewählte Sprache (Fallback Englisch). */
export function labelsFor(language: Language): Labels {
  return language === 'de' ? LABELS_DE : LABELS_EN;
}
