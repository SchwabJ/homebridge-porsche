/**
 * Ruheverlust: Was das Auto verliert, während es NICHTS tut.
 *
 * Nicht dasselbe wie der Standverbrauch der Kapazitätsschätzung
 * ({@link ./capacity}): Der zählt alles ohne gefahrene Kilometer — also auch
 * Vorklimatisierung und Zündung. Hier wird getrennt: Ein Intervall zählt nur
 * als RUHE, wenn kein Kabel steckt, kein Kilometer dazukam und die Klima aus
 * war. Läuft die Klima im Stand, wandert der Verlust in einen eigenen Topf —
 * „über Nacht sollte nichts an sein, und trotzdem fehlt etwas" ist genau die
 * Frage, die diese Trennung beantwortet.
 *
 * ## Messgrenzen, ehrlich benannt
 *
 * Der Ladestand kommt ganzzahlig: 1 % sind ~0,8 kWh. Eine einzelne Nacht
 * entscheidet damit die Rundung, nicht das Auto. Belastbar wird die Zahl über
 * die SUMME vieler Ruhephasen — deshalb schweigt {@link idleStats} unter 48
 * Stunden beobachteter Ruhezeit.
 *
 * `climateOn` steht nur in Zeilen, in denen es sich GEÄNDERT hat — der
 * Zustand muss als letzter bekannter fortgeführt werden. Und eine Messlücke
 * bricht die Phase ab: Was in drei ungemessenen Stunden geschah, weiß
 * niemand; lieber Daten verlieren als eine Behauptung aufstellen.
 */

import type { ChargeLogSample } from './chargeLog';

/**
 * Größter Messabstand, der noch als lückenlos gilt, in Minuten.
 *
 * Bewusst großzügiger als die 35 min der Zeitreihen-Lückenerkennung, und
 * zwar aus einer Messung: Ohne Kabel pollt das Plugin alle 20 min, ein
 * einzelner ausgefallener Poll ergibt also 40 min Abstand. An 94 h echtem
 * Mitschrieb war 40 min exakt der größte vorkommende Abstand (p90 = p99 =
 * max = 40); mit einer 35er-Schwelle fielen 29 Intervalle mit zusammen
 * 19,3 h Ruhezeit heraus — mehr als ein Drittel der Beobachtung.
 *
 * Nach oben ist die Wahl unkritisch: Ab 45 min ändert sich am Ergebnis
 * nichts mehr, weil es keine Abstände zwischen 45 min und einer echten
 * Datenlücke gibt. 45 fängt den verpassten Poll ein und weist alles ab, was
 * wirklich unbeobachtet war.
 *
 * Die Zeitreihe darf enger bleiben: Sie MISST die Lücke als Datenqualität,
 * hier geht es darum, ob ein Intervall überhaupt verwertbar ist.
 */
const GAP_MAX_MIN = 45;

/** Eine zusammenhängende Ruhephase — z. B. eine Nacht. */
export interface IdlePhase {
  from: string;
  to: string;
  minutes: number;
  /** Ladestand-Verlust in Prozentpunkten. */
  socDrop: number;
}

export interface IdleAnalysis {
  /** Summierte echte Ruhezeit in Minuten (kein Kabel, kein km, Klima aus). */
  idleMinutes: number;
  /** Ladestand-Verlust in dieser Ruhezeit, Prozentpunkte. */
  idleSocDrop: number;
  /** Standzeit MIT laufender Klima, Minuten. */
  climateMinutes: number;
  /** Verlust während dieser Klima-Standzeit, Prozentpunkte. */
  climateSocDrop: number;
  /** Ruhephasen mit Verlust, größte zuerst. */
  phases: IdlePhase[];
}

/**
 * Wie lange nach Fahrt, Kabel oder Klima noch NICHT von Ruhe gesprochen wird.
 *
 * Der wichtigste Befund aus den echten Daten: Ohne diesen Ausschluss misst
 * man das Abkühlen und nennt es Ruhe. Über 94 h Mitschrieb stammte der
 * GESAMTE beobachtete Abfall von 4 Prozentpunkten aus den Minuten direkt
 * nach Fahrten — die drei langen Phasen danach (7,8 h, 7,3 h und 10,0 h,
 * darunter zwei ganze Nächte) verloren zusammen null. Die daraus gerechneten
 * „1,38 kWh/Tag" waren damit reines Nachlauf-Artefakt.
 *
 * Eine Stunde ist konservativ gewählt: Sie deckt Steuergeräte-Nachlauf und
 * Batterietemperierung ab, ohne von der eigentlichen Standzeit mehr
 * wegzunehmen als nötig.
 */
