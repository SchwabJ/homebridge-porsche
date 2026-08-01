/**
 * Ladehistorie-Dashboard.
 *
 * Kleiner HTTP-Server, der den Rohdaten-Mitschrieb zu Ladevorgängen auswertet
 * und als Seite ausliefert. Bewusst ohne Framework und ohne externe Assets:
 * eine Datei, keine Build-Kette, offline lauffähig und auf dem Homescreen
 * ablegbar.
 *
 * ## Zur Erreichbarkeit — genau lesen
 *
 * `listen(port)` ohne Adresse bindet an ALLE Schnittstellen, nicht nur an
 * localhost. Das ist Absicht (sonst käme man vom Telefon nicht auf die Seite),
 * heißt aber: Wer den Rechner erreicht, erreicht auch das Dashboard. Eine
 * Authentifizierung gibt es NICHT.
 *
 * Hier stand einmal „bindet ausschließlich ans LAN … von außen nicht
 * erreichbar". Das war eine Annahme über das Netz des Nutzers, keine
 * Eigenschaft dieses Codes — bei einer Portfreigabe oder einem Rechner mit
 * öffentlicher Adresse ist die Seite offen. Deshalb warnt der Start jetzt im
 * Log, und das README sagt es ebenfalls.
 *
 * Abgesichert ist stattdessen die Angriffsfläche selbst: Alles Lesende ist ein
 * reines GET auf feste Pfade — keine Route nimmt einen Dateipfad aus der URL
 * entgegen. Der einzige Aufruf mit Wirkung nach draußen (`/api/refresh`)
 * verlangt POST samt gleichem Origin und ist zusätzlich ratenbegrenzt.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { buildSessions, type ChargeSession } from './sessions';
import { aggregate, efficiency, keyOf, SUB, type Granularity, type Bucket} from './aggregate';
import type { ChargeLogSample } from './chargeLog';
import { ICONS } from './icons';
import { fill, type Labels } from './i18n';
import {
  capacityTrend,
  estimateCapacity,
  stateOfHealth,
  type CapacityEstimate,
} from './capacity';
import { buildTrips, summarizeTrips, type Trip } from './trips';
import { analyzeIdle, idleStats } from './idle';
import { buildReceipt, receiptCsv, receiptMonths, type Receipt } from './receipt';
import { tripsCsv, sessionsCsv } from './csv';
import { buildTripReport, tripMonths, type TripReport } from './tripReport';
import { buildBatteryReport, type BatteryReport } from './batteryReport';
import { monthKey, socSpan } from './format';
import { readPrices, writePrice, costFrom, sanitize, type PriceStore } from './prices';
import {
  archivePrice,
  localDay,
  dayOk,
  mergeSettings,
  readSettings,
  writeSettings,
  sanitizeSettings,
  rejectedSettings,
  type DashboardSettings,
  type Source,
} from './settings';
import {
  chargeCurve,
  barChart,
  sparkline,
  CHART_CSS,
  BARS_CSS,
  SPARK_CSS,
  type BarPoint,
} from './chart';

export interface DashboardOptions {
  port: number;
  logDir: string;
  capacityKwh: number;
  /** Effektiver Arbeitspreis in EUR/kWh (Grundpreis abzüglich Bonus). */
  pricePerKwh: number;
  /** Nur für die Anzeige: Grundpreis und Bonus in Cent. */
  priceCt: number;
  bonusCt: number;
  /** Vorgabepreis für Ladungen unterwegs in Cent je kWh (0 = keiner). */
  externalPriceCt: number;
  /** Stunde, zu der ein neuer Tag beginnt (lokale Zeit). */
  dayBoundaryHour: number;
  vehicleName: string;
  /** Port der Homebridge-Oberfläche, für den Einstellungen-Link. */
  uiPort: number;
  /** Lokalisierte Texte — einzige Quelle sichtbarer Zeichenketten. */
  labels: Labels;
  log?: (msg: string) => void;
  /**
   * Löst einen sofortigen Abruf beim Fahrzeug-Backend aus (Refresh-Knopf).
   *
   * Optional: Ohne Handler bleibt der Knopf verborgen, statt einen Fehler zu
   * zeigen — so bleibt das Dashboard auch eigenständig lauffähig.
   */
  onRefresh?: () => Promise<void>;
}

/**
 * Mindestabstand zwischen zwei manuellen Abrufen.
 *
 * Ein Knopf ohne Sperre lädt zum Draufhämmern ein, und genau das provoziert
 * die 429er, gegen die der Poll-Zyklus abgesichert ist — im schlimmsten Fall
 * bis zur Captcha-Sperre, die ein neues Login erzwingen würde.
 */
const REFRESH_COOLDOWN_MS = 60000;

/**
 * Wie viele Ladungen bzw. Fahrten eine Liste höchstens zeigt.
 *
 * Ohne Deckel wächst die Ausgabe mit dem Mitschrieb: Ein Jahr ergibt 365
 * Ladungen, jede mit eigener Ladekurve — nachgemessen 1,4 MB HTML und 3,6
 * Sekunden auf einem schnellen Rechner, auf einem Raspberry Pi ein Vielfaches
 * davon. Die DATEN sind dabei nie das Problem (ein Jahr einlesen kostet 81 ms),
 * nur ihre Darstellung.
 *
 * Wird gedeckelt, sagt die Liste es ausdrücklich — ein stiller Schnitt sähe
 * aus wie Vollständigkeit.
 */
const LIST_LIMIT = 40;

/**
 * Signatur des Verzeichnisses: Dateinamen, Größen und Änderungszeiten.
 *
 * Grundlage des Caches — bei rund 50.000 Zeilen im Jahr wäre es Verschwendung,
 * bei jedem Seitenaufruf alles neu zu parsen. Da nur angehängt wird, genügt
 * Größe plus mtime, um jede Änderung zu erkennen.
 */
function signature(dir: string): string {
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
const CACHE_MAX_FILES = 500;


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
        rows.push(normalizeSample(JSON.parse(line) as ChargeLogSample));
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
      capacity: CapacityEstimate;
      trips: Trip[];
      pollMin: number;
    }
  | undefined;

interface HistoryStats {
  capacity: CapacityEstimate;
  trips: Trip[];
  pollMin: number;
}

