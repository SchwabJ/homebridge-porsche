/**
 * Ladevorgänge aus dem Rohdaten-Mitschrieb rekonstruieren.
 *
 * Reine Auswertung ohne Seiteneffekte: rein gehen die JSONL-Zeilen aus
 * {@link ./chargeLog}, raus kommen fertige Ladevorgänge. Dadurch lässt sich
 * dieselbe Logik live wie rückwirkend über alte Tage laufen lassen.
 *
 * ## Warum die Sessiongrenze am Stecker hängt, nicht am Laden
 *
 * Bei preisgesteuertem Laden (dynamische Tarife wie Octopus, Tibber u. a.) schaltet der Tarif in 15-Minuten-
 * Slots ein und aus. Eine Nachtladung zerfiele über `charging` in ein Dutzend
 * Fragmente. `plugged` bleibt dagegen über die gesamte Standzeit true – von
 * Einstecken bis Ausstecken – und liefert damit genau eine Session pro Nacht.
 *
 * ## Warum die Energie aus dem SoC-Delta kommt
 *
 * Leistung über Zeit zu integrieren scheitert an denselben Slots: Zwischen zwei
 * Messungen kann ein kompletter Slot an und wieder aus gewesen sein. Das
 * SoC-Delta über die ganze Session ist gegen solche Lücken unempfindlich – nur
 * Anfangs- und Endwert zählen. Die Leistungswerte dienen deshalb nur noch der
 * Kurve (Spitze, Mittel), nicht der Energiemenge.
 */

import type { ChargeLogSample } from './chargeLog';

/** Nutzbare Netto-Kapazität in kWh (Taycan Performance Battery Plus). */
export const DEFAULT_CAPACITY_KWH = 83.7;

/**
 * Eine zusammenhängende Ladephase innerhalb einer Session.
 *
 * Bei tarifgesteuertem Laden schaltet der Anbieter in Fenstern ein und aus.
 * Die Session am Kabel hält die Energiebilanz zusammen; die Phasen zeigen,
 * WANN tatsächlich Strom floss — genau die Information, die eine reine
 * Summenzeile verschluckt.
 */
export interface ChargePhase {
  startedAt: string;
  endedAt: string;
  durationMin: number;
  startSoc?: number;
  endSoc?: number;
  energyKwh?: number;
  avgPowerKw?: number;
  rangeAddedKm?: number;
}

export interface ChargeSession {
  /** Zeitpunkt des Einsteckens (ISO). */
  startedAt: string;
  /** Zeitpunkt des Aussteckens (ISO); fehlt, solange die Session offen ist. */
  endedAt?: string;
  /** Gesamte Standzeit am Kabel in Minuten. */
  durationMin: number;
  /** Davon Zeit mit aktivem Laden in Minuten (bei Slot-Ladung deutlich kürzer). */
  chargingMin: number;
  startSoc?: number;
  endSoc?: number;
  /** Geladene Energie aus dem SoC-Delta. Nie negativ (siehe socDropped). */
  energyKwh?: number;
  /** true, wenn der SoC netto gefallen ist (z. B. Vorklimatisierung ohne Ladung). */
  socDropped: boolean;
  peakPowerKw?: number;
  /** Mittlere Leistung über die Samples MIT aktivem Laden. */
  avgPowerKw?: number;
  /**
   * Geladene Reichweite in km — gemessen aus dem Zuwachs von `rangeKm`,
   * nicht aus der Energie zurückgerechnet.
   *
   * Die Reichweitenanzeige schwankt mit der Verbrauchsprognose des Fahrzeugs;
   * über eine Ladung hinweg ist sie aber stabil genug und näher an dem, was
   * der Fahrer im Display sieht, als jede eigene Umrechnung.
   */
  rangeAddedKm?: number;
  /** Mittlere Laderate in km je Minute (geladene Reichweite / reine Ladezeit). */
  avgKmPerMin?: number;
  /** Höchste vom Fahrzeug gemeldete Laderate in km/min. */
  peakKmPerMin?: number;
  chargingType?: string;
  /**
   * Wurde zuhause geladen? `undefined`, solange keine Position vorlag.
   *
   * Gehört zur SESSION, nicht zum einzelnen Messpunkt: Beim Anstecken trägt
   * die zwischengespeicherte Fahrzeugantwort oft noch die Position von
   * unterwegs — beobachtet wurden elf Minuten, bis „zuhause" ankam. Wer nach
   * Messpunkten filtert, verliert den Anfang jeder Ladung.
   *
   * Ein einziges „zuhause" während der Kabelzeit genügt deshalb: Das Fahrzeug
   * bewegt sich beim Laden nicht. Ein falsches „zuhause" müsste erst den
   * Radius um die eingetragene Adresse treffen; ein falsches „auswärts"
   * entsteht dagegen allein durch eine veraltete Position.
   */
  atHome?: boolean;
  /** Kosten zum Effektivpreis, sofern ein Preis übergeben wurde. */
  costEur?: number;
  /** Kosten zum Grundpreis, also ohne Bonus. */
  costGrossEur?: number;
  /** Ersparnis durch den Bonus. */
  savedEur?: number;
  /** Angewandter Arbeitspreis — mitgespeichert, damit die Zeile prüfbar bleibt. */
  pricePerKwh?: number;
  /** false, wenn das Ausstecken nie beobachtet wurde (Session läuft noch / Daten enden). */
  complete: boolean;
  /** Anzahl der zugrunde liegenden Messpunkte. */
  samples: number;
  /** Die einzelnen Ladephasen — bei Tarifsteuerung typischerweise mehrere. */
  phases: ChargePhase[];
}