const SETTLE_MIN = 60;

/**
 * Mindestlänge einer Phase für die Einzel-Liste, in Minuten.
 *
 * Die Einzelphase ist grob (ein Prozentpunkt über zwei Stunden ist fast
 * reine Rundung) — deshalb steht sie als absoluter Verlust da und wird nie
 * auf einen Tag hochgerechnet. Das tut nur {@link idleStats}, über die Summe.
 */
const PHASE_MIN_MIN = 120;

/**
 * Läuft einmal über den Mitschrieb und sortiert jedes Messintervall in Ruhe,
 * Klima-Stand oder „zählt nicht" (Kabel, Fahrt, Lücke, fehlende Werte).
 */
export function analyzeIdle(
  samples: Iterable<ChargeLogSample>,
  opts: { maxGapMin?: number } = {},
): IdleAnalysis {
  // Die Lückenschwelle folgt dem tatsächlichen Abfragetakt.
  //
  // Fest verdrahtet wäre sie an einem Zwanzig-Minuten-Takt kalibriert —
  // und bei stündlicher Abfrage, die die Konfiguration zulässt, wäre JEDER
  // reguläre Abstand eine „Lücke" und die Auswertung schwiege für immer.
  const gapMax = Math.max(GAP_MAX_MIN, opts.maxGapMin ?? 0);
  const out: IdleAnalysis = {
    idleMinutes: 0,
    idleSocDrop: 0,
    climateMinutes: 0,
    climateSocDrop: 0,
    phases: [],
  };

  let prev: ChargeLogSample | undefined;
  let prevSoc: number | undefined;
  let prevOdo: number | undefined;
  let climate = false;
  /**
   * Der Klima-Zustand beim letzten AUSGEWERTETEN Messpunkt.
   *
   * Nicht dasselbe wie `climate`: Zeilen ohne `plugged` werden übersprungen,
   * aktualisieren aber weiter den Zustand — sonst verpasste man einen
   * Wechsel, der nur dort steht. Für das laufende Intervall zählt jedoch der
   * Stand an seinem ANFANG. Ohne diese Trennung galt ein Klima-Aus, das auf
   * einer übersprungenen Zeile stand, rückwirkend für das ganze Intervall
   * davor, und der Vorklimatisierungs-Verlust erschien als Ruheverlust.
   */
  let climateAtPrev = false;
  /**
   * Lief die Klima irgendwann seit dem letzten AUSGEWERTETEN Messpunkt?
   *
   * `climateAtPrev` und der aktuelle Zustand genügen nicht: Ein An-und-
   * wieder-Aus kann komplett auf übersprungenen Zeilen stehen. Der Zustand
   * an BEIDEN Enden des Intervalls ist dann „aus", gelaufen ist sie
   * trotzdem — und der Verlust gehört nicht in den Ruhe-Topf.
   */
  let climateSeit = false;
  /** Zeitpunkt der letzten Aktivität (Fahrt, Kabel, Klima) — für den Nachlauf. */
  let lastActive = -Infinity;
  /**
   * Offener Ruhe-Lauf. Trägt den Ladestand an seinem ANFANG und den zuletzt
   * gesehenen — der Verlust wird beim Schließen aus beiden gebildet, nicht
   * aus der Summe der Einzelrückgänge.
   */
  let phase:
    | { from: string; to: string; minutes: number; socDrop: number; firstSoc?: number; lastSoc?: number }
    | undefined;

  /**
   * Schließt den laufenden Ruhe-Lauf und bucht seinen NETTO-Verlust.
   *
   * Teleskopiert über den ganzen Lauf statt Einzeldifferenzen zu summieren.
   * Der Ladestand kommt ganzzahlig und zittert an der Rundungsgrenze; wer
   * die Beträge aller Rückgänge addiert, macht aus 80→81→80 einen
   * Prozentpunkt Verlust, obwohl netto nichts fehlt. Über sechzig Stunden
   * Pendeln waren das sechzig Punkte — hochgerechnet 19,9 kWh/Tag aus
   * reinem Rauschen, und die Obergrenzen-Sicherung kippte gleich mit, weil
   * die erfundene Summe ihre Schwelle überschritt.
   *
   * Nur die Buchung hängt am Lauf, nicht die Aufnahme in die Liste: Auch ein
   * kurzer Lauf, der die Mindestlänge für {@link IdleAnalysis.phases}
   * verfehlt, trägt seinen Verlust zur Gesamtsumme bei.
   */
  const closePhase = (): void => {
    if (phase) {
      const netto =
        phase.firstSoc !== undefined && phase.lastSoc !== undefined
          ? Math.max(0, phase.firstSoc - phase.lastSoc)
          : 0;
      out.idleSocDrop += netto;
      phase.socDrop = netto;
      if (phase.minutes >= PHASE_MIN_MIN && netto > 0) {
        out.phases.push(phase);
      }
    }
    phase = undefined;
  };

  for (const cur of samples) {
    if (cur.climateOn !== undefined) {
      climate = cur.climateOn;
    }
    // VOR dem Überspringen: Eine Zeile ohne `plugged` fällt gleich heraus,
    // ihr Klima-Zustand gilt aber trotzdem für das laufende Intervall.
    if (climate) {
      climateSeit = true;
    }

    // Leere Antwort (nur `ts`) überspringen, statt die Phase zu zerschneiden.
    //
    // Dieselbe Regel wie in buildSessions: Ein fehlgeschlagener Poll ist kein
    // Ausstecken. An den echten Daten gemessen ist das kein Randfall — in 20
    // von 94 Stunden fehlt `plugged`. Zerschnitte jede solche Zeile die
    // Phase, fiele ein Fünftel der Betriebszeit aus der Auswertung, und die
    // Ruhezeit sähe nach einem Bruchteil dessen aus, was sie ist.
    //
    // Der Zeitbezug geht dabei nicht verloren: `prev` bleibt der letzte
    // Messpunkt MIT Aussage, das nächste Intervall überspannt also die
    // Lücke — und wird von der Lückensicherung unten verworfen, wenn es
    // dadurch zu lang wird.
    if (cur.plugged === undefined) {
      continue;
    }

    const minutes = prev ? (Date.parse(cur.ts) - Date.parse(prev.ts)) / 60000 : 0;
    const socDrop =
      prevSoc !== undefined && cur.soc !== undefined ? Math.max(0, prevSoc - cur.soc) : 0;
    // Stillstand muss BELEGT sein, nicht bloß unwiderlegt.
    //
    // Vorher galt „nicht gefahren", sobald der Kilometerstand fehlte — und
    // eine Fahrt ohne gemeldeten Zählerstand wurde damit zur Ruhephase, ihr
    // Fahrverbrauch zum Ruheverlust. Nachgestellt ergab das 8 statt 0
    // Prozentpunkte, also ein Vielfaches der gesuchten Größe.
    const stillstand =
      prevOdo !== undefined && cur.odometerKm !== undefined && cur.odometerKm === prevOdo;
    // Ein Intervall zählt nur mit BEIDEN Enden ausdrücklich ohne Kabel —
    // `undefined` ist ein fehlgeschlagener Poll, kein Ausstecken.
    const ohneKabel = prev?.plugged === false && cur.plugged === false;
    const lueckenlos = prev !== undefined && minutes > 0 && minutes <= gapMax;

    const jetzt = Date.parse(cur.ts);
    // Nachlauf: Erst {@link SETTLE_MIN} nach der letzten Aktivität zählt die
    // Zeit als Ruhe. Gemessen am ANFANG des Intervalls — dort entsteht der
    // Verlust, den es zuschreibt; am Ende zu messen zöge die halbe
    // Abkühlphase wieder herein.
    const abgekuehlt =
      prev !== undefined && Date.parse(prev.ts) - lastActive >= SETTLE_MIN * 60000;

    if (lueckenlos && ohneKabel && stillstand) {
      // Lief die Klima IRGENDWANN im Intervall — am Anfang oder am Ende —,
      // gehört der Verlust in ihren Topf. Was bis zum Abschalt-Messpunkt
      // verloren ging, hat noch sie gezogen.
      if (climateAtPrev || climate || climateSeit) {
        // Der Klima-Topf kennt keinen Nachlauf: Was die Klima zieht, zieht
        // sie ab der ersten Minute.
        out.climateMinutes += minutes;
        out.climateSocDrop += socDrop;
        closePhase();
      } else if (abgekuehlt) {
        out.idleMinutes += minutes;
        if (!phase) {
          phase = { from: prev!.ts, to: cur.ts, minutes: 0, socDrop: 0, firstSoc: prevSoc };
        }
        phase.to = cur.ts;
        phase.minutes += minutes;
        if (cur.soc !== undefined) {
          phase.lastSoc = cur.soc;
          // Beginnt der Lauf an einem Messpunkt ohne Ladestand, verankert
          // ihn der erste, der einen trägt.
          if (phase.firstSoc === undefined) {
            phase.firstSoc = cur.soc;
          }
        }
      } else {
        // Nachlauf: zählt in keinen Topf — weder Ruhe noch Klima.
        closePhase();
      }
    } else if (prev) {
      closePhase();
    }

    // Nachlauf-Anker: alles, was nicht belegter Stillstand ohne Kabel ist.
    //
    // Auch der laufende Klimabetrieb zählt dazu — nach dem Abschalten kühlt
    // der Innenraum aus, und das ist genauso wenig Ruhe wie nach einer
    // Fahrt. Ebenso die unklare Zeile: Nach ihr weiß niemand, ob gefahren
    // wurde, und eine Stunde Karenz ist billiger als eine erfundene
    // Ruhephase.
    //
    // `prev !== undefined`, weil sich am allerersten Messpunkt kein
    // Stillstand belegen lässt — dort beginnen bloß die Daten. Ihn als
    // Aktivität zu werten kostete die erste Stunde jeder Auswertung.
    if (cur.plugged === true || climate || (prev !== undefined && !stillstand)) {
      lastActive = jetzt;
    }

    prev = cur;
    climateAtPrev = climate;
    // Zurücksetzen auf den HIER geltenden Zustand: Ohne das bliebe nach dem
    // ersten Klimabetrieb jede spätere Ruhephase für immer im falschen Topf.
    climateSeit = climate;
    if (cur.soc !== undefined) {
      prevSoc = cur.soc;
    }
    if (cur.odometerKm !== undefined) {
      prevOdo = cur.odometerKm;
    }
  }
  closePhase();

  out.phases.sort((a, b) => b.socDrop - a.socDrop || b.minutes - a.minutes);
  return out;
}