function statsFor(o: DashboardOptions): HistoryStats {
  const eff = optionsFor(o);
  const sig = signature(o.logDir);
  if (
    statsCache &&
    statsCache.dir === o.logDir &&
    statsCache.sig === sig &&
    // Die Kapazität geht in die Fahrten-Energie NICHT ein, wohl aber der Preis
    // in ihre Kosten. Beide im Schlüssel, damit eine Änderung auf der
    // Einstellungsseite sofort greift.
    statsCache.capacityKwh === eff.capacityKwh &&
    statsCache.pricePerKwh === eff.pricePerKwh
  ) {
    return statsCache;
  }
  const capacity = estimateCapacity(streamSamples(o.logDir));
  const trips = buildTrips(streamSamples(o.logDir), { pricePerKwh: eff.pricePerKwh });
  const pollMin = pollIntervalMinutes(streamSamples(o.logDir));
  statsCache = {
    sig,
    dir: o.logDir,
    capacityKwh: eff.capacityKwh,
    pricePerKwh: eff.pricePerKwh,
    capacity,
    trips,
    pollMin,
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

function cachedAggregate(
  o: DashboardOptions,
  stream: () => Iterable<ChargeLogSample>,
  sessions: ChargeSession[],
  g: Granularity,
  place: Place,
): Bucket[] {
  const eff = optionsFor(o);
  const key = [
    signature(o.logDir),
    g,
    place,
    eff.dayBoundaryHour,
    eff.capacityKwh,
    eff.pricePerKwh,
    eff.grossPricePerKwh,
  ].join('|');
  const hit = aggCache.get(key);
  if (hit) {
    return hit;
  }
  const out = aggregate(streamByPlace(stream(), sessions, place), g, eff);
  // Kein LRU, nur ein Deckel: Ändert sich der Mitschrieb, sind ohnehin alle
  // Schlüssel kalt, und dann ist Leeren billiger als Verwalten.
  if (aggCache.size >= AGG_CACHE_MAX) {
    aggCache.clear();
  }
  aggCache.set(key, out);
  return out;
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
        out.push(normalizeSample(JSON.parse(line) as ChargeLogSample));
      } catch {
        // abgeschnittene Zeile ignorieren
      }
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Die Tagesdateien eines Verzeichnisses, zeitlich aufsteigend. */
function dayFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
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
        out.push(JSON.parse(line) as ChargeLogSample);
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

/** Ortsfilter des Dashboards. */
export type Place = 'all' | 'home' | 'away';

/**
 * Blendet die Messpunkte aus, die zu einer Ladung am FALSCHEN Ort gehören.
 *
 * Bewusst subtraktiv: Entfernt werden nur Messpunkte innerhalb einer Session
 * mit unpassendem Ort. Alles außerhalb der Kabelzeit bleibt stehen, denn dort
 * entsteht keine geladene Energie — wohl aber die gefahrenen Kilometer und der
 * Verbrauch. Ein Filter auf „zuhause" soll die Ladekosten trennen, nicht die
 * Fahrleistung halbieren.
 *
 * Ladungen ohne bekannten Ort zählen zu keinem der beiden Filter. Sie
 * verschwinden damit aus beiden Ansichten — sichtbar bleibt das in der
 * Gesamtansicht, wo die Summe dann höher ist als zuhause plus unterwegs.
 */
export function filterByPlace(
  samples: ChargeLogSample[],
  sessions: ChargeSession[],
  place: Place,
): ChargeLogSample[] {
  // Ohne Filter das Original, nicht eine Kopie: Bei einem Jahr Mitschrieb wäre
  // die Kopie ein zweites Array über 151.000 Verweise, und zwar für nichts.
  if (place === 'all') {
    return samples;
  }
  return [...streamByPlace(samples, sessions, place)];
}

/**
 * Dasselbe als Strom — für Auswertungen über die ganze Historie.
 *
 * Die Zeitfenster der auszuschließenden Ladungen sind klein (eine Handvoll
 * Zahlen je Ladung); die Messpunkte laufen einzeln durch und werden danach
 * wieder freigegeben. Ohne diesen Weg müsste für einen Ortsfilter die gesamte
 * Historie als Objekte im Speicher liegen.
 */
export function* streamByPlace(
  samples: Iterable<ChargeLogSample>,
  sessions: ChargeSession[],
  place: Place,
): Generator<ChargeLogSample> {
  if (place === 'all') {
    yield* samples;
    return;
  }
  const want = place === 'home';
  const drop = sessions
    .filter((x) => x.atHome !== want)
    .map((x) => ({
      from: Date.parse(x.startedAt),
      to: x.endedAt ? Date.parse(x.endedAt) : Number.MAX_SAFE_INTEGER,
    }));
  if (drop.length === 0) {
    yield* samples;
    return;
  }
  for (const s of samples) {
    const t = Date.parse(s.ts);
    if (!drop.some((d) => t >= d.from && t <= d.to)) {
      yield s;
    }
  }
}

/**
 * Setzt die Kosten der Ladungen UNTERWEGS aus eingetragenem Preis oder Vorgabe.
 *
 * Reihenfolge mit Absicht: Ein je Ladung eingetragener Preis schlägt die
 * Vorgabe — er ist die konkrete Beobachtung, die Vorgabe nur ein Mittelwert
 * über Säulen, die sich um den Faktor drei unterscheiden. Liegt beides nicht
 * vor, bleiben die Kosten LEER statt auf den Haustarif zurückzufallen.
 *
 * Heimladungen bleiben unangetastet: Für sie hat `buildSessions` bereits mit
 * dem Haustarif gerechnet.
 */
export function applyExternalPrices(
  sessions: ChargeSession[],
  prices: PriceStore,
  fallbackCt: number,
): ChargeSession[] {
  return sessions.map((s) => {
    if (s.atHome !== false) {
      return s;
    }
    const own = prices[s.startedAt];
    const cost =
      costFrom(own, s.energyKwh) ??
      (fallbackCt > 0 && s.energyKwh !== undefined
        ? (fallbackCt / 100) * s.energyKwh
        : undefined);
    const out: ChargeSession = { ...s };
    delete out.costGrossEur;
    delete out.savedEur;
    if (cost === undefined) {
      delete out.costEur;
      delete out.pricePerKwh;
      return out;
    }
    out.costEur = Math.round(cost * 100) / 100;
    if (s.energyKwh) {
      out.pricePerKwh = Math.round((cost / s.energyKwh) * 10000) / 10000;
    }
    return out;
  });
}

/** Monatsschlüssel `YYYY-MM` einer Session (nach Startzeitpunkt). */
const monthOf = (s: ChargeSession): string => s.startedAt.slice(0, 7);

export interface MonthSummary {
  month: string;
  kwh: number;
  cost: number;
  count: number;
}

/** Fasst Sessions je Kalendermonat zusammen, neueste zuerst. */
export function summarize(sessions: ChargeSession[]): MonthSummary[] {
  const byMonth = new Map<string, MonthSummary>();
  for (const s of sessions) {
    const key = monthOf(s);
    const m = byMonth.get(key) ?? { month: key, kwh: 0, cost: 0, count: 0 };
    m.kwh += s.energyKwh ?? 0;
    m.cost += s.costEur ?? 0;
    m.count++;
    byMonth.set(key, m);
  }
  return [...byMonth.values()].sort((a, b) => b.month.localeCompare(a.month));
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const fmtDate = (iso: string, locale: string): string =>
  new Date(iso).toLocaleString(locale, {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const fmtDur = (min: number): string =>
  min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`;

/**
 * Letzter tatsächlich vorhandener Wert einer Angabe über eine Reihe Messpunkte.
 *
 * Gebraucht für die Zielmarken einer einzelnen Ladung. Vorher stammten sie aus
 * dem AKTUELLEN Fahrzeugzustand — jede Ladung der Liste bekam damit das heutige
 * Ladeziel aufgemalt, auch eine von letzter Woche mit einem anderen. Das
 * verschiebt nicht nur die gestrichelte Linie: `chargeCurve` endet, sobald das
 * Ziel erreicht ist, und schnitte eine Ladung auf 100 % beim heutigen Ziel von
 * 80 % mitten im Verlauf ab.
 *
 * Rückwärts gesucht, weil das Ziel am ENDE der Ladung das ist, gegen das
 * tatsächlich geladen wurde — ändert der Tarifanbieter es mittendrin, zählt der
 * letzte Stand. Und rückwärts bis zum ersten Messpunkt MIT der Angabe, weil
 * leere API-Antworten nur `ts` tragen und ausgerechnet am Ende einer Ladung
 * häufig sind; ein einzelner solcher Messpunkt würde die Marke sonst löschen.
 */
const lastValue = (
  rows: ChargeLogSample[],
  pick: (s: ChargeLogSample) => number | undefined,
): number | undefined => {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = pick(rows[i]);
    if (v !== undefined) {
      return v;
    }
  }
  return undefined;
};

/**
 * Auswertungs-Optionen aus der Dashboard-Konfiguration.
 *
 * Eine einzige Quelle für alle Aufrufer: Diese Optionen wurden ursprünglich an
 * drei Stellen einzeln zusammengebaut, wobei eine davon Grundpreis und
 * Tagesgrenze verlor — die Ersparnis stand dann auf 0 und die Tagesgrenze
 * wirkte nur in der JSON-Schnittstelle.
 */
/**
 * Die tatsächlich wirksamen Auswertungswerte.
 *
 * Bei JEDEM Aufruf frisch von der Platte gelesen: Eine Änderung auf der
 * Einstellungsseite soll beim nächsten Laden greifen, nicht erst nach einem
 * Neustart des Plugins — genau darum gibt es sie.
 */
export function effective(o: DashboardOptions): {
  values: { priceCt: number; bonusCt: number; externalPriceCt: number; capacityKwh: number; dayBoundaryHour: number };
  source: Record<'priceCt' | 'bonusCt' | 'externalPriceCt' | 'capacityKwh' | 'dayBoundaryHour', Source>;
  stored: DashboardSettings;
} {
  const stored = readSettings(o.logDir);
  const { values, source } = mergeSettings(
    {
      priceCt: o.priceCt,
      bonusCt: o.bonusCt,
      externalPriceCt: o.externalPriceCt,
      capacityKwh: o.capacityKwh,
      dayBoundaryHour: o.dayBoundaryHour,
    },
    stored,
  );
  return { values, source, stored };
}

export function optionsFor(o: DashboardOptions): {
  capacityKwh: number;
  pricePerKwh: number;
  grossPricePerKwh: number;
  dayBoundaryHour: number;
  labels: Labels;
} {
  // Über die Einstellungsseite, falls dort etwas gesetzt ist. Der Effektivpreis
  // wird dabei neu gerechnet: Er ist Grundpreis minus Bonus, und beide können
  // von dort kommen.
  const { values } = effective(o);
  return {
    capacityKwh: values.capacityKwh,
    pricePerKwh: Math.max(0, values.priceCt - values.bonusCt) / 100,
    grossPricePerKwh: values.priceCt / 100,
    dayBoundaryHour: values.dayBoundaryHour,
    labels: o.labels,
  };
}

/**
 * Der aktuelle Fahrzeug- und Überwachungszustand aus dem letzten Messpunkt.
 *
 * `monitorOk` ist bewusst an das Alter des letzten Messpunkts geknüpft, nicht
 * daran, dass der Dienst läuft: Ein laufendes Plugin, dessen Abfragen seit
 * Stunden scheitern, wäre sonst als „aktiv" ausgewiesen, obwohl die Anzeige
 * längst eingefroren ist.
 */
/**
 * Messwerte, die zwischen zwei Abfragen gültig bleiben.
 *
 * Rund 7 % der Messpunkte tragen keinen Ladestand: Die Schnittstelle
 * beantwortet einen Teil der Abfragen nur mit dem Ladezustand, und ein
 * fehlendes Feld heißt dort „nicht geliefert", nicht „nicht vorhanden". Für
 * die Anzeige des JETZIGEN Zustands ist der letzte bekannte Wert die richtige
 * Antwort — ein Kilometerstand von vor drei Minuten IST der Kilometerstand.
 *
 * Momentanwerte stehen bewusst nicht hier. 10 kW Ladeleistung von vorhin sind
 * keine Aussage über jetzt, und `plugged` erst recht nicht: Beim Ausstecken
 * verwirft {@link ./store#normalizeSample} die Leerantwort-Zeilen, ein
 * fortgeschriebenes „eingesteckt" behauptete also ein Kabel am längst
 * abgefahrenen Auto.
 */
const CARRY_FIELDS = ['soc', 'rangeKm', 'odometerKm', 'minSoc', 'targetSoc'] as const;

export interface CurrentStatus {
  /** Roher letzter Messpunkt: Abfragezeitpunkt und Momentanwerte. */
  last?: ChargeLogSample;
  /** Derselbe Punkt, ergänzt um die zuletzt bekannten {@link CARRY_FIELDS}. */
  state?: ChargeLogSample;
  /** Zeitpunkt, aus dem die ergänzten Messwerte stammen. */
  stateAt?: string;
  ageMinutes?: number;
  monitorOk: boolean;
}

export function currentStatus(samples: ChargeLogSample[], now: number): CurrentStatus {
  const last = samples[samples.length - 1];
  if (!last) {
    return { monitorOk: false };
  }
  const state: ChargeLogSample = { ...last };
  for (const f of CARRY_FIELDS) {
    if (state[f] !== undefined) {
      continue;
    }
    for (let i = samples.length - 1; i >= 0; i--) {
      const v = samples[i][f];
      if (v !== undefined) {
        state[f] = v;
        break;
      }
    }
  }
  // Der Zeitpunkt der Anzeige ist der jüngste Messpunkt, der überhaupt einen
  // Messwert trug — nicht der jüngste je Feld. Ladeziel und Sofortlade-
  // Schwelle liefert das Fahrzeug nur am Kabel; sie am stehenden Auto
  // mitzählen zu lassen schrieb über eine taufrische Anzeige „Stand 05:12".
  let stateAt: string | undefined;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (CARRY_FIELDS.some((f) => samples[i][f] !== undefined)) {
      stateAt = samples[i].ts;
      break;
    }
  }
  // Nie negativ: Die Fahrzeugantwort ist zwischengespeichert und trägt
  // gelegentlich einen Zeitstempel, der in der Zukunft liegt. „vor -2700 min"
  // ist keine Altersangabe, sondern ein Rechenartefakt.
  const ageMinutes = Math.max(0, (now - Date.parse(last.ts)) / 60000);
  // Kulanz: das langsamste reguläre Intervall plus Puffer.
  return { last, state, stateAt, ageMinutes, monitorOk: ageMinutes <= 45 };
}

/**
 * Wie viele Unterteilungen ein Zeitraum höchstens zeigt.
 *
 * Nicht mehr die Zahl der Zeiträume in der Reihe: Der gewählte Zeitraum ist der
 * Rahmen, und darin stehen seine eigenen Abschnitte — 24 Stunden, 7 Tage,
 * gut 5 Wochen, 12 Monate.
 */
const SPAN: Record<Granularity, number> = { hour: 24, day: 24, week: 7, month: 6, year: 12 };

const GRAN_LABEL: Record<Granularity, string> = {
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year',
};

/**
 * Typischer Abstand zwischen zwei Messpunkten OHNE Kabel, in Minuten.
 *
 * Der Median, nicht der Mittelwert: Ein Plugin-Neustart oder ein Netzausfall
 * reißt eine Lücke von Stunden, und die zöge jeden Durchschnitt mit sich. Der
 * Wert beschreibt, wie fein die Fahrterkennung überhaupt auflösen kann.
 */
/**
 * Prognose für die laufende Ladung: Wie lange noch bis zum Ziel?
 *
 * Gerechnet aus dem SoC-Rest mal Kapazität durch die MITTLERE Leistung der
 * bisherigen Ladephasen — nicht aus dem Momentanwert, der bei jeder
 * Slot-Pause null wäre.
 *
 * Eine UHRZEIT gibt es nur, wenn die Ladung bisher praktisch pausenfrei lief:
 * Bei tarifgesteuertem Laden (Octopus & Co.) hängen die künftigen Slots am
 * Anbieter, und eine geratene Uhrzeit wäre schlechter als keine. Dann bleibt
 * es bei der REINEN Ladezeit, als solche gekennzeichnet.
 */
export function chargeEta(
  running: ChargeSession,
  capacityKwh: number,
  now: number,
): { restMin: number; doneBy?: number; pureChargeTime: boolean } | undefined {
  const { endSoc, targetSoc, avgPowerKw } = running;
  if (
    endSoc === undefined ||
    targetSoc === undefined ||
    avgPowerKw === undefined ||
    avgPowerKw <= 0 ||
    endSoc >= targetSoc
  ) {
    return undefined;
  }
  const restKwh = ((targetSoc - endSoc) / 100) * capacityKwh;
  const restMin = Math.round((restKwh / avgPowerKw) * 60);
  // „Pausenfrei" mit Toleranz: Die Phasensummen sind gerundet, und die erste
  // Minute nach dem Einstecken lädt oft noch nicht.
  const pausenfrei = running.durationMin <= 0 || running.chargingMin >= running.durationMin * 0.9;
  if (pausenfrei) {
    return { restMin, doneBy: now + restMin * 60000, pureChargeTime: false };
  }
  return { restMin, pureChargeTime: true };
}

/**
 * Erster Index, dessen Wert nicht kleiner als `x` ist — klassische Binärsuche.
 *
 * Setzt eine aufsteigend sortierte Reihe voraus; `readSamples` liefert genau
 * das.
 */
function lowerBound(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

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

function renderPage(
  allSessions: ChargeSession[],
  allSamples: ChargeLogSample[],
  gran: Granularity,
  o: DashboardOptions,
  host: string,
  place: Place = 'all',
  picked?: string,
  /**
   * Alle Messpunkte als STROM, für jeden Aufruf neu.
   *
   * Eine Fabrik und kein Array: Was über die ganze Historie rechnet — Zeitreihe,
   * Kapazität, Fahrten — bekommt damit einen frischen Durchlauf, ohne dass die
   * Historie gleichzeitig im Speicher liegen muss. Ohne Fabrik (Tests, kurze
   * Historien) dient `allSamples` als Quelle.
   */
  stream?: () => Iterable<ChargeLogSample>,
): string {
  const L = o.labels;
  const alle = stream ?? ((): Iterable<ChargeLogSample> => allSamples);
  // Was über die ganze Historie geht und nicht am Zeitraum hängt, kommt
  // gecacht — sonst streamt ein Aufruf fünfmal durch sechs Jahre.
  const stats = statsFor(o);
  const sessions =
    place === 'all'
      ? allSessions
      : allSessions.filter((x) => x.atHome === (place === 'home'));
  const samples = filterByPlace(allSamples, allSessions, place);
  // Die Liste zeigt die Ladungen DES GEWÄHLTEN Zeitraums, nicht alle. Vorher
  // blieb sie beim Umschalten unverändert stehen — der Umschalter änderte
  // Kacheln und Balken, aber darunter stand immer dasselbe.
  let recent: ChargeSession[] = [];
  const running = sessions.find((s) => !s.complete);
  const priceStore = readPrices(o.logDir);
  // Plugin-Konfiguration, überlagert von der Einstellungsseite.
  const cfg = effective(o).values;

  // Zeitreihe aus den Rohdaten — nur so verteilt sich eine Nachtladung korrekt
  // auf beide Tage, statt komplett dem Startzeitpunkt zugeschlagen zu werden.
  // Die Zeitreihe über die GANZE Historie — gestreamt und gecacht, damit sechs
  // Jahre Mitschrieb nicht als Objekte im Speicher landen.
  const all = cachedAggregate(o, alle, allSessions, gran, place);

  // Welcher Zeitraum ist gewählt? Ohne Angabe der jüngste. Der Schlüssel steht
  // in der Adresse, damit ein Blättern teilbar und über „zurück" bedienbar ist.
  const pickedIdx = picked ? all.findIndex((b) => b.key === picked) : -1;
  const currentIdx = pickedIdx >= 0 ? pickedIdx : all.length - 1;
  const current = all[currentIdx];
  const previous = all[currentIdx - 1];
  // Das Diagramm zeigt die UNTERTEILUNG des gewählten Zeitraums, nicht die
  // Reihe der Zeiträume: Wer „Woche" wählt, will die Tage dieser Woche sehen.
  //
  // Vorher stand in der Wochenansicht ein einziger Balken, obwohl an zwei Tagen
  // geladen worden war — beide lagen in derselben Woche, also im selben Balken.
  const sub = SUB[gran];
  const series = current
    ? cachedAggregate(o, alle, allSessions, sub, place).filter(
        (b) =>
          keyOf(new Date(Date.parse(b.from) - cfg.dayBoundaryHour * 3600000), gran) ===
          current.key,
      )
    : [];
  // Effizienz des GEWÄHLTEN Zeitraums, nicht der ganzen Historie.
  //
  // Vorher stand hier `efficiency(all)` — die Summe über alles, beschriftet
  // mit „im Zeitraum". An einem Tag mit 20 gefahrenen Kilometern zeigte die
  // Kachel 211: die Gesamtstrecke des Mitschriebs. Mit einem Jahr Daten wären
  // es fünfstellige Zahlen unter einer Tagesansicht gewesen.
  //
  // Aus `current` statt aus `series`: Genau derselbe Bucket, aus dem auch die
  // kWh- und Kosten-Kacheln rechnen — zwei Wege zur selben Zahl wären zwei
  // Gelegenheiten, auseinanderzulaufen.
  const eff = efficiency(current ? [current] : []);
  // Die Ersparnis ist die eine Zahl, die ausdrücklich „gesamt" meint. Sie kommt
  // aus den LADUNGEN, nicht aus der Zeitreihe: Ein Bonus hängt an einer
  // Ladung, nicht an einem Zeitabschnitt.
  const totalSaved =
    Math.round(allSessions.reduce((a, x) => a + (x.savedEur ?? 0), 0) * 100) / 100;

  // Ohne konfigurierten Arbeitspreis werden keine Kosten gezeigt: 0,00 € wäre
  // eine Behauptung, keine Information.
  const awaySessions = allSessions.filter((x) => x.atHome === false);
  // Ladungen unterwegs tragen ihre Kosten selbst — aus eingetragenem Preis
  // oder Vorgabe. Ob überhaupt welche bekannt sind, entscheidet, ob die
  // Kostenseite dort erscheint.
  const awayPriced = awaySessions.some((x) => x.costEur !== undefined);
  const hasPrice = place === 'away' ? awayPriced : cfg.priceCt > 0;
  const awayUnpriced =
    cfg.priceCt > 0 && awaySessions.some((x) => x.costEur === undefined);
  // Der Ladebonus hängt am Haustarif. Unterwegs gibt es ihn nicht.
  const hasBonus = hasPrice && cfg.bonusCt > 0 && place !== 'away';


  // --- Fahrten --------------------------------------------------------------
  //
  // Aus ALLEN Messpunkten, nicht aus den ortsgefilterten: Wo geladen wurde,
  // sagt nichts darüber, wo gefahren wurde. Eine Fahrt zählt zu dem Zeitraum,
  // in dem sie ENDETE — sie ist ein Ereignis mit einem Ziel.
  //
  // Derselbe Effektivpreis wie bei den Ladungen — Grundpreis minus Bonus.
  const allTrips = stats.trips;

  // Der Gegenbalken kommt aus DERSELBEN Aggregation wie die Ladeenergie.
  //
  // Vorher stammte er aus den Fahrten und wurde dem Abschnitt zugeschlagen, in
  // dem die Fahrt ENDETE. Bei einer zweistündigen Fahrt stand dann ein
  // 46-kWh-Balken in einer Stunde, während die Stunde davor mit hundert
  // gefahrenen Kilometern auf null blieb — zwei Maßstäbe im selben Bild.
  const q = (g: Granularity, p: Place, d?: string): string =>
    `?g=${g}${p === 'all' ? '' : `&p=${p}`}${d ? `&d=${encodeURIComponent(d)}` : ''}`;

  // Drilldown nur, wenn der Unterzeitraum eine eigene Ansicht hat: Die
  // Stundenansicht existiert nicht als Ziel, und in ihr selbst ist der
  // Balken schon die feinste Auflösung.
  const drill = (b: Bucket): string | undefined =>
    sub !== gran && sub !== 'hour' ? `/${q(sub, place, b.key)}` : undefined;

  const barPoints: BarPoint[] = series.map((b) => {
    const offen = b.unratedKm;
    return {
      label: b.label,
      value: b.kwh,
      down: Math.round(b.usedKwh * 10) / 10,
      // Stückweise zusammengesetzt und dann verbunden: Vorher entstand bei
      // fehlender Reichweite ein doppelter Trenner („0,00 € ·  · 6 km").
      detail: [
        hasPrice ? `${b.cost.toFixed(2)} €` : '',
        b.rangeAdded > 0 ? `+${b.rangeAdded} km` : '',
        b.km > 0 ? `${b.km} km ${L.dashDriven.toLowerCase()}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      downDetail:
        offen > 0 ? L.chartUnrated.replace('%n', offen.toLocaleString(L.locale)) : undefined,
      current: b === current,
      href: drill(b),
    };
  });
  const bars = barChart(barPoints, L);

  const tabs = (['day', 'week', 'month', 'year'] as Granularity[])
    .map((g) => `<a href="${q(g, place)}"${g === gran ? ' class="on"' : ''}>${GRAN_LABEL[g]}</a>`)
    .join('');

  // Ortsumschalter — nur zeigen, wenn es überhaupt etwas zu trennen gibt.
  // Ein Filter, der immer dieselbe Liste liefert, ist nur Bedienlast.
  const homeCount = allSessions.filter((x) => x.atHome === true).length;
  const awayCount = allSessions.filter((x) => x.atHome === false).length;
  const places: [Place, string][] = [
    ['all', L.placeAll],
    ['home', L.placeHome],
    ['away', L.placeAway],
  ];
  // Blättern. Ein Zeitraum ohne Nachbarn braucht keinen Pfeil — ein toter
  // Knopf ist schlechter als keiner.
  const older = all[currentIdx - 1];
  const newer = all[currentIdx + 1];
  const nav = current
    ? `<nav class="per">
        ${
          older
            ? `<a href="${q(gran, place, older.key)}" rel="prev" aria-label="${esc(L.navOlder)}">‹</a>`
            : '<span>‹</span>'
        }
        <b>${esc(current.label)}</b>
        ${
          newer
            ? `<a href="${q(gran, place, newer.key)}" rel="next" aria-label="${esc(L.navNewer)}">›</a>`
            : '<span>›</span>'
        }
        ${
          currentIdx < all.length - 1
            ? `<a class="now" href="${q(gran, place)}">${esc(L.navNow)}</a>`
            : ''
        }
      </nav>`
    : '';

  const placeTabs =
    homeCount > 0 && awayCount > 0
      ? `<nav class="tabs sub">${places
          .map(
            ([pl, label]) =>
              `<a href="${q(gran, pl)}"${pl === place ? ' class="on"' : ''}>${esc(label)}${
                pl === 'home' ? `<em>${homeCount}</em>` : pl === 'away' ? `<em>${awayCount}</em>` : ''
              }</a>`,
          )
          .join('')}</nav>`
      : '';

  // Ladungen im angezeigten Zeitraum. Zugeordnet wird nach Startzeitpunkt —
  // eine Ladung IST ein Ereignis mit einem Beginn, anders als die Energie,
  // die sich über die Zeit verteilt.
  // Eine Ladung zählt zu JEDEM Zeitraum, in den sie hineinreicht — nicht nur
  // zu dem ihres Starts. Sonst zeigt ein Tag „Energie geladen, 0 Ladungen",
  // weil die Nachtladung schon am Vorabend begann.
  const inPeriod = current
    ? sessions.filter((x) => {
        const shift = cfg.dayBoundaryHour * 3600000;
        const from = keyOf(new Date(Date.parse(x.startedAt) - shift), gran);
        const to = keyOf(
          new Date((x.endedAt ? Date.parse(x.endedAt) : Date.now()) - shift),
          gran,
        );
        return current.key >= from && current.key <= to;
      })
    : [];
  // Gedeckelt: Jede gezeigte Ladung bringt ihre Ladekurve als eigenes SVG mit.
  // Ungedeckelt wog die Jahresansicht 1,4 MB — die Kacheln und das Diagramm
  // darüber rechnen weiterhin mit ALLEN Ladungen des Zeitraums.
  recent = [...inPeriod].reverse().slice(0, LIST_LIMIT);
  const avgPerCharge =
    inPeriod.length > 0
      ? inPeriod.reduce((a, s) => a + (s.energyKwh ?? 0), 0) / inPeriod.length
      : 0;

  // Aktueller Zustand für die Statuszeile.
  const st = currentStatus(samples, Date.now());
  // Ort nur anzeigen, wenn er bekannt ist — bei Privatmodus fehlt die Position,
  // und „auswärts" zu behaupten wäre dann schlicht falsch.
  const where =
    st.last?.atHome === true ? ` · ${esc(L.dashAtHome)}` : st.last?.atHome === false ? ` · ${esc(L.dashAway)}` : '';
  // Unbekannt ist nicht ausgesteckt. `!undefined` ist `true`, deshalb behauptete
  // die Zeile „nicht eingesteckt", wo die Schnittstelle gar nichts geliefert
  // hatte — an 14 Messpunkten einer Woche nachweislich am ladenden Auto, mit
  // 10 kW über die Lücke hinweg. Fortschreiben verbietet sich hier, aus dem
  // Grund, der über {@link CARRY_FIELDS} steht: Es tauschte diese Falschaussage
  // gegen die umgekehrte. Die Plakette bleibt grau — das Projekt trägt
  // Unbekanntes im Wort, nicht in der Farbe.
  const plugText =
    st.last?.plugged === undefined
      ? esc(L.dashPlugUnknown)
      : !st.last.plugged
        ? esc(L.dashNotPlugged)
        : st.last.charging
    ? // Ohne Laderate: Beide Plaketten sollen nebeneinander in EINE Zeile
            // passen, und die km/min sagen nichts, was die Fertig-Prognose eine
            // Zeile tiefer nicht besser sagt.
            `${esc(L.dashCharging)}${
              st.last.powerKw !== undefined ? ` · ${st.last.powerKw.toFixed(1)} kW` : ''
            }${where}`
          : `${esc(L.dashPluggedWaiting)}${where}`;
  const plugClass = !st.last?.plugged ? 'off' : st.last.charging ? 'ok' : 'wait';

  // Gemessene Kapazität — die empfindlichste Größe der ganzen Auswertung.
  // Aus ALLEN Fahrten: Wo geladen wurde, ändert die Batterie nicht.
  const cap = stats.capacity;
  const soh = stateOfHealth(cap.capacityKwh, cfg.capacityKwh);
  // Verlauf über die Monate — schweigt, solange er nichts hergibt.
  const capTrend = capacityTrend(cap);
  // Abweichung der Messung von der eingestellten Kapazität, in Prozent.
  const capDelta =
    cap.capacityKwh !== undefined
      ? Math.round(((cap.capacityKwh - cfg.capacityKwh) / cfg.capacityKwh) * 1000) / 10
      : undefined;

  // Fahrverbrauch laut Fahrzeug — unabhängig von unserer Rechnung.
  // Verbrauch DES ZEITRAUMS, nicht der letzte Messwert der ganzen Historie.
  //
  // Vorher stand hier `st.last?.tripKwh100` — der Fahrzeugschnitt seit dem
  // letzten Laden, also ein Momentanwert von jetzt. Er zeigte in JEDEM
  // Zeitraum dieselbe Zahl, auch für einen Tag, dessen Strecke ausdrücklich
  // als „ohne belastbaren Verbrauch" geführt wird.
  const ratedKm = current ? current.km - current.unratedKm : 0;
  const tripKwh100 =
    current && ratedKm > 0 ? Math.round((current.usedKwh / ratedKm) * 1000) / 10 : undefined;

  // Datenqualität des angezeigten Zeitraums. Ohne dieses Maß sähe eine
  // Auswertung aus sechs Messpunkten genauso vertrauenswürdig aus wie eine
  // aus sechshundert — und der Vergleich beider Verbrauchswerte wäre wertlos.
  //
  // Gemessen an den UNGEFILTERTEN Daten. Der Ortsfilter schneidet ganze
  // Ladungen heraus, und die entstehenden Löcher sind keine fehlenden
  // Messwerte, sondern genau das, was der Filter tun soll. Über die gefilterte
  // Reihe gerechnet meldete die Warnung „69 % erfasst, 11,4 h fehlen", während
  // der Mitschrieb in Wahrheit keine einzige Lücke über 35 Minuten hatte.
  const qualitySeries =
    place === 'all' ? all : cachedAggregate(o, alle, allSessions, gran, 'all');
  const qualityBucket = current
    ? qualitySeries.find((b) => b.key === current.key)
    : undefined;
  let quality: { level: string; text: string } | undefined;
  if (current && qualityBucket) {
    const covered = qualityBucket.spanMinutes + qualityBucket.gapMinutes;
    const pct = covered > 0 ? Math.round((qualityBucket.spanMinutes / covered) * 100) : 0;
    const gapH = qualityBucket.gapMinutes / 60;
    if (qualityBucket.samples < 5) {
      quality = { level: 'bad', text: L.dashTooFewPoints.replace('%n', String(current.samples)) };
    } else if (pct < 90) {
      quality = {
        level: 'warn',
        text: L.dashGaps.replace('%p', String(pct)).replace('%h', gapH.toFixed(1)),
      };
    }
  }
  // Die Gegenüberstellung beider Verbrauchswerte lohnt nur bei belastbarer
  // Datenbasis — gemessen an Messpunkten und Lücken, nicht an der Fahrstrecke.
  // Der Vergleich „laut Fahrzeug gegen bezahlt" braucht BEIDE Größen: gefahrene
  // Kilometer UND geladene Energie. Ohne Ladung im Zeitraum stand dort
  // „bezahlt 0.0" — das behauptet, der Wagen fahre umsonst.
  const trustworthy = quality === undefined && eff.km > 0 && eff.kwh > 0;
  // Der Vergleich „laut Fahrzeug gegen bezahlt" setzt voraus, dass Laden und
  // Fahren im selben Zeitraum liegen. Über eine Woche hinweg tun sie das
  // ungefähr, über einen Tag nicht: 26,8 kWh nachts geladen und 22 km gefahren
  // ergeben „bezahlt 121,7 kWh/100 km" — rechnerisch richtig, als Aussage
  // Unsinn. Die Nachtladung deckt die Fahrten des Folgetags.
  const payableCompare = trustworthy && gran !== 'day' && gran !== 'hour';

  // Vergleich mit dem Vorzeitraum. Der laufende Zeitraum ist unvollständig —
  // deshalb wird er als solcher gekennzeichnet statt schöngerechnet.
  let trend = '';
  if (current && previous && previous.kwh > 0) {
    const pct = Math.round(((current.kwh - previous.kwh) / previous.kwh) * 100);
    const sign = pct > 0 ? '+' : '';
    trend = `<span>${sign}${pct} % ${esc(L.dashComparedTo)} ${esc(previous.label)} · ${esc(
      L.dashInProgress,
    )}</span>`;
  }

  const fmtClock = (iso: string): string =>
    new Date(iso).toLocaleTimeString(L.locale, { hour: '2-digit', minute: '2-digit' });

  // Fertig-um-Prognose — die Frage, die man während einer Ladung hat.
  // Hängt die Ladung (stundenlang stromlos, Ziel verfehlt), wäre eine
  // Prognose eine Lüge: Dann steht dort die Warnung.
  let etaText = '';
  if (running) {
    const ziel = `${esc(L.dashTarget)} ${running.targetSoc} %`;
    const eta = running.stalled ? undefined : chargeEta(running, o.capacityKwh, Date.now());
    etaText = running.stalled
      ? `⚠︎ ${ziel} — ${L.dashStalled}`
      : eta
        ? eta.doneBy !== undefined
          ? `${ziel} · ${L.dashDoneAbout}${fmtClock(new Date(eta.doneBy).toISOString())}`
          : `${ziel} · ~${fmtDur(eta.restMin)} ${L.dashChargingLeft}`
        : '';
  }

  // Zeitstempel EINMAL in Zahlen umrechnen — die Ladekurven schneiden sich
  // ihre Messpunkte danach per Binärsuche heraus.
  // Messpunkte für die Ladekurven: aus dem ZEITRAUM, nicht aus dem globalen
  // Cache. Bei langer Historie hält der nur das Ende — eine Ladung von vor
  // zwei Jahren hätte dort keine Kurve mehr. Ein Tag Rand nach vorn, weil eine
  // Nachtladung am Vortag beginnt.
  //
  // Bei kurzer Historie ist `samples` ohnehin vollständig; dann wird nichts
  // zusätzlich gelesen.
  const curveSamples = ((): ChargeLogSample[] => {
    if (recent.length === 0) {
      return samples;
    }
    const ersteBekannt = samples.length > 0 ? samples[0].ts.slice(0, 10) : '9999-12-31';
    const brauchtVon = recent[recent.length - 1].startedAt.slice(0, 10);
    if (brauchtVon >= ersteBekannt) {
      return samples;
    }
    const tagFrueher = new Date(Date.parse(`${brauchtVon}T12:00:00Z`) - 86400000)
      .toISOString()
      .slice(0, 10);
    const bis = (recent[0].endedAt ?? recent[0].startedAt).slice(0, 10);
    return readSamplesRange(o.logDir, tagFrueher, bis);
  })();
  const sampleTimes = curveSamples.map((x) => Date.parse(x.ts));

  const tripsInPeriod = current
    ? allTrips.filter(
        (t) =>
          keyOf(new Date(Date.parse(t.endedAt) - cfg.dayBoundaryHour * 3600000), gran) ===
          current.key,
      )
    : [];
  const tripSum = summarizeTrips(tripsInPeriod);
  // Wie fein ist die Auflösung überhaupt? Der typische Messabstand OHNE Kabel
  // — am Kabel läuft der Poll deutlich dichter und verzerrte den Wert.
  const tripPollMin = stats.pollMin;
  /**
   * `?m=` für die Berichtslinks — der Monat, den der Nutzer gerade ansieht.
   *
   * Ohne ihn fielen beide Berichte auf den jüngsten Monat MIT Daten zurück:
   * Wer in einen früheren Zeitraum geblättert war, landete in anderen Zahlen
   * als denen, die er gerade las.
   */
  const berichtsMonat =
    current && (gran === 'day' || gran === 'week' || gran === 'month')
      ? `?m=${encodeURIComponent(monthKey(current.from))}`
      : '';
  const shownTrips = [...tripsInPeriod].reverse().slice(0, LIST_LIMIT);
  const tripRows = shownTrips
    .map((t) => {
      const soc =
        t.startSoc !== undefined && t.endSoc !== undefined ? `${t.startSoc} → ${t.endSoc} %` : '—';
      // Ohne belastbaren Verbrauch bleibt die Zelle leer statt „0,0" — die
      // Strecke ist gefahren worden, nur ihr Preis ist nicht sagbar.
      //
      // Die Einheit steht AN der Zahl, nicht nur im Spaltenkopf: Am Telefon
      // bricht die Tabelle zu Karten auf, und der Kopf verschwindet dabei —
      // „22.5 2.02 kWh" wären dort zwei zusammenhanglose Zahlen.
      const use =
        t.kwhPer100km !== undefined
          ? `${t.kwhPer100km.toFixed(1)} kWh/100 km<small>${(t.energyKwh as number).toFixed(
              2,
            )} kWh</small>`
          : '—';
      const cost = t.costEur !== undefined ? `${t.costEur.toFixed(2)} €` : '';
      return `<tr class="trip">
        <td>${esc(fmtDate(t.endedAt, L.locale))}</td>
        <td>${t.km.toLocaleString(L.locale)} km</td>
        <td>${esc(soc)}</td>
        <td class="num">${use}</td>
        <td class="num">${cost}</td>
      </tr>`;
    })
    .join('');

  const rows = recent
    .map((s) => {
      const soc =
        s.startSoc !== undefined && s.endSoc !== undefined ? `${s.startSoc} → ${s.endSoc} %` : '—';
      const noEnergy = !s.energyKwh;
      const kwh = noEnergy
        ? '—'
        : `${(s.energyKwh as number).toFixed(1)} kWh` +
          (s.rangeAddedKm ? `<small>+${s.rangeAddedKm} km</small>` : '');
      // Ohne konfigurierten Preis bleibt die Zelle LEER, nicht „—": Ein Strich
      // liest sich als fehlender Messwert, dabei ist die Kostenrechnung nur
      // nicht eingerichtet. Bei konfiguriertem Preis ohne Energie bleibt „—"
      // richtig — dort fehlt tatsächlich ein Wert.
      // Auf `costEur` prüfen, nicht auf `hasPrice`: Ein konfigurierter Preis
      // heißt nicht, dass DIESE Ladung Kosten hat. Für eine Fremdladung ohne
      // eingetragenen Preis bleiben sie absichtlich leer — vorher lief das in
      // ein `undefined.toFixed()` und riss die ganze Seite mit (HTTP 500,
      // sobald einmal auswärts geladen wurde).
      const cost =
        !hasPrice || s.costEur === undefined
          ? noEnergy && hasPrice
            ? '—'
            : ''
          : `${s.costEur.toFixed(2)} €` +
            (s.savedEur ? `<small>−${s.savedEur.toFixed(2)} € ${esc(L.dashBonus)}</small>` : '');
      const flag = s.complete ? '' : ` <span class="tag">${esc(L.dashRunning)}</span>`;
      const drop = s.socDropped ? ` <span class="tag warn">${esc(L.dashSocDropped)}</span>` : '';
      // Abbruch: Das Ziel blieb offen, obwohl das Auto noch am Kabel stand.
      const abort = s.aborted
        ? ` <span class="tag warn">${esc(
            L.dashAborted
              .replace('%e', String(s.endSoc))
              .replace('%t', String(s.targetSoc)),
          )}</span>`
        : '';
      // Ort je Ladung sichtbar machen. Ohne ihn bliebe die Zuordnung, an der
      // die ganze Kostentrennung hängt, unüberprüfbar.
      const where =
        s.atHome === true
          ? ` <span class="tag home">${esc(L.placeHome.toLowerCase())}</span>`
          : s.atHome === false
            ? ` <span class="tag away">${esc(L.placeAway.toLowerCase())}</span>`
            : '';

      // Kopfzeile = die ganze Zeit am Kabel; darunter je Ladephase eine Zeile.
      // Beides zusammen, weil die Summe die Energiebilanz trägt, die Phasen
      // aber zeigen, WANN der Tarif tatsächlich eingeschaltet hat.
      //
      // ZWEI Aufklapp-Ebenen statt einer: Die Kurve IST die bildliche
      // Zusammenfassung der Kopfzeile — sie gehört an die erste Stelle. Die
      // Phasenzeilen sagen dasselbe noch einmal in Zahlen und kommen deshalb
      // erst auf Wunsch. Wer nur wissen will „wie lief die Ladung", ist nach
      // einem Klick fertig.
      const idx = recent.indexOf(s);
      const open = !s.complete;
      const head = `<tr class="sess${s.phases.length ? ' has' : ''}${open ? ' open' : ''}"${
        s.phases.length ? ` data-i="${idx}"` : ''
      }>
        <td>${s.phases.length ? '<span class="chev">›</span>' : ''}${esc(
          fmtDate(s.startedAt, L.locale),
        )}${flag}${drop}${abort}${where}${
          s.phases.length
            ? `<small class="pc">${s.phases.length} ${
                s.phases.length === 1 ? L.dashPhase : L.dashPhases
              }</small>`
            : ''
        }</td>
        <td>${esc(fmtDur(s.durationMin))}<small>${esc(L.dashOfWhichCharging)} ${esc(fmtDur(s.chargingMin))}${
          s.avgKmPerMin ? ` · ${s.avgKmPerMin.toFixed(1)} km/min` : ''
        }</small></td>
        <td>${esc(soc)}</td>
        <td class="num">${kwh}</td>
        <td class="num">${cost}</td>
      </tr>`;

      // Ladeverlauf der Session — nur die Messpunkte dieser Session.
      const from = Date.parse(s.startedAt);
      const to = s.endedAt ? Date.parse(s.endedAt) : Number.MAX_SAFE_INTEGER;
      // Über Binärsuche statt `filter`: Die Reihe ist zeitlich sortiert, und
      // ein Vollscan JE LADUNG kostete bei einem Jahr Mitschrieb vierzig mal
      // 151.000 `Date.parse` — gemessen der teuerste Posten der ganzen Seite.
      const own = curveSamples.slice(
        lowerBound(sampleTimes, from),
        lowerBound(sampleTimes, to + 1),
      );
      const curve = chargeCurve(own, s.phases, {
        targetSoc: lastValue(own, (x) => x.targetSoc),
        minSoc: lastValue(own, (x) => x.minSoc),
        labels: L,
      });
      // Preiseingabe — nur für Ladungen unterwegs, wo kein Tarif bekannt ist.
      const entered = priceStore[s.startedAt];
      const priceForm =
        s.atHome === false
          ? `<form class="pf" data-key="${esc(s.startedAt)}">
              <label>€ <input name="eur" type="text" inputmode="decimal" value="${
                entered?.eur !== undefined ? entered.eur.toFixed(2) : ''
              }" placeholder="${esc(L.pfAmount)}"></label>
              <label>ct/kWh <input name="ct" type="text" inputmode="decimal" value="${
                entered?.ct !== undefined ? String(entered.ct) : ''
              }" placeholder="${cfg.externalPriceCt > 0 ? String(cfg.externalPriceCt) : ''}"></label>
              <input name="note" type="text" value="${esc(
                entered?.note ?? '',
              )}" placeholder="${esc(L.pfProvider)}">
              <button type="submit">${esc(L.pfSave)}</button>
              <em></em>
            </form>`
          : '';

      // Ohne Kurve (zu wenige Messpunkte) gäbe es keinen Schalter für die
      // zweite Ebene — dann rücken die Phasen auf die erste.
      const lvl2 = curve ? 'lvl2' : 'lvl1';
      const curveRow = curve
        ? `<tr class="phase curve lvl1 p${idx}${open ? '' : ' hidden'}">
            <td colspan="5">${curve}${priceForm}<button class="more" type="button" data-i="${idx}">${
              s.phases.length
            } ${s.phases.length === 1 ? L.dashPhase : L.dashPhases} ${esc(
              L.dashInDetail,
            )}<span class="chev">\u203a</span></button></td></tr>`
        : '';

      const phases = s.phases
        .map((p, i) => {
          const pSoc =
            p.startSoc !== undefined && p.endSoc !== undefined
              ? `${p.startSoc} → ${p.endSoc} %`
              : '';
          return `<tr class="phase ${lvl2} p${idx}${open && !curve ? '' : ' hidden'}">
            <td><span class="idx">${i + 1}</span> ${esc(fmtClock(p.startedAt))}–${esc(
              fmtClock(p.endedAt),
            )}</td>
            <td>${esc(fmtDur(p.durationMin))}${
              p.avgPowerKw ? `<small>${p.avgPowerKw.toFixed(1)} kW</small>` : ''
            }</td>
            <td>${esc(pSoc)}</td>
            <td class="num">${p.energyKwh ? `${p.energyKwh.toFixed(1)} kWh` : '—'}${
              p.rangeAddedKm ? `<small>+${p.rangeAddedKm} km</small>` : ''
            }</td>
            <td class="num"></td>
          </tr>`;
        })
        .join('');

      return head + curveRow + phases;
    })
    .join('');

  return `<!doctype html>
<html lang="${esc(L.locale)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${esc(o.vehicleName)}">
${THEME_META}
<meta name="format-detection" content="telephone=no">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon-180.png">
<title>${esc(o.vehicleName)} — ${esc(L.dashTitle)}</title>
<style>
:root{--bg:#f6f6f7;--card:#fff;--fg:#16171a;--dim:#6b6f76;--line:#e3e4e8;--accent:#0a84ff}
@media(prefers-color-scheme:dark){:root{--bg:#111214;--card:#1c1d21;--fg:#f2f3f5;--dim:#9aa0a8;--line:#2c2e33}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
/* Inhalt begrenzen: Die Diagramme werden in die verfügbare Breite gestreckt
   (preserveAspectRatio="none"), was am Bildschirm auch die Schrift verzerrt.
   Eine Höchstbreite hält die Streckung im Rahmen — und eine über 2000 px
   gezogene Tabelle liest ohnehin niemand. */
body{max-width:760px;margin:0 auto;background:var(--bg);color:var(--fg);
 font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
 padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom));
 -webkit-font-smoothing:antialiased}
h1{font-size:19px;margin:0 0 14px;display:flex;justify-content:space-between;
 align-items:center;gap:8px}
h1>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h1 em{font-style:normal;font-size:12px;color:var(--dim);font-weight:400;
 display:flex;align-items:center;gap:8px;white-space:nowrap}
/* 44px Trefferfläche um das 18px-Symbol, ohne die Kopfzeile zu strecken. */
h1 .cog{color:var(--dim);display:flex;align-items:center;justify-content:center;
 width:34px;height:34px;margin:-8px 0;border-radius:9px;background:none;border:0;
 padding:0;cursor:pointer}
h1 a.cog{margin-right:-6px}
h1 .cog:active{background:var(--line)}
h1 button.cog[disabled]{opacity:.4;cursor:default}
h1 button.cog.busy svg{animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
/* Zwei Spalten am Telefon, drei ab Tablet — mit sechs Kacheln geht beides
   ohne Lücke auf. */
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:16px}
@media(min-width:620px){.grid{grid-template-columns:repeat(3,1fr)}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px}
.card b{display:block;font-size:23px;font-weight:600;letter-spacing:-.02em}
.card{display:flex;flex-direction:column;gap:2px;min-height:96px}
/* Erste Zeile = Bezeichnung (Versalien), letzte = Detail (normal, klein).
   Detail in Versalien brach über drei Zeilen und blähte jede Kachel auf. */
.card>span:first-child{color:var(--dim);font-size:11px;text-transform:uppercase;
 letter-spacing:.05em;font-weight:600}
.card>span:last-child:not(:first-child){color:var(--dim);font-size:12px;
 line-height:1.35;margin-top:auto;text-transform:none;letter-spacing:0}
.card span s{opacity:.75}
.card.save b{color:#1e9e5a}
/* Die beiden Kilometer-Kacheln tragen die Farben des Diagramms: Wer dort den
   orangen Gegenbalken gesehen hat, findet hier dieselbe Größe in derselben
   Farbe wieder. */
.card.driven b{color:#e8833a}
.card.charged b{color:var(--accent)}
@media(prefers-color-scheme:dark){.card.save b{color:#35c77b}}
.cap{background:var(--card);border:1px solid var(--line);border-radius:12px;
 padding:14px;margin-bottom:16px;position:relative;overflow:hidden}
.cap::after{content:"";position:absolute;inset:0;pointer-events:none;
 background:radial-gradient(120% 90% at 100% 0%,rgba(10,132,255,.10),transparent 60%)}
.caphead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.caphead span{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
/* Der Weg zum Nachweis führt über die Überschrift der Kachel — dort steht die
   Zahl, über die er Auskunft gibt. Dezent unterstrichen statt als Knopf: Die
   Seite braucht kaum jemand täglich, aber wer sie sucht, sucht sie hier. */
.caphead a.plain{color:inherit;text-decoration:underline;text-underline-offset:3px;
 text-decoration-color:var(--line)}
.caphead em{font-style:normal;color:var(--dim);font-size:11.5px}
.capmain{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
.capmain b{font-size:30px;font-weight:600;letter-spacing:-.03em;
 font-variant-numeric:tabular-nums}
.capmain b i{font-style:normal;font-size:15px;font-weight:500;color:var(--dim);margin-left:4px}
.soh{font-size:12px;font-weight:600;color:#1e9e5a;background:rgba(30,158,90,.14);
 padding:3px 9px;border-radius:7px}
@media(prefers-color-scheme:dark){.soh{color:#35c77b;background:rgba(53,199,123,.16)}}
.capbar{position:relative;height:8px;background:var(--line);border-radius:5px;
 overflow:hidden;margin-bottom:8px}
.capbar i{display:block;height:100%;border-radius:5px;
 background:linear-gradient(90deg,#0a84ff,#35c77b)}
/* Streuung als helle Zone über dem Balken — zeigt die Unsicherheit mit an. */
.capbar u{position:absolute;top:0;height:100%;background:rgba(255,255,255,.45);
 border-radius:5px;mix-blend-mode:overlay}
.capfoot{color:var(--dim);font-size:11.5px}
/* Verlauf über die Monate: Linie und Spanne nebeneinander, damit die Karte
   nicht in die Höhe wächst. */
.captrend{display:flex;align-items:center;gap:10px;margin:2px 0 8px}
.captrend em{font-style:normal;color:var(--dim);font-size:11.5px}
/* Die Unsicherheit steht direkt an der Zahl, nicht im Kleingedruckten: Eine
   Kapazität ohne ihre Spanne lädt dazu ein, sie für einen Messwert zu halten. */
.capunc{color:var(--dim);font-size:14px;font-style:normal;margin-left:-2px}
.quality{border-radius:10px;padding:9px 12px;font-size:12.5px;margin-bottom:12px;
 border:1px solid var(--line)}
.quality.warn{background:rgba(200,129,26,.14);color:#c8811a;border-color:rgba(200,129,26,.35)}
.quality.bad{background:rgba(196,64,47,.14);color:#c4402f;border-color:rgba(196,64,47,.35)}
@media(prefers-color-scheme:dark){.quality.warn{color:#e0a54a}.quality.bad{color:#e07a68}}
.status{background:var(--card);border:1px solid var(--line);border-radius:12px;
 padding:13px;margin-bottom:12px}
.soc{margin-bottom:10px}
.soc b{font-size:26px;font-weight:600;letter-spacing:-.02em;margin-right:8px}
.soc span{color:var(--dim);font-size:13px}
.socbar{height:7px;background:var(--line);border-radius:4px;overflow:hidden;margin-bottom:9px}
.socbar i{display:block;height:100%;border-radius:4px;transition:width .3s;
 background:linear-gradient(90deg,#0a84ff,#35c77b)}
.pills{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
/* Die laufende Ladung — direkt unter den Plaketten, im selben Kasten.
   Abgesetzt durch eine Trennlinie, damit sie sich nicht mit dem
   darüberstehenden Ladestand vermischt. */
.live{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;
 margin-top:11px;padding-top:10px;border-top:1px solid var(--line)}
.live b{font-size:17px;font-weight:600;letter-spacing:-.01em}
.live span{color:var(--dim);font-size:12.5px}
.pill{font-size:12px;padding:5px 10px;border-radius:8px;background:var(--line);
 color:var(--fg);white-space:nowrap;line-height:1.2}
.pill.ok{background:#1e9e5a;color:#fff}
.pill.wait{background:#c8811a;color:#fff}
.pill.bad{background:#c4402f;color:#fff}
.pill.off{background:var(--line);color:var(--dim)}
button.pill{font:inherit;font-size:12px;border:0;cursor:pointer;font-weight:600;
 background:var(--accent);color:#fff;padding:6px 12px}
button.pill:active{opacity:.6}
button.pill[disabled]{opacity:.5;cursor:default}
.chart{background:var(--card);border:1px solid var(--line);border-radius:12px;
 padding:10px 8px 4px;margin-bottom:16px}
/* Am Bildschirm muss die Kurvenzeile eine echte Tabellenzeile bleiben —
   sonst schrumpft sie auf die Breite ihres Inhalts statt über alle Spalten
   zu laufen. Ausdrücklich gesetzt, weil sie sonst als Block landet. */
tr.curve{display:table-row}
tr.curve td{display:table-cell;padding:4px 12px 10px}
tr.curve td .curvewrap{width:100%}
/* Schalter für die zweite Ebene. Bewusst ein schlichter Textschalter statt
   einer Schaltfläche: Er soll die Kurve nicht überstimmen, aber 44px hoch
   und über die ganze Breite treffbar sein. */
button.more{display:flex;align-items:center;width:100%;min-height:38px;
 background:transparent;border:0;border-top:1px solid var(--line);margin-top:4px;
 padding:0 2px;color:var(--dim);font:inherit;font-size:12.5px;cursor:pointer}
button.more .chev{margin:0 0 0 5px}
button.more.open .chev{transform:rotate(90deg)}
button.more:active{opacity:.6}
.tabs{display:flex;gap:6px;margin-bottom:14px;position:sticky;top:0;z-index:5;
 background:var(--bg);padding:4px 0}
/* 44px Höhe = Apples Mindestmaß für zuverlässig treffbare Bedienelemente. */
.tabs a{flex:1;display:flex;align-items:center;justify-content:center;min-height:44px;
 border-radius:11px;text-decoration:none;color:var(--dim);background:var(--card);
 border:1px solid var(--line);font-size:15px;transition:background .12s}
.tabs a.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.tabs.sub{margin-top:-8px;position:static}
.tabs.sub a{min-height:34px;font-size:13.5px;border-radius:9px;background:transparent}
.tabs.sub a.on{background:var(--card);border-color:var(--line);color:var(--fg);font-weight:600}
.tabs.sub em{font-style:normal;opacity:.55;margin-left:5px;font-size:12px}
/* Zeitraum-Navigation: Der Name des Zeitraums trägt die Aussage, die Pfeile
   treten zurück. Ein Zeitraum ohne Nachbarn zeigt den Pfeil ausgegraut statt
   ihn wegzulassen — sonst springt die Zeile bei jedem Schritt. */
.per{display:flex;align-items:center;justify-content:center;gap:4px;margin:-4px 0 14px}
.per a,.per span{min-width:40px;min-height:40px;display:flex;align-items:center;
 justify-content:center;font-size:20px;text-decoration:none;color:var(--dim);
 border-radius:10px}
.per span{opacity:.25}
.per a:active{background:var(--card)}
.per b{min-width:150px;text-align:center;font-size:15px;font-weight:600}
.per a.now{min-width:auto;padding:0 12px;font-size:13px;font-weight:600;
 color:var(--accent)}
.note{background:var(--card);border:1px solid var(--line);border-radius:10px;
 padding:9px 12px;margin:-4px 0 14px;color:var(--dim);font-size:12.5px}
/* Abschnittsüberschrift mit Kennzahl rechts — die Zusammenfassung gehört an
   die Überschrift, nicht in eine eigene Zeile darunter. */
h2{font-size:14px;font-weight:600;margin:22px 0 10px;display:flex;
 justify-content:space-between;align-items:baseline;gap:10px}
h2 em{font-style:normal;font-size:12px;color:var(--dim);font-weight:400;
 text-align:right}
/* Nachsatz unter einer Tabelle: ohne Rahmen, damit er nicht wie eine weitere
   Zeile aussieht. */
p.note{background:none;border:0;padding:2px 2px 0;margin:8px 0 4px;line-height:1.5}
form.pf{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0 2px;
 padding:9px 10px;background:var(--bg);border:1px solid var(--line);border-radius:10px}
form.pf label{display:flex;align-items:center;gap:5px;color:var(--dim);font-size:12px}
form.pf input{width:78px;min-height:32px;padding:4px 7px;border-radius:7px;
 border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:13px}
form.pf input[name=note]{width:104px}
form.pf button{min-height:32px;padding:0 12px;border-radius:7px;border:1px solid var(--line);
 background:var(--card);color:var(--fg);font:inherit;font-size:13px;cursor:pointer}
form.pf button:active{opacity:.6}
form.pf em{font-style:normal;font-size:12px;color:var(--dim)}
form.pf.ok em{color:#35c77b}
form.pf.bad em{color:#d9534f}
.tabs a:active{opacity:.6}

/* Kein Verlauf am rechten Rand mehr: Er sollte einst auf waagerechtes
   Scrollen hinweisen, aber seit dem Karten-Layout scrollt hier nichts —
   am Telefon sind es Karten, am Bildschirm passt die Tabelle hinein.
   Übrig blieb nur eine halbtransparente rechte Seite. */
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px}
table{width:100%;min-width:430px;border-collapse:collapse;background:var(--card);
 border:1px solid var(--line);border-radius:12px;overflow:hidden}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;
 color:var(--dim);padding:10px 12px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
td:last-child,th:last-child{padding-right:16px}
tr:last-child td{border-bottom:0}
tr.sess td{font-weight:500}
tr.sess:not(:first-child) td{border-top:2px solid var(--line)}
/* Phasen optisch untergeordnet, damit die Ladung als Einheit lesbar bleibt. */
tr.phase td{padding-top:6px;padding-bottom:6px;font-size:13px;color:var(--dim);
 border-bottom-style:dashed}
tr.phase.hidden{display:none}
tr.sess.has{cursor:pointer}
tr.sess.has:active td{background:var(--line)}
.chev{display:inline-block;color:var(--dim);margin-right:6px;transition:transform .15s;
 transform:rotate(0deg)}
tr.sess.open .chev{transform:rotate(90deg)}
tr.phase td:first-child{padding-left:20px}
.idx{display:inline-block;min-width:17px;height:17px;line-height:17px;text-align:center;
 background:var(--line);border-radius:5px;font-size:11px;margin-right:5px;color:var(--fg)}
td small{display:block;color:var(--dim);font-size:12px}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tag{display:inline-block;background:var(--accent);color:#fff;border-radius:5px;
 padding:1px 6px;font-size:11px;vertical-align:middle}
.tag.warn{background:#c8811a}
.tag.home{background:transparent;color:var(--dim);border:1px solid var(--line)}
.tag.away{background:#3a6ea5;color:#fff}

/* Aktionszeile unter JEDER Liste — gleiche Form, gleiche Stelle, gleiche
   Beschriftung für Ladungen und Fahrten. Dahinter liegt jeweils der
   Monatsbericht, und darin der CSV-Knopf: EIN Weg zum selben Ziel. */
/* Tooltip der Balkendiagramme — als HTML, weil ein SVG-<title> auf Touch nie
   erscheint. pre-line erhält die Zeilen aus data-tip. */
#bartip{position:fixed;z-index:9;max-width:min(78vw,320px);padding:8px 11px;border-radius:10px;
 background:var(--card);border:1px solid var(--line);color:var(--fg);font-size:12.5px;
 line-height:1.45;white-space:pre-line;box-shadow:0 6px 20px rgba(0,0,0,.18);pointer-events:none}
.acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px 18px;margin:8px 0 4px}
.act{color:var(--accent);text-decoration:none;font-size:13.5px;min-height:30px;
 display:inline-flex;align-items:center}
${CHART_CSS}${BARS_CSS}${SPARK_CSS}${REFRESH_CSS}
/* Legende des Gegenbalkens: Ohne sie ist die zweite Farbe eine Behauptung,
   die nur der Tooltip auflöst. */
.legend{display:flex;gap:14px;justify-content:center;margin:2px 0 6px;
 font-size:11.5px;color:var(--dim)}
.legend span{display:inline-flex;align-items:center;gap:5px}
.legend span::before{content:"";width:9px;height:9px;border-radius:3px}
.legend .up::before{background:var(--accent)}
.legend .dn::before{background:#e8833a}
@media(max-width:620px){
  /* Spaltenlayout bricht auf dem Telefon zu Wortsalat — deshalb je Ladung
     eine Karte. Positionen explizit über Zeile/Spalte statt benannter
     Bereiche: robuster, wenn eine Zelle mal leer ist. */
  .tablewrap{overflow:visible}
  table{display:block;min-width:0;border:0;background:transparent}
  thead{display:none}
  tbody{display:block}

  tr.sess.open.has{border-radius:12px 12px 0 0;margin-bottom:0}
  tr.sess{display:grid;grid-template-columns:minmax(0,1fr) auto;
   gap:2px 12px;background:var(--card);border:1px solid var(--line);
   border-radius:12px;padding:12px 14px;margin-bottom:8px;align-items:baseline}
  tr.sess>td{display:block;border:0!important;padding:0}
  tr.sess>td:nth-child(1){grid-column:1;grid-row:1;font-weight:600;font-size:15px}
  tr.sess>td:nth-child(4){grid-column:2;grid-row:1;text-align:right;
   font-weight:600;font-size:16px;white-space:nowrap}
  tr.sess>td:nth-child(2){grid-column:1;grid-row:2;font-size:12.5px;
   color:var(--dim);font-weight:400}
  tr.sess>td:nth-child(3){grid-column:2;grid-row:2;text-align:right;
   font-size:12.5px;color:var(--dim);font-weight:400;white-space:nowrap}
  tr.sess>td:nth-child(5){grid-column:1/-1;grid-row:3;font-size:12.5px;
   color:var(--dim);font-weight:400}
  tr.sess td small{display:inline;margin:0 0 0 6px;font-size:11.5px}
  /* Die Phasenzahl steht in derselben Zelle wie das Datum. Ohne eigenen Umbruch
     rutscht sie hinter ein langes Datum, bricht mitten im Wort um und lässt
     „phase" allein in der nächsten Zeile stehen. Als eigene Zeile sitzt sie
     unter dem Datum — dort, wo auch der Zustands-Chip sitzt. */
  tr.sess td small.pc{display:block;margin:2px 0 0}
  /* Steht ein Chip davor, bringt der den Umbruch schon mit. */
  tr.sess td .tag + small.pc{display:inline;margin:0 0 0 6px}

  tr.phase{display:grid;grid-template-columns:minmax(0,1fr) auto;
   gap:2px 12px;background:var(--card);border:1px solid var(--line);
   border-left:2px solid var(--accent);border-radius:0 10px 10px 0;
   padding:9px 12px;margin:-4px 0 8px 16px;align-items:baseline}
  tr.phase>td{display:block;border:0!important;padding:0;font-size:12.5px}
  tr.phase>td:nth-child(1){grid-column:1;grid-row:1}
  tr.phase>td:nth-child(4){grid-column:2;grid-row:1;text-align:right}
  tr.phase>td:nth-child(2){grid-column:1;grid-row:2;color:var(--dim)}
  tr.phase>td:nth-child(3){grid-column:2;grid-row:2;text-align:right;color:var(--dim)}
  tr.phase>td:nth-child(5){display:none}
  tr.phase td small{display:inline;margin-left:5px}

  /* Gleiche Fläche und Einrückung wie die Phasenkarten — vorher saß die
     Kurve transparent zwischen ihnen und wirkte beim Wechsel der Breite wie
     ein Darstellungsfehler. */
  /* Die Kurve gehört optisch zur Ladung darüber, nicht zu den Phasen:
     gleiche Breite wie die Ladungskarte, ohne den blauen Balken, der die
     Phasenzeilen markiert. */
  tr.phase.curve{display:block;background:var(--card);border:1px solid var(--line);
   border-top:0;border-radius:0 0 12px 12px;padding:2px 10px 6px;margin:-9px 0 8px}
  /* Die Phase direkt nach der Kurve darf nicht hochrutschen — sonst deckt
     sie die Zeitachse darunter zu. */
  tr.phase.curve + tr.phase{margin-top:0}
  tr.phase.curve>td{display:block}
  /* Muss NACH den Layout-Regeln stehen: sonst zeigt jede zugeklappte
     Ladung ihre Kurve und ihre Phasen. */
  tr.phase.hidden{display:none}

  /* Fahrten wie Ladungen als Karte — die Strecke ist hier die Hauptzahl. */
  tr.trip{display:grid;grid-template-columns:minmax(0,1fr) auto;
   gap:2px 12px;background:var(--card);border:1px solid var(--line);
   border-radius:12px;padding:12px 14px;margin-bottom:8px;align-items:baseline}
  tr.trip>td{display:block;border:0!important;padding:0}
  tr.trip>td:nth-child(1){grid-column:1;grid-row:1;font-weight:600;font-size:15px}
  tr.trip>td:nth-child(2){grid-column:2;grid-row:1;text-align:right;
   font-weight:600;font-size:16px;white-space:nowrap}
  tr.trip>td:nth-child(3){grid-column:1;grid-row:2;font-size:12.5px;color:var(--dim)}
  tr.trip>td:nth-child(4){grid-column:2;grid-row:2;text-align:right;
   font-size:12.5px;color:var(--dim);white-space:nowrap}
  tr.trip>td:nth-child(5){grid-column:1/-1;grid-row:3;font-size:12.5px;color:var(--dim)}
  tr.trip td small{display:inline;margin-left:6px;font-size:11.5px}
}
</style></head><body>
<h1><span>${esc(o.vehicleName)}</span><em>${
  st.last
    ? `${esc(L.dashAsOf)} ${esc(
        new Date(st.stateAt ?? st.last.ts).toLocaleTimeString(L.locale, {
          hour: '2-digit',
          minute: '2-digit',
        }),
      )}`
    : ''
}${
  o.onRefresh
    ? `<button class="cog" id="rf" type="button" title="${esc(L.dashRefresh)}" aria-label="${esc(L.dashRefresh)}"
       ><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
        stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
       ><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>`
    : ''
}<a class="cog" href="//${esc(host)}:${o.uiPort}/" target="_blank" rel="noopener"
 title="${esc(L.dashSettings)}" aria-label="${esc(L.dashSettings)}"><svg viewBox="0 0 24 24" width="18" height="18"
 fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
 ><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 5 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9.5a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></a></em></h1>
<div class="status">
  <div class="soc">
    <div class="socbar"><i style="width:${st.state?.soc ?? 0}%"></i></div>
    <b>${st.state?.soc !== undefined ? `${st.state.soc} %` : '—'}</b>
    <span>${st.state?.rangeKm !== undefined ? `${st.state.rangeKm} km` : ''}${
      st.state?.minSoc !== undefined ? ` · ${esc(L.dashInstantTo)} ${st.state.minSoc} %` : ''
    }${st.state?.targetSoc !== undefined ? ` · ${esc(L.dashTarget)} ${st.state.targetSoc} %` : ''}</span>
  </div>
  <div class="pills">
    <span class="pill ${plugClass}">${plugText}</span>
    <span class="pill ${st.monitorOk ? 'ok' : 'bad'}">${
      st.monitorOk
        ? // Kurz, solange alles läuft: Die Plakette steht immer an derselben
          // Stelle, das Wort „Überwachung" trägt dort nichts. Stimmt etwas
          // nicht, steht der volle Satz da — dann zählt Deutlichkeit.
          st.ageMinutes !== undefined
          ? esc(L.dashMonitorAge.replace('%s', `${Math.round(st.ageMinutes)} min`))
          : esc(L.dashMonitorOk)
        : st.ageMinutes !== undefined
          ? `${esc(L.dashNoDataFor)} ${fmtDur(st.ageMinutes)}`
          : esc(L.dashNoDataYet)
    }</span>
  </div>
</div>
<!-- Über den Filtern: Die gemessene Kapazität ändert sich weder mit dem
     Zeitraum noch mit dem Ort. Darunter gelesen wirkte sie gefiltert. -->
${
  cap.capacityKwh !== undefined
    ? `<div class="cap">
        <div class="caphead">
          <span><a href="/batterie" class="plain">${esc(L.dashMeasuredCapacity)}</a></span>
          <em>${cap.samples} ${esc(cap.samples === 1 ? L.capDrive : L.capDrives)} · ${cap.km} km</em>
        </div>
        <div class="capmain">
          <b>${cap.capacityKwh.toFixed(1)}<i>kWh</i></b>
          ${
            cap.uncertaintyKwh !== undefined
              ? `<i class="capunc">± ${cap.uncertaintyKwh.toFixed(1)}</i>`
              : ''
          }
          ${soh !== undefined ? `<span class="soh">${soh.toFixed(0)} % ${esc(L.dashHealth)}</span>` : ''}
        </div>
        <div class="capbar">
          <i style="width:${Math.max(0, Math.min(100, soh ?? 0))}%"></i>
          ${
            cap.spreadKwh !== undefined
              ? `<u style="left:${Math.max(0, Math.min(96, (soh ?? 0) - 2))}%;width:${Math.min(
                  20,
                  (cap.spreadKwh / cfg.capacityKwh) * 100,
                )}%"></u>`
              : ''
          }
        </div>
        ${
          capTrend.length
            ? `<div class="captrend">${sparkline(
                capTrend.map((m) => ({ t: Date.parse(`${m.month}-15T12:00:00Z`), v: m.kwh })),
                { minSpan: 2 },
              )}<em>${esc(
                L.capTrendOver
                  .replace('%a', capTrend[0].kwh.toFixed(1))
                  .replace('%b', capTrend[capTrend.length - 1].kwh.toFixed(1))
                  .replace('%n', String(capTrend.length)),
              )}</em></div>`
            : ''
        }
        <div class="capfoot">${esc(L.dashConfigured)} ${cfg.capacityKwh} kWh${
          capDelta !== undefined
            ? ` · ${esc(L.dashMeasurement)} ${capDelta > 0 ? '+' : ''}${capDelta.toFixed(1)} %`
            : ''
        }${cap.spreadKwh !== undefined ? ` · ${esc(L.dashSpread)} ±${(cap.spreadKwh / 2).toFixed(1)} kWh` : ''}</div>
      </div>`
    : ''
}
${REFRESH_NOTE}
<nav class="tabs">${tabs}</nav>
${placeTabs}${nav}${
  place === 'away' && !awayPriced
    ? `<div class="note">${esc(L.dashNoAwayPrice)}</div>`
    : awayUnpriced
      ? `<div class="note">${esc(L.dashSomeAwayUnpriced)}</div>`
      : ''
}
<div class="grid">
  <div class="card"><span>${esc(current ? current.label : GRAN_LABEL[gran])}</span>
    <b>${current ? current.kwh.toFixed(1) : '0'} kWh</b>${trend}</div>
  ${
    hasPrice
      ? `<div class="card"><span>${esc(L.dashCost)}</span><b>${current ? current.cost.toFixed(2) : '0.00'} €</b>
    <span>${
      // Der Bruttopreis stand hier als „statt 19,41 €" — dieselbe Aussage wie
      // die Ersparnis daneben, nur rückwärts gerechnet. Ohne Bonus bleibt der
      // Arbeitspreis, der sonst nirgends steht.
      current && current.costGross > current.cost
        ? ''
        : `${(o.pricePerKwh * 100).toFixed(2)} ct/kWh`
    }${
      // Die Ersparnis DES ZEITRAUMS, und die Gesamtsumme nur, wenn sie eine
      // andere ist — sonst stünde dieselbe Zahl zweimal in einer Kachel.
      hasBonus && current && current.saved > 0.005
        ? ` · ${current.saved.toFixed(2)} € ${esc(L.dashSavedSuffix)}${
            totalSaved > current.saved + 0.005
              ? ` (${esc(L.dashTotal)} ${totalSaved.toFixed(2)} €)`
              : ''
          }`
        : hasBonus && totalSaved > 0.005
          ? ` · ${esc(L.dashTotal)} ${totalSaved.toFixed(2)} € ${esc(L.dashSavedSuffix)}`
          : ''
    }${
      // Auch hier: ohne Kosten im Zeitraum keine Kosten je Kilometer. „0,0
      // ct/km" ist keine günstige Fahrt, sondern eine fehlende Ladung.
      eff.centPerKm !== undefined && eff.cost > 0
        ? ` · ${eff.centPerKm.toFixed(1)} ct/km`
        : ''
    }</span></div>`
      : // Ohne Preis steht hier die tatsächliche LADEZEIT der Ladungen im
        // Zeitraum. Vorher zeigte diese Kachel `spanMinutes` — die erfasste
        // Messspanne, also wie lange überhaupt Daten vorliegen. Unter der
        // Überschrift „Ladezeit" war das schlicht falsch.
        `<div class="card"><span>${esc(L.dashChargeTime)}</span><b>${esc(
          fmtDur(inPeriod.reduce((a, x) => a + x.chargingMin, 0)),
        )}</b><span>${inPeriod.length} ${esc(
          inPeriod.length === 1 ? L.dashChargeOne : L.dashCharges.toLowerCase(),
        )}</span></div>`
  }
  <div class="card"><span>${esc(L.dashConsumption)}</span>
    <b>${
      tripKwh100 !== undefined
        ? tripKwh100.toFixed(1)
        : // Der Ersatzweg nur, wenn er etwas hergibt: „0,0 gerechnet" ist keine
          // sparsame Fahrt, sondern eine fehlende Verbrauchsangabe.
          eff.kwhPer100km !== undefined && eff.kwhPer100km > 0
          ? eff.kwhPer100km.toFixed(1)
          : '—'
    }</b>
    <span>kWh/100 km ${
      tripKwh100 !== undefined
        ? esc(L.dashPerVehicle)
        : eff.kwhPer100km !== undefined && eff.kwhPer100km > 0
          ? esc(L.dashCalculated)
          : ''
    }${
      payableCompare && tripKwh100 !== undefined && eff.kwhPer100km !== undefined
        ? ` · ${esc(L.dashPaid)} ${eff.kwhPer100km.toFixed(1)}`
        : ''
    }</span></div>

  <div class="card"><span>${esc(L.dashCharges)}</span><b>${inPeriod.length}</b>
    <span>${
      // „Ø 0,0 kWh" ist keine Durchschnittsangabe, sondern eine Ladung ohne
      // Energiezuwachs — etwa reines Vorklimatisieren am Kabel.
      inPeriod.length > 0 && avgPerCharge > 0.05
        ? `Ø ${avgPerCharge.toFixed(1)} kWh`
        : inPeriod.length > 0
          ? ''
          : esc(L.dashNone)
    }</span></div>

  <!-- Die beiden Kilometer-Kacheln als PAAR, in den Farben des Diagramms:
       gefahren orange, geladen blau. Sie stehen an den Positionen fünf und
       sechs, weil nur dort ein Paar in BEIDEN Rastern zusammenbleibt — am
       Telefon zwei Spalten, ab Tablet drei. An Position drei und vier würde
       das Dreierraster sie auseinanderreißen.

       Vorher zeigte die Kachel bei konfiguriertem Bonus die ERSPARNIS statt
       der Strecke: Wer einen Bonus hatte, sah die gefahrenen Kilometer
       nirgends. Zwei Kernzahlen dürfen sich nicht denselben Platz teilen. -->
  <div class="card driven"><span>${esc(L.dashDriven)}</span><b>${eff.km.toLocaleString(
    L.locale,
  )} km</b>
    <span>${
      tripSum.trips > 0
        ? `${tripSum.trips} ${esc(tripSum.trips === 1 ? L.capDrive : L.capDrives)}`
        : ''
    }</span></div>
  <div class="card charged"><span>${esc(L.dashChargedRange)}</span>
    <b>${current ? current.rangeAdded.toLocaleString(L.locale) : '0'} km</b>
    <span>${esc(L.dashRange)}${
      current && current.kwh > 0 && current.rangeAdded > 0
        ? ` · ${(current.rangeAdded / current.kwh).toFixed(1)} km/kWh`
        : ''
    }</span>
  </div>${
    // Die laufende Ladung gehört HIER hin und nicht in eine eigene Karte weit
    // unten: Ladestand und Ziel stünden sonst doppelt an zwei Orten, und wer
    // wissen will, was das Auto gerade tut, sieht nur nach oben.
    //
    // Das Ladeziel steht bereits eine Zeile höher und wird deshalb nicht
    // wiederholt. Kabelzeit und echte Ladezeit dagegen gehören beide her:
    // Die Energiemenge bildet nur die Minuten ab, in denen Strom floss,
    // während der Beginn das Einstecken meint — nebeneinander gelesen sahen
    // 10 kW und 2,5 kWh sonst falsch aus, obwohl beide stimmten.
    running
      ? `
  <div class="live">${
    running.energyKwh !== undefined ? `<b>${running.energyKwh.toFixed(1)} kWh</b>` : ''
  }${
    running.startSoc !== undefined
      ? `<span>${esc(socSpan(running.startSoc, running.endSoc, ''))}</span>`
      : ''
  }<span>${esc(L.dashSince)} ${esc(fmtClock(running.startedAt))}</span>${
    running.chargingMin > 0 && running.chargingMin < running.durationMin - 1
      ? `<span>${esc(L.dashOfWhichCharging)} ${esc(fmtDur(running.chargingMin))}</span>`
      : ''
  }${
    etaText
      ? `<span>${esc(etaText.replace(new RegExp(`^${L.dashTarget} \\d+ % · `), ''))}</span>`
      : ''
  }</div>`
      : ''
  }
</div>
${
  quality
    ? `<div class="quality ${quality.level}">${esc(quality.text)}</div>`
    : ''
}
${
  series.length
    ? `<div class="chart">${
        // Legende nur, wenn es zwei Richtungen gibt. Bei einer Reihe sagt die
        // Überschrift schon alles, und eine Legende wäre nur Bedienlast.
        barPoints.some((b) => (b.down ?? 0) > 0)
          ? `<div class="legend"><span class="up">${esc(
              L.chartCharged,
            )}</span><span class="dn">${esc(L.chartUsed)}</span></div>`
          : ''
      }${bars}</div>`
    : ''
}
${
  recent.length
    ? `<div class="tablewrap"><table><thead><tr><th>${esc(L.dashStart)}</th><th>${esc(L.dashDuration)}</th><th>${esc(L.dashChargeState)}</th>
       <th class="num">${esc(L.dashEnergy)}</th><th class="num">${
         hasPrice ? esc(L.dashCost) : ''
       }</th></tr></thead><tbody>${rows}</tbody></table></div>${
         inPeriod.length > LIST_LIMIT
           ? `<p class="note">${esc(
               L.dashChargesCapped.replace('%n', String(LIST_LIMIT)).replace(
                 '%t',
                 String(inPeriod.length),
               ),
             )}</p>`
           : ''
       }`
    : `<div class="empty">${esc(L.dashNoCharges)}<br>${esc(L.dashNoChargesHint)}</div>`
}
${
  allSessions.some((x) => x.complete && (x.energyKwh ?? 0) > 0)
    ? `<p class="acts"><a class="act" href="/beleg${berichtsMonat}">${esc(L.dashReport)} ›</a></p>`
    : ''
}
${
  tripsInPeriod.length
    ? `<h2>${esc(L.dashTripsHeading)}<em>${tripSum.km.toLocaleString(L.locale)} km${
        tripSum.kwhPer100km !== undefined
          ? ` · ${tripSum.kwhPer100km.toFixed(1)} kWh/100 km${
              tripSum.costEur > 0 ? ` · ${tripSum.costEur.toFixed(2)} €` : ''
            }`
          : ''
      }</em></h2>
      <div class="tablewrap"><table><thead><tr><th>${esc(L.dashTripEnd)}</th><th>${esc(
        L.dashTripDistance,
      )}</th><th>${esc(L.dashChargeState)}</th>
       <th class="num">${esc(L.dashTripConsumption)}</th><th class="num">${
         hasPrice ? esc(L.dashCost) : ''
       }</th></tr></thead>
       <tbody>${tripRows}</tbody></table></div>
      ${
        tripsInPeriod.length > LIST_LIMIT
          ? `<p class="note">${esc(
              L.dashTripsCapped.replace('%n', String(LIST_LIMIT)).replace(
                '%t',
                String(tripsInPeriod.length),
              ),
            )}</p>`
          : ''
      }
      <p class="acts"><a class="act" href="/fahrtenbericht${berichtsMonat}">${esc(
        L.dashReport,
      )} ›</a></p>`
    : ''
}
<div id="bartip" hidden></div>
<script>
// Aktualisiert sich still im Hintergrund: alle 60 s, aber nur wenn die Seite
// sichtbar ist — im Homescreen-Modus liegt sie sonst tagelang offen und würde
// den Pi ohne Grund abfragen. Beim Zurückwechseln sofort neu laden, damit man
// nie veraltete Zahlen sieht.
(function(){
  // Balken-Details antippbar machen: Das SVG-<title> erscheint nur beim
  // Maus-Hover, und den gibt es auf dem Telefon nicht. Der ERSTE Tap zeigt
  // den Tooltip, der zweite auf denselben Balken öffnet den Unterzeitraum —
  // sofortiges Navigieren nähme Touch-Nutzern die Details.
  var bt = document.getElementById('bartip');
  var lastHit = null;
  if (bt) document.addEventListener('pointerdown', function(e){
    var hit = e.target && e.target.closest ? e.target.closest('.bars .hit') : null;
    if (hit && hit.dataset.tip) {
      if (hit === lastHit && hit.dataset.href) { location.href = hit.dataset.href; return; }
      lastHit = hit;
      bt.textContent = hit.dataset.tip;
      bt.hidden = false;
      var w = bt.offsetWidth, h = bt.offsetHeight;
      bt.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, e.clientX - w / 2)) + 'px';
      bt.style.top = Math.max(6, e.clientY - h - 18) + 'px';
    } else { lastHit = null; bt.hidden = true; }
  });
  // Crosshair auf den Ladekurven: Linie, Punkt und Wertelabel folgen dem
  // Zeiger bzw. dem Finger — wie in der Wetter-App von iOS.
  document.querySelectorAll('.curvewrap').forEach(function(wrap){
    var pts = wrap.dataset.pts.split(';').map(function(r){
      var f = r.split(','); 
      return { x:+f[0], y:+f[1], soc:f[2], kw:f[3], time:f[4] };
    });
    if (!pts.length) return;
    var svg = wrap.querySelector('svg');
    var tip = wrap.querySelector('.curvetip');
    var line = wrap.querySelector('.cl');
    var dot = wrap.querySelector('.cd');
    var vw = +wrap.dataset.w;

    function show(clientX){
      var box = svg.getBoundingClientRect();
      // Bildschirm-x in SVG-Koordinaten umrechnen (das SVG wird gestreckt).
      var vx = ((clientX - box.left) / box.width) * vw;
      var best = pts[0], bd = Infinity;
      for (var i=0;i<pts.length;i++){
        var d = Math.abs(pts[i].x - vx);
        if (d < bd){ bd = d; best = pts[i]; }
      }
      line.setAttribute('x1', best.x); line.setAttribute('x2', best.x);
      dot.setAttribute('cx', best.x); dot.setAttribute('cy', best.y);
      tip.hidden = false;
      tip.querySelector('b').textContent = best.soc + ' %';
      tip.querySelector('span').textContent = best.time + (best.kw ? ' · ' + best.kw + ' kW' : '');
      // Label innerhalb des Diagramms halten — an seiner TATSÄCHLICHEN Breite
      // ausgerichtet, sonst wird der rechte Teil abgeschnitten.
      var px = (best.x / vw) * box.width;
      var half = tip.offsetWidth / 2 + 4;
      tip.style.left = Math.max(half, Math.min(box.width - half, px)) + 'px';
      wrap.classList.add('on');
    }
    function hide(){ wrap.classList.remove('on'); tip.hidden = true; }

    wrap.addEventListener('pointermove', function(e){ show(e.clientX); });
    wrap.addEventListener('pointerdown', function(e){ show(e.clientX); });
    wrap.addEventListener('pointerleave', hide);
    wrap.addEventListener('pointercancel', hide);
  });

  // Ladephasen auf- und zuklappen. Reines Umschalten einer Klasse — kein
  // Nachladen, die Zeilen stehen bereits im Dokument.
  var lvl = function(i, level, on){
    document.querySelectorAll('tr.phase.' + level + '.p' + i).forEach(function(p){
      p.classList.toggle('hidden', !on);
    });
  };
  document.querySelectorAll('tr.sess.has').forEach(function(tr){
    tr.addEventListener('click', function(){
      var i = tr.dataset.i;
      var open = tr.classList.toggle('open');
      lvl(i, 'lvl1', open);
      if(!open){
        lvl(i, 'lvl2', false);
        var b = document.querySelector('button.more[data-i="' + i + '"]');
        if(b) b.classList.remove('open');
      }
    });
  });
  // Preis einer Fremdladung sichern. Ohne Neuladen — die Seite scrollt sonst
  // an den Anfang zurück, und man trägt oft mehrere hintereinander ein.
  document.querySelectorAll('form.pf').forEach(function(f){
    f.addEventListener('click', function(e){ e.stopPropagation(); });
    f.addEventListener('submit', function(e){
      e.preventDefault();
      e.stopPropagation();
      var note = f.querySelector('[name=note]').value;
      var eur = f.querySelector('[name=eur]').value.trim();
      var ct = f.querySelector('[name=ct]').value.trim();
      var out = f.querySelector('em');
      var body = { key: f.dataset.key, clear: !eur && !ct,
                   price: { eur: eur, ct: ct, note: note } };
      f.classList.remove('ok','bad');
      out.textContent = '…';
      fetch('/api/price', { method:'POST', headers:{'content-type':'application/json'},
                            body: JSON.stringify(body) })
        .then(function(r){ return r.json(); })
        .then(function(j){
          f.classList.add(j.ok ? 'ok' : 'bad');
          out.textContent = j.ok ? ${JSON.stringify(L.pfSaved)} : ${JSON.stringify(L.pfFailed)};
          if(j.ok) setTimeout(function(){ location.reload(); }, 700);
        })
        .catch(function(){ f.classList.add('bad'); out.textContent = ${JSON.stringify(L.pfFailed)}; });
    });
  });
  document.querySelectorAll('button.more').forEach(function(b){
    b.addEventListener('click', function(e){
      // Der Schalter liegt innerhalb der aufgeklappten Ladung — ohne das
      // hier klappte der Klick die Ladung gleich wieder zu.
      e.stopPropagation();
      lvl(b.dataset.i, 'lvl2', b.classList.toggle('open'));
    });
  });
  ${refreshScript(L)}
  // Reload nur, wenn er niemanden unterbricht: kein fokussiertes Feld (ein
  // halb ausgefülltes Preisformular wäre weg), keine offene Ladungszeile
  // (die Kurve, die gerade jemand studiert, klappte zu), kein offener
  // Balken-Tooltip. Der nächste Tick holt den Reload nach.
  function busy(){
    var a=document.activeElement;
    if(a && (a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.tagName==='SELECT')) return true;
    if(document.querySelector('tr.sess.open')) return true;
    var tip=document.getElementById('bartip');
    if(tip && !tip.hidden) return true;
    return false;
  }
  var t=setInterval(function(){ if(!document.hidden && !busy()) location.reload(); },60000);
  var hidden=false;
  document.addEventListener('visibilitychange',function(){
    if(document.hidden){ hidden=true; }
    else if(hidden){ location.reload(); }
  });
})();
</script>

</body></html>`;
}

/**
 * Grundgerüst, das Dashboard und Einstellungsseite teilen.
 *
 * Ausgelagert, damit die Einstellungen nicht wie ein fremdes Werkzeug wirken:
 * gleiche Farben, gleiche Kopfzeile, gleiche Kartenfläche.
 */
/**
 * Das Aussehen der BERICHTE — Ladebeleg wie Fahrtenbericht.
 *
 * Eine Quelle für beide: Sie sind dieselbe Art Seite (Monatswahl, Tabelle,
 * Werkzeugzeile, Druckansicht) und müssen deshalb identisch aussehen.
 */
const REPORT_CSS = `
.wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;min-width:480px;border-collapse:collapse;margin:14px 0}
th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;
 font-size:13.5px;white-space:nowrap}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr.sum td{font-weight:600;border-top:2px solid var(--line);border-bottom:0;padding-top:10px}
.months{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}
.months a{padding:6px 11px;border-radius:9px;border:1px solid var(--line);
 color:var(--fg);text-decoration:none;font-size:13px}
.months a.on{background:var(--accent);border-color:var(--accent);color:#fff}
.tools{display:flex;gap:14px;align-items:center;margin:10px 0 4px}
.tools a{color:var(--accent);text-decoration:none;font-size:13.5px}
.foot{color:var(--dim);font-size:12px;line-height:1.6;margin-top:18px}
.back{display:inline-flex;align-items:center;gap:6px;color:var(--dim);
 text-decoration:none;font-size:14px;min-height:44px}
@media print{
  /* Auf Papier stört jede Bedienung — und Weiß auf Schwarz kostet Toner. */
  :root{--bg:#fff;--card:#fff;--fg:#000;--dim:#444;--line:#bbb}
  .months,.tools,.back{display:none}
  body{max-width:none}
  .wrap{overflow:visible}
  table{min-width:0}
}`;

/**
 * Farbschema-Angaben für JEDE Seite.
 *
 * Das CSS rendert hell als Voreinstellung und dunkel per Media-Query. Ein
 * festes `content="dark"` widersprach dem: Im Light Mode standen dunkle
 * UA-Formularfelder und ein dunkler Overscroll-Hintergrund auf heller Seite,
 * und die Safari-Leiste blieb dunkel. Beide Schemata deklarieren und die
 * Themenfarbe je Modus liefern.
 */
/**
 * Der Abruf-Knopf — Rückmeldezeile, CSS und Verhalten, für Dashboard wie
 * Statusseite.
 *
 * Die Rückmeldung ist SICHTBAR, nicht im title-Attribut: Auf dem Telefon
 * gibt es dafür keine Anzeige. Schlug der Abruf fehl oder griff die Sperre,
 * hörte das Symbol dort einfach auf zu drehen — keine Erklärung, kein
 * Hinweis, ob überhaupt etwas passiert ist.
 */
const REFRESH_NOTE = '<div id="rfnote" class="rfnote" hidden></div>';

const REFRESH_CSS = `
.rfnote{margin:-4px 0 8px;padding:7px 11px;border-radius:9px;background:var(--card);
 border:1px solid var(--line);color:var(--dim);font-size:12.5px}
.rfnote.bad{color:#c0392b;border-color:#e0a99f}
@media(prefers-color-scheme:dark){.rfnote.bad{color:#e07a68;border-color:#5a3a34}}`;

/** Das Verhalten des Knopfs — Labels kommen je Seite herein. */
const refreshScript = (L: Labels): string => `
  var rf=document.getElementById('rf');
  var rfn=document.getElementById('rfnote');
  var sagen=function(text,schlecht){
    if(!rfn) return;
    if(!text){ rfn.hidden=true; return; }
    rfn.textContent=text; rfn.hidden=false;
    rfn.classList.toggle('bad', !!schlecht);
  };
  if(rf) rf.addEventListener('click',function(){
    rf.disabled=true; rf.classList.add('busy'); sagen('');
    var zurueck=function(ms){ setTimeout(function(){
      rf.classList.remove('busy'); rf.disabled=false; sagen('');
    }, ms); };
    fetch('/api/refresh',{method:'POST'}).then(function(r){return r.json();}).then(function(j){
      if(j.ok){ location.reload(); return; }
      rf.classList.remove('busy');
      var warten = j.reason==='cooldown';
      sagen(warten
        ? ${JSON.stringify('%n')}.replace('%n', ${JSON.stringify(L.dashWaitSeconds)}.replace('%n', String(Math.ceil((j.retryInMs||0)/1000))))
        : ${JSON.stringify(L.dashRefreshFailed)}, !warten);
      zurueck(warten ? (j.retryInMs||3000) : 4000);
    }).catch(function(){
      rf.classList.remove('busy');
      sagen(${JSON.stringify(L.dashRefreshFailed)}, true);
      zurueck(4000);
    });
  });`;

const THEME_META =
  '<meta name="color-scheme" content="light dark">' +
  '<meta name="theme-color" content="#f6f6f7" media="(prefers-color-scheme: light)">' +
  '<meta name="theme-color" content="#111214" media="(prefers-color-scheme: dark)">';

const BASE_CSS = `${REFRESH_CSS}

.empty{background:var(--card);border:1px solid var(--line);border-radius:12px;
 padding:26px;text-align:center;color:var(--dim)}

:root{--bg:#f6f6f7;--card:#fff;--fg:#16171a;--dim:#6b6f76;--line:#e3e4e8;--accent:#0a84ff}
@media(prefers-color-scheme:dark){:root{--bg:#111214;--card:#1c1d21;--fg:#f2f3f5;--dim:#9aa0a8;--line:#2c2e33}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{max-width:760px;margin:0 auto;background:var(--bg);color:var(--fg);
 font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
 padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom));
 -webkit-font-smoothing:antialiased}
h1{font-size:19px;margin:0 0 14px;display:flex;justify-content:space-between;
 align-items:center;gap:8px}
h1>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h1 em{font-style:normal;font-size:12px;color:var(--dim);font-weight:400;
 display:flex;align-items:center;gap:8px;white-space:nowrap}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
`;

/**
 * Letzter bekannter Wert eines Zustandsfelds über den ganzen Mitschrieb.
 *
 * Nötig wegen der Delta-Schreibung in {@link ./chargeLog}: Zustandsfelder
 * stehen nur in der Zeile, in der sie sich geändert haben. Der letzte
 * Messpunkt trägt sie deshalb meistens NICHT.
 */
function lastState<K extends keyof ChargeLogSample>(
  samples: ChargeLogSample[],
  key: K,
): { value: NonNullable<ChargeLogSample[K]>; at: string } | undefined {
  for (let i = samples.length - 1; i >= 0; i--) {
    const v = samples[i][key];
    if (v !== undefined) {
      return { value: v as NonNullable<ChargeLogSample[K]>, at: samples[i].ts };
    }
  }
  return undefined;
}

/**
 * Fahrzeugzustand als eigene Seite.
 *
 * Bewusst getrennt vom Ladedashboard: Reifendruck und Serviceintervall haben
 * mit dem Laden nichts zu tun, und eine Seite, die alles zeigt, zeigt nichts
 * mehr deutlich. Verlinkt ist sie aus der Kopfzeile.
 *
 * Der Mehrwert gegenüber der Porsche-App ist der VERLAUF: Sie zeigt den
 * aktuellen Reifendruck, aber nicht, dass er seit sechs Wochen fällt.
 */
function renderStatus(
  o: DashboardOptions,
  samples: ChargeLogSample[],
  host: string,
  /** Alle Messpunkte als Strom — siehe {@link renderPage}. */
  stream?: () => Iterable<ChargeLogSample>,
): string {
  const L = o.labels;
  const stats = statsFor(o);
  const st = currentStatus(samples, Date.now());
  const tyre = lastState(samples, 'tyreBar');
  const diff = lastState(samples, 'tyreDiffBar');
  const service = lastState(samples, 'serviceKm');
  const locked = lastState(samples, 'locked');
  const climate = lastState(samples, 'climateOn');
  const temp = lastState(samples, 'targetTempC');
  const open = lastState(samples, 'anyOpen');

  // Wie lange wird „offen" schon durchgehend gemeldet?
  //
  // Nach dem Abstellen meldet das Fahrzeug regelmäßig ein offenes Fenster im
  // Fond, obwohl es zu ist — beobachtet über etwa eine halbe Stunde, dann
  // korrigiert es sich von selbst. Vermutlich werden die hinteren
  // Türsteuergeräte vom Bus getrennt, bevor sie ihren Endzustand gemeldet
  // haben.
  //
  // Ein Alarm, der mehrmals täglich grundlos angeht, wird nach einer Woche
  // ignoriert — und dann nützt er auch nicht mehr, wenn wirklich ein Fenster
  // offen steht. Deshalb gilt „offen" erst nach einer Weile als gesichert;
  // vorher steht es da, aber ohne Alarmfarbe und mit dem Grund dabei.
  const OPEN_SETTLE_MIN = 45;
  let openSince: number | undefined;
  if (open?.value === true) {
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].anyOpen === false) {
        break;
      }
      if (samples[i].anyOpen === true) {
        openSince = Date.parse(samples[i].ts);
      }
    }
  }
  const openMinutes =
    openSince !== undefined ? (Date.now() - openSince) / 60000 : undefined;
  const openSettled = openMinutes !== undefined && openMinutes >= OPEN_SETTLE_MIN;


  const ago = (iso: string): string => {
    // Nie negativ — siehe {@link currentStatus}: Ein zwischengespeicherter
    // Zeitstempel kann in der Zukunft liegen, und „vor -45 h" ist keine Angabe.
    const min = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
    return min < 90
      ? L.stAgoMin.replace('%n', String(Math.round(min)))
      : L.stAgoHour.replace('%n', String(Math.round(min / 60)));
  };

  // Reifen: Der Sollabgleich kommt vom Fahrzeug (differenceBar) — eigene
  // Sollwerte zu raten wäre bei last- und temperaturabhängigen Vorgaben falsch.
  const WHEELS = [L.stFrontLeft, L.stFrontRight, L.stRearLeft, L.stRearRight];

  // Verlauf je Rad. Das ist der eigentliche Gewinn gegenüber der Fahrzeug-App:
  // Die zeigt den heutigen Druck, aber nicht, dass ein Reifen seit Wochen
  // verliert. Ein einzelner Wert kann immer Tagesform sein — erst die Reihe
  // unterscheidet Wetter von Verlust.
  const history = samples
    .filter((x) => x.tyreBar !== undefined)
    .map((x) => ({ t: Date.parse(x.ts), v: x.tyreBar as [number, number, number, number] }));
  // Ein Wert je Tag genügt und macht die Linie ruhig: Über den Tag schwankt
  // der Druck mit der Temperatur, das ist kein Trend.
  const daily: typeof history = [];
  for (const h of history) {
    const day = new Date(h.t).toDateString();
    if (daily.length === 0 || new Date(daily[daily.length - 1].t).toDateString() !== day) {
      daily.push(h);
    } else {
      daily[daily.length - 1] = h;
    }
  }
  const trendFor = (i: number): { svg: string; text: string } => {
    const pts = daily.map((d) => ({ t: d.t, v: d.v[i] }));
    const svg = sparkline(pts, { minSpan: 0.2 });
    if (pts.length < 4) {
      return { svg: '', text: '' };
    }
    const delta = pts[pts.length - 1].v - pts[0].v;
    const days = String(
      Math.max(1, Math.round((pts[pts.length - 1].t - pts[0].t) / 86400000)),
    );
    return {
      svg,
      text:
        Math.abs(delta) < 0.05
          ? L.stStableOver.replace('%n', days)
          : L.stChangeOver
              .replace('%v', `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`)
              .replace('%n', days),
    };
  };
  const tyreRows = tyre
    ? tyre.value
        .map((bar, i) => {
          const d = diff?.value[i];
          const trend = trendFor(i);
          const level = d === undefined ? '' : Math.abs(d) >= 0.3 ? ' bad' : Math.abs(d) >= 0.15 ? ' warn' : ' ok';
          return `<div class="wheel${level}">
            <span>${esc(WHEELS[i])}</span>
            <b>${bar.toFixed(1)}<i>bar</i></b>
            ${d !== undefined ? `<em>${d > 0 ? '+' : ''}${d.toFixed(1)} ${esc(L.stToTarget)}</em>` : ''}
            ${trend.svg}${trend.text ? `<u>${esc(trend.text)}</u>` : ''}
          </div>`;
        })
        .join('')
    : '';

  // Kilometerleistung der letzten sieben Tage — die Zahl, die man sonst
  // nirgends bekommt, ohne selbst Buch zu führen.
  const weekAgo = Date.now() - 7 * 86400000;
  const odoNow = lastState(samples, 'odometerKm');
  const odoThen = samples.find(
    (x) => x.odometerKm !== undefined && Date.parse(x.ts) >= weekAgo,
  )?.odometerKm;
  const weekKm =
    odoNow && odoThen !== undefined ? Math.max(0, odoNow.value - odoThen) : undefined;

  // `alert` hebt hervor, was man wissen WILL, ohne die Seite zu durchsuchen:
  // ein offenes Auto. Alles andere bleibt gleich laut, sonst hebt sich nichts
  // mehr ab.
  // Service-Prognose: Wie lange reicht die Rest-Reichweite bei der aktuellen
  // Fahrleistung? Die Kilometerzahl allein sagt wenig — 27.000 km sind bei
  // 200 km je Woche gut zweieinhalb Jahre, bei 800 km ein gutes halbes.
  //
  // Gerechnet über die letzten vier Wochen, nicht über die gesamte Historie:
  // Eine Urlaubsfahrt vor einem Jahr sagt nichts über den nächsten Monat.
  const monthAgo = Date.now() - 28 * 86400000;
  const odoMonth = samples.find(
    (x) => x.odometerKm !== undefined && Date.parse(x.ts) >= monthAgo,
  );
  let serviceEta = '';
  if (service && odoNow && odoMonth?.odometerKm !== undefined) {
    const days = (Date.now() - Date.parse(odoMonth.ts)) / 86400000;
    const km = odoNow.value - odoMonth.odometerKm;
    // Erst ab einer Woche und 100 km ist die Hochrechnung mehr als Rauschen.
    if (days >= 7 && km >= 100) {
      const perDay = km / days;
      const daysLeft = service.value / perDay;
      const when = new Date(Date.now() + daysLeft * 86400000);
      const perWeek = String(Math.round(perDay * 7));
      // Ab eineinhalb Jahren nur noch grob in Jahren. Ein Monatsdatum, das
      // zweieinhalb Jahre in der Zukunft liegt, behauptet eine Genauigkeit,
      // die eine Hochrechnung aus vier Wochen nicht hergibt.
      serviceEta =
        daysLeft > 550
          ? (() => {
              // „noch gut 1 Jahre" — die Einzahl braucht ihre eigene Form.
              const jahre = Math.floor(daysLeft / 365);
              return `${L.stPerWeek.replace('%n', perWeek)} ${(jahre === 1
                ? L.stYearLeft
                : L.stYearsLeft
              ).replace('%n', String(jahre))}`;
            })()
          : `${L.stPerWeek.replace('%n', perWeek)} ${L.stAbout} ${when.toLocaleDateString(
              L.locale,
              { month: 'long', year: 'numeric' },
            )}`;
    }
  }

  // Abgebrochene letzte Ladung — die einzige Ladeinformation, die auf die
  // Statusseite gehört: Sie sagt, warum das Auto jetzt weniger hat als geplant.
  //
  // Nur die JÜNGSTE abgeschlossene Ladung, und nur solange nicht wieder am
  // Kabel: Sobald die nächste läuft, ist die Warnung Geschichte.
  const sessions = buildSessions(stream ? stream() : samples, optionsFor(o));
  const lastDone = [...sessions].reverse().find((x) => x.complete);
  const abortedLast =
    st.last?.plugged !== true && lastDone?.aborted === true ? lastDone : undefined;

  // Standverbrauch: was ohne Fahren verloren geht.
  const cap = stats.capacity;
  const idleRoh = analyzeIdle(stream ? stream() : samples, { maxGapMin: stats.pollMin * 2 + 5 });
  const idle = idleStats(idleRoh, optionsFor(o).capacityKwh);

  // Wie ehrlich ist die Reichweitenanzeige? Gemessen daran, wie viel Anzeige
  // ein gefahrener Kilometer kostet — nicht an einer eigenen Prognose.
  const tripStats = summarizeTrips(stats.trips);
  const realOf100 =
    tripStats.rangeFactor !== undefined && tripStats.rangeFactor > 0
      ? Math.round(100 / tripStats.rangeFactor)
      : undefined;

  const card = (label: string, value: string, sub = '', alert = false): string =>
    `<div class="card${alert ? ' alert' : ''}"><span>${esc(label)}</span><b>${value}</b>${
      sub ? `<span>${sub}</span>` : ''
    }</div>`;

  return `<!doctype html>
<html lang="${esc(L.locale)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${THEME_META}
<title>${esc(o.vehicleName)} — ${esc(L.stTitle)}</title>
<style>${BASE_CSS}${SPARK_CSS}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.card span{display:block;color:var(--dim);font-size:11px;text-transform:uppercase;
 letter-spacing:.04em;margin-bottom:4px}
.card b{font-size:24px;font-weight:600;display:block}
.card b i{font-style:normal;font-size:13px;color:var(--dim);margin-left:3px}
.card span+b+span{text-transform:none;letter-spacing:0;font-size:12.5px;margin:4px 0 0}
.wheels{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
.wheel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.wheel span{display:block;color:var(--dim);font-size:11.5px;margin-bottom:3px}
.wheel b{font-size:21px;font-weight:600}
.wheel b i{font-style:normal;font-size:12px;color:var(--dim);margin-left:3px}
.wheel em{display:block;font-style:normal;font-size:12px;color:var(--dim);margin-top:2px}
.wheel.ok em{color:#35c77b}
.wheel.warn{border-color:#c8811a}.wheel.warn em{color:#c8811a}
.wheel.bad{border-color:#d9534f}.wheel.bad em{color:#d9534f}
.wheel u{display:block;text-decoration:none;font-size:11.5px;color:var(--dim);margin-top:2px}
.card.alert{border:1px solid #d9534f}
.card.alert b{color:#d9534f}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);
 font-weight:600;margin:0 0 8px}
.back{display:inline-flex;align-items:center;gap:6px;color:var(--dim);text-decoration:none;
 font-size:14px;min-height:44px}
.cog{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;
 margin:-8px -6px;color:var(--dim);background:none;border:0;padding:0;cursor:pointer}
.cog:active{opacity:.5}
.cog.busy svg{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<h1><span>${esc(o.vehicleName)}</span><em>${
  st.last
    ? `${esc(L.dashAsOf)} ${esc(
        new Date(st.stateAt ?? st.last.ts).toLocaleTimeString(L.locale, {
          hour: '2-digit',
          minute: '2-digit',
        }),
      )}`
    : ''
}${
  o.onRefresh
    ? `<button class="cog" id="rf" type="button" title="${esc(L.dashRefresh)}" aria-label="${esc(
        L.dashRefresh,
      )}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
        stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
       ><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>`
    : ''
}<a class="back" href="/">‹ ${esc(L.stBackToCharging)}</a></em></h1>
${REFRESH_NOTE}
${
  tyre
    ? `<h2>${esc(L.stTyrePressure)} · ${esc(ago(tyre.at))}</h2><div class="wheels">${tyreRows}</div>`
    : `<div class="empty">${esc(L.stNoTyreData)}</div>`
}
<h2>${esc(L.stVehicle)}</h2>
<div class="grid">
  ${
    abortedLast
      ? card(
          L.stAborted,
          `${abortedLast.endSoc}<i>${esc(
            L.stAbortedUnit.replace('%t', String(abortedLast.targetSoc)),
          )}</i>`,
          esc(L.stAbortedDetail.replace('%d', fmtDate(abortedLast.endedAt as string, L.locale))),
          true,
        )
      : ''
  }
  ${
    service
      ? card(L.stNextService, `${service.value.toLocaleString(L.locale)}<i>km</i>`, serviceEta)
      : ''
  }
  ${odoNow ? card(L.stOdometer, `${odoNow.value.toLocaleString(L.locale)}<i>km</i>`) : ''}
  ${
    realOf100 !== undefined
      ? card(
          L.stRealRange,
          `${realOf100}<i>${esc(L.stRealRangeUnit)}</i>`,
          // Knapp halten: Ein Detailtext über mehrere Zeilen bläht die Kachel
          // auf und reißt ein Loch in die Reihe daneben.
          esc(L.stRealRangeDetail.replace('%n', tripStats.rangeKm.toLocaleString(L.locale))),
        )
      : ''
  }
  ${
    idle !== undefined
      ? card(
          L.stIdleDrain,
          // „unter", wenn der Ladestand über die ganze Beobachtung kaum
          // gefallen ist: Dann ist die Zahl eine Obergrenze, keine Messung.
          `${idle.obergrenze ? esc(L.stIdleDrainAtMost) : ''}${idle.kwhPerDay.toFixed(1)}<i>${esc(
            L.stIdleDrainUnit,
          )}</i>`,
          esc(L.stIdleDrainDetail.replace('%n', String(Math.round(idleRoh.idleMinutes / 60)))),
        )
      : // Sichtbar bleiben, auch ohne Ergebnis: Eine Kachel, die verschwindet,
        // ist von „kaputt" nicht zu unterscheiden.
        card(
          L.stIdleDrain,
          `<i>${esc(L.stIdleDrainCollecting)}</i>`,
          esc(
            L.stIdleDrainProgress.replace('%n', String(Math.round(idleRoh.idleMinutes / 60))).replace(
              '%m',
              '48',
            ),
          ),
        )
  }
  ${weekKm !== undefined ? card(L.stLast7Days, `${weekKm}<i>km</i>`) : ''}
  ${st.state?.soc !== undefined ? card(L.stChargeLevel, `${st.state.soc}<i>%</i>`,
      st.state.rangeKm !== undefined ? `${st.state.rangeKm} ${esc(L.stRangeSuffix)}` : '') : ''}
</div>
<h2>${esc(L.stSecurity)}</h2>
<div class="grid">
  ${
    locked
      ? card(L.stLocked, esc(locked.value ? L.stYes : L.stNo), esc(ago(locked.at)), !locked.value)
      : ''
  }
  ${
    open
      ? card(
          L.stAllClosed,
          esc(open.value ? L.stNo : L.stYes),
          open.value && !openSettled
            ? esc(L.stOpenUnsettled.replace('%n', String(Math.round(openMinutes ?? 0))))
            : esc(ago(open.at)),
          openSettled,
        )
      : ''
  }
  ${
    climate
      ? card(
          L.stClimate,
          esc(climate.value ? L.stOn : L.stOff),
          temp ? `${esc(L.stTargetTemp)} ${temp.value} °C` : '',
        )
      : ''
  }
</div>
<p style="color:var(--dim);font-size:12.5px;line-height:1.6">${esc(L.stFootnote)}</p>
<script>
(function(){
  // Derselbe Abruf wie im Dashboard: Wer nachsieht, ob das Auto verriegelt
  // ist, will nicht den Stand von vor einer Viertelstunde.
  ${refreshScript(L)}
})();
</script>
</body></html>`;
}

