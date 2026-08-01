/**
 * Daten- und Cache-Schicht des Dashboards.
 *
 * Alles, was Messpunkte von der Platte holt oder teure Auswertungen über die
 * ganze Historie zwischenspeichert, lebt hier — getrennt vom Markup, damit
 * die Cache-Schlüsselregeln direkt per Unit-Test prüfbar sind. Die Funktionen
 * kennen keine {@link ./dashboard!DashboardOptions}: Sie bekommen das
 * Verzeichnis und die WIRKSAMEN Auswertungswerte übergeben und bleiben damit
 * frei von der Einstellungs- und Server-Schicht.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ChargeLogSample } from './chargeLog';
import { aggregate, type AggregateOptions, type Bucket, type Granularity } from './aggregate';
import { estimateCapacity, type CapacityEstimate } from './capacity';
import { buildTrips, type Trip } from './trips';
import { analyzeIdle, type IdleAnalysis } from './idle';

/** Ortsfilter des Dashboards. */
export type Place = 'all' | 'home' | 'away';

/**
 * Die tatsächlich wirksamen Auswertungswerte — Konfiguration überlagert von
 * der Einstellungsseite, aufgelöst vom Aufrufer.
 *
 * `priceSig` gehört dazu, weil zwei Zustände mit gleichem AKTUELLEN Preis
 * sich in der Tarifhistorie unterscheiden können — und damit in jeder alten
 * Zahl. Ein Cache, der das nicht im Schlüssel führt, liefert stille
 * Falschwerte.
 */
export interface EffectiveOptions extends AggregateOptions {
  capacityKwh: number;
  pricePerKwh: number;
  grossPricePerKwh: number;
  dayBoundaryHour: number;
  priceFor: (iso: string) => { pricePerKwh: number; grossPricePerKwh: number };
  /** Signatur der Tarifhistorie — Teil jedes Cache-Schlüssels. */
  priceSig: string;
}

/**
 * Signatur des Verzeichnisses: Dateinamen, Größen und Änderungszeiten.
 *
 * Grundlage des Caches — bei rund 50.000 Zeilen im Jahr wäre es Verschwendung,
 * bei jedem Seitenaufruf alles neu zu parsen. Da nur angehängt wird, genügt
 * Größe plus mtime, um jede Änderung zu erkennen.
 */
export function signature(dir: string): string {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      })
      .join('|');
  } catch {
    return '';
  }
}

let cache: { sig: string; dir: string; samples: ChargeLogSample[] } | undefined;

/**
 * Grenze, ab der die Messpunkte NICHT mehr vollständig im Speicher gehalten
 * werden — gemessen in Tagesdateien.
 *
 * Nachgemessen mit einem synthetischen Mitschrieb in echter Dichte: Ein Jahr
 * (151.000 Zeilen, 32 MB Text) wird zu 52 MB Objekten, sechs Jahre zu 248 MB.
 * Ein Raspberry Pi, auf dem neben Homebridge noch etwas anderes läuft, hat
 * keine 250 MB frei — der Prozess stirbt dann mitten in einem Seitenaufruf,
 * und mit ihm die Child Bridge samt HomeKit-Kacheln.
 *
 * Unterhalb der Grenze bleibt alles wie bisher: ein Cache, ein Parse, 1,2 ms
 * je Aufruf. Oberhalb wird gestreamt — Datei für Datei gelesen und sofort
 * wieder freigegeben. Das kostet Zeit und spart Speicher, und diese Richtung
 * ist die richtige: Langsam ist unangenehm, tot ist ein Ausfall.
 */
export const CACHE_MAX_FILES = 500;

/**
 * Liest alle Tagesdateien (gecacht); defekte Zeilen werden übersprungen.
 *
 * Bei sehr langen Historien gibt sie nur noch das Ende zurück — wer alles
 * braucht, nimmt {@link streamSamples}. Aufrufer, die nur den aktuellen
 * Zustand brauchen (Statuszeile, letzter Messwert), sind damit weiterhin
 * richtig bedient.
 */
export function readSamples(dir: string): ChargeLogSample[] {
  const sig = signature(dir);
  if (cache && cache.dir === dir && cache.sig === sig) {
    return cache.samples;
  }
  const samples = readSamplesUncached(dir);
  cache = { sig, dir, samples };
  return samples;
}

