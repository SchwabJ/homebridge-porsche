import { parseMeasurements, VehicleState } from '../src/api/measurements';

/** Hüllt measurements in das echte PPA-Antwort-Objekt. */
function ppaResponse(measurements: Array<{ key: string; value: unknown }>): unknown {
  return { vin: 'WP0TEST', modelName: 'Taycan', measurements };
}

describe('parseMeasurements (echte PPA-Struktur)', () => {
  it('parst das echte Live-Beispiel (ladend, verriegelt, Klima aus, GPS-String)', () => {
    const res = ppaResponse([
      { key: 'GPS_LOCATION', value: { location: '48.137154,11.576124', direction: 164 } },
      {
        key: 'CHARGING_SUMMARY',
        value: { status: 'CHARGING', mode: 'PROFILE', type: 'AC', chargingProfile: { minSoC: 80 } },
      },
      { key: 'E_RANGE', value: { kilometers: 199, isRouteBasedRange: false } },
      { key: 'BATTERY_LEVEL', value: { percent: 52 } },
      { key: 'CLIMATIZER_STATE', value: { isOn: false, targetTemperature: 295.15 } },
      { key: 'LOCK_STATE_VEHICLE', value: { isLocked: true } },
    ]);

    const s = parseMeasurements(res);
    expect(s.soc).toBe(52);
    expect(s.rangeKm).toBe(199);
    expect(s.charging).toBe(true);
    expect(s.plugged).toBe(true); // aus Lade-Status abgeleitet (kein plugState beim Laden)
    expect(s.chargingType).toBe('AC');
    expect(s.targetSoc).toBe(80); // chargingProfile.minSoC
    expect(s.locked).toBe(true);
    expect(s.climateOn).toBe(false);
    expect(s.targetTempC).toBe(22); // 295.15 K → 22 °C
    expect(s.lat).toBe(48.137154);
    expect(s.lon).toBe(11.576124);
    expect(s.heading).toBe(164);
  });

  it('parst Verbrenner-Werte: FUEL_LEVEL → fuelLevel, RANGE → fuelRangeKm', () => {
    const s = parseMeasurements(
      ppaResponse([
        { key: 'FUEL_LEVEL', value: { percent: 64 } },
        { key: 'RANGE', value: { kilometers: 540 } },
        { key: 'LOCK_STATE_VEHICLE', value: { isLocked: true } },
      ]),
    );
    expect(s.fuelLevel).toBe(64);
    expect(s.fuelRangeKm).toBe(540);
    // Kein E-Antrieb gemeldet → SoC/E-Reichweite bleiben undefined.
    expect(s.soc).toBeUndefined();
    expect(s.rangeKm).toBeUndefined();
  });

  it('PHEV: E_RANGE und RANGE getrennt, beide Energie-Größen vorhanden', () => {
    const s = parseMeasurements(
      ppaResponse([
        { key: 'BATTERY_LEVEL', value: { percent: 70 } },
        { key: 'E_RANGE', value: { kilometers: 40 } },
        { key: 'FUEL_LEVEL', value: { percent: 55 } },
        { key: 'RANGE', value: { kilometers: 600 } },
      ]),
    );
    expect(s.soc).toBe(70);
    expect(s.rangeKm).toBe(40);
    expect(s.fuelLevel).toBe(55);
    expect(s.fuelRangeKm).toBe(600);
  });

  it('parst ALLE Felder aus einer vollständigen echten Antwort', () => {
    const nowMs = Date.parse('2026-06-18T12:00:00Z');
    const res = {
      vin: 'WP0ZZZ99ZTS900000',
      modelName: 'Taycan',
      timestamp: '2026-06-18T11:59:30Z',
      measurements: [
        { key: 'BATTERY_LEVEL', status: { isEnabled: true }, value: { percent: 52 } },
        { key: 'E_RANGE', value: { kilometers: 199 } },
        { key: 'MILEAGE', value: { kilometers: 34210 } },
        {
          key: 'CHARGING_SUMMARY',
          value: {
            status: 'CHARGING',
            type: 'DC',
            targetDateTimeWithOffset: '2026-06-18T13:30:00Z',
            chargingProfile: { minSoC: 80 },
          },
        },
        {
          key: 'CHARGING_RATE',
          value: { chargingPowerkW: 11.2, maxChargingPowerkW: 270, chargingRatekmPerMin: 1.4 },
        },
        {
          key: 'CHARGING_PROFILES',
          value: {
            list: [
              { id: 1, isEnabled: false, name: 'Arbeit', minSoc: 60, chargingOption: 'AC' },
              { id: 2, isEnabled: true, name: 'Zuhause', minSoc: 80, chargingOption: 'AC' },
            ],
          },
        },
        {
          key: 'CLIMATIZER_STATE',
          value: {
            isOn: true,
            targetTemperature: 294.15,
            climateZonesEnabled: { frontLeft: true, frontRight: false, rearLeft: true, rearRight: false },
          },
        },
        { key: 'LOCK_STATE_VEHICLE', value: { isLocked: false } },
        { key: 'OPEN_STATE_DOOR_FRONT_LEFT', value: { isOpen: true } },
        { key: 'OPEN_STATE_DOOR_FRONT_RIGHT', value: { isOpen: false } },
        { key: 'OPEN_STATE_DOOR_REAR_LEFT', value: { isOpen: false } },
        { key: 'OPEN_STATE_DOOR_REAR_RIGHT', value: { isOpen: false } },
        { key: 'OPEN_STATE_LID_FRONT', value: { isOpen: false } },
        { key: 'OPEN_STATE_LID_REAR', value: { isOpen: true } },
        { key: 'OPEN_STATE_WINDOW_FRONT_LEFT', value: { isOpen: false } },
        { key: 'OPEN_STATE_WINDOW_FRONT_RIGHT', value: { isOpen: false } },
        { key: 'OPEN_STATE_WINDOW_REAR_LEFT', value: { isOpen: false } },
        { key: 'OPEN_STATE_WINDOW_REAR_RIGHT', value: { isOpen: true } },
        { key: 'PARKING_BRAKE', value: { isOn: true } },
        { key: 'PARKING_LIGHT', value: { isOn: false } },
        {
          key: 'TIRE_PRESSURE',
          value: {
            frontLeftTire: { actualPressureBar: 2.5, differenceBar: 0.0 },
            frontRightTire: { actualPressureBar: 2.4, differenceBar: -0.1 },
            rearLeftTire: { actualPressureBar: 2.6, differenceBar: 0.1 },
            rearRightTire: { actualPressureBar: 2.1, differenceBar: -0.4 },
          },
        },
        { key: 'MAIN_SERVICE_RANGE', value: { kilometers: 1500 } },
        { key: 'GPS_LOCATION', value: { location: '48.137154,11.576124', direction: 164 } },
        { key: 'GLOBAL_PRIVACY_MODE', value: { isEnabled: false } },
        { key: 'REMOTE_ACCESS_AUTHORIZATION', value: { isEnabled: true } },
      ],
    };

    const s = parseMeasurements(res, nowMs);
    expect(s.soc).toBe(52);
    expect(s.rangeKm).toBe(199);
    expect(s.odometerKm).toBe(34210);
    expect(s.charging).toBe(true);
    expect(s.chargingType).toBe('DC');
    expect(s.chargingPowerKw).toBe(11.2);
    expect(s.maxChargingPowerKw).toBe(270);
    expect(s.chargeRateKmMin).toBe(1.4);
    expect(s.chargeEtaMinutes).toBe(90); // 13:30 - 12:00 = 90 min
    expect(s.targetSoc).toBe(80);
    expect(s.activeProfileName).toBe('Zuhause'); // das isEnabled-Profil
    expect(s.climateOn).toBe(true);
    expect(s.targetTempC).toBe(21); // 294.15 K
    expect(s.climateZones).toEqual({ fl: true, fr: false, rl: true, rr: false });
    expect(s.locked).toBe(false);
    expect(s.doors).toEqual({ fl: true, fr: false, rl: false, rr: false });
    expect(s.frunkOpen).toBe(false);
    expect(s.trunkOpen).toBe(true);
    expect(s.windows).toEqual({ fl: false, fr: false, rl: false, rr: true });
    expect(s.parkingBrake).toBe(true);
    expect(s.parkingLight).toBe(false);
    expect(s.tirePressureBar).toEqual({ fl: 2.5, fr: 2.4, rl: 2.6, rr: 2.1 });
    expect(s.tireDiffBar).toEqual({ fl: 0.0, fr: -0.1, rl: 0.1, rr: -0.4 });
    expect(s.serviceKm).toBe(1500);
    expect(s.heading).toBe(164);
    expect(s.privacyMode).toBe(false);
    expect(s.remoteAccess).toBe(true);
    expect(s.dataTimestamp).toBe(Date.parse('2026-06-18T11:59:30Z'));
  });

  it('chargeEtaMinutes ist nie negativ (Ziel in der Vergangenheit → 0)', () => {
    const nowMs = Date.parse('2026-06-18T14:00:00Z');
    const res = ppaResponse([
      {
        key: 'CHARGING_SUMMARY',
        value: { status: 'CHARGING', targetDateTimeWithOffset: '2026-06-18T13:30:00Z' },
      },
    ]);
    expect(parseMeasurements(res, nowMs).chargeEtaMinutes).toBe(0);
  });

  it('value: undefined / fehlende Sub-Objekte → Felder undefined, kein Throw', () => {
    const res = ppaResponse([
      { key: 'BATTERY_LEVEL', value: undefined },
      { key: 'TIRE_PRESSURE', value: { frontLeftTire: { actualPressureBar: 2.5 } } },
      { key: 'CLIMATIZER_STATE', value: { isOn: true } },
    ]);
    const s = parseMeasurements(res);
    expect(s.soc).toBeUndefined();
    expect(s.targetTempC).toBeUndefined(); // keine targetTemperature
    expect(s.climateZones).toBeUndefined();
    // nur ein Reifen verfügbar → Rest 0
    expect(s.tirePressureBar).toEqual({ fl: 2.5, fr: 0, rl: 0, rr: 0 });
    expect(s.tireDiffBar).toBeUndefined(); // keine differenceBar geliefert
  });

  it('parst nicht-ladend + Klima an + entriegelt', () => {
    const res = ppaResponse([
      { key: 'BATTERY_LEVEL', value: { percent: 80 } },
      { key: 'E_RANGE', value: { kilometers: 300 } },
      { key: 'CHARGING_SUMMARY', value: { status: 'NOT_CHARGING', plugState: 'DISCONNECTED' } },
      { key: 'CLIMATIZER_STATE', value: { isOn: true } },
      { key: 'LOCK_STATE_VEHICLE', value: { isLocked: false } },
    ]);
    const s = parseMeasurements(res);
    expect(s.charging).toBe(false);
    expect(s.plugged).toBe(false);
    expect(s.climateOn).toBe(true);
    expect(s.locked).toBe(false);
    expect(s.soc).toBe(80);
    expect(s.rangeKm).toBe(300);
    expect(s.lat).toBeUndefined();
  });

  it('plugState CONNECTED ohne Laden → plugged=true', () => {
    const res = ppaResponse([
      { key: 'CHARGING_SUMMARY', value: { status: 'NOT_CHARGING', plugState: 'CONNECTED' } },
    ]);
    expect(parseMeasurements(res).plugged).toBe(true);
  });

  it('akzeptiert auch ein bloßes Array (Rückwärtskompatibilität)', () => {
    const s = parseMeasurements([{ key: 'BATTERY_LEVEL', value: { percent: 41 } }]);
    expect(s.soc).toBe(41);
  });

  it('leere measurements / fehlendes Feld / null → Defaults, kein Throw', () => {
    for (const input of [ppaResponse([]), { measurements: undefined }, null, {}, []]) {
      expect(() => parseMeasurements(input)).not.toThrow();
      const s = parseMeasurements(input);
      expect(s.charging).toBe(false);
      // Ohne jede Lade-Information: unbekannt, NICHT „ausgesteckt" — sonst
      // zerschneidet jede leere Antwort eine laufende Ladung.
      expect(s.plugged).toBeUndefined();
      expect(s.climateOn).toBe(false);
      expect(s.soc).toBeUndefined();
    }
  });

  it('ignoriert unbekannte Keys und kaputte GPS-Strings', () => {
    const res = ppaResponse([
      { key: 'BATTERY_LEVEL', value: { percent: 30 } },
      { key: 'TOTALLY_UNKNOWN', value: { foo: 'bar' } },
      { key: 'GPS_LOCATION', value: { location: 'kaputt' } },
    ]);
    const s = parseMeasurements(res);
    expect(s.soc).toBe(30);
    expect(s.lat).toBeUndefined();
    expect(s.lon).toBeUndefined();
  });
});

