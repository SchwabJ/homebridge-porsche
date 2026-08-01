/**
 * SVG-Diagramme für das Dashboard.
 *
 * Bewusst serverseitig gerendertes SVG statt einer Diagramm-Bibliothek: Die
 * Seite soll eine einzige Datei ohne externe Abhängigkeiten bleiben, und ein
 * Ladeverlauf mit ein paar hundert Punkten braucht kein Framework.
 *
 * Gestaltungsregeln, die hier durchgehalten werden:
 * - EINE Achse je Diagramm. Ladestand (%) und Leistung (kW) haben verschiedene
 *   Skalen und werden deshalb NICHT übereinandergelegt — die Ladephasen
 *   erscheinen stattdessen als Bänder hinter der Ladestandskurve.
 * - Dünne Marken, 2px Linien, Datenenden mit 4px Radius.
 * - Raster und Achsen treten zurück; die Daten führen.
 * - Hover-Ebene gehört dazu, nicht als Zusatz.
 */

import type { ChargeLogSample } from './chargeLog';
import type { ChargePhase } from './sessions';
import type { Labels } from './i18n';

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const fmtClock = (iso: string, locale: string): string =>
  new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

/**
 * Ladeverlauf einer Session: Ladestand über der Zeit, Ladephasen als Bänder.
 *
 * Gibt einen leeren String zurück, wenn zu wenige Punkte vorliegen — ein
 * Diagramm aus zwei Messwerten führt mehr in die Irre, als es zeigt.
 */