/** Mindest-Ruhezeit, bevor eine Tageszahl behauptet wird, in Stunden. */
const MIN_OBSERVED_HOURS = 48;

/**
 * Ab wie vielen Prozentpunkten Gesamtabfall eine Punktschätzung zulässig ist.
 *
 * Der Ladestand ist ganzzahlig: Jede Messung trägt bis zu einem halben Punkt
 * Rundung, Anfang und Ende zusammen also einen ganzen. Bei zwei beobachteten
 * Punkten wäre die Unsicherheit damit so groß wie die Hälfte des Ergebnisses
 * — eine Zahl mit Komma wäre dort schlicht erfunden.
 */
const MIN_DROP_FOR_POINT = 3;

export interface IdleStats {
  /** Ruheverlust je Tag in kWh. */
  kwhPerDay: number;
  /** Ruheverlust je Tag in Prozentpunkten. */
  socPerDay: number;
  /** Beobachtete Ruhezeit in Tagen. */
  observedDays: number;
  /**
   * true = die Werte sind eine OBERGRENZE, keine Messung.
   *
   * Tritt genau dann ein, wenn der Ladestand über die ganze Beobachtung
   * kaum gefallen ist. Dann lautet die ehrliche Aussage „höchstens so viel",
   * gerechnet mit dem Rundungszuschlag — und nicht eine Nachkommastelle,
   * die aus Rauschen entstanden wäre.
   */
  obergrenze: boolean;
}

/**
 * Der Ruheverlust als Tagesrate — `undefined`, solange die beobachtete
 * Ruhezeit unter {@link MIN_OBSERVED_HOURS} liegt.
 */
export function idleStats(a: IdleAnalysis, capacityKwh: number): IdleStats | undefined {
  if (a.idleMinutes < MIN_OBSERVED_HOURS * 60 || capacityKwh <= 0) {
    return undefined;
  }
  const days = a.idleMinutes / 1440;
  const obergrenze = a.idleSocDrop < MIN_DROP_FOR_POINT;
  // Bei zu kleinem Abfall auf den Rundungszuschlag von einem Punkt gehen:
  // Mehr als das kann die Beobachtung nicht verborgen haben.
  const socPerDay = (obergrenze ? a.idleSocDrop + 1 : a.idleSocDrop) / days;
  return {
    kwhPerDay: Math.round(((socPerDay * capacityKwh) / 100) * 100) / 100,
    socPerDay: Math.round(socPerDay * 10) / 10,
    observedDays: Math.round(days * 10) / 10,
    obergrenze,
  };
}