/**
 * Die Einstellungsseite.
 *
 * Zeigt je Feld, woher der wirksame Wert stammt. Ohne diese Angabe wäre nicht
 * erklärbar, warum eine Änderung in den Homebridge-Einstellungen folgenlos
 * bleibt, sobald hier einmal etwas eingetragen wurde.
 */
/**
 * Ab wie vielen Zyklen der Messwert zur Übernahme angeboten wird.
 *
 * So vorgegeben, und das ist richtig: Bei wenigen Zyklen schwankt die
 * Schätzung noch deutlich. Ein Knopf, der einen vorläufigen Wert in die
 * Konfiguration schreibt, würde die Vorläufigkeit verstecken — und weil die
 * Kapazität rückwirkend jede kWh-Zahl verändert, wäre das teuer.
 */
const ADOPT_MIN_CYCLES = 10;

/**
 * Der Monatsbeleg als Seite — bewusst schlicht, weil sie gedruckt wird.
 *
 * Kein Diagramm, keine Farben, keine Interaktion außer dem Monatswechsel und
 * dem CSV-Verweis: Was auf Papier landet, soll aussehen wie eine Abrechnung
 * und nicht wie eine App.
 */

/**
 * Der Fahrtenbericht — bewusst als SPIEGEL des Ladebelegs.
 *
 * Gleiche Monatswahl, gleiche Tabellenform, gleiche Werkzeugzeile mit CSV
 * und Drucken, gleiche Druckregeln. Beides sind Monatsaufstellungen über
 * dieselbe Historie; zwei verschiedene Bedienmuster dafür wären Willkür.
 */