export function chargeCurve(
  samples: ChargeLogSample[],
  phases: ChargePhase[],
  opts: { targetSoc?: number; minSoc?: number; labels: Labels },
): string {
  // Zeitfenster: vom Anstecken bis zum Erreichen des Ladeziels.
  //
  // Nicht bis zum Ausstecken: Nach erreichtem Ziel hängt das Fahrzeug oft noch
  // Stunden am Kabel, ohne dass etwas passiert. Über die gesamte Kabelzeit
  // gerechnet quetscht sich der eigentliche Ladevorgang auf ein Fünftel der
  // Breite, der Rest ist eine waagerechte Linie.
  const all = samples
    .filter((s) => s.soc !== undefined)
    .map((s) => ({ t: Date.parse(s.ts), soc: s.soc as number, kw: s.powerKw }));
  if (all.length < 3) {
    return '';
  }

  const goal = opts.targetSoc ?? opts.minSoc;
  // Erster Messpunkt, der das Ziel erreicht — das ist das Ende des Vorgangs.
  const reached = goal !== undefined ? all.find((p) => p.soc >= goal) : undefined;
  const lastPhaseEnd =
    phases.length > 0 ? Date.parse(phases[phases.length - 1].endedAt) : undefined;
  const end = reached?.t ?? lastPhaseEnd ?? all[all.length - 1].t;
  // Etwas Rand, damit die Linie nicht am Bildrand klebt.
  const pad = Math.max(3 * 60000, (end - all[0].t) * 0.04);

  const roh = all.filter((p) => p.t <= end + pad);
  if (roh.length < 3) {
    return '';
  }

  // Punktdichte deckeln.
  //
  // Eine Nachtladung im Drei-Minuten-Takt liefert an die zweihundert
  // Messpunkte. Bei 720 px Diagrammbreite ist das ein Punkt alle vier Pixel
  // — feiner, als ein Bildschirm zeigen kann, aber jeder wandert doppelt ins
  // HTML: einmal in den Pfad, einmal ins Datenattribut fürs Crosshair.
  // Gemessen an einem Jahr Mitschrieb machte das 121 kB allein an Rohdaten
  // auf einer Seite von 360 kB.
  //
  // Gleichmäßig ausgedünnt, Anfang und Ende bleiben exakt: Eine Ladekurve
  // ist glatt, und eine Auflösung von rund zehn Minuten je Punkt zeigt jede
  // Ladepause, die es zu sehen gibt.
  const MAX_POINTS = 80;
  const pts =
    roh.length <= MAX_POINTS
      ? roh
      : (() => {
          const schritt = (roh.length - 1) / (MAX_POINTS - 1);
          const out: typeof roh = [];
          for (let i = 0; i < MAX_POINTS - 1; i++) {
            out.push(roh[Math.round(i * schritt)]);
          }
          out.push(roh[roh.length - 1]);
          return out;
        })();

  const W = 720;
  const H = 170;
  const PAD = { l: 34, r: 12, t: 14, b: 16 };
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const span = Math.max(1, t1 - t0);

  // Y-Achse FEST von 0 bis 100 %.
  //
  // Eine mitwandernde Skala lässt jede Ladung gleich steil aussehen: 56→80 %
  // und 5→100 % wären optisch identisch. Mit fester Skala ist auf einen Blick
  // erkennbar, wie viel eine Ladung wirklich gebracht hat — und die
  // Zielmarken sitzen immer an derselben Stelle.
  const lo = 0;
  const hi = 100;
  const yspan = 100;

  const x = (t: number): number => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r);
  const y = (soc: number): number => PAD.t + (1 - (soc - lo) / yspan) * (H - PAD.t - PAD.b);

  // Ladephasen als Bänder hinter der Kurve — sie beantworten „wann floss Strom".
  const bands = phases
    .map((p) => {
      const bx = x(Date.parse(p.startedAt));
      const bw = Math.max(2, x(Date.parse(p.endedAt)) - bx);
      return `<rect class="band" x="${bx.toFixed(1)}" y="${PAD.t}" width="${bw.toFixed(1)}" height="${
        H - PAD.t - PAD.b
      }" rx="3"/>`;
    })
    .join('');

  // Zielmarken als gestrichelte Hilfslinien.
  const markLine = (v: number, label: string): string =>
    `<line class="mark" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(
      1,
    )}"/><text class="ax mk" x="${PAD.l + 4}" y="${(y(v) - 4).toFixed(1)}">${esc(label)}</text>`;
  // Fallen Sofortgrenze und Ziel zusammen, gilt „Ziel".
  //
  // „Sofort" beschreibt, WIE geladen wird — ohne auf ein günstiges
  // Tarif-Fenster zu warten. Die Frage an einer Ladekurve ist aber, WOHIN
  // sie läuft. Bei minSoc === targetSoc stand vorher nur „80 % sofort" da,
  // und das Ladeziel, das die Kurve tatsächlich begrenzt, fehlte ganz.
  const gleich = opts.minSoc !== undefined && opts.minSoc === opts.targetSoc;
  const imBild = (v: number | undefined): v is number =>
    v !== undefined && v >= lo && v <= hi;
  const marks = [
    !gleich && imBild(opts.minSoc)
      ? markLine(opts.minSoc, `${opts.minSoc}% ${opts.labels.chartInstantTo}`)
      : '',
    imBild(opts.targetSoc)
      ? markLine(opts.targetSoc, `${opts.targetSoc}% ${opts.labels.chartTargetMark}`)
      : '',
  ].join('');

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.soc).toFixed(1)}`).join('');

  /**
   * Die Ladeleistung als zweite Linie, mit eigener Skala.
   *
   * An einer Ladekurve ist sie die zweite Hälfte der Auskunft: Bei
   * Wechselstrom läuft sie flach, an einer Schnellladesäule fällt sie mit
   * steigendem Ladestand ab — und genau dieser Abfall ist das, was man sehen
   * will. Bisher stand die Leistung nur im Crosshair-Text beim Überfahren,
   * also nirgends für den, der die Kurve bloß ansieht.
   *
   * Eigene Skala auf den Höchstwert dieser Ladung, nicht auf eine feste
   * Obergrenze: Eine 11-kW-Wallbox neben einer 270-kW-Skala ergäbe eine
   * Linie, die am Boden klebt. Der Höchstwert steht als Beschriftung dabei,
   * sonst wäre die Linie ohne Bezugsgröße nur Dekoration.
   *
   * Gezeichnet wird nur, wo Messwerte sind. Ältere Ladungen tragen keine
   * Leistung, und eine Linie auf null wäre eine Behauptung statt einer
   * Messung.
   */
  const kwPts = pts.filter((p): p is typeof p & { kw: number } => p.kw !== undefined && p.kw > 0);
  const kwMax = kwPts.reduce((m, p) => Math.max(m, p.kw), 0);
  const kwLine =
    kwPts.length >= 2 && kwMax > 0
      ? `<path class="kw" d="${kwPts
          .map(
            (p, i) =>
              `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${(
                PAD.t +
                (1 - p.kw / kwMax) * (H - PAD.t - PAD.b)
              ).toFixed(1)}`,
          )
          .join('')}"/><text class="ax kwax" x="${W - PAD.r - 2}" y="${(PAD.t + 9).toFixed(
          1,
        )}">${kwMax % 1 === 0 || kwMax >= 100 ? kwMax.toFixed(0) : kwMax.toFixed(1)} kW</text>`
      : '';
  const area =
    `M${x(pts[0].t).toFixed(1)},${(H - PAD.b).toFixed(1)}` +
    pts.map((p) => `L${x(p.t).toFixed(1)},${y(p.soc).toFixed(1)}`).join('') +
    `L${x(pts[pts.length - 1].t).toFixed(1)},${(H - PAD.b).toFixed(1)}Z`;

  // Achsenbeschriftung: nur Anfang, Ende und die beiden Extremwerte — mehr
  // Zahlen würden die Kurve nur zustellen.
  // Nur die Y-Beschriftung bleibt im SVG. Die Zeiten stehen als HTML
  // darunter: Das SVG wird in der Breite gestreckt, was Text verzerrt und
  // abschneidet — aus „10:21" wurde dabei eine „1".
  // Nur 0 / 50 / 100 beschriften — mehr Zahlen stellen die Kurve zu.
  const axis =
    [100, 50, 0]
      .map(
        (v) =>
          `<line class="gl" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(1)}" y2="${y(
            v,
          ).toFixed(1)}"/><text class="ax" x="4" y="${(y(v) + 4).toFixed(1)}">${v}%</text>`,
      )
      .join('');

  // Crosshair statt nativer Tooltips: eine senkrechte Linie, ein Punkt und ein
  // Wertelabel folgen dem Zeiger — wie in der Wetter-App von iOS. Die
  // Messpunkte reisen als Datenattribut mit, damit das Skript ohne zweite
  // Abfrage rechnen kann.
  const data = pts
    .map(
      (p) =>
        `${x(p.t).toFixed(1)},${y(p.soc).toFixed(1)},${p.soc},${
          p.kw !== undefined ? p.kw.toFixed(1) : ''
        },${fmtClock(new Date(p.t).toISOString(), opts.labels.locale)}`,
    )
    .join(';');

  const hover = `<g class="cross" aria-hidden="true">
    <line class="cl" y1="${PAD.t}" y2="${H - PAD.b}"/>
    <circle class="cd" r="4"/>
  </g>`;

  // Zeitachse als HTML unter dem Diagramm, nicht als SVG-Text: Das SVG wird
  // in der Breite gestreckt, und gestreckter Text verzerrt und schneidet ab.
  // Nur Anfang, Dauer und Ende — sie sagen, wie lange die Kurve überhaupt
  // dauert, und mehr Zahlen stellen sie zu.
  const uhr = (t: number): string =>
    new Date(t).toLocaleTimeString(opts.labels.locale, { hour: '2-digit', minute: '2-digit' });
  const dauerMin = Math.round((t1 - t0) / 60000);
  const dauer =
    dauerMin >= 60
      ? `${Math.floor(dauerMin / 60)} h ${dauerMin % 60} min`
      : `${dauerMin} min`;

  return `<div class="curvewrap" data-pts="${esc(data)}" data-w="${W}" data-h="${H}">
<div class="curvetip" hidden><b></b><span></span></div>
<svg class="curve" viewBox="0 0 ${W} ${H}" role="img"
   aria-label="${esc(opts.labels.chartCurveAria)}">
  <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="var(--accent)" stop-opacity=".28"/>
    <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
  </linearGradient></defs>
  ${bands}${marks}
  <path class="fill" d="${area}"/>
  <path class="ln" d="${line}"/>
  ${kwLine}
  ${axis}${hover}
</svg>
<div class="curvetime"><span>${esc(uhr(t0))}</span><em>${esc(dauer)}</em><span>${esc(
    uhr(t1),
  )}</span></div>
</div>`;
}