export interface BuildOptions {
  /** Nutzbare Kapazität in kWh. Default {@link DEFAULT_CAPACITY_KWH}. */
  capacityKwh?: number;
  /** Effektiver Arbeitspreis in EUR/kWh. Ohne Angabe bleiben die Kosten leer. */
  pricePerKwh?: number;
  /** Grundpreis ohne Bonus. Fehlt er, gilt der Effektivpreis (Ersparnis = 0). */
  grossPricePerKwh?: number;
}

const minutesBetween = (a: string, b: string): number =>
  (new Date(b).getTime() - new Date(a).getTime()) / 60000;

/** Sammelzustand einer noch offenen Session. */
interface Open {
  first: ChargeLogSample;
  last: ChargeLogSample;
  socValues: number[];
  rangeValues: number[];
  powers: number[];
  rates: number[];
  chargingSamples: ChargeLogSample[];
  /** Laufende Phase: Messpunkte seit dem letzten Einschalten. */
  phase: ChargeLogSample[];
  /** Abgeschlossene Phasen dieser Session. */
  phases: ChargeLogSample[][];
  /** Letzter Messpunkt ohne Laden — Startanker der nächsten Phase. */
  lastIdle?: ChargeLogSample;
  chargingType?: string;
  /** Sah diese Session je ein „zuhause" bzw. ein „auswärts"? */
  sawHome: boolean;
  sawAway: boolean;
  count: number;
}

function finish(
  open: Open,
  complete: boolean,
  opts: BuildOptions,
): ChargeSession {
  const capacity = opts.capacityKwh ?? DEFAULT_CAPACITY_KWH;
  const startSoc = open.socValues[0];
  const endSoc = open.socValues[open.socValues.length - 1];

  let energyKwh: number | undefined;
  let socDropped = false;
  if (startSoc !== undefined && endSoc !== undefined) {
    const delta = endSoc - startSoc;
    socDropped = delta < 0;
    energyKwh = Math.round(Math.max(0, delta) * 0.01 * capacity * 100) / 100;
  }

  // Ladezeit aus den Abständen zwischen aufeinanderfolgenden Lade-Samples.
  let chargingMin = 0;
  for (let i = 1; i < open.chargingSamples.length; i++) {
    chargingMin += minutesBetween(
      open.chargingSamples[i - 1].ts,
      open.chargingSamples[i].ts,
    );
  }

  // Laufende Phase mit abschließen, falls die Session im Laden endet.
  const rawPhases = open.phase.length > 0 ? [...open.phases, open.phase] : open.phases;

  const phases: ChargePhase[] = rawPhases
    .filter((p) => p.length > 0)
    .map((p) => {
      const socs = p.map((x) => x.soc).filter((v): v is number => v !== undefined);
      const ranges = p.map((x) => x.rangeKm).filter((v): v is number => v !== undefined);
      const pw = p.map((x) => x.powerKw).filter((v): v is number => v !== undefined);
      const phase: ChargePhase = {
        startedAt: p[0].ts,
        endedAt: p[p.length - 1].ts,
        durationMin: Math.round(minutesBetween(p[0].ts, p[p.length - 1].ts)),
      };
      if (socs.length > 0) {
        phase.startSoc = socs[0];
        phase.endSoc = socs[socs.length - 1];
        phase.energyKwh =
          Math.round(Math.max(0, socs[socs.length - 1] - socs[0]) * 0.01 * capacity * 100) / 100;
      }
      if (ranges.length > 0) {
        phase.rangeAddedKm = Math.round(Math.max(0, ranges[ranges.length - 1] - ranges[0]));
      }
      if (pw.length > 0) {
        phase.avgPowerKw = Math.round((pw.reduce((a, b) => a + b, 0) / pw.length) * 10) / 10;
      }
      return phase;
    });

  const session: ChargeSession = {
    startedAt: open.first.ts,
    durationMin: Math.round(minutesBetween(open.first.ts, open.last.ts)),
    chargingMin: Math.round(chargingMin),
    socDropped,
    complete,
    samples: open.count,
    phases,
  };
  if (complete) {
    session.endedAt = open.last.ts;
  }
  if (startSoc !== undefined) {
    session.startSoc = startSoc;
  }
  if (endSoc !== undefined) {
    session.endSoc = endSoc;
  }
  if (energyKwh !== undefined) {
    session.energyKwh = energyKwh;
    if (opts.pricePerKwh !== undefined) {
      const gross = opts.grossPricePerKwh ?? opts.pricePerKwh;
      session.costEur = Math.round(energyKwh * opts.pricePerKwh * 100) / 100;
      session.costGrossEur = Math.round(energyKwh * gross * 100) / 100;
      session.savedEur = Math.round((session.costGrossEur - session.costEur) * 100) / 100;
      session.pricePerKwh = opts.pricePerKwh;
    }
  }
  // Geladene Reichweite: Zuwachs von Anfang zu Ende, nie negativ (die
  // Prognose kann während einer Ladung auch fallen, etwa wenn geheizt wird).
  const firstRange = open.rangeValues[0];
  const lastRange = open.rangeValues[open.rangeValues.length - 1];
  if (firstRange !== undefined && lastRange !== undefined) {
    const added = Math.max(0, lastRange - firstRange);
    session.rangeAddedKm = Math.round(added);
    if (chargingMin > 0 && added > 0) {
      session.avgKmPerMin = Math.round((added / chargingMin) * 10) / 10;
    }
  }
  if (open.rates.length > 0) {
    session.peakKmPerMin = Math.max(...open.rates);
  }
  if (open.powers.length > 0) {
    session.peakPowerKw = Math.max(...open.powers);
    const sum = open.powers.reduce((a, b) => a + b, 0);
    session.avgPowerKw = Math.round((sum / open.powers.length) * 10) / 10;
  }
  if (open.chargingType) {
    session.chargingType = open.chargingType;
  }
  // Ein einziges „zuhause" während der Kabelzeit entscheidet — siehe atHome.
  if (open.sawHome) {
    session.atHome = true;
  } else if (open.sawAway) {
    session.atHome = false;
  }
  return session;
}

