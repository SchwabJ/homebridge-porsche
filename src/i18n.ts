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
  /** Prognose der laufenden Ladung: „done ~21:40". */
  dashDoneAbout: string;
  /** Reine Ladezeit ohne Uhrzeit — bei tarifgesteuertem Laden. */
  dashChargingLeft: string;
  /** Warnung statt Prognose, wenn die Ladung hängt. */
  dashStalled: string;
  dashNotPlugged: string;
  /** Die Schnittstelle hat den Steckerzustand nicht geliefert. */
  dashPlugUnknown: string;
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
  /** Zusatz in der Kosten-Kachel: das Wort fuer eine Ersparnis. */
  dashSavedSuffix: string;
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
  dashChargeOne: string;
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
  /** Überschrift des Fahrtenabschnitts. */
  dashTripsHeading: string;
  dashTripEnd: string;
  dashTripDistance: string;
  dashTripConsumption: string;
  /** Deckel-Hinweis der Ladungsliste. `%n` gezeigt, `%t` gesamt. */
  dashChargesCapped: string;
  /** Deckel-Hinweis der Fahrtenliste. `%n` gezeigt, `%t` gesamt. */
  dashTripsCapped: string;
  /** Wie die Fahrten entstehen. `%n` = Abfrageabstand in Minuten. */
  dashTripsNote: string;
  /** Nicht bewertete Strecke. `%r` bewertet, `%k` gesamt. */
  dashTripsUnrated: string;
  /** Beleg: Kopfzeilen und Spalten. */
  rcTitle: string;
  rcVehicle: string;
  rcMonth: string;
  rcPlace: string;
  rcUnknownPlace: string;
  /** Spaltenköpfe der Fahrten-CSV und des Fahrtenberichts. */
  csvEnd: string;
  csvMinutes: string;
  csvOdometer: string;
  csvType: string;
  csvPluggedMinutes: string;
  csvChargingMinutes: string;
  /** Überschrift und Leerzustand des Fahrtenberichts. */
  trTitle: string;
  trEmpty: string;
  trTrip: string;
  trTrips: string;
  /** Aktionszeile unter beiden Listen. */
  dashReport: string;
  /** Standardansicht der Seite (Tag/Woche/Monat/Jahr). */
  setDefaultView: string;
  setDefaultViewHint: string;
  /** Kapazität automatisch aus der Messung übernehmen. */
  setAutoCapacity: string;
  setAutoCapacityHint: string;
  /** Ab wann ein neuer Arbeitspreis gilt. */
  setPriceFrom: string;
  setPriceFromHint: string;
  rcSumHome: string;
  rcSumAway: string;
  rcSumUnknown: string;
  rcCsv: string;
  rcPrint: string;
  rcNoCharges: string;
  /** Fußnote des Belegs. `%v` Fahrzeug, `%m` Monat, `%c` Kapazität in kWh. */
  rcFootnote: string;
  /** Verweis auf den Beleg unter der Ladungsliste. */
  dashReceiptLink: string;
  /** Marke an einer abgebrochenen Ladung. `%e` erreicht, `%t` Ziel. */
  dashAborted: string;
  /** Kapazitätsverlauf. `%a` erster Wert, `%b` letzter, `%n` Monate. */
  capTrendOver: string;
  stRealRange: string;
  /** Einheit der Reichweiten-Kachel — die Zahl steht davor. */
  stRealRangeUnit: string;
  /** Detail der Reichweiten-Kachel. `%n` = zugrunde liegende Strecke in km. */
  stRealRangeDetail: string;
  stIdleDrain: string;
  stIdleDrainUnit: string;
  /** Detail des Standverbrauchs. `%n` = beobachtete Standzeit in Stunden. */
  stIdleDrainDetail: string;
  /** Vorsatz, wenn der Wert eine Obergrenze ist statt einer Messung. */
  stIdleDrainAtMost: string;
  /** Kachelwert, solange noch zu wenig Ruhezeit beobachtet wurde. */
  stIdleDrainCollecting: string;
  /** Fortschritt: „%n von %m h Ruhe gesammelt". */
  stIdleDrainProgress: string;
  stAborted: string;
  /** Einheit der Abbruch-Kachel. `%t` = Ziel-Ladestand. */
  stAbortedUnit: string;
  /** Detail der Abbruch-Kachel. `%d` = Zeitpunkt. */
  stAbortedDetail: string;
  stTitle: string;
  stBackToCharging: string;
  stTyrePressure: string;
  stFrontLeft: string;
  stFrontRight: string;
  stRearLeft: string;
  stRearRight: string;
  stToTarget: string;
  stNoTyreData: string;
  stVehicle: string;
  stNextService: string;
  stOdometer: string;
  stLast7Days: string;
  stChargeLevel: string;
  /**
   * Texte der Push-Meldungen.
   *
   * Sie waren als einzige fest deutsch — ein Nutzer in England bekam einen
   * englischen Bildschirm und eine deutsche Benachrichtigung aufs Telefon.
   */
  pushReportTitle: string;
  pushSessionTitle: string;
  pushAbortedTitle: string;
  pushStallTitle: string;
  pushYesterday: string;
  pushNoCharge: string;
  pushDriven: string;
  pushAverage: string;
  pushFor: string;
  pushLevel: string;
  /** „Am Kabel: 10 h, davon 3 h geladen" — {0} Kabelzeit, {1} reine Ladezeit. */
  pushCableLine: string;
  pushPeak: string;
  /** „Nur 55 % statt 80 %" — {0} erreicht, {1} Ziel. */
  pushAbortedLine: string;
  /** Erklärt, warum das ein Abbruch war und kein Ausstecken. */
  pushAbortedCable: string;
  /** „Steht bei 55 %, Ziel 80 %" — {0} erreicht, {1} Ziel. */
  pushStallLine: string;
  /** Ohne bekannten Ladestand. */
  pushStallLinePlain: string;
  /** „Noch am Kabel seit 3 h 20 min" — {0} Dauer. */
  pushStallSince: string;
  /** Batterie-Nachweis: Überschrift und Felder. */
  battTitle: string;
  battMeasured: string;
  /** „90,1 % der eingestellten 83,7 kWh" — {0} Prozent, {1} Werksangabe. */
  battOfRated: string;
  battVehicle: string;
  battRated: string;
  battCycles: string;
  battDistance: string;
  battPeriod: string;
  /** „(105 Tage)" — {0} Tage. */
  battDays: string;
  battLoss: string;
  battNotYet: string;
  battNoMeasurement: string;
  /** „Erst {0} Zyklen gemessen — belastbar ab {1}." */
  battFewCycles: string;
  /** „Erst {0} Tage erfasst … (belastbar ab {1} Tagen)." */
  battShortPeriod: string;
  battMonth: string;
  battReadings: string;
  battMethod: string;
  battPrint: string;
  battBack: string;
  /** Warnung bei hohem Ruheverlust. */
  pushIdleTitle: string;
  /** Verlust je Tag, Energie und Beobachtungsdauer als Platzhalter. */
  pushIdleLine: string;
  pushIdleAdvice: string;
  /** Warnung, wenn die Batterie messbar nachgelassen hat. */
  pushHealthTitle: string;
  /** Kapazitaet, Gesundheit und Verlust als Platzhalter. */
  pushHealthLine: string;
  pushHealthAdvice: string;
  /** Jahresnachweis fuer die Dienstwagen-Erstattung. */
  yrTitle: string;
  yrBackToMonth: string;
  yrHomeCharged: string;
  yrCharges: string;
  /** Jahressumme; {0} ist das Jahr. */
  yrTotal: string;
  yrAlsoAway: string;
  yrAlsoUnknown: string;
  yrEmpty: string;
  yrNote: string;
  yrLink: string;
  /** Beschriftungen der Befehlsknoepfe. */
  cmdPreclimate: string;
  cmdClimateOff: string;
  cmdChargeStart: string;
  cmdChargeStop: string;
  cmdChargeStopAsk: string;
  cmdLock: string;
  cmdFailed: string;
  stRangeSuffix: string;
  stSecurity: string;
  stLocked: string;
  stAllClosed: string;
  stClimate: string;
  stYes: string;
  stNo: string;
  stOn: string;
  stOff: string;
  stTargetTemp: string;
  stAgoMin: string;
  stAgoHour: string;
  stFootnote: string;
  stOpenUnsettled: string;
  navOlder: string;
  navNewer: string;
  navNow: string;
  stStableOver: string;
  stChangeOver: string;
  stPerWeek: string;
  stAbout: string;
  stYearsLeft: string;
  /** Einzahl zu {@link Labels.stYearsLeft} — „noch gut 1 Jahre" war falsch. */
  stYearLeft: string;
  aggWeek: string;
  placeAll: string;
  placeHome: string;
  placeAway: string;
  dashNoAwayPrice: string;
  dashSomeAwayUnpriced: string;
  pfAmount: string;
  pfProvider: string;
  pfSave: string;
  pfSaved: string;
  pfFailed: string;
  capDrive: string;
  capDrives: string;
  capFewCycles: string;
  setTitle: string;
  setBack: string;
  setPrice: string;
  setPriceHint: string;
  setBonus: string;
  setBonusHint: string;
  setExternal: string;
  setExternalHint: string;
  setCapacity: string;
  setCapacityHint: string;
  setDayBoundary: string;
  setDayBoundaryHint: string;
  setAdopt: string;
  setAdoptHint: string;
  setAdoptFrom: string;
  setMeasured: string;
  setFooter: string;
  setFooterTail: string;
  dashActive: string;
  dashComparedTo: string;
  dashInProgress: string;
  chartInstantTo: string;
  chartTargetMark: string;
  chartCurveAria: string;
  chartBarsAria: string;
  /** Aria-Label des Diagramms mit Gegenbalken. */
  chartBarsBothAria: string;
  /** Legende und Tooltip des Diagramms. */
  chartCharged: string;
  chartUsed: string;
  /** Offene Strecke im Tooltip. `%n` = km. */
  chartUnrated: string;
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
  dashDoneAbout: 'done ~',
  dashChargingLeft: 'of charging left',
  dashStalled: 'stalled — no power for hours',
  dashNotPlugged: 'Not plugged in',
  dashPlugUnknown: 'Plug state unknown',
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
  dashSavedSuffix: 'saved',
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
  dashChargeOne: 'charge',
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
  dashTripsHeading: 'Trips',
  dashTripEnd: 'End',
  dashTripDistance: 'Distance',
  dashTripConsumption: 'Consumption',
  dashChargesCapped: 'The most recent %n of %t charges — tiles and chart use all of them.',
  dashTripsCapped: 'The most recent %n of %t trips. ',
  dashTripsNote:
    'Derived from the odometer — polled every %n minutes while unplugged, so short stops merge into a single trip.',
  dashTripsUnrated: ' Consumption is only reliable for %r of %k km.',
  rcTitle: 'Charging receipt',
  rcVehicle: 'Vehicle',
  rcMonth: 'Month',
  rcPlace: 'Place',
  rcUnknownPlace: 'unknown',
  csvEnd: 'End',
  csvMinutes: 'Minutes',
  csvOdometer: 'Odometer',
  csvType: 'Type',
  csvPluggedMinutes: 'Minutes plugged in',
  csvChargingMinutes: 'of which charging',
  trTitle: 'Trip report',
  trEmpty: 'No trips in this month.',
  trTrip: 'trip',
  trTrips: 'trips',
  dashReport: 'Report',
  setDefaultView: 'Default view',
  setDefaultViewHint: 'The view the dashboard opens with. You can still switch at any time.',
  setAutoCapacity: 'Adopt measured capacity',
  setAutoCapacityHint: 'Once enough discharge cycles are available, the measured value replaces the configured one.',
  setPriceFrom: 'Valid from',
  setPriceFromHint: 'Day the new price takes effect. Charges before it keep the old one. Empty means today.',
  rcSumHome: 'Total at home',
  rcSumAway: 'Total away',
  rcSumUnknown: 'Total without location',
  rcCsv: 'Download as CSV',
  rcPrint: 'Print',
  rcNoCharges: 'No charging in this month.',
  rcFootnote:
    '%v · %m. The energy is not metered at the socket but calculated from the state of charge: the increase in percentage points times %c kWh of usable capacity. Charging losses between socket and battery are not included — the electricity actually drawn is correspondingly higher.',
  dashReceiptLink: 'Monthly receipt, ready to print or hand on ›',
  dashAborted: 'at %e % instead of %t %',
  capTrendOver: '%a → %b kWh over %n months',
  stRealRange: 'Real range',
  stRealRangeUnit: 'of every 100 km',
  stRealRangeDetail: 'from %n km of driving',
  stIdleDrain: 'Idle drain',
  stIdleDrainUnit: 'kWh/day',
  stIdleDrainDetail: 'from %n h of true idle time',
  stIdleDrainAtMost: 'under ',
  stIdleDrainCollecting: 'collecting',
  stIdleDrainProgress: '%n of %m h idle time collected',
  stAborted: 'Charge aborted',
  stAbortedUnit: '% instead of %t %',
  stAbortedDetail: '%d — still plugged in, but without power for over an hour',
  stTitle: 'Vehicle status',
  stBackToCharging: 'Charging history',
  stTyrePressure: 'Tyre pressure',
  stFrontLeft: 'front left',
  stFrontRight: 'front right',
  stRearLeft: 'rear left',
  stRearRight: 'rear right',
  stToTarget: 'to target',
  stNoTyreData: 'No tyre pressure recorded yet.',
  stVehicle: 'Vehicle',
  stNextService: 'Next service',
  stOdometer: 'Odometer',
  stLast7Days: 'Last 7 days',
  stChargeLevel: 'Charge level',
  pushReportTitle: 'charging report',
  pushSessionTitle: 'charging finished',
  pushAbortedTitle: 'charging aborted',
  pushStallTitle: 'charging stalled',
  pushYesterday: 'Yesterday',
  pushNoCharge: 'no charging',
  pushDriven: 'Driven',
  pushAverage: 'Average',
  pushFor: 'for',
  pushLevel: 'Charge level',
  pushCableLine: 'Plugged in: {0}, charging for {1}',
  pushPeak: 'Peak',
  pushAbortedLine: 'Only {0} % instead of {1} %',
  pushAbortedCable: 'the car was still plugged in and stopped charging.',
  pushStallLine: 'At {0} %, target {1} % — no power for over two hours.',
  pushStallLinePlain: 'No power for over two hours, and the target is not reached.',
  pushStallSince: 'Still plugged in for {0}.',
  battTitle: 'Battery report',
  battMeasured: 'measured usable capacity',
  battOfRated: '{0} % of the configured {1} kWh',
  battVehicle: 'Vehicle',
  battRated: 'Rated capacity',
  battCycles: 'Discharge cycles',
  battDistance: 'Distance covered',
  battPeriod: 'Period',
  battDays: '({0} days)',
  battLoss: 'Loss over the period',
  battNotYet: 'not reliable yet',
  battNoMeasurement: 'No measurement yet. One appears by itself once the car has covered a distance between two charges.',
  battFewCycles: 'Only {0} cycles measured — reliable from {1}.',
  battShortPeriod: 'Only {0} days covered — over such a short span, ageing cannot be told apart from ordinary scatter (reliable from {1} days).',
  battMonth: 'Month',
  battReadings: 'Readings',
  battMethod: 'How this is measured: between two charges the car covers a distance and loses state of charge. Together with the consumption the car reports, that gives the energy behind one percentage point — and from it the usable capacity. Each such stretch is one reading; what is stated is their median rather than their mean, so that a single drive in frost or with heavy preconditioning does not pull the result. The uncertainty is the larger of the statistical error and a systematic floor that does not shrink with more cycles.',
  battPrint: 'Print',
  battBack: '‹ Back',
  pushIdleTitle: 'high idle drain',
  pushIdleLine: '{0} % per day while parked ({1} kWh), measured over {2} days of standstill.',
  pushHealthTitle: 'battery has degraded',
  pushHealthLine: 'Measured {0} kWh, which is {1} % of the rated capacity{2}.',
  pushHealthAdvice: 'The report with trend and data basis is ready at /batterie - print it and keep it while the warranty still runs.',
  yrTitle: 'Annual statement',
  yrBackToMonth: '‹ Monthly receipt',
  yrHomeCharged: 'Charged at home',
  yrCharges: 'Charges',
  yrTotal: 'Total {0} at home',
  yrAlsoAway: 'for reference: away',
  yrAlsoUnknown: 'for reference: place unknown',
  yrEmpty: 'Nothing was charged in this year.',
  yrNote: 'Stated is the energy charged at home — only that qualifies for reimbursement by an employer; away from home the charging provider bills you directly. The individual charges with their times and levels are in the monthly receipt. A charge is assigned by when it started: a night charge from the 31st into the 1st belongs entirely to the earlier month, because it was paid for as one.',
  yrLink: 'Annual statement',
  cmdPreclimate: 'Precondition',
  cmdClimateOff: 'Climate off',
  cmdChargeStart: 'Start charging',
  cmdChargeStop: 'Stop charging',
  cmdChargeStopAsk: 'Really stop charging?',
  cmdLock: 'Lock',
  cmdFailed: 'did not work',
  pushIdleAdvice: 'Well under 1 % is normal. If preconditioning and auxiliary heating were off, this is worth showing to a workshop — reported cases came down to a single weak cell.',
  stRangeSuffix: 'km of range',
  stSecurity: 'Security',
  stLocked: 'Locked',
  stAllClosed: 'All closed',
  stClimate: 'Climate',
  stYes: 'yes',
  stNo: 'no',
  stOn: 'on',
  stOff: 'off',
  stTargetTemp: 'Target',
  stAgoMin: '%n min ago',
  stAgoHour: '%n h ago',
  stFootnote: 'State values are only recorded when they change — the time above each block is therefore the last KNOWN reading, not the last poll. The interface provides no outside temperature.',
  stOpenUnsettled: 'reported for %n min — often delayed after parking',
  navOlder: 'Earlier',
  navNewer: 'Later',
  navNow: 'today',
  stStableOver: 'stable over %n days',
  stChangeOver: '%v bar in %n days',
  stPerWeek: 'at %n km/week',
  stAbout: 'about',
  stYearsLeft: 'over %n more years',
  stYearLeft: 'over %n more year',
  aggWeek: 'CW',
  placeAll: 'All',
  placeHome: 'Home',
  placeAway: 'Away',
  dashNoAwayPrice: 'No price for charging away yet. Enter one per charge, or set a default in the settings — your home tariff does not apply here.',
  dashSomeAwayUnpriced: 'Some charges away have no price yet and are missing from the cost total.',
  pfAmount: 'Amount',
  pfProvider: 'Provider',
  pfSave: 'Save',
  pfSaved: 'saved',
  pfFailed: 'not saved',
  capDrive: 'drive',
  capDrives: 'drives',
  capFewCycles: 'few drives so far, the value may still move',
  setTitle: 'Settings',
  setBack: 'Back',
  setPrice: 'Energy price',
  setPriceHint: 'Cents per kWh. 0 hides all cost figures.',
  setBonus: 'Charging bonus',
  setBonusHint: 'Cents per kWh deducted from the energy price.',
  setExternal: 'Price away',
  setExternalHint: 'Cents per kWh as a default for charges away from home. Can be overridden per charge.',
  setCapacity: 'Capacity',
  setCapacityHint: 'Usable kWh. Every energy figure scales linearly with it.',
  setDayBoundary: 'Day starts at',
  setDayBoundaryHint: 'Hour at which a new day counts. 4 assigns an overnight charge to the evening it started.',
  setAdopt: 'Adopt measured value',
  setAdoptHint: 'Measured from your drives between charges. Changes every kWh and cost figure retroactively.',
  setAdoptFrom: 'Offered for adoption from %n drives on — below that the estimate still moves too much.',
  setMeasured: 'Measured',
  setFooter: 'The port and poll intervals live in',
  setFooterTail: '— they only take effect after a restart.',
  dashActive: 'active',
  dashComparedTo: 'vs.',
  dashInProgress: 'in progress',
  chartInstantTo: 'instant',
  chartTargetMark: 'target',
  chartCurveAria: 'Charging curve: state of charge over time',
  chartBarsAria: 'Energy charged per period',
  chartBarsBothAria: 'Energy charged upwards, energy used downwards, per period',
  chartCharged: 'charged',
  chartUsed: 'used',
  chartUnrated: '%n km without a reliable consumption figure',
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
  dashDoneAbout: 'fertig ~',
  dashChargingLeft: 'reine Ladezeit',
  dashStalled: 'hängt — seit Stunden kein Strom',
  dashNotPlugged: 'Nicht eingesteckt',
  dashPlugUnknown: 'Steckerzustand unbekannt',
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
  dashSavedSuffix: 'gespart',
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
  dashChargeOne: 'Ladung',
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
  dashTripsHeading: 'Fahrten',
  dashTripEnd: 'Ende',
  dashTripDistance: 'Strecke',
  dashTripConsumption: 'Verbrauch',
  dashChargesCapped: 'Die jüngsten %n von %t Ladungen — Kacheln und Diagramm rechnen mit allen.',
  dashTripsCapped: 'Die jüngsten %n von %t Fahrten. ',
  dashTripsNote:
    'Aus dem Kilometerstand abgeleitet — ohne Kabel wird alle %n Minuten abgefragt, kurze Pausen verschmelzen deshalb zu einer Fahrt.',
  dashTripsUnrated: ' Verbrauch nur für %r der %k km belastbar.',
  rcTitle: 'Ladebeleg',
  rcVehicle: 'Fahrzeug',
  rcMonth: 'Monat',
  rcPlace: 'Ort',
  rcUnknownPlace: 'unbekannt',
  csvEnd: 'Ende',
  csvMinutes: 'Minuten',
  csvOdometer: 'Kilometerstand',
  csvType: 'Typ',
  csvPluggedMinutes: 'Minuten am Kabel',
  csvChargingMinutes: 'davon geladen',
  trTitle: 'Fahrtenbericht',
  trEmpty: 'In diesem Monat wurde nicht gefahren.',
  trTrip: 'Fahrt',
  trTrips: 'Fahrten',
  dashReport: 'Bericht',
  setDefaultView: 'Standardansicht',
  setDefaultViewHint: 'Mit dieser Ansicht öffnet das Dashboard. Umschalten geht weiterhin jederzeit.',
  setAutoCapacity: 'Messwert übernehmen',
  setAutoCapacityHint: 'Sobald genug Entladezyklen vorliegen, ersetzt die Messung den eingestellten Wert.',
  setPriceFrom: 'Gilt ab',
  setPriceFromHint: 'Tag, ab dem der neue Preis gilt. Ladungen davor behalten den alten. Leer heißt heute.',
  rcSumHome: 'Summe zuhause',
  rcSumAway: 'Summe unterwegs',
  rcSumUnknown: 'Summe ohne Ortsangabe',
  rcCsv: 'Als CSV laden',
  rcPrint: 'Drucken',
  rcNoCharges: 'In diesem Monat wurde nicht geladen.',
  rcFootnote:
    '%v · %m. Die Energiemenge ist nicht an der Steckdose gemessen, sondern aus dem Ladestand des Fahrzeugs gerechnet: Zuwachs in Prozentpunkten mal %c kWh nutzbarer Kapazität. Ladeverluste zwischen Steckdose und Batterie sind darin nicht enthalten — die tatsächlich bezogene Strommenge liegt entsprechend höher.',
  dashReceiptLink: 'Monatsbeleg zum Ausdrucken oder Weiterreichen ›',
  dashAborted: 'bei %e % statt %t %',
  capTrendOver: '%a → %b kWh über %n Monate',
  stRealRange: 'Reichweite real',
  stRealRangeUnit: 'von je 100 km',
  stRealRangeDetail: 'aus %n km Fahrt',
  stIdleDrain: 'Standverbrauch',
  stIdleDrainUnit: 'kWh/Tag',
  stIdleDrainDetail: 'aus %n h echter Ruhezeit',
  stIdleDrainAtMost: 'unter ',
  stIdleDrainCollecting: 'sammelt',
  stIdleDrainProgress: '%n von %m h Ruhe gesammelt',
  stAborted: 'Ladung abgebrochen',
  stAbortedUnit: '% statt %t %',
  stAbortedDetail: '%d — am Kabel, aber seit über einer Stunde ohne Strom',
  stTitle: 'Zustand',
  stBackToCharging: 'Ladehistorie',
  stTyrePressure: 'Reifendruck',
  stFrontLeft: 'vorne links',
  stFrontRight: 'vorne rechts',
  stRearLeft: 'hinten links',
  stRearRight: 'hinten rechts',
  stToTarget: 'zum Soll',
  stNoTyreData: 'Noch kein Reifendruck erfasst.',
  stVehicle: 'Fahrzeug',
  stNextService: 'Nächster Service',
  stOdometer: 'Kilometerstand',
  stLast7Days: 'Letzte 7 Tage',
  stChargeLevel: 'Ladestand',
  pushReportTitle: 'Ladebericht',
  pushSessionTitle: 'Ladung beendet',
  pushAbortedTitle: 'Ladung abgebrochen',
  pushStallTitle: 'Ladung hängt',
  pushYesterday: 'Gestern',
  pushNoCharge: 'keine Ladung',
  pushDriven: 'Gefahren',
  pushAverage: 'Schnitt',
  pushFor: 'für',
  pushLevel: 'Ladestand',
  pushCableLine: 'Am Kabel: {0}, davon {1} geladen',
  pushPeak: 'Spitze',
  pushAbortedLine: 'Nur {0} % statt {1} %',
  pushAbortedCable: 'das Auto stand noch am Kabel und hat aufgehört zu laden.',
  pushStallLine: 'Steht bei {0} %, Ziel {1} % — seit über zwei Stunden fließt kein Strom.',
  pushStallLinePlain: 'Seit über zwei Stunden fließt kein Strom, das Ziel ist nicht erreicht.',
  pushStallSince: 'Noch am Kabel seit {0}.',
  battTitle: 'Batterie-Nachweis',
  battMeasured: 'gemessene nutzbare Kapazität',
  battOfRated: '{0} % der eingestellten {1} kWh',
  battVehicle: 'Fahrzeug',
  battRated: 'Werksangabe',
  battCycles: 'Entladezyklen',
  battDistance: 'Erfasste Strecke',
  battPeriod: 'Zeitraum',
  battDays: '({0} Tage)',
  battLoss: 'Verlust im Zeitraum',
  battNotYet: 'noch nicht belastbar',
  battNoMeasurement: 'Noch keine Messung. Sie entsteht von selbst, sobald das Fahrzeug eine Strecke zwischen zwei Ladungen zurückgelegt hat.',
  battFewCycles: 'Erst {0} Zyklen gemessen — belastbar ab {1}.',
  battShortPeriod: 'Erst {0} Tage erfasst — über einen so kurzen Zeitraum ist Alterung von der normalen Streuung nicht zu unterscheiden (belastbar ab {1} Tagen).',
  battMonth: 'Monat',
  battReadings: 'Messungen',
  battMethod: 'So wird gemessen: Zwischen zwei Ladungen legt das Fahrzeug eine Strecke zurück und verliert dabei Ladestand. Zusammen mit dem vom Fahrzeug gemeldeten Verbrauch ergibt sich daraus, wie viel Energie ein Prozentpunkt trägt — und daraus die nutzbare Kapazität. Jeder solche Abschnitt ist eine Einzelmessung; ausgewiesen wird ihr Median, nicht ihr Mittelwert, damit eine einzelne Fahrt bei Frost oder mit viel Standklima das Ergebnis nicht zieht. Die Unsicherheit ist das Größere aus dem statistischen Fehler und einem systematischen Boden, der auch mit vielen Zyklen nicht verschwindet.',
  battPrint: 'Drucken',
  battBack: '‹ Zurück',
  pushIdleTitle: 'hoher Ruheverlust',
  pushIdleLine: '{0} % je Tag im Stehen ({1} kWh), gemessen über {2} Tage Stillstand.',
  pushHealthTitle: 'Batterie hat nachgelassen',
  pushHealthLine: 'Gemessen {0} kWh, das sind {1} % der Werksangabe{2}.',
  pushHealthAdvice: 'Der Nachweis mit Verlauf und Datenbasis liegt unter /batterie bereit — ausdrucken und aufheben, solange die Garantie noch läuft.',
  yrTitle: 'Jahresnachweis',
  yrBackToMonth: '‹ Monatsbeleg',
  yrHomeCharged: 'Zuhause geladen',
  yrCharges: 'Ladungen',
  yrTotal: 'Summe {0} zuhause',
  yrAlsoAway: 'nachrichtlich: unterwegs',
  yrAlsoUnknown: 'nachrichtlich: ohne Ortsangabe',
  yrEmpty: 'In diesem Jahr wurde nicht geladen.',
  yrNote: 'Ausgewiesen ist die zuhause geladene Energie — nur sie kommt für eine Erstattung durch den Arbeitgeber in Betracht; unterwegs rechnet der Ladeanbieter selbst ab. Die einzelnen Ladungen samt Zeitpunkt und Ladestand stehen im Monatsbeleg. Zugeordnet wird nach dem Beginn der Ladung: Eine Nachtladung vom 31. auf den 1. gehört vollständig in den alten Monat, weil sie als Ganzes bezahlt wurde.',
  yrLink: 'Jahresnachweis',
  cmdPreclimate: 'Vorklimatisieren',
  cmdClimateOff: 'Klima aus',
  cmdChargeStart: 'Laden starten',
  cmdChargeStop: 'Laden stoppen',
  cmdChargeStopAsk: 'Laden wirklich stoppen?',
  cmdLock: 'Verriegeln',
  cmdFailed: 'ging nicht',
  pushIdleAdvice: 'Normal ist deutlich unter 1 %. Wenn Vorklimatisierung und Standheizung aus waren, gehört das in der Werkstatt angesehen — gemeldete Fälle gingen auf eine einzelne schwache Zelle zurück.',
  stRangeSuffix: 'km Reichweite',
  stSecurity: 'Sicherung',
  stLocked: 'Verriegelt',
  stAllClosed: 'Alles geschlossen',
  stClimate: 'Klima',
  stYes: 'ja',
  stNo: 'nein',
  stOn: 'an',
  stOff: 'aus',
  stTargetTemp: 'Ziel',
  stAgoMin: 'vor %n min',
  stAgoHour: 'vor %n h',
  stFootnote: 'Zustandswerte werden nur mitgeschrieben, wenn sie sich ändern — der Zeitpunkt über jedem Block ist deshalb der letzte BEKANNTE Stand, nicht der letzte Abruf. Eine Außentemperatur liefert die Schnittstelle nicht.',
  stOpenUnsettled: 'seit %n min gemeldet — nach dem Abstellen oft verspätet',
  navOlder: 'Früher',
  navNewer: 'Später',
  navNow: 'heute',
  stStableOver: 'stabil über %n Tage',
  stChangeOver: '%v bar in %n Tagen',
  stPerWeek: 'bei %n km/Woche',
  stAbout: 'etwa',
  stYearsLeft: 'noch gut %n Jahre',
  stYearLeft: 'noch gut %n Jahr',
  aggWeek: 'KW',
  placeAll: 'Alle',
  placeHome: 'Zuhause',
  placeAway: 'Unterwegs',
  dashNoAwayPrice: 'Noch kein Preis für unterwegs. Trage ihn je Ladung ein oder hinterlege einen Vorgabepreis in den Einstellungen — der Haustarif gilt hier nicht.',
  dashSomeAwayUnpriced: 'Einzelne Ladungen unterwegs haben noch keinen Preis und fehlen deshalb in der Kostensumme.',
  pfAmount: 'Betrag',
  pfProvider: 'Anbieter',
  pfSave: 'Sichern',
  pfSaved: 'gesichert',
  pfFailed: 'nicht gespeichert',
  capDrive: 'Fahrt',
  capDrives: 'Fahrten',
  capFewCycles: 'noch wenige Fahrten, Wert kann sich verschieben',
  setTitle: 'Einstellungen',
  setBack: 'Zurück',
  setPrice: 'Arbeitspreis',
  setPriceHint: 'Cent je kWh. 0 blendet alle Kosten aus.',
  setBonus: 'Ladebonus',
  setBonusHint: 'Cent je kWh, die vom Arbeitspreis abgezogen werden.',
  setExternal: 'Preis unterwegs',
  setExternalHint: 'Cent je kWh als Vorgabe für Fremdladungen. Je Ladung überschreibbar.',
  setCapacity: 'Kapazität',
  setCapacityHint: 'Nutzbare kWh. Jede Energiemenge hängt linear daran.',
  setDayBoundary: 'Tagesgrenze',
  setDayBoundaryHint: 'Stunde, ab der ein neuer Tag zählt. 4 schlägt eine Nachtladung dem Vorabend zu.',
  setAdopt: 'Messwert übernehmen',
  setAdoptHint: 'Aus deinen Fahrten zwischen Ladungen gemessen. Ändert rückwirkend alle kWh- und Kostenzahlen.',
  setAdoptFrom: 'Zur Übernahme angeboten ab %n Fahrten — vorher schwankt die Schätzung zu stark.',
  setMeasured: 'Gemessen',
  setFooter: 'Port und Abfrage-Intervalle stehen in',
  setFooterTail: '— sie greifen erst nach einem Neustart.',
  dashActive: 'aktiv',
  dashComparedTo: 'ggü.',
  dashInProgress: 'laufend',
  chartInstantTo: 'sofort',
  chartTargetMark: 'Ziel',
  chartCurveAria: 'Ladeverlauf: Ladestand über die Zeit',
  chartBarsAria: 'Geladene Energie je Zeitraum',
  chartBarsBothAria: 'Geladene Energie nach oben, verbrauchte nach unten, je Zeitraum',
  chartCharged: 'geladen',
  chartUsed: 'verbraucht',
  chartUnrated: '%n km ohne belastbaren Verbrauch',
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

/**
 * Ersetzt `{0}`, `{1}`, … in einem Label durch die übergebenen Werte.
 *
 * Nötig, weil sich Satzbau zwischen Sprachen unterscheidet: „Only 55 %
 * instead of 80 %" und „Nur 55 % statt 80 %" tragen dieselben Zahlen an
 * verschiedenen Stellen. Ein zusammengestückelter Satz aus Textfragmenten
 * ergäbe in der einen Sprache Sinn und in der anderen Kauderwelsch.
 */
export function fill(template: string, ...values: Array<string | number>): string {
  return template.replace(/\{(\d+)\}/g, (treffer, i) => {
    const v = values[Number(i)];
    return v === undefined ? treffer : String(v);
  });
}