/** CSS des Ladeverlaufs — einmal pro Seite eingebunden. */
export const CHART_CSS = `
/* height:auto, NICHT eine feste Höhe: Ohne preserveAspectRatio="none" passt
   der Browser das SVG in die Box ein (xMidYMid meet). Eine feste Höhe, die
   nicht zum Seitenverhältnis passt, zentriert das Diagramm dann mit Leerraum
   darüber und darunter. */
.curve{width:100%;height:auto;display:block;margin:2px 0 4px;overflow:visible}
.curve .band{fill:var(--accent);opacity:.10}
.curve .gl{stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke}
.curve .mark{stroke:var(--dim);stroke-width:1;stroke-dasharray:3 3;opacity:.45}
.curve .fill{fill:url(#cg)}
.curve .ln{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;
 stroke-linecap:round;vector-effect:non-scaling-stroke}
/* Die Leistung: dünner und in Orange, damit sie den Ladestand nicht
   überstimmt. Der ist die Hauptaussage der Kurve, die Leistung erklärt ihn —
   deshalb gestrichelt und ohne Fläche. */
.curve .kw{fill:none;stroke:#e08a2e;stroke-width:1.4;stroke-dasharray:4 3;
 stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke;opacity:.9}
.curve .ax{fill:var(--dim);font-size:10px}
.curve .ax.kwax{fill:#e08a2e;text-anchor:end;font-size:9.5px}
@media(prefers-color-scheme:dark){.curve .kw{stroke:#f0a44e}.curve .ax.kwax{fill:#f0a44e}}
.curve .ax.mk{font-size:9.5px;opacity:.85}
.curvewrap{position:relative;touch-action:pan-y}
.curvetime{display:flex;justify-content:space-between;align-items:baseline;
 margin:-2px 2px 6px;color:var(--dim);font-size:11.5px}
.curvetime em{font-style:normal;opacity:.8}
.curve .cross{opacity:0;transition:opacity .12s}
.curvewrap.on .cross{opacity:1}
.curve .cl{stroke:var(--dim);stroke-width:1;stroke-dasharray:2 2;
 vector-effect:non-scaling-stroke}
.curve .cd{fill:var(--accent);stroke:var(--card);stroke-width:2;
 vector-effect:non-scaling-stroke}
/* Label folgt dem Zeiger; -translate hält es über dem Punkt und innerhalb
   des Diagramms, damit es am Rand nicht abgeschnitten wird. */
.curvetip{position:absolute;top:2px;transform:translateX(-50%);pointer-events:none;
 background:var(--fg);color:var(--bg);border-radius:8px;padding:4px 9px;
 font-size:12px;font-weight:600;white-space:nowrap;z-index:2;
 box-shadow:0 2px 10px rgba(0,0,0,.25)}
.curvetip span{font-weight:400;opacity:.7;margin-left:6px}
.curvetip[hidden]{display:none}
`;