/**
 * Alle Messpunkte, Datei für Datei — ohne sie alle gleichzeitig zu halten.
 *
 * Der entscheidende Unterschied zu {@link readSamples}: Hier lebt immer nur
 * EINE Tagesdatei als Objekte, danach gibt sie der Garbage Collector frei.
 * Sechs Jahre Mitschrieb kosten damit statt 248 MB rund ein Tausendstel
 * davon; bezahlt wird mit der Zeit, weil jeder Durchlauf neu parst.
 *
 * Die Reihenfolge ist zeitlich aufsteigend — die Dateinamen sind Datumsangaben
 * und werden schlicht sortiert. Darauf verlassen sich alle Auswerter.
 */
export function* streamSamples(dir: string): Generator<ChargeLogSample> {
  // Unter der Grenze aus dem Cache: Wer schon alles im Speicher hat, soll es
  // nicht ein zweites Mal von der Platte lesen.
  const files = dayFiles(dir);
  if (files.length <= CACHE_MAX_FILES) {
    yield* readSamples(dir);
    return;
  }
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const rows: ChargeLogSample[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const roh = JSON.parse(line) as ChargeLogSample;
        // Ohne Zeitstempel ist die Zeile für jede Auswertung wertlos — und
        // der Sortiervergleich wirft an ihr, was JEDE Route auf 500 riss.
        if (typeof roh?.ts !== 'string') {
          continue;
        }
        rows.push(normalizeSample(roh));
      } catch {
        // abgeschnittene Zeile ignorieren
      }
    }
    // Innerhalb einer Datei kann die Reihenfolge verrutscht sein (Neustart
    // mitten am Tag) — sortieren, aber nur diese Datei.
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    yield* rows;
  }
}

/**
 * Die Messpunkte eines Zeitfensters — gezielt gelesen, nicht aus dem Cache.
 *
 * Die Ladekurven brauchen die Rohdaten der gezeigten Ladungen. Der Cache hält
 * bei langer Historie nur das Ende ({@link CACHE_MAX_FILES}); wer in einen
 * Zeitraum von vor zwei Jahren blättert, fände dort nichts. Weil die
 * Tagesdateien nach Datum heißen, lässt sich das Fenster aber ohne jedes
 * Parsen aus den Dateinamen bestimmen — gelesen wird nur, was gebraucht wird.
 *
 * `from` und `to` sind Tagesschlüssel (`YYYY-MM-DD`), beide einschließlich.
 * Der Aufrufer sollte einen Tag Rand mitgeben: Eine Nachtladung beginnt am
 * Vortag, und ohne ihren Anfang fehlte der Kurve das erste Stück.
 */
export function readSamplesRange(
  dir: string,
  from: string,
  to: string,
): ChargeLogSample[] {
  const out: ChargeLogSample[] = [];
  for (const f of dayFiles(dir)) {
    const day = f.slice(0, 10);
    if (day < from || day > to) {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const roh = JSON.parse(line) as ChargeLogSample;
        if (typeof roh?.ts !== 'string') {
          continue;
        }
        out.push(normalizeSample(roh));
      } catch {
        // abgeschnittene Zeile ignorieren
      }
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Die Tagesdateien eines Verzeichnisses, zeitlich aufsteigend. */
/**
 * Nur die Tagesdateien des Mitschriebs, sortiert.
 *
 * Der Name ist Teil des Formats: `YYYY-MM-DD.jsonl`. Was anders heißt,
 * gehört jemand anderem — eine halb zurückgespielte Sicherung, ein Export,
 * eine von Hand angelegte Datei. Vorher genügte die Endung, und eine
 * einzige fremde Datei konnte die gesamte Auswertung kippen.
 */
export const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function dayFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => DAY_FILE.test(f))
      .sort();
  } catch {
    return [];
  }
}