function renderTripReport(o: DashboardOptions, r: TripReport, months: string[]): string {
  const L = o.labels;
  const fmtMonth = (m: string): string =>
    new Date(`${m}-01T12:00:00Z`).toLocaleDateString(L.locale, {
      month: 'long',
      year: 'numeric',
    });
  const num = (n: number | undefined, d = 2): string =>
    n === undefined
      ? ''
      : n.toLocaleString(L.locale, { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtStampLocal = (iso: string): string =>
    new Date(iso).toLocaleString(L.locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const rows = r.lines
    .map(
      (l) => `<tr>
        <td>${esc(fmtStampLocal(l.endedAt))}</td>
        <td class="num">${l.km.toLocaleString(L.locale)}</td>
        <td class="num">${l.minutes}</td>
        <td class="num">${num(l.energyKwh)}</td>
        <td class="num">${num(l.kwhPer100km, 1)}</td>
        <td class="num">${num(l.costEur)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="${L.locale.slice(0, 2)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(o.vehicleName)} — ${esc(L.trTitle)} ${esc(fmtMonth(r.month))}</title>
<style>${BASE_CSS}
${REPORT_CSS}
</style></head><body>
<h1><span>${esc(L.trTitle)}</span><em><a class="back" href="/?g=month">‹ ${esc(
    L.setBack,
  )}</a></em></h1>
<div class="months">${months
    .map(
      (m) =>
        `<a href="/fahrtenbericht?m=${encodeURIComponent(m)}"${
          m === r.month ? ' class="on"' : ''
        }>${esc(fmtMonth(m))}</a>`,
    )
    .join('')}</div>
<div class="tools">
  <a href="/fahrten.csv?m=${encodeURIComponent(r.month)}">${esc(L.rcCsv)}</a>
  <a href="#" onclick="window.print();return false">${esc(L.rcPrint)}</a>
</div>
${
  r.lines.length
    ? `<div class="wrap"><table>
        <thead><tr><th>${esc(L.csvEnd)}</th><th class="num">km</th><th class="num">${esc(
          L.csvMinutes,
        )}</th>
        <th class="num">kWh</th><th class="num">kWh/100 km</th><th class="num">EUR</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="sum">
          <td>${r.lines.length} ${esc(r.lines.length === 1 ? L.trTrip : L.trTrips)}</td>
          <td class="num">${r.km.toLocaleString(L.locale)}</td>
          <td></td>
          <td class="num">${r.energyKwh > 0 ? num(r.energyKwh) : ''}</td>
          <td class="num">${num(r.kwhPer100km, 1)}</td>
          <td class="num">${r.costEur > 0 ? num(r.costEur) : ''}</td>
        </tr></tfoot>
      </table></div>`
    : `<div class="empty">${esc(L.trEmpty)}</div>`
}
<p class="foot">${esc(o.vehicleName)} · ${esc(fmtMonth(r.month))}</p>
</body></html>`;
}

/** Den strukturierten Grund in einen Satz übersetzen — hier weiß man die Sprache. */
function battWhy(why: BatteryReport['why'], L: Labels): string {
  if (!why) {
    return L.battNotYet;
  }
  switch (why.reason) {
    case 'no-measurement':
      return L.battNoMeasurement;
    case 'few-cycles':
      return fill(L.battFewCycles, why.cycles, why.needed);
    case 'short-period':
      return fill(L.battShortPeriod, why.days, why.needed);
  }
}

/**
 * Der Batterie-Nachweis als druckbare Seite.
 *
 * Bewusst dieselbe Form wie Ladebeleg und Fahrtenbericht: Es sind alles
 * Dokumente, die man jemandem vorlegt.
 *
 * Der Aufbau folgt dem, was ein Käufer oder eine Garantieabteilung prüfen
 * würde — erst die Zahl, dann woher sie kommt, dann der Verlauf, dann die
 * Methode. Wo die Datenbasis noch nicht trägt, steht das an derselben Stelle,
 * an der sonst der Verlust stünde. Eine Zahl zu zeigen und ihre Unsicherheit
 * zu verschweigen wäre hier besonders verkehrt: Der ganze Zweck des Blattes
 * ist, überprüfbar zu sein.
 */
function renderBattery(o: DashboardOptions, r: BatteryReport): string {
  const L = o.labels;
  const stamp = (iso: string): string =>
    new Date(iso).toLocaleString(L.locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const zeitraum =
    r.firstAt !== undefined && r.lastAt !== undefined
      ? `${stamp(r.firstAt)} – ${stamp(r.lastAt)}`
      : '—';

  const verlauf = r.months
    .map(
      (m) => `<tr>
        <td>${esc(m.month)}</td>
        <td class="num">${m.kwh.toFixed(1)}</td>
        <td class="num">${m.samples}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="${esc(L.locale.slice(0, 2))}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(o.vehicleName)} — ${esc(L.battTitle)}</title>
<style>${BASE_CSS}
${REPORT_CSS}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:14px 0;font-size:14px}
.kv dt{color:var(--dim)}
.kv dd{margin:0;font-weight:600}
.big{font-size:34px;font-weight:600;letter-spacing:-.02em;margin:4px 0 2px}
.big small{font-size:15px;font-weight:400;color:var(--dim);margin-left:6px}
.hint{color:var(--dim);font-size:13px;line-height:1.5;margin:10px 0}
</style></head><body>
<h1><span>${esc(L.battTitle)}</span><em><a class="back" href="/">${esc(L.battBack)}</a></em></h1>
<div class="tools">
  <a href="#" onclick="window.print();return false">${esc(L.battPrint)}</a>
</div>
${
  r.capacityKwh !== undefined
    ? `<div class="big">${r.capacityKwh.toFixed(1)} kWh${
        r.uncertaintyKwh !== undefined ? `<small>± ${r.uncertaintyKwh.toFixed(1)}</small>` : ''
      }</div>
<div class="hint">${esc(L.battMeasured)}${
        r.healthPct !== undefined
          ? ` · ${esc(fill(L.battOfRated, r.healthPct.toFixed(1), r.ratedKwh.toFixed(1)))}`
          : ''
      }</div>`
    : `<div class="empty">${esc(L.battNoMeasurement)}</div>`
}
<dl class="kv">
  <dt>${esc(L.battVehicle)}</dt><dd>${esc(o.vehicleName)}</dd>
  <dt>${esc(L.battRated)}</dt><dd>${r.ratedKwh.toFixed(1)} kWh</dd>
  <dt>${esc(L.battCycles)}</dt><dd>${r.cycles}</dd>
  <dt>${esc(L.battDistance)}</dt><dd>${r.km.toLocaleString(L.locale)} km</dd>
  <dt>${esc(L.battPeriod)}</dt><dd>${esc(zeitraum)}${
    r.days !== undefined ? ` ${esc(fill(L.battDays, r.days))}` : ''
  }</dd>
  <dt>${esc(L.battLoss)}</dt><dd>${
    r.lossKwh !== undefined
      ? `${r.lossKwh.toFixed(1)} kWh`
      : `<span style="font-weight:400;color:var(--dim)">${esc(battWhy(r.why, L))}</span>`
  }</dd>
</dl>
${
  verlauf
    ? `<div class="wrap"><table>
        <thead><tr><th>${esc(L.battMonth)}</th><th class="num">kWh</th>
        <th class="num">${esc(L.battReadings)}</th></tr></thead>
        <tbody>${verlauf}</tbody>
      </table></div>`
    : ''
}
<p class="hint">${esc(L.battMethod)}</p>
<p class="foot">${esc(o.vehicleName)} · ${esc(stamp(new Date().toISOString()))}</p>
</body></html>`;
}

function renderReceipt(
  o: DashboardOptions,
  r: Receipt,
  months: string[],
): string {
  const L = o.labels;
  const fmtMonth = (m: string): string =>
    new Date(`${m}-01T12:00:00Z`).toLocaleDateString(L.locale, {
      month: 'long',
      year: 'numeric',
    });
  const num = (n: number, d = 2): string =>
    n.toLocaleString(L.locale, { minimumFractionDigits: d, maximumFractionDigits: d });
  // Mit Jahr, ohne Wochentag: Auf einem Beleg zählt das vollständige Datum,
  // nicht der Wochentag — und die Spalte bleibt schmal genug fürs Telefon.
  const fmtStamp = (iso: string): string =>
    new Date(iso).toLocaleString(L.locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const rows = r.lines
    .map(
      (l) => `<tr>
        <td>${esc(fmtStamp(l.startedAt))}</td>
        <td>${esc(l.atHome === true ? L.dashAtHome : l.atHome === false ? L.dashAway : '—')}</td>
        <td>${
          l.startSoc !== undefined && l.endSoc !== undefined
            ? `${l.startSoc} → ${l.endSoc} %`
            : '—'
        }</td>
        <td class="num">${num(l.kwh)}</td>
        <td class="num">${l.centPerKwh !== undefined ? num(l.centPerKwh) : ''}</td>
        <td class="num">${l.costEur !== undefined ? num(l.costEur) : ''}</td>
      </tr>`,
    )
    .join('');

  const sum = ([label, g]: [string, { kwh: number; costEur: number; count: number }]): string =>
    g.count === 0
      ? ''
      : `<tr class="sum"><td colspan="3">${esc(label)} · ${g.count} ${
          g.count === 1 ? esc(L.dashChargeOne) : esc(L.dashCharges)
        }</td>
         <td class="num">${num(g.kwh)}</td><td></td>
         <td class="num">${g.costEur > 0 ? num(g.costEur) : ''}</td></tr>`;

  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(o.vehicleName)} — ${esc(L.rcTitle)} ${esc(fmtMonth(r.month))}</title>
<style>${BASE_CSS}
${REPORT_CSS}
</style></head><body>
<h1><span>${esc(L.rcTitle)}</span><em><a class="back" href="/?g=month">‹ ${esc(L.setBack)}</a></em></h1>
<div class="months">${months
    .map(
      (m) =>
        `<a href="/beleg?m=${encodeURIComponent(m)}"${m === r.month ? ' class="on"' : ''}>${esc(
          fmtMonth(m),
        )}</a>`,
    )
    .join('')}</div>
<div class="tools">
  <a href="/beleg.csv?m=${encodeURIComponent(r.month)}">${esc(L.rcCsv)}</a>
  <a href="#" onclick="window.print();return false">${esc(L.rcPrint)}</a>
</div>
${
  r.lines.length
    ? `<div class="wrap"><table>
        <thead><tr><th>${esc(L.dashStart)}</th><th>${esc(L.rcPlace)}</th><th>${esc(L.dashChargeState)}</th>
        <th class="num">kWh</th><th class="num">ct/kWh</th><th class="num">EUR</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>${[
          [L.rcSumHome, r.home],
          [L.rcSumAway, r.away],
          [L.rcSumUnknown, r.unknown],
        ]
          .map((x) => sum(x as [string, { kwh: number; costEur: number; count: number }]))
          .join('')}</tfoot>
      </table></div>`
    : `<div class="empty">${esc(L.rcNoCharges)}</div>`
}
<p class="foot">${esc(
  L.rcFootnote
    .replace('%v', o.vehicleName)
    .replace('%m', fmtMonth(r.month))
    .replace('%c', num(effective(o).values.capacityKwh, 1)),
)}</p>
</body></html>`;
}

function renderSettings(
  o: DashboardOptions,
  host: string,
  measured?: number,
  cycles = 0,
  uncertainty?: number,
): string {
  const L = o.labels;
  const { values } = effective(o);
  // One field, one value.
  //
  // Every field used to show its value as a grey placeholder when it came from
  // the plugin config and in black when it was set here, plus a line explaining
  // what that meant. A control that needs explaining is built wrong: where a
  // value comes from is the program's problem, not the driver's.
  //
  // Now each field simply holds the EFFECTIVE value. The first save moves
  // everything here; from then on this page is the only source.
  const field = (
    key: keyof DashboardSettings,
    label: string,
    hint: string,
    step: string,
  ): string =>
    `<div class="srow">
      <label for="f-${key}">${esc(label)}</label>
      <input id="f-${key}" name="${key}" type="text" inputmode="decimal" step="${step}"
             value="${values[key as keyof typeof values]}">
      <small>${esc(hint)}</small>
    </div>`;

  return `<!doctype html>
<html lang="${esc(L.locale)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${THEME_META}
<title>${esc(o.vehicleName)} — ${esc(L.setTitle)}</title>
<style>${BASE_CSS}
.srow{display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:center;
 padding:12px 0;border-bottom:1px solid var(--line)}
.srow:last-of-type{border-bottom:0}
.srow label{font-size:15px}
.srow input,.srow select{width:112px;min-height:38px;padding:6px 9px;border-radius:9px;text-align:right;
 border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:15px}
.srow small{grid-column:1/-1;color:var(--dim);font-size:12px;line-height:1.5}
.srow small i{font-style:normal;opacity:.75}
.adopt{padding:10px 0 2px;border-bottom:1px solid var(--line)}
.adopt button{min-height:38px;padding:0 14px;border-radius:9px;border:1px solid var(--accent);
 background:transparent;color:var(--accent);font:inherit;font-size:14px;cursor:pointer}
.adopt button:active{opacity:.6}
.adopt small{display:block;color:var(--dim);font-size:12px;line-height:1.5;margin-top:6px}
.sbar{display:flex;align-items:center;gap:12px;margin-top:18px}
.sbar button{min-height:44px;padding:0 18px;border-radius:11px;border:0;background:var(--accent);
 color:#fff;font:inherit;font-size:15px;font-weight:600;cursor:pointer}
.sbar button:active{opacity:.7}
.sbar em{font-style:normal;color:var(--dim);font-size:13px}
.sbar.ok em{color:#35c77b}
.sbar.bad em{color:#d9534f}
.back{display:inline-flex;align-items:center;gap:6px;color:var(--dim);text-decoration:none;
 font-size:14px;min-height:44px}
</style></head><body>
<h1><span>${esc(L.setTitle)}</span><em><a class="back" href="/">‹ ${esc(L.setBack)}</a></em></h1>
<form id="sf" class="card" style="display:block;padding:4px 14px 14px">
  ${field('priceCt', L.setPrice, L.setPriceHint, '0.01')}
  ${field('bonusCt', L.setBonus, L.setBonusHint, '0.01')}
  ${field('externalPriceCt', L.setExternal, L.setExternalHint, '0.01')}
  ${field('capacityKwh', L.setCapacity, L.setCapacityHint, '0.1')}
  ${
    measured !== undefined && cycles >= ADOPT_MIN_CYCLES
      ? `<div class="adopt"><button type="button" id="adopt" data-v="${measured}">${esc(L.setAdopt)}: ${measured.toFixed(1)}${
          uncertainty !== undefined ? ` ± ${uncertainty.toFixed(1)}` : ''
        } kWh</button><small>${esc(L.setAdoptHint)}</small></div>`
      : measured !== undefined
        ? `<div class="adopt"><small>${esc(L.setMeasured)}: ${measured.toFixed(1)}${
            uncertainty !== undefined ? ` ± ${uncertainty.toFixed(1)}` : ''
          } kWh — ${cycles} ${esc(
            cycles === 1 ? L.capDrive : L.capDrives,
          )}. ${esc(L.setAdoptFrom).replace('%n', String(ADOPT_MIN_CYCLES))}</small></div>`
        : ''
  }
  ${field('dayBoundaryHour', L.setDayBoundary, L.setDayBoundaryHint, '1')}
  <div class="srow">
    <label for="f-defaultView">${esc(L.setDefaultView)}</label>
    <select id="f-defaultView" name="defaultView">
      ${(['day', 'week', 'month', 'year'] as const)
        .map(
          (v) =>
            `<option value="${v}"${
              (effective(o).stored.defaultView ?? 'month') === v ? ' selected' : ''
            }>${esc(GRAN_LABEL[v])}</option>`,
        )
        .join('')}
    </select>
    <small>${esc(L.setDefaultViewHint)}</small>
  </div>
  <div class="srow">
    <label for="f-autoCapacity">${esc(L.setAutoCapacity)}</label>
    <input id="f-autoCapacity" name="autoCapacity" type="checkbox"${
      effective(o).stored.autoCapacity === true ? ' checked' : ''
    }>
    <small>${esc(L.setAutoCapacityHint)}</small>
  </div>
  <div class="srow">
    <label for="f-priceFrom">${esc(L.setPriceFrom)}</label>
    <input id="f-priceFrom" name="priceFrom" type="date">
    <small>${esc(L.setPriceFromHint)}</small>
  </div>
  <div class="sbar"><button type="submit">${esc(L.pfSave)}</button><em></em></div>
</form>
<p style="color:var(--dim);font-size:12.5px;line-height:1.6;margin-top:18px">
  ${esc(L.setFooter)}
  <a href="//${esc(host)}:${o.uiPort}/" target="_blank" rel="noopener"
     style="color:var(--accent)">Homebridge</a> ${esc(L.setFooterTail)}
</p>
<script>
(function(){
  var f=document.getElementById('sf'), bar=f.querySelector('.sbar'), out=bar.querySelector('em');
  var ad=document.getElementById('adopt');
  // Nur ins Feld schreiben, nicht sofort sichern: Wer den Wert sieht, soll ihn
  // noch verwerfen können, bevor die ganze Historie neu gerechnet wird.
  if(ad) ad.addEventListener('click',function(){
    document.getElementById('f-capacityKwh').value=ad.dataset.v;
    out.textContent=${JSON.stringify(L.pfSaved)};
  });
  f.addEventListener('submit',function(e){
    e.preventDefault();
    var body={};
    f.querySelectorAll('input,select').forEach(function(i){
      body[i.name] = i.type === 'checkbox' ? i.checked : i.value.trim();
    });
    bar.classList.remove('ok','bad'); out.textContent='…';
    fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},
                           body:JSON.stringify(body)})
      .then(function(r){return r.json();})
      .then(function(j){
        bar.classList.add(j.ok?'ok':'bad');
        out.textContent=j.ok?${JSON.stringify(L.pfSaved)}:${JSON.stringify(L.pfFailed)};
        if(j.ok) setTimeout(function(){location.reload();},600);
      })
      .catch(function(){bar.classList.add('bad');out.textContent=${JSON.stringify(L.pfFailed)};});
  });
})();
</script>
</body></html>`;
}

/**
 * Startet das Dashboard. Gibt `undefined` zurück, wenn der Port 0 ist (aus).
 *
 * Fehler beim Binden werden geloggt, aber nie geworfen: Ein belegter Port darf
 * das Plugin nicht am Starten hindern.
 */
/**
 * Der gewünschte Monat aus `?m=`, geprüft — sonst der jüngste mit Daten.
 *
 * Ein leerer Bericht für einen frisch begonnenen Monat wäre die schlechtere
 * Vorgabe. Die Form allein genügt nicht: `2026-13` passt auf das Muster,
 * ergibt aber ein ungültiges Datum. Gemeinsam für Ladebeleg und
 * Fahrtenbericht: Zwei Berichte, die sich bei derselben Adresse verschieden
 * verhalten, sind ein Fehler mit Ansage.
 */
function monatAusAnfrage(wanted: string | null, months: string[]): string {
  const gueltig = wanted !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(wanted);
  return gueltig ? wanted : (months[0] ?? new Date().toISOString().slice(0, 7));
}

export function startDashboard(o: DashboardOptions): http.Server | undefined {
  if (!o.port) {
    return undefined;
  }
  const load = (): { samples: ChargeLogSample[]; sessions: ChargeSession[] } => {
    const samples = readSamples(o.logDir);
    return {
      samples,
      sessions: applyExternalPrices(
        buildSessions(streamSamples(o.logDir), optionsFor(o)),
        readPrices(o.logDir),
        effective(o).values.externalPriceCt,
      ),
    };
  };

  /**
   * Eine CSV-Antwort — mit BOM und Download-Kopf.
   *
   * Das BOM ist keine Kür: Ohne es zeigt ein deutsch eingestelltes Excel
   * jedes Nicht-ASCII-Zeichen als Kauderwelsch, und die Ladungsliste trägt
   * einen Pfeil in der Ladestand-Spalte.
   */
  const csvAntwort = (res: http.ServerResponse, dateiname: string, csv: string): void => {
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${dateiname}"`,
    });
    res.end('\ufeff' + csv);
  };

  const json = (res: http.ServerResponse, data: unknown, status = 200): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  let lastRefresh = 0;

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const g = url.searchParams.get('g');
      // Ohne g-Parameter gilt die in den Einstellungen gewählte
      // Standardansicht; erst danach der Monat als Voreinstellung.
      const gran: Granularity =
        g === 'day' || g === 'week' || g === 'month' || g === 'year'
          ? g
          : readSettings(o.logDir).defaultView ?? 'month';
      const pRaw = url.searchParams.get('p');
      const place: Place = pRaw === 'home' || pRaw === 'away' ? pRaw : 'all';
      // Gewählter Zeitraum als Bucket-Schlüssel (`2026-07-28`, `2026-W31`, …).
      // Der Wert wird gegen die vorhandenen Zeiträume geprüft, taugt also nicht
      // als Einfallstor.
      const dRaw = url.searchParams.get('d');
      const picked = dRaw && /^[0-9W-]{4,10}$/.test(dRaw) ? dRaw : undefined;

      // --- Web-App-Beiwerk (Homescreen-Symbol, Manifest) ---
      const iconMatch = /^\/icon-(\d+)\.png$/.exec(url.pathname);
      if (iconMatch) {
        const png = ICONS[Number(iconMatch[1])];
        if (png) {
          const buf = Buffer.from(png, 'base64');
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': buf.length,
            'cache-control': 'public, max-age=604800',
          });
          res.end(buf);
          return;
        }
      }
      if (url.pathname === '/status') {
        const page = renderStatus(
          o,
          load().samples,
          String(req.headers.host ?? '').split(':')[0],
          () => streamSamples(o.logDir),
        );
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }
      // Vollständige Listen als CSV — anders als der Monatsbeleg über ALLE
      // Monate; mit `?m=` auf einen Monat begrenzt.
      if (url.pathname === '/fahrten.csv') {
        const trips = statsFor(o).trips;
        const wanted = url.searchParams.get('m');
        const gefiltert =
          wanted !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(wanted)
            ? trips.filter((t) => monthKey(t.endedAt) === wanted)
            : trips;
        csvAntwort(
          res,
          `trips${wanted && gefiltert !== trips ? `-${wanted}` : ''}.csv`,
          tripsCsv(gefiltert, o.vehicleName, o.labels),
        );
        return;
      }
      if (url.pathname === '/ladungen.csv') {
        csvAntwort(res, 'charges.csv', sessionsCsv(load().sessions, o.vehicleName, o.labels));
        return;
      }
      // Der Fahrtenbericht — dieselbe Form wie der Ladebeleg.
      // Der Batterie-Nachweis. Eigene Seite, weil eine Zahl auf einer Kachel
      // beim Verkauf oder im Garantiefall niemanden überzeugt.
      if (url.pathname === '/batterie') {
        const st = statsFor(o);
        const page = renderBattery(o, buildBatteryReport(st.capacity, o.capacityKwh));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }
      if (url.pathname === '/fahrtenbericht') {
        const trips = statsFor(o).trips;
        const months = tripMonths(trips);
        const month = monatAusAnfrage(url.searchParams.get('m'), months);
        const page = renderTripReport(o, buildTripReport(trips, month), months);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }
      if (url.pathname === '/beleg' || url.pathname === '/beleg.csv') {
        const { sessions } = load();
        const months = receiptMonths(sessions);
        // Ohne Angabe der jüngste Monat MIT Ladungen — ein leerer Beleg für
        // einen frisch begonnenen Monat wäre die schlechtere Vorgabe.
        // Die Form allein genügt nicht: `2026-13` passt auf das Muster, ergibt
        // aber ein ungültiges Datum — die Seite hieß dann „Invalid Date".
        const month = monatAusAnfrage(url.searchParams.get('m'), months);
        const receipt = buildReceipt(sessions, month);
        if (url.pathname === '/beleg.csv') {
          csvAntwort(
            res,
            `charging-receipt-${month}.csv`,
            receiptCsv(receipt, o.vehicleName, o.labels),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderReceipt(o, receipt, months));
        return;
      }
      if (url.pathname === '/settings') {
        const est = estimateCapacity(streamSamples(o.logDir));
        const page = renderSettings(
          o,
          String(req.headers.host ?? '').split(':')[0],
          est.capacityKwh,
          est.samples,
          est.uncertaintyKwh,
        );
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }
      if (url.pathname === '/manifest.json') {
        res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
        res.end(
          JSON.stringify({
            name: `${o.vehicleName} — ${o.labels.dashTitle}`,
            short_name: o.vehicleName,
            start_url: '/?g=month',
            display: 'standalone',
            background_color: '#0b0c0e',
            theme_color: '#0b0c0e',
            icons: [
              { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
              { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
            ],
          }),
        );
        return;
      }

      if (url.pathname === '/api/refresh') {
        if (!o.onRefresh) {
          json(res, { ok: false, reason: 'not-available' });
          return;
        }
        // Die einzige Route mit Wirkung nach draußen — sie stößt einen echten
        // Abruf beim Porsche-Backend an. Als schlichtes GET genügte eine
        // beliebige Webseite, die jemand im selben Netz öffnet: Ein GET löst
        // keinen Preflight aus, die Antwort muss der Angreifer gar nicht lesen,
        // der Abruf läuft trotzdem. Bei 20 s Sperre wären das 180 Abrufe je
        // Stunde — gerichtet gegen genau das Ratenlimit, dessen Überschreiten
        // eine Captcha-Sperre und damit ein neues Login erzwingt.
        //
        // Zwei Riegel, beide nötig: POST verlangt bei einem fremden Origin
        // einen Preflight, und den beantwortet dieser Server nicht (er sendet
        // keine CORS-Header). Der Origin-Vergleich fängt zusätzlich alles ab,
        // was den Preflight umgeht. Ein fehlender Origin bleibt erlaubt —
        // curl und der eigene Knopf im Homescreen-Modus senden keinen.
        if (req.method !== 'POST') {
          json(res, { ok: false, reason: 'method-not-allowed' }, 405);
          return;
        }
        const origin = req.headers.origin;
        if (typeof origin === 'string' && origin !== `http://${req.headers.host ?? ''}`) {
          json(res, { ok: false, reason: 'cross-origin' }, 403);
          return;
        }
        const since = Date.now() - lastRefresh;
        if (since < REFRESH_COOLDOWN_MS) {
          json(res, { ok: false, reason: 'cooldown', retryInMs: REFRESH_COOLDOWN_MS - since });
          return;
        }
        lastRefresh = Date.now();
        o.onRefresh()
          .then(() => json(res, { ok: true }))
          .catch((err) => {
            // Detail nur ins Log: Node-Fehler tragen gern absolute Pfade.
            o.log?.(`Manual refresh failed: ${String(err)}`);
            json(res, { ok: false, reason: 'refresh-failed' });
          });
        return;
      }
      if (url.pathname === '/api/settings') {
        // Wie jede schreibende Route: POST und gleicher Origin.
        if (req.method !== 'POST') {
          json(res, { ok: false, reason: 'method-not-allowed' }, 405);
          return;
        }
        const origin = req.headers.origin;
        if (typeof origin === 'string' && origin !== `http://${req.headers.host ?? ''}`) {
          json(res, { ok: false, reason: 'cross-origin' }, 403);
          return;
        }
        let body = '';
        let tooBig = false;
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
          if (body.length > 4096) {
            tooBig = true;
            req.destroy();
          }
        });
        req.on('end', () => {
          if (tooBig) {
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body || '{}');
          } catch {
            json(res, { ok: false, reason: 'bad-json' }, 400);
            return;
          }
          const next = sanitizeSettings(parsed);
          if (next === undefined) {
            json(res, { ok: false, reason: 'bad-settings' }, 400);
            return;
          }
          // Was verworfen wurde, gehört in die Antwort: „gesichert" zu melden,
          // während ein Wert stillschweigend gefallen ist, ist die schlechteste
          // aller Rückmeldungen — der Nutzer glaubt, es habe geklappt, und
          // sucht den Fehler später woanders.
          const rejected = rejectedSettings(parsed);
          if (rejected.length > 0 && Object.keys(next).length === 0) {
            json(res, { ok: false, reason: 'rejected', rejected }, 400);
            return;
          }
          // Tarifwechsel archivieren: Der bisher WIRKSAME Preis wird zur
          // historischen Periode, damit alte Ladungen ihre alten Kosten
          // behalten. `priceFrom` legt den Tag des Wechsels fest; ohne
          // Angabe gilt der neue Preis ab heute.
          const fromRaw = (parsed as Record<string, unknown>).priceFrom;
          if (fromRaw !== undefined && fromRaw !== '' && !dayOk(fromRaw)) {
            json(res, { ok: false, reason: 'bad-from' }, 400);
            return;
          }
          const fromDay = dayOk(fromRaw) ? fromRaw : localDay(new Date().toISOString());
          const before = effective(o).values;
          const after = mergeSettings({ priceCt: o.priceCt, bonusCt: o.bonusCt }, next).values;
          const history = archivePrice(
            readSettings(o.logDir).priceHistory,
            { priceCt: before.priceCt, bonusCt: before.bonusCt },
            { priceCt: after.priceCt, bonusCt: after.bonusCt },
            fromDay,
          );
          // Die Historie steht in keinem Formularfeld — sie muss den
          // Komplett-Ersatz durch den Formularstand ausdrücklich überleben.
          if (history.length > 0) {
            next.priceHistory = history;
          }
          const ok = writeSettings(o.logDir, next);
          json(
            res,
            ok
              ? rejected.length > 0
                ? { ok: true, rejected }
                : { ok: true }
              : { ok: false, reason: 'write-failed' },
            ok ? 200 : 500,
          );
        });
        return;
      }
      if (url.pathname === '/api/price') {
        if (req.method !== 'POST') {
          json(res, { ok: false, reason: 'method-not-allowed' }, 405);
          return;
        }
        const origin = req.headers.origin;
        if (typeof origin === 'string' && origin !== `http://${req.headers.host ?? ''}`) {
          json(res, { ok: false, reason: 'cross-origin' }, 403);
          return;
        }
        let body = '';
        let tooBig = false;
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
          // Ein Preis braucht keine 4 kB. Alles darüber wird verworfen,
          // statt Speicher für einen offenen Datenstrom zu binden.
          if (body.length > 4096) {
            tooBig = true;
            req.destroy();
          }
        });
        req.on('end', () => {
          if (tooBig) {
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body || '{}');
          } catch {
            json(res, { ok: false, reason: 'bad-json' }, 400);
            return;
          }
          const data = parsed as Record<string, unknown>;
          const key = typeof data.key === 'string' ? data.key : '';
          // Nur Zeitpunkte, die es im Mitschrieb wirklich gibt — sonst ließe
          // sich die Datei mit beliebigen Schlüsseln vollschreiben.
          const known = load().sessions.some((x) => x.startedAt === key);
          if (!known) {
            json(res, { ok: false, reason: 'unknown-session' }, 400);
            return;
          }
          const price = data.clear === true ? undefined : sanitize(data.price);
          if (data.clear !== true && price === undefined) {
            json(res, { ok: false, reason: 'bad-price' }, 400);
            return;
          }
          const ok = writePrice(o.logDir, key, price);
          json(res, ok ? { ok: true } : { ok: false, reason: 'write-failed' }, ok ? 200 : 500);
        });
        return;
      }
      if (url.pathname.startsWith('/api/sessions')) {
        json(res, load().sessions);
        return;
      }
      if (url.pathname.startsWith('/api/summary')) {
        json(res, summarize(load().sessions));
        return;
      }
      if (url.pathname.startsWith('/api/series')) {
        const { samples } = load();
        const series = aggregate(samples, gran, optionsFor(o));
        json(res, { granularity: gran, series, efficiency: efficiency(series) });
        return;
      }
      const { samples, sessions } = load();
      // Host aus dem Request, damit der Einstellungen-Link auch dann stimmt,
      // wenn das Dashboard über Hostname statt IP aufgerufen wurde.
      const host = (req.headers.host ?? '').split(':')[0] || '127.0.0.1';
      const html = renderPage(sessions, samples, gran, o, host, place, picked, () =>
        streamSamples(o.logDir),
      );
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      o.log?.(`Dashboard request failed: ${String(err)}`);
      // Nur antworten, wenn noch nichts gesendet wurde — sonst reißt der
      // Fehlerpfad den Server mit.
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Fehler: ${String(err)}`);
      } else {
        res.end();
      }
    }
  });

  server.on('error', (err) => {
    o.log?.(`Charging dashboard failed to start: ${String(err)}`);
  });
  server.listen(o.port, () => {
    // Die Warnung gehört hierher und nicht nur ins README: Der Port bindet an
    // alle Schnittstellen, und wer das Dashboard erreicht, liest die
    // Ladehistorie ohne Anmeldung. Wer das nicht will, setzt den Port auf 0.
    o.log?.(
      `Charging dashboard on port ${o.port} — reachable on all interfaces ` +
        'and NOT password-protected. Keep it off the public internet; set ' +
        'dashboardPort to 0 to disable it.',
    );
  });
  if (typeof server.unref === 'function') {
    server.unref();
  }
  return server;
}