export interface BarPoint {
  label: string;
  value: number;
  /**
   * Gegenwert, der NACH UNTEN aufgetragen wird — die verbrauchte Energie.
   *
   * Dieselbe Einheit und dieselbe Skala wie {@link BarPoint.value}: Nur dann
   * sind die beiden Flächen vergleichbar, und genau darum geht es. Zwei
   * getrennte Achsen würden aus jedem Verhältnis ein beliebiges machen.
   */
  down?: number;
  /** Zusatzzeile für den Tooltip. */
  detail?: string;
  /** Zusatzzeile für den Tooltip des Gegenbalkens. */
  downDetail?: string;
  /**
   * Ziel für den Drilldown — der Unterzeitraum dieses Balkens.
   *
   * Ohne ihn ist der Balken reine Grafik: Der Sprung in einen alten Zeitraum
   * kostet dann viele Einzelschritte, obwohl die Adresse ihn längst kennt.
   */
  href?: string;
  /** Hebt den laufenden Zeitraum hervor. */
  current?: boolean;
}

/**
 * Balkendiagramm der Energie je Zeitraum — geladen nach oben, verbraucht nach
 * unten.
 *
 * Ersetzt eine Flexbox-Lösung, bei der zwei Datenpunkte zu zwei bildschirm-
 * breiten Blöcken wurden. Hier haben Balken eine Höchstbreite und sitzen
 * linksbündig auf einer Achse — zwei Tage sehen dann aus wie zwei Tage und
 * nicht wie ein kaputtes Diagramm.
 *
 * ## Warum die Gegenrichtung und nicht zwei Balken nebeneinander
 *
 * Laden und Fahren sind dieselbe Größe in entgegengesetzter Richtung. An einer
 * gemeinsamen Nulllinie liest man die Bilanz ohne zu rechnen: Ragt unten mehr
 * heraus als oben, ist mehr gefahren als geladen worden. Zwei Balken
 * nebeneinander würden bei vielen Zeiträumen zu Streifen, und eine Linie über
 * den Balken macht die Flächen nicht vergleichbar.
 *
 * **Beide Richtungen teilen zwingend dieselbe Skala.** Eine eigene Achse je
 * Richtung würde aus jedem Verhältnis ein beliebiges machen — das Bild sähe
 * dann aus wie eine Aussage, wäre aber eine Willkür.
 */