describe('TRIP_STATISTICS_CYCLIC — die Bauform, die die Schnittstelle wirklich liefert', () => {
  // An der Live-API gemessen (2026-08-01). Der Eintrag ist der ZURÜCKSETZBARE
  // Zyklus-Zähler des Fahrzeugs, nicht eine Monatshistorie: genau ein Eintrag,
  // fünf Felder. Die Monatszahlen der Porsche-App (1586 km im Juli) stammen aus
  // einer serverseitigen Aggregation, an die der Messwert-Endpunkt nicht
  // heranreicht — TRIP_STATISTICS_LONG_TERM, _SHORT_TERM und TRIP_STATISTICS
  // wurden einzeln probiert und antworten nicht.
  const live = {
    key: 'TRIP_STATISTICS_CYCLIC',
    value: {
      list: [
        {
          avgKwhPerHundredKm: 22.5,
          avgSpeedKmh: 19,
          distanceKm: 66,
          drivingTimeMinutes: 217,
          tripEndTime: '2026-07-31T15:17:29Z',
        },
      ],
    },
  };

  it('liest alle fünf Felder des Eintrags', () => {
    const s = parseMeasurements(ppaResponse([live])) as VehicleState;
    expect(s.tripConsumptionKwhPer100Km).toBe(22.5);
    expect(s.tripDistanceKm).toBe(66);
    expect(s.tripDrivingMinutes).toBe(217);
    expect(s.tripAvgSpeedKmh).toBe(19);
    expect(s.tripEndTime).toBe('2026-07-31T15:17:29Z');
  });

  it('hält die Bauform fest, damit ein Formatwechsel auffällt', () => {
    const s = parseMeasurements(ppaResponse([live])) as VehicleState;
    expect(s.tripShape).toEqual({
      count: 1,
      fields: ['avgKwhPerHundredKm', 'avgSpeedKmh', 'distanceKm', 'drivingTimeMinutes', 'tripEndTime'],
    });
  });

  it('nimmt auch die unverschachtelte Form ohne list', () => {
    // Die Schnittstelle hat historisch beide Formen geliefert; der Parser
    // akzeptiert weiterhin beide.
    const s = parseMeasurements(
      ppaResponse([{ key: 'TRIP_STATISTICS_CYCLIC', value: { distanceKm: 40, avgKwhPerHundredKm: 19.5 } }]),
    ) as VehicleState;
    expect(s.tripDistanceKm).toBe(40);
    expect(s.tripShape?.count).toBe(1);
  });

  it('schweigt ohne Fahrtstatistik, statt Nullen zu behaupten', () => {
    const s = parseMeasurements(ppaResponse([])) as VehicleState;
    expect(s.tripShape).toBeUndefined();
    expect(s.tripDistanceKm).toBeUndefined();
    expect(s.tripDrivingMinutes).toBeUndefined();
  });
});
