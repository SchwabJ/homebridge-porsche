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
import { chargeCurve, barChart, CHART_CSS, BARS_CSS, type BarPoint } from './chart';

export interface DashboardOptions {
  port: number;
  logDir: string;
  capacityKwh: number;
  /** Effektiver Arbeitspreis in EUR/kWh (Grundpreis abzüglich Bonus). */
  pricePerKwh: number;
  /** Nur für die Anzeige: Grundpreis und Bonus in Cent. */
  priceCt: number;
  bonusCt: number;
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
export function optionsFor(o: DashboardOptions): {
  capacityKwh: number;
  pricePerKwh: number;
  grossPricePerKwh: number;
  dayBoundaryHour: number;
  labels: Labels;
} {
  return {
    capacityKwh: o.capacityKwh,
    pricePerKwh: o.pricePerKwh,
    grossPricePerKwh: o.priceCt / 100,
    dayBoundaryHour: o.dayBoundaryHour,
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
  sessions: ChargeSession[],
  samples: ChargeLogSample[],
  gran: Granularity,
  o: DashboardOptions,
  host: string,
): string {
  const L = o.labels;
  const recent = [...sessions].reverse();
  const running = sessions.find((s) => !s.complete);

  // Zeitreihe aus den Rohdaten — nur so verteilt sich eine Nachtladung korrekt
  // auf beide Tage, statt komplett dem Startzeitpunkt zugeschlagen zu werden.
  const all = aggregate(samples, gran, optionsFor(o));
  const series = all.slice(-SPAN[gran]);
  const current = series[series.length - 1];
  const previous = series[series.length - 2];
  const eff = efficiency(all);

  // Ohne konfigurierten Arbeitspreis werden keine Kosten gezeigt: 0,00 € wäre
  // eine Behauptung, keine Information.
  const hasPrice = o.priceCt > 0;
  const hasBonus = hasPrice && o.bonusCt > 0;


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

  const tabs = (['day', 'week', 'month', 'year'] as Granularity[])
    .map(
      (g) =>
        `<a href="?g=${g}"${g === gran ? ' class="on"' : ''}>${GRAN_LABEL[g]}</a>`,
    )
    .join('');

  // Ladungen im angezeigten Zeitraum. Zugeordnet wird nach Startzeitpunkt —
  // eine Ladung IST ein Ereignis mit einem Beginn, anders als die Energie,
  // die sich über die Zeit verteilt.
  // Eine Ladung zählt zu JEDEM Zeitraum, in den sie hineinreicht — nicht nur
  // zu dem ihres Starts. Sonst zeigt ein Tag „Energie geladen, 0 Ladungen",
  // weil die Nachtladung schon am Vorabend begann.
  const inPeriod = current
    ? sessions.filter((x) => {
        const shift = o.dayBoundaryHour * 3600000;
        const from = keyOf(new Date(Date.parse(x.startedAt) - shift), gran);
        const to = keyOf(
          new Date((x.endedAt ? Date.parse(x.endedAt) : Date.now()) - shift),
          gran,
        );
        return current.key >= from && current.key <= to;
      })
    : [];
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
  const cap = estimateCapacity(samples);
  const soh = stateOfHealth(cap.capacityKwh, o.capacityKwh);
  // Abweichung der Messung von der eingestellten Kapazität, in Prozent.
  const capDelta =
    cap.capacityKwh !== undefined
      ? Math.round(((cap.capacityKwh - o.capacityKwh) / o.capacityKwh) * 1000) / 10
      : undefined;

  // Fahrverbrauch laut Fahrzeug — unabhängig von unserer Rechnung.
  const tripKwh100 = st.last?.tripKwh100;

  // Datenqualität des angezeigten Zeitraums. Ohne dieses Maß sähe eine
  // Auswertung aus sechs Messpunkten genauso vertrauenswürdig aus wie eine
  // aus sechshundert — und der Vergleich beider Verbrauchswerte wäre wertlos.
  let quality: { level: string; text: string } | undefined;
  if (current) {
    const covered = current.spanMinutes + current.gapMinutes;
    const pct = covered > 0 ? Math.round((current.spanMinutes / covered) * 100) : 0;
    const gapH = current.gapMinutes / 60;
    if (current.samples < 5) {
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
      const cost = !hasPrice
        ? ''
        : noEnergy
          ? '—'
          : `${(s.costEur as number).toFixed(2)} €` +
            (s.savedEur ? `<small>−${s.savedEur.toFixed(2)} € ${esc(L.dashBonus)}</small>` : '');
      const flag = s.complete ? '' : ` <span class="tag">${esc(L.dashRunning)}</span>`;
      const drop = s.socDropped ? ` <span class="tag warn">${esc(L.dashSocDropped)}</span>` : '';

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
        )}${flag}${drop}${
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
      // Ohne Kurve (zu wenige Messpunkte) gäbe es keinen Schalter für die
      // zweite Ebene — dann rücken die Phasen auf die erste.
      const lvl2 = curve ? 'lvl2' : 'lvl1';
      const curveRow = curve
        ? `<tr class="phase curve lvl1 p${idx}${open ? '' : ' hidden'}">
            <td colspan="5">${curve}<button class="more" type="button" data-i="${idx}">${
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
<nav class="tabs">${tabs}</nav>
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
      : `<div class="card"><span>${esc(L.dashChargeTime)}</span><b>${
          current ? Math.round(current.spanMinutes / 60) : 0
        } h</b><span>${esc(L.dashRecorded)}</span></div>`
  }
  ${
    hasBonus
      ? `<div class="card save"><span>${esc(L.dashSaved)}</span>
    <b>${current ? current.saved.toFixed(2) : '0.00'} €</b>
    <span>${o.bonusCt.toFixed(2)} ct/kWh ${esc(L.dashBonus)}${
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
  cap.capacityKwh !== undefined
    ? `<div class="cap">
        <div class="caphead">
          <span>${esc(L.dashMeasuredCapacity)}</span>
          <em>${cap.samples} ${esc(L.dashTrips)} · ${cap.km} km</em>
        </div>
        <div class="capmain">
          <b>${cap.capacityKwh.toFixed(1)}<i>kWh</i></b>
          ${soh !== undefined ? `<span class="soh">${soh.toFixed(0)} % ${esc(L.dashHealth)}</span>` : ''}
        </div>
        <div class="capbar">
          <i style="width:${Math.max(0, Math.min(100, soh ?? 0))}%"></i>
          ${
            cap.spreadKwh !== undefined
              ? `<u style="left:${Math.max(0, Math.min(96, (soh ?? 0) - 2))}%;width:${Math.min(
                  20,
                  (cap.spreadKwh / o.capacityKwh) * 100,
                )}%"></u>`
              : ''
          }
        </div>
        <div class="capfoot">${esc(L.dashConfigured)} ${o.capacityKwh} kWh${
          capDelta !== undefined
            ? ` · ${esc(L.dashMeasurement)} ${capDelta > 0 ? '+' : ''}${capDelta.toFixed(1)} %`
            : ''
        }${cap.spreadKwh !== undefined ? ` · ${esc(L.dashSpread)} ±${(cap.spreadKwh / 2).toFixed(1)} kWh` : ''}</div>
      </div>`
    : ''
}
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
      sessions: buildSessions(samples, optionsFor(o)),
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
      const html = renderPage(sessions, samples, gran, o, host);
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