export function barChart(points: BarPoint[], L: Labels, unit = 'kWh'): string {
  if (points.length === 0) {
    return '';
  }
  const hasDown = points.some((p) => (p.down ?? 0) > 0);
  const W = 640;
  // Mit Gegenbalken braucht das Bild mehr Höhe: Sonst schrumpfen beide
  // Richtungen auf die Hälfte und aus dem Diagramm wird ein Streifenmuster.
  const H = hasDown ? 176 : 132;
  const PAD = { l: 34, r: 8, t: 10, b: 22 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  const maxUp = Math.max(...points.map((p) => p.value));
  const maxDown = Math.max(0, ...points.map((p) => p.down ?? 0));
  // Auf eine runde Zahl aufrunden, damit die Achse lesbar bleibt — beide
  // Richtungen mit DEMSELBEN Schritt, sonst wäre die Skala nicht dieselbe.
  const m = Math.max(maxUp, maxDown);
  const step = m <= 5 ? 1 : m <= 25 ? 5 : m <= 60 ? 10 : m <= 150 ? 25 : 50;
  const topUp = Math.max(step, Math.ceil(maxUp / step) * step);
  const topDown = hasDown ? Math.max(step, Math.ceil(maxDown / step) * step) : 0;

  // Die Fläche teilt sich im Verhältnis der beiden Maxima auf. Damit ist die
  // Strecke je kWh oben und unten GLEICH — eine feste Aufteilung (etwa halbe
  // halbe) würde bei ungleichen Maxima zwei verschiedene Maßstäbe ergeben und
  // aus jedem Verhältnis ein beliebiges machen.
  const upH = (plotH * topUp) / (topUp + topDown);
  const downH = plotH - upH;
  const zeroY = PAD.t + upH;

  const slot = plotW / points.length;
  // Höchstbreite verhindert die „zwei Riesenblöcke"-Optik bei wenig Daten.
  const bw = Math.min(38, Math.max(3, slot - 2));

  /** Pixel je Einheit — für BEIDE Richtungen derselbe Wert. */
  const scale = upH / topUp;
  const y = (v: number): number => zeroY - v * scale;

  // Gitter: die Nulllinie immer, darüber Mitte und Spitze, darunter die
  // Spitze des Gegenbereichs. Die Beschriftung unten trägt kein Minus — es
  // ist ein Betrag in der anderen Richtung, keine negative Energie.
  // Die untere Beschriftung trägt KEIN Minuszeichen — es ist ein Betrag in der
  // anderen Richtung, keine negative Energie. Ohne weitere Kennzeichnung stand
  // damit aber zweimal dieselbe Zahl an der Achse („30 · 15 · 0 · 30"), und
  // die war nicht mehr lesbar. Deshalb trägt sie die FARBE des Gegenbalkens:
  // Sie sagt, wohin der Wert gehört, ohne ein falsches Vorzeichen zu behaupten.
  const gridLine = (v: number, zero = false): string => {
    const unten = v < 0;
    return `<line class="${zero ? 'zl' : 'gl'}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v).toFixed(
      1,
    )}" y2="${y(v).toFixed(1)}"/><text class="ax${unten ? ' dn' : ''}" x="${
      PAD.l - 5
    }" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${
      Math.abs(v) % 1 ? Math.abs(v).toFixed(1) : Math.abs(v)
    }</text>`;
  };
  const grid =
    gridLine(0, true) +
    gridLine(topUp) +
    // Die Mittellinie nur, wenn oben genug Platz ist — sonst klebt sie an der
    // Spitze und macht die Achse unruhig statt genauer.
    (upH > 34 ? gridLine(topUp / 2) : '') +
    (topDown > 0 ? gridLine(-topDown) : '') +
    (topDown > 0 && downH > 34 ? gridLine(-topDown / 2) : '');

  // 1 px Luft an der Nulllinie, damit sich die beiden Füllungen berühren, aber
  // nicht verschmelzen — sonst liest man einen durchgehenden Balken.
  const GAP = 1;
  const bars = points
    .map((p, i) => {
      const cx = PAD.l + slot * i + slot / 2;
      const down = p.down ?? 0;
      // Der Hinweis auf unbewertete Strecke hängt NICHT am Gegenbalken: Sind
      // alle Fahrten eines Abschnitts unbewertet, ist der Balken null — und
      // genau dann ist der Hinweis am wichtigsten.
      const zeilen = [
        `${p.label}: ${p.value.toFixed(1)} ${unit} ${L.chartCharged}${p.detail ? ` · ${p.detail}` : ''}`,
      ];
      if (down > 0) {
        zeilen.push(`${p.label}: ${down.toFixed(1)} ${unit} ${L.chartUsed}`);
      }
      if (p.downDetail) {
        zeilen.push(p.downDetail);
      }
      const cls = `bar${p.current ? ' cur' : ''}${p.value === 0 && down === 0 ? ' zero' : ''}`;
      const hUp = Math.max(2, zeroY - GAP - y(p.value));
      const hDown = Math.max(2, y(-down) - zeroY - GAP);
      return `<g class="${cls}">
        <rect class="hit" data-tip="${esc(zeilen.join('\n'))}"${
          p.href ? ` data-href="${esc(p.href)}"` : ''
        } x="${(cx - slot / 2).toFixed(1)}" y="${PAD.t}" width="${slot.toFixed(
          1,
        )}" height="${plotH}"><title>${esc(zeilen.join('\n'))}</title></rect>
        ${
          p.value > 0
            ? `<rect class="v" x="${(cx - bw / 2).toFixed(1)}" y="${y(p.value).toFixed(
                1,
              )}" width="${bw.toFixed(1)}" height="${hUp.toFixed(1)}" rx="4"/>`
            : `<rect class="v0" x="${(cx - bw / 2).toFixed(1)}" y="${(zeroY - 2).toFixed(
                1,
              )}" width="${bw.toFixed(1)}" height="2" rx="1"/>`
        }
        ${
          down > 0
            ? `<rect class="d" x="${(cx - bw / 2).toFixed(1)}" y="${(zeroY + GAP).toFixed(
                1,
              )}" width="${bw.toFixed(1)}" height="${hDown.toFixed(1)}" rx="4"/>`
            : ''
        }
      </g>`;
    })
    .join('');

  // Beschriftung ausdünnen, damit sich nichts überlappt.
  //
  // Das Jahr fällt weg, sofern noch etwas davorsteht: „Juli 2026" wird zu
  // „Juli", „KW 31 / 2026" zu „KW 31" — das nackte Jahr im Jahresdiagramm
  // bleibt aber stehen. Das vollständige Label steht ohnehin im Tooltip.
  const short = (s: string): string => s.replace(/[ /]+\d{4}$/, '').slice(0, 10);
  const every = Math.ceil(points.length / 7);
  const labels = points
    .map((p, i) =>
      i % every === 0 || i === points.length - 1
        ? `<text class="ax" x="${(PAD.l + slot * i + slot / 2).toFixed(1)}" y="${
            H - 6
          }" text-anchor="middle">${esc(short(p.label))}</text>`
        : '',
    )
    .join('');

  return `<svg class="bars" viewBox="0 0 ${W} ${H}" role="img"
   aria-label="${esc(hasDown ? L.chartBarsBothAria : L.chartBarsAria)}">
  <defs><linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#35c77b"/><stop offset="100%" stop-color="var(--accent)"/>
  </linearGradient>
  <linearGradient id="bg2" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#f0883e"/><stop offset="100%" stop-color="#d9534f"/>
  </linearGradient></defs>
  ${grid}${bars}${labels}
</svg>`;
}