function readSamplesUncached(dir: string): ChargeLogSample[] {
  // Bei sehr langer Historie nur das Ende: Ein vollständiger Cache über sechs
  // Jahre kostet 248 MB und bringt den Pi um. Wer alles braucht, streamt.
  const all = dayFiles(dir);
  const files = all.length > CACHE_MAX_FILES ? all.slice(-CACHE_MAX_FILES) : all;
  const out: ChargeLogSample[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const roh = JSON.parse(line) as ChargeLogSample;
        if (typeof roh?.ts !== 'string') {
          continue;
        }
        out.push(roh);
      } catch {
        // abgeschnittene Zeile ignorieren
      }
    }
  }
  return out.map(normalizeSample).sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Repariert Messpunkte aus älteren Plugin-Versionen.
 *
 * Bis zum 2026-07-28 schrieb der Parser bei einer Antwort ohne
 * `CHARGING_SUMMARY` ein `plugged: false` — also „ausgesteckt" statt
 * „unbekannt". Solche Zeilen zerschneiden rückwirkend jede Nachtladung, in der
 * die API eine ihrer stündlichen Leerantworten geliefert hat.
 *
 * Erkennungsmerkmal: `plugged: false` OHNE jeden anderen Messwert. Ein echtes
 * Ausstecken kommt praktisch nie ohne Ladestand — die leeren Antworten dagegen
 * enthielten ausschließlich den Zeitstempel.
 */
function normalizeSample(s: ChargeLogSample): ChargeLogSample {
  if (s.plugged === false && s.soc === undefined && s.rangeKm === undefined) {
    const { plugged: _drop, ...rest } = s;
    return rest;
  }
  return s;
}

/**
 * Ergebnisse, die über die GANZE Historie gehen und nicht am gewählten
 * Zeitraum hängen — Kapazität, Fahrten, Abfragetakt.
 *
 * Ohne diesen Cache streamt ein Seitenaufruf fünfmal durch die Historie: für
 * die Zeitreihe, ihre Unterteilung, die Datenqualität, die Kapazität und die
 * Fahrten. Bei sechs Jahren sind das fünfmal eine halbe Sekunde nur zum
 * Parsen — gemessen 3,5 s für eine Seite.
 *
 * Bewusst nur diese drei: Zeitreihe und Unterteilung hängen an Granularität
 * und Ortsfilter, also an der Adresse. Sie zu cachen hieße, einen Schlüssel
 * über alle Kombinationen zu führen, und der wäre bei jedem Wechsel kalt.
 */
let statsCache:
  | {
      sig: string;
      dir: string;
      capacityKwh: number;
      pricePerKwh: number;
      priceSig: string;
      capacity: CapacityEstimate;
      trips: Trip[];
      pollMin: number;
      idle: IdleAnalysis;
    }
  | undefined;

/**
 * Die GEMESSENE Kapazität, mit eigenem Cache.
 *
 * Bewusst getrennt von {@link statsFor}: Die Messung hängt an keiner
 * Einstellung, nur an den Rohdaten — deshalb genügt die Verzeichnissignatur
 * als Schlüssel. Genau das löst den Zirkelbezug, der sonst entstünde:
 * `optionsFor` braucht die Messung, `statsFor` braucht `optionsFor`.
 */
let measuredCache: { sig: string; dir: string; est: CapacityEstimate } | undefined;

export function measuredCapacity(dir: string): CapacityEstimate {
  const sig = signature(dir);
  if (measuredCache && measuredCache.dir === dir && measuredCache.sig === sig) {
    return measuredCache.est;
  }
  const est = estimateCapacity(streamSamples(dir));
  measuredCache = { sig, dir, est };
  return est;
}

export interface HistoryStats {
  capacity: CapacityEstimate;
  trips: Trip[];
  pollMin: number;
  /** Ruhe- und Standklima-Bilanz — siehe {@link ./idle}. */
  idle: IdleAnalysis;
}

export function statsFor(dir: string, eff: EffectiveOptions): HistoryStats {
  const sig = signature(dir);
  if (
    statsCache &&
    statsCache.dir === dir &&
    statsCache.sig === sig &&
    // Die Kapazität geht in die Fahrten-Energie NICHT ein, wohl aber der Preis
    // in ihre Kosten. Beide im Schlüssel, damit eine Änderung auf der
    // Einstellungsseite sofort greift.
    statsCache.capacityKwh === eff.capacityKwh &&
    statsCache.pricePerKwh === eff.pricePerKwh &&
    statsCache.priceSig === eff.priceSig
  ) {
    return statsCache;
  }
  const capacity = estimateCapacity(streamSamples(dir));
  const trips = buildTrips(streamSamples(dir), {
    pricePerKwh: eff.pricePerKwh,
    priceFor: eff.priceFor,
  });
  const pollMin = pollIntervalMinutes(streamSamples(dir));
  // Die Lückenschwelle der Ruheanalyse folgt dem GEMESSENEN Abfragetakt:
  // zwei Intervalle plus etwas Luft. So überlebt ein einzelner ausgefallener
  // Poll, während eine echte Datenlücke weiter abgewiesen wird — und die
  // Auswertung funktioniert unabhängig davon, wie das Intervall konfiguriert
  // ist. Fest verdrahtet wäre sie an einen Takt gebunden, den der Nutzer
  // jederzeit ändern kann.
  const idle = analyzeIdle(streamSamples(dir), { maxGapMin: pollMin * 2 + 5 });
  statsCache = {
    sig,
    dir,
    capacityKwh: eff.capacityKwh,
    pricePerKwh: eff.pricePerKwh,
    priceSig: eff.priceSig,
    capacity,
    trips,
    pollMin,
    idle,
  };
  return statsCache;
}