/**
 * Baut Ladevorgänge aus einer zeitlich sortierten Sample-Folge.
 *
 * Samples ohne `plugged`-Angabe werden übersprungen, statt eine laufende
 * Session zu beenden — ein fehlgeschlagener Poll ist kein Ausstecken.
 */
export function buildSessions(
  samples: ChargeLogSample[],
  opts: BuildOptions = {},
): ChargeSession[] {
  const sessions: ChargeSession[] = [];
  let open: Open | undefined;

  for (const s of samples) {
    if (s.plugged === undefined) {
      continue;
    }

    if (s.plugged) {
      if (!open) {
        open = {
          first: s,
          last: s,
          socValues: [],
          rangeValues: [],
          powers: [],
          rates: [],
          chargingSamples: [],
          phase: [],
          phases: [],
          sawHome: false,
          sawAway: false,
          count: 0,
        };
      }
      open.last = s;
      open.count++;
      if (s.atHome === true) {
        open.sawHome = true;
      } else if (s.atHome === false) {
        open.sawAway = true;
      }
      if (s.soc !== undefined) {
        open.socValues.push(s.soc);
      }
      if (s.rangeKm !== undefined) {
        open.rangeValues.push(s.rangeKm);
      }
      if (s.charging) {
        // Beim Einschalten den letzten Nicht-Lade-Messpunkt als Startpunkt
        // mitnehmen: Sonst begänne die Phase erst beim zweiten Messpunkt und
        // der erste Ladestand-Sprung fehlte.
        if (open.phase.length === 0 && open.lastIdle) {
          open.phase.push(open.lastIdle);
        }
        open.phase.push(s);
        open.chargingSamples.push(s);
        if (s.powerKw !== undefined) {
          open.powers.push(s.powerKw);
        }
        if (s.rateKmMin !== undefined) {
          open.rates.push(s.rateKmMin);
        }
        if (s.chargingType) {
          open.chargingType = s.chargingType;
        }
      } else {
        // Ladepause: laufende Phase abschließen.
        if (open.phase.length > 0) {
          open.phases.push(open.phase);
          open.phase = [];
        }
        open.lastIdle = s;
      }
    } else if (open) {
      // Ausgesteckt: das erste nicht-eingesteckte Sample markiert das Ende.
      open.last = s;
      if (s.soc !== undefined) {
        open.socValues.push(s.soc);
      }
      if (s.rangeKm !== undefined) {
        open.rangeValues.push(s.rangeKm);
      }
      sessions.push(finish(open, true, opts));
      open = undefined;
    }
  }

  if (open) {
    sessions.push(finish(open, false, opts));
  }
  return sessions;
}