/** CSS des Balkendiagramms. */
export const BARS_CSS = `
.bars{width:100%;height:auto;display:block;overflow:visible}
.bars .gl{stroke:var(--line);stroke-width:1}
/* Die Nulllinie trägt die ganze Aussage des Gegenbalkens — sie darf nicht
   aussehen wie eine Hilfslinie. */
.bars .zl{stroke:var(--dim);stroke-width:1;opacity:.55}
.bars .ax{fill:var(--dim);font-size:10px}
/* Die Beschriftung unter der Nulllinie trägt die Farbe des Gegenbalkens.
   Ohne sie stand dort dieselbe Zahl wie oben, ohne jeden Hinweis darauf, dass
   sie in die andere Richtung gilt. */
.bars .ax.dn{fill:#e8833a}
.bars .v{fill:var(--accent);transition:opacity .12s}
.bars .v0{fill:var(--line)}
/* Verbrauch in Warmton: gegensätzliche Richtung, gegensätzliche Farbe. */
.bars .d{fill:#e8833a;transition:opacity .12s}
.bars .cur .v{fill:url(#bg1)}
.bars .cur .d{fill:url(#bg2)}
.bars g:hover .v,.bars g:hover .d{opacity:.75}
.bars .hit{fill:transparent}
`;

/** Ein Messwert einer Verlaufslinie. */
export interface TrendPoint {
  /** Zeitpunkt in ms seit Epoch. */
  t: number;
  v: number;
}

