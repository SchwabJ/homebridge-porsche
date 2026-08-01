import { chargeWindowAction, parseWindow } from '../src/chargeWindow';

/** 2026-08-01, lokale Zeit — die Fenster denkt der Nutzer in Ortszeit. */
const um = (h: number, m = 0): Date => new Date(2026, 7, 1, h, m);

const amKabel = {
  plugged: true,
  charging: false,
  soc: 40,
  targetSoc: 80,
  minSoc: 30,
};

describe('parseWindow', () => {
  it('nimmt HH:MM', () => {
    expect(parseWindow('00:30', '04:30')).toEqual({ fromMin: 30, toMin: 270 });
  });

  it('weist Unsinn zurück, statt ihn zu raten', () => {
    // Ein falsch geschriebenes Fenster darf nicht stillschweigend zu einem
    // anderen werden — das Auto stünde sonst morgens ungeladen da.
    expect(parseWindow('24:00', '04:30')).toBeUndefined();
    expect(parseWindow('00:60', '04:30')).toBeUndefined();
    expect(parseWindow('halb eins', '04:30')).toBeUndefined();
    expect(parseWindow('', '')).toBeUndefined();
  });

  it('weist ein Fenster der Länge null zurück', () => {
    expect(parseWindow('01:00', '01:00')).toBeUndefined();
  });
});

describe('chargeWindowAction — im Fenster laden', () => {
  const f = parseWindow('00:30', '04:30');

  it('startet im Fenster, wenn das Ziel noch nicht erreicht ist', () => {
    expect(chargeWindowAction(um(1, 0), f, amKabel)).toBe('start');
  });

  it('stoppt außerhalb des Fensters', () => {
    expect(chargeWindowAction(um(20, 0), f, { ...amKabel, charging: true })).toBe('stop');
  });

  it('tut nichts, wenn der Zustand schon stimmt', () => {
    // Im Fenster und lädt bereits; außerhalb und lädt nicht.
    expect(chargeWindowAction(um(1, 0), f, { ...amKabel, charging: true })).toBeUndefined();
    expect(chargeWindowAction(um(20, 0), f, amKabel)).toBeUndefined();
  });

  it('trägt ein Fenster über Mitternacht', () => {
    // 22:00–06:00 ist der übliche Nachttarif und überschreitet den Tageswechsel.
    const nacht = parseWindow('22:00', '06:00');
    expect(chargeWindowAction(um(23, 0), nacht, amKabel)).toBe('start');
    expect(chargeWindowAction(um(3, 0), nacht, amKabel)).toBe('start');
    expect(chargeWindowAction(um(12, 0), nacht, { ...amKabel, charging: true })).toBe('stop');
  });

  it('startet nicht, wenn das Ladeziel erreicht ist', () => {
    expect(chargeWindowAction(um(1, 0), f, { ...amKabel, soc: 80 })).toBeUndefined();
    expect(chargeWindowAction(um(1, 0), f, { ...amKabel, soc: 95 })).toBeUndefined();
  });
});

describe('chargeWindowAction — die Sicherheitsnetze', () => {
  const f = parseWindow('00:30', '04:30');

  it('stoppt NIE unterhalb der Sofortlade-Schwelle', () => {
    // Diese Schwelle ist die Reserve des Fahrzeugs: Bis dahin lädt es
    // unabhängig von jedem Zeitfenster. Ein Sparfenster darf sie nicht
    // aushebeln — sonst steht morgens ein Auto da, das nicht weit kommt.
    expect(
      chargeWindowAction(um(20, 0), f, { ...amKabel, charging: true, soc: 25, minSoc: 30 }),
    ).toBeUndefined();
  });

  it('lädt außerhalb des Fensters, wenn die Reserve unterschritten ist', () => {
    // Wichtiger als billiger Strom ist ein fahrbereites Auto.
    expect(chargeWindowAction(um(20, 0), f, { ...amKabel, soc: 25, minSoc: 30 })).toBe('start');
  });

  it('greift nicht ohne Kabel', () => {
    expect(chargeWindowAction(um(1, 0), f, { ...amKabel, plugged: false })).toBeUndefined();
    expect(chargeWindowAction(um(1, 0), f, { ...amKabel, plugged: undefined })).toBeUndefined();
  });

  it('greift nicht bei unbekanntem Zustand, statt zu raten', () => {
    // Die Schnittstelle beantwortet einen Teil der Abfragen ohne Messwerte.
    // Auf einen geratenen Ladestand hin das Laden zu stoppen, wäre der
    // schlimmste Fehler, den diese Funktion machen kann.
    expect(chargeWindowAction(um(1, 0), f, { ...amKabel, soc: undefined })).toBeUndefined();
    expect(chargeWindowAction(um(1, 0), f, { ...amKabel, charging: undefined })).toBeUndefined();
    expect(chargeWindowAction(um(1, 0), f, { ...amKabel, targetSoc: undefined })).toBeUndefined();
  });

  it('greift gar nicht ohne konfiguriertes Fenster', () => {
    // Standard ist AUS: Wer nichts einstellt, dem greift nichts ins Auto.
    expect(chargeWindowAction(um(1, 0), undefined, amKabel)).toBeUndefined();
  });

  it('kommt ohne Sofortlade-Schwelle aus, ohne die Reserve zu erfinden', () => {
    // Liefert das Fahrzeug keine Schwelle, gibt es keine Reserve zu schützen —
    // das Fenster gilt dann schlicht.
    expect(
      chargeWindowAction(um(20, 0), f, { ...amKabel, charging: true, minSoc: undefined }),
    ).toBe('stop');
  });
});
