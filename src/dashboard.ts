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
import { aggregate, efficiency, keyOf, type Granularity } from './aggregate';
import type { ChargeLogSample } from './chargeLog';
import { ICONS } from './icons';
import type { Labels } from './i18n';
import { estimateCapacity, stateOfHealth } from './capacity';
import { readPrices, writePrice, costFrom, sanitize, type PriceStore } from './prices';
import {
  readSettings,
  writeSettings,
  sanitizeSettings,
  mergeSettings,
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

/** Liest alle Tagesdateien (gecacht); defekte Zeilen werden übersprungen. */
export function readSamples(dir: string): ChargeLogSample[] {
  const sig = signature(dir);
  if (cache && cache.dir === dir && cache.sig === sig) {
    return cache.samples;
  }
  const samples = readSamplesUncached(dir);
  cache = { sig, dir, samples };
  return samples;
}

function readSamplesUncached(dir: string): ChargeLogSample[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
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
  if (place === 'all') {
    return samples;
  }
  const want = place === 'home';
  const drop = sessions
    .filter((x) => x.atHome !== want)
    .map((x) => ({
      from: Date.parse(x.startedAt),
      to: x.endedAt ? Date.parse(x.endedAt) : Number.MAX_SAFE_INTEGER,
    }));
  if (drop.length === 0) {
    return samples;
  }
  return samples.filter((s) => {
    const t = Date.parse(s.ts);
    return !drop.some((d) => t >= d.from && t <= d.to);
  });
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
export function currentStatus(
  samples: ChargeLogSample[],
  now: number,
): {
  last?: ChargeLogSample;
  ageMinutes?: number;
  monitorOk: boolean;
} {
  const last = samples[samples.length - 1];
  if (!last) {
    return { monitorOk: false };
  }
  const ageMinutes = (now - Date.parse(last.ts)) / 60000;
  // Kulanz: das langsamste reguläre Intervall plus Puffer.
  return { last, ageMinutes, monitorOk: ageMinutes <= 45 };
}

/** Wie viele Zeiträume die jeweilige Ansicht zeigt. */
const SPAN: Record<Granularity, number> = { day: 30, week: 26, month: 24, year: 10 };

const GRAN_LABEL: Record<Granularity, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year',
};

function renderPage(
  allSessions: ChargeSession[],
  allSamples: ChargeLogSample[],
  gran: Granularity,
  o: DashboardOptions,
  host: string,
  place: Place = 'all',
  picked?: string,
): string {
  const L = o.labels;
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
  const all = aggregate(samples, gran, optionsFor(o));

  // Welcher Zeitraum ist gewählt? Ohne Angabe der jüngste. Der Schlüssel steht
  // in der Adresse, damit ein Blättern teilbar und über „zurück" bedienbar ist.
  const pickedIdx = picked ? all.findIndex((b) => b.key === picked) : -1;
  const currentIdx = pickedIdx >= 0 ? pickedIdx : all.length - 1;
  const current = all[currentIdx];
  const previous = all[currentIdx - 1];
  // Der Balken zeigt den Verlauf BIS zum gewählten Zeitraum — beim Blättern
  // wandert das Fenster mit, statt immer am heutigen Ende zu kleben.
  const series = all.slice(Math.max(0, currentIdx + 1 - SPAN[gran]), currentIdx + 1);
  const eff = efficiency(all);

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


  const barPoints: BarPoint[] = series.map((b) => ({
    label: b.label,
    value: b.kwh,
    detail:
      (hasPrice ? `${b.cost.toFixed(2)} € · ` : '') +
      (b.rangeAdded > 0 ? `+${b.rangeAdded} km` : '') +
      (b.km > 0 ? ` · ${b.km} km ${L.dashDriven.toLowerCase()}` : ''),
    current: b === current,
  }));
  const bars = barChart(barPoints, L);

  const q = (g: Granularity, p: Place, d?: string): string =>
    `?g=${g}${p === 'all' ? '' : `&p=${p}`}${d ? `&d=${encodeURIComponent(d)}` : ''}`;
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
  recent = [...inPeriod].reverse();
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
  const plugText = !st.last?.plugged
    ? esc(L.dashNotPlugged)
    : st.last.charging
      ? `${esc(L.dashCharging)}${
          st.last.powerKw !== undefined
            ? ` · ${st.last.powerKw.toFixed(1)} kW${
                st.last.rateKmMin !== undefined ? ` · ${st.last.rateKmMin.toFixed(1)} km/min` : ''
              }`
            : ''
        }${where}`
      : `${esc(L.dashPluggedWaiting)}${where}`;
  const plugClass = !st.last?.plugged ? 'off' : st.last.charging ? 'ok' : 'wait';

  // Gemessene Kapazität — die empfindlichste Größe der ganzen Auswertung.
  // Aus ALLEN Fahrten: Wo geladen wurde, ändert die Batterie nicht.
  const cap = estimateCapacity(allSamples);
  const soh = stateOfHealth(cap.capacityKwh, cfg.capacityKwh);
  // Abweichung der Messung von der eingestellten Kapazität, in Prozent.
  const capDelta =
    cap.capacityKwh !== undefined
      ? Math.round(((cap.capacityKwh - cfg.capacityKwh) / cfg.capacityKwh) * 1000) / 10
      : undefined;

  // Fahrverbrauch laut Fahrzeug — unabhängig von unserer Rechnung.
  const tripKwh100 = st.last?.tripKwh100;

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
    place === 'all' ? all : aggregate(allSamples, gran, optionsFor(o));
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
  const trustworthy = quality === undefined && eff.km > 0;

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
        )}${flag}${drop}${where}${
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
      const own = samples.filter((x) => {
        const t = Date.parse(x.ts);
        return t >= from && t <= to;
      });
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
<meta name="theme-color" content="#0b0c0e">
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
@media(prefers-color-scheme:dark){.card.save b{color:#35c77b}}
.cap{background:var(--card);border:1px solid var(--line);border-radius:12px;
 padding:14px;margin-bottom:16px;position:relative;overflow:hidden}
.cap::after{content:"";position:absolute;inset:0;pointer-events:none;
 background:radial-gradient(120% 90% at 100% 0%,rgba(10,132,255,.10),transparent 60%)}
.caphead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.caphead span{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
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

.empty{background:var(--card);border:1px solid var(--line);border-radius:12px;
 padding:26px;text-align:center;color:var(--dim)}
${CHART_CSS}${BARS_CSS}
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
}
</style></head><body>
<h1><span>${esc(o.vehicleName)}</span><em>${
  st.last
    ? `${esc(L.dashAsOf)} ${esc(
        new Date(st.last.ts).toLocaleTimeString(L.locale, { hour: '2-digit', minute: '2-digit' }),
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
    <div class="socbar"><i style="width:${st.last?.soc ?? 0}%"></i></div>
    <b>${st.last?.soc !== undefined ? `${st.last.soc} %` : '—'}</b>
    <span>${st.last?.rangeKm !== undefined ? `${st.last.rangeKm} km` : ''}${
      st.last?.minSoc !== undefined ? ` · ${esc(L.dashInstantTo)} ${st.last.minSoc} %` : ''
    }${st.last?.targetSoc !== undefined ? ` · ${esc(L.dashTarget)} ${st.last.targetSoc} %` : ''}</span>
  </div>
  <div class="pills">
    <span class="pill ${plugClass}">${plugText}</span>
    <span class="pill ${st.monitorOk ? 'ok' : 'bad'}">${
      st.monitorOk
        ? `${esc(L.dashMonitorOk)}${
            st.ageMinutes !== undefined
              ? ` · ${esc(L.dashMonitorAge.replace('%s', `${Math.round(st.ageMinutes)} min`))}`
              : ''
          }`
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
          <span>${esc(L.dashMeasuredCapacity)}</span>
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
        <div class="capfoot">${esc(L.dashConfigured)} ${cfg.capacityKwh} kWh${
          capDelta !== undefined
            ? ` · ${esc(L.dashMeasurement)} ${capDelta > 0 ? '+' : ''}${capDelta.toFixed(1)} %`
            : ''
        }${cap.spreadKwh !== undefined ? ` · ${esc(L.dashSpread)} ±${(cap.spreadKwh / 2).toFixed(1)} kWh` : ''}</div>
      </div>`
    : ''
}
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
      current && current.costGross > current.cost
        ? `${esc(L.dashInsteadOf)} <s>${current.costGross.toFixed(2)} €</s>`
        : `${(o.pricePerKwh * 100).toFixed(2)} ct/kWh`
    }${eff.centPerKm !== undefined ? ` · ${eff.centPerKm.toFixed(1)} ct/km` : ''}</span></div>`
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
  ${
    hasBonus
      ? `<div class="card save"><span>${esc(L.dashSaved)}</span>
    <b>${current ? current.saved.toFixed(2) : '0.00'} €</b>
    <span>${cfg.bonusCt.toFixed(2)} ct/kWh ${esc(L.dashBonus)}${
      current && eff.saved > current.saved + 0.005 ? ` · ${esc(L.dashTotal)} ${eff.saved.toFixed(2)} €` : ''
    }</span></div>`
      : `<div class="card"><span>${esc(L.dashDriven)}</span><b>${eff.km.toLocaleString(L.locale)} km</b>
         <span></span></div>`
  }
  <div class="card"><span>${esc(L.dashChargedRange)}</span>
    <b>${current ? current.rangeAdded.toLocaleString(L.locale) : '0'} km</b>
    <span>${esc(L.dashRange)}${
      current && current.kwh > 0 && current.rangeAdded > 0
        ? ` · ${(current.rangeAdded / current.kwh).toFixed(1)} km/kWh`
        : ''
    }</span></div>
  <div class="card"><span>${esc(L.dashConsumption)}</span>
    <b>${tripKwh100 !== undefined ? tripKwh100.toFixed(1) : eff.kwhPer100km !== undefined ? eff.kwhPer100km.toFixed(1) : '—'}</b>
    <span>kWh/100 km ${esc(tripKwh100 !== undefined ? L.dashPerVehicle : L.dashCalculated)}${
      trustworthy && tripKwh100 !== undefined && eff.kwhPer100km !== undefined
        ? ` · ${esc(L.dashPaid)} ${eff.kwhPer100km.toFixed(1)}`
        : ''
    }</span></div>

  <div class="card"><span>${esc(L.dashCharges)}</span><b>${inPeriod.length}</b>
    <span>${
      inPeriod.length > 0
        ? `Ø ${avgPerCharge.toFixed(1)} kWh`
        : esc(L.dashNone)
    }</span></div>
</div>
${running ? `<div class="card" style="margin-bottom:16px"><span>${esc(L.dashRunning)}</span><b>${
    running.startSoc !== undefined ? `${esc(L.dashFrom)} ${running.startSoc} %` : esc(L.dashActive)
  }</b><span>${esc(L.dashSince)} ${esc(fmtDate(running.startedAt, L.locale))}</span></div>` : ''}
${
  quality
    ? `<div class="quality ${quality.level}">${esc(quality.text)}</div>`
    : ''
}
${series.length ? `<div class="chart">${bars}</div>` : ''}
${
  recent.length
    ? `<div class="tablewrap"><table><thead><tr><th>${esc(L.dashStart)}</th><th>${esc(L.dashDuration)}</th><th>${esc(L.dashChargeState)}</th>
       <th class="num">${esc(L.dashEnergy)}</th><th class="num">${
         hasPrice ? esc(L.dashCost) : ''
       }</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="empty">${esc(L.dashNoCharges)}<br>${esc(L.dashNoChargesHint)}</div>`
}
<script>
// Aktualisiert sich still im Hintergrund: alle 60 s, aber nur wenn die Seite
// sichtbar ist — im Homescreen-Modus liegt sie sonst tagelang offen und würde
// den Pi ohne Grund abfragen. Beim Zurückwechseln sofort neu laden, damit man
// nie veraltete Zahlen sieht.
(function(){
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
  var rf=document.getElementById('rf');
  if(rf) rf.addEventListener('click',function(){
    // Als Symbol gibt es keinen Text mehr für Rückmeldungen — deshalb dreht
    // es sich während des Abrufs, und die Sperre wird im Titel erklärt.
    rf.disabled=true; rf.classList.add('busy');
    var back=function(ms){ setTimeout(function(){
      rf.classList.remove('busy'); rf.disabled=false; rf.title=${JSON.stringify(L.dashRefresh)};
    }, ms); };
    fetch('/api/refresh',{method:'POST'}).then(function(r){return r.json();}).then(function(j){
      if(j.ok){ location.reload(); return; }
      rf.classList.remove('busy');
      rf.title = j.reason==='cooldown'
        ? ${JSON.stringify(L.dashWaitSeconds)}.replace('%n', String(Math.ceil((j.retryInMs||0)/1000)))
        : ${JSON.stringify(L.dashRefreshFailed)};
      back(j.reason==='cooldown' ? (j.retryInMs||3000) : 3000);
    }).catch(function(){
      rf.classList.remove('busy'); rf.title=${JSON.stringify(L.dashRefreshFailed)}; back(3000);
    });
  });
  var t=setInterval(function(){ if(!document.hidden) location.reload(); },60000);
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
const BASE_CSS = `
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
function renderStatus(o: DashboardOptions, samples: ChargeLogSample[], host: string): string {
  const L = o.labels;
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
    const min = (Date.now() - Date.parse(iso)) / 60000;
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
          ? `${L.stPerWeek.replace('%n', perWeek)} ${L.stYearsLeft.replace(
              '%n',
              String(Math.floor(daysLeft / 365)),
            )}`
          : `${L.stPerWeek.replace('%n', perWeek)} ${L.stAbout} ${when.toLocaleDateString(
              L.locale,
              { month: 'long', year: 'numeric' },
            )}`;
    }
  }

  const card = (label: string, value: string, sub = '', alert = false): string =>
    `<div class="card${alert ? ' alert' : ''}"><span>${esc(label)}</span><b>${value}</b>${
      sub ? `<span>${sub}</span>` : ''
    }</div>`;

  return `<!doctype html>
<html lang="${esc(L.locale)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
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
</style></head><body>
<h1><span>${esc(o.vehicleName)}</span><em><a class="back" href="/">‹ ${esc(L.stBackToCharging)}</a></em></h1>
${
  tyre
    ? `<h2>${esc(L.stTyrePressure)} · ${esc(ago(tyre.at))}</h2><div class="wheels">${tyreRows}</div>`
    : `<div class="empty">${esc(L.stNoTyreData)}</div>`
}
<h2>${esc(L.stVehicle)}</h2>
<div class="grid">
  ${
    service
      ? card(L.stNextService, `${service.value.toLocaleString(L.locale)}<i>km</i>`, serviceEta)
      : ''
  }
  ${odoNow ? card(L.stOdometer, `${odoNow.value.toLocaleString(L.locale)}<i>km</i>`) : ''}
  ${weekKm !== undefined ? card(L.stLast7Days, `${weekKm}<i>km</i>`) : ''}
  ${st.last?.soc !== undefined ? card(L.stChargeLevel, `${st.last.soc}<i>%</i>`,
      st.last.rangeKm !== undefined ? `${st.last.rangeKm} ${esc(L.stRangeSuffix)}` : '') : ''}
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
 * Justins Vorgabe, und sie ist richtig: Bei wenigen Zyklen schwankt die
 * Schätzung noch deutlich. Ein Knopf, der einen vorläufigen Wert in die
 * Konfiguration schreibt, würde die Vorläufigkeit verstecken — und weil die
 * Kapazität rückwirkend jede kWh-Zahl verändert, wäre das teuer.
 */
const ADOPT_MIN_CYCLES = 10;

function renderSettings(
  o: DashboardOptions,
  host: string,
  measured?: number,
  cycles = 0,
  uncertainty?: number,
): string {
  const L = o.labels;
  const { values, source, stored } = effective(o);
  const field = (
    key: keyof DashboardSettings,
    label: string,
    hint: string,
    step: string,
  ): string => {
    const own = stored[key];
    const from = source[key as keyof typeof source];
    return `<div class="srow">
      <label for="f-${key}">${esc(label)}</label>
      <input id="f-${key}" name="${key}" type="text" inputmode="decimal" step="${step}"
             value="${own !== undefined ? String(own) : ''}"
             placeholder="${values[key as keyof typeof values]}">
      <small>${esc(hint)}<br><i>${
        from === 'dashboard'
          ? `${L.setFromDashboard}: ${values[key as keyof typeof values]}`
          : `${L.setFromPlugin}: ${values[key as keyof typeof values]}`
      }</i></small>
    </div>`;
  };

  return `<!doctype html>
<html lang="${esc(L.locale)}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${esc(o.vehicleName)} — ${esc(L.setTitle)}</title>
<style>${BASE_CSS}
.srow{display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:center;
 padding:12px 0;border-bottom:1px solid var(--line)}
.srow:last-of-type{border-bottom:0}
.srow label{font-size:15px}
.srow input{width:112px;min-height:38px;padding:6px 9px;border-radius:9px;text-align:right;
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
    f.querySelectorAll('input').forEach(function(i){ body[i.name]=i.value.trim(); });
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
export function startDashboard(o: DashboardOptions): http.Server | undefined {
  if (!o.port) {
    return undefined;
  }
  const load = (): { samples: ChargeLogSample[]; sessions: ChargeSession[] } => {
    const samples = readSamples(o.logDir);
    return {
      samples,
      sessions: applyExternalPrices(
        buildSessions(samples, optionsFor(o)),
        readPrices(o.logDir),
        effective(o).values.externalPriceCt,
      ),
    };
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
      const gran: Granularity =
        g === 'day' || g === 'week' || g === 'year' ? g : 'month';
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
        );
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }
      if (url.pathname === '/settings') {
        const est = estimateCapacity(readSamples(o.logDir));
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
          const ok = writeSettings(o.logDir, next);
          json(res, ok ? { ok: true } : { ok: false, reason: 'write-failed' }, ok ? 200 : 500);
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
      const html = renderPage(sessions, samples, gran, o, host, place, picked);
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