/**
 * Fertige Zeitreihen, nach Granularität und Ortsfilter getrennt.
 *
 * Die Reihe selbst ist klein — sechs Jahre ergeben 2190 Tages-Buckets, jedes
 * ein flaches Objekt mit einem Dutzend Zahlen. Teuer ist nur ihr Aufbau, weil
 * er die ganze Historie durchläuft. Genau das macht sie zum idealen
 * Cache-Kandidaten: viel Rechenzeit, wenig Speicher.
 *
 * Der Schlüssel führt ALLES mit, was das Ergebnis verändert — auch Kapazität
 * und Preise, denn beide sind auf der Einstellungsseite änderbar und gehen in
 * jede Zahl der Reihe ein. Ein Cache, der eine Einstellungsänderung nicht
 * bemerkt, ist schlimmer als keiner.
 */
const aggCache = new Map<string, Bucket[]>();

/** Höchstzahl gehaltener Reihen: vier Granularitäten mal drei Ortsfilter. */
const AGG_CACHE_MAX = 12;

/**
 * Der Aufrufer liefert den (bereits ortsgefilterten) Strom als Fabrik — sie
 * wird nur bei einem Cache-Fehlschlag aufgerufen. Der Schlüssel entsteht
 * hier, aus allem, was das Ergebnis verändert.
 */
export function cachedAggregate(
  dir: string,
  eff: EffectiveOptions,
  g: Granularity,
  place: Place,
  produce: () => Iterable<ChargeLogSample>,
): Bucket[] {
  const key = [
    // Das Verzeichnis ausdrücklich mit: Die Signatur trägt nur Dateinamen,
    // Größen und Zeiten — zwei Verzeichnisse mit gleichen Tagesdateien
    // ergäben sonst denselben Schlüssel.
    dir,
    signature(dir),
    g,
    place,
    eff.dayBoundaryHour,
    eff.capacityKwh,
    eff.pricePerKwh,
    eff.grossPricePerKwh,
    eff.priceSig,
  ].join('|');
  const hit = aggCache.get(key);
  if (hit) {
    return hit;
  }
  const out = aggregate(produce(), g, eff);
  // Kein LRU, nur ein Deckel: Ändert sich der Mitschrieb, sind ohnehin alle
  // Schlüssel kalt, und dann ist Leeren billiger als Verwalten.
  if (aggCache.size >= AGG_CACHE_MAX) {
    aggCache.clear();
  }
  aggCache.set(key, out);
  return out;
}

/**
 * Typischer Abstand zwischen zwei Messpunkten OHNE Kabel, in Minuten.
 *
 * Der Median, nicht der Mittelwert: Ein Plugin-Neustart oder ein Netzausfall
 * reißt eine Lücke von Stunden, und die zöge jeden Durchschnitt mit sich. Der
 * Wert beschreibt, wie fein die Fahrterkennung überhaupt auflösen kann.
 */
function pollIntervalMinutes(samples: Iterable<ChargeLogSample>): number {
  const gaps: number[] = [];
  let prev: ChargeLogSample | undefined;
  for (const s of samples) {
    if (s.plugged === true) {
      prev = undefined;
      continue;
    }
    if (prev) {
      gaps.push((Date.parse(s.ts) - Date.parse(prev.ts)) / 60000);
    }
    prev = s;
  }
  if (gaps.length === 0) {
    return 0;
  }
  gaps.sort((a, b) => a - b);
  return Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)]));
}
