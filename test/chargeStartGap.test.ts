import { buildSessions } from '../src/sessions';
import type { ChargeLogSample } from '../src/chargeLog';

/**
 * Der reale Verlauf vom 3. August 2026:
 *
 *   19:50:39   20 %   kein Kabel
 *   20:30      22 %   Kabel steckt, lädt
 *
 * Zwischen zwei Messpunkten wurde eingesteckt und schon geladen. Ohne Kabel
 * fragt das Plugin nur alle zwanzig Minuten nach; die ersten zwei
 * Prozentpunkte fielen in diese Lücke und fehlten der Ladung. Über den
 * Mitschrieb summiert waren es 1,67 kWh, um die Ladungsliste und Zeitreihe
 * auseinanderliefen — sichtbar als „mal fehlt ein Prozent".
 *
 * Ein Ladestand STEIGT nicht von selbst. Blieb der Kilometerstand dabei
 * stehen, gibt es nur eine Erklärung: Es wurde geladen, bevor wir hinsahen.
 */
const t = (h: number, m: number): string => new Date(Date.UTC(2026, 7, 3, h, m)).toISOString();

describe('Ladungsbeginn in der Abfragelücke', () => {
  const verlauf: ChargeLogSample[] = [
    { ts: t(19, 30), soc: 20, odometerKm: 52800, plugged: false },
    { ts: t(19, 50), soc: 20, odometerKm: 52800, plugged: false },
    // 40 Minuten Lücke — hier wird eingesteckt und geladen.
    { ts: t(20, 30), soc: 22, odometerKm: 52800, plugged: true, charging: true },
    { ts: t(21, 30), soc: 40, odometerKm: 52800, plugged: true, charging: true },
    { ts: t(22, 30), soc: 60, odometerKm: 52800, plugged: false },
  ];

  it('rechnet den Zuwachs aus der Lücke der Ladung zu', () => {
    const [s] = buildSessions(verlauf, { capacityKwh: 83.7 });
    // Ohne die Korrektur begänne die Ladung bei 22 % und verlöre zwei Punkte.
    expect(s.startSoc).toBe(20);
    expect(s.endSoc).toBe(60);
  });

  it('verträgt ein paar Kilometer Rangieren', () => {
    // Am Fahrzeug beobachtet: Zwischen dem letzten Punkt ohne Kabel und dem
    // ersten mit Kabel stand ein Kilometer — in die Garage rangiert. Eine
    // Bedingung auf exakt gleichen Kilometerstand griff deshalb nie. Fahren
    // SENKT den Ladestand; steigt er trotzdem, wurde geladen.
    const rangiert: ChargeLogSample[] = [
      { ts: t(19, 50), soc: 20, odometerKm: 53006, plugged: false },
      { ts: t(20, 30), soc: 22, odometerKm: 53007, plugged: true, charging: true },
      { ts: t(21, 30), soc: 40, odometerKm: 53007, plugged: true, charging: true },
      { ts: t(22, 30), soc: 60, odometerKm: 53007, plugged: false },
    ];
    const [s] = buildSessions(rangiert, { capacityKwh: 83.7 });
    expect(s.startSoc).toBe(20);
  });

  it('rechnet NICHT zu, wenn das Auto eine Strecke gefahren ist', () => {
    // Über längere Strecken kann Rekuperation mehrere Prozentpunkte bringen —
    // dann wäre die Zuordnung geraten.
    const gefahren: ChargeLogSample[] = [
      { ts: t(19, 50), soc: 20, odometerKm: 52800, plugged: false },
      { ts: t(20, 30), soc: 22, odometerKm: 52830, plugged: true, charging: true },
      { ts: t(21, 30), soc: 40, odometerKm: 52830, plugged: true, charging: true },
      { ts: t(22, 30), soc: 40, odometerKm: 52830, plugged: false },
    ];
    const [s] = buildSessions(gefahren, { capacityKwh: 83.7 });
    expect(s.startSoc).toBe(22);
  });

  it('rechnet NICHT zu, wenn der Ladestand gefallen ist', () => {
    // Der Normalfall: Zwischen zwei Ladungen wird gefahren.
    const gefallen: ChargeLogSample[] = [
      { ts: t(19, 50), soc: 40, odometerKm: 52800, plugged: false },
      { ts: t(20, 30), soc: 22, odometerKm: 52900, plugged: true, charging: true },
      { ts: t(21, 30), soc: 60, odometerKm: 52900, plugged: true, charging: true },
      { ts: t(22, 30), soc: 60, odometerKm: 52900, plugged: false },
    ];
    const [s] = buildSessions(gefallen, { capacityKwh: 83.7 });
    expect(s.startSoc).toBe(22);
  });

  it('rechnet keinen unplausibel großen Sprung zu', () => {
    // Nach einer langen Lücke ohne Messpunkte ist die Zuordnung nicht mehr
    // belegt — dann lieber die Ladung kleiner ausweisen als etwas erfinden.
    const riesig: ChargeLogSample[] = [
      { ts: t(2, 0), soc: 20, odometerKm: 52800, plugged: false },
      { ts: t(20, 30), soc: 55, odometerKm: 52800, plugged: true, charging: true },
      { ts: t(21, 30), soc: 60, odometerKm: 52800, plugged: true, charging: true },
      { ts: t(22, 30), soc: 60, odometerKm: 52800, plugged: false },
    ];
    const [s] = buildSessions(riesig, { capacityKwh: 83.7 });
    expect(s.startSoc).toBe(55);
  });
});