/**
 * Kleine Verlaufslinie für einen langsam veränderlichen Messwert.
 *
 * Gedacht für den Reifendruck: Die Porsche-App zeigt den heutigen Wert, aber
 * nicht, dass ein Reifen seit Wochen Luft verliert. Genau diese Bewegung ist
 * hier die Aussage — die absolute Höhe steht ohnehin als Zahl daneben.
 *
 * Die Y-Achse folgt deshalb den DATEN, nicht der Null: Ein Druckverlust von
 * 2,7 auf 2,5 bar wäre auf einer Achse ab 0 eine waagerechte Linie. Damit ein
 * ruhiger Verlauf nicht wie ein Beben aussieht, gilt eine Mindestspanne.
 *
 * Gibt einen leeren String zurück, solange zu wenige Punkte vorliegen — zwei
 * Messwerte ergeben immer eine Gerade und behaupten einen Trend, den niemand
 * belegen kann.
 */
export function sparkline(points: TrendPoint[], opts: { minSpan?: number } = {}): string {
  if (points.length < 4) {
    return '';
  }
  const W = 120;
  const H = 28;
  const PAD = 3;
  const minSpan = opts.minSpan ?? 0.2;

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const tSpan = Math.max(1, t1 - t0);

  const values = points.map((p) => p.v);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const mid = (lo + hi) / 2;
  const span = Math.max(hi - lo, minSpan);
  const from = mid - span / 2;

  const x = (t: number): number => PAD + ((t - t0) / tSpan) * (W - 2 * PAD);
  const y = (v: number): number => PAD + (1 - (v - from) / span) * (H - 2 * PAD);

  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join('');
  const last = points[points.length - 1];

  // Richtung färbt die Linie: Fallender Druck ist das, was auffallen soll.
  const delta = last.v - points[0].v;
  const cls = delta <= -minSpan / 2 ? ' down' : delta >= minSpan / 2 ? ' up' : '';

  return `<svg class="spark${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
   role="img" aria-hidden="true"><path d="${d}"/><circle cx="${x(last.t).toFixed(
     1,
   )}" cy="${y(last.v).toFixed(1)}" r="2.2"/></svg>`;
}

/** CSS der Verlaufslinie. */
export const SPARK_CSS = `
.spark{width:100%;height:28px;display:block;margin-top:6px;overflow:visible}
.spark path{fill:none;stroke:var(--dim);stroke-width:1.6;stroke-linejoin:round;
 stroke-linecap:round;vector-effect:non-scaling-stroke}
.spark circle{fill:var(--dim)}
.spark.down path,.spark.down circle{stroke:#d9534f;fill:#d9534f}
.spark.down path{fill:none}
.spark.up path,.spark.up circle{stroke:#35c77b;fill:#35c77b}
.spark.up path{fill:none}
`;
