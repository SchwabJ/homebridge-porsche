/**
 * Kleine Formatierungshelfer, die mehrere Seiten teilen.
 *
 * Jeder von ihnen existierte vorher mehrfach — `esc` in Dashboard und
 * Diagrammen, die SoC-Spanne an vier Stellen, der Beleg-Stempel doppelt. Zwei
 * Kopien desselben Formats laufen irgendwann auseinander, und der Unterschied
 * fällt erst auf, wenn ein Beleg anders aussieht als die Seite daneben.
 */

/** HTML-Escaping für Text, der in Markup eingesetzt wird. */
export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/**
 * Ladestand-Spanne „62 → 80 %" — oder der Fallback, wenn ein Ende fehlt.
 *
 * Der Fallback ist je Ausgabeort verschieden: Tabellen zeigen einen
 * Gedankenstrich, CSV-Zellen bleiben leer. Geprüft wird auf `undefined`,
 * nicht auf Falsy — 0 % ist ein echter Ladestand.
 */
export const socSpan = (
  start: number | undefined,
  end: number | undefined,
  fallback = '—',
): string => (start !== undefined && end !== undefined ? `${start} → ${end} %` : fallback);

/** Dauer in Minuten als „x min" bzw. „x h y min". */
export const fmtDur = (min: number): string =>
  min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`;

/** Uhrzeit „HH:MM" (lokale Zeit) — für Ladephasen und Prognosen. */
export const fmtClock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/**
 * Zeitstempel des Monatsbelegs: mit Jahr, ohne Wochentag und Sekunden.
 *
 * Auf einem Beleg zählt das vollständige Datum, nicht der Wochentag — und die
 * Spalte bleibt schmal genug fürs Telefon. Druckansicht und CSV nutzen genau
 * dasselbe Format, damit beide Ausgaben zueinander passen.
 */
export const fmtStamp = (iso: string): string =>
  new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Monatsschlüssel `YYYY-MM` aus LOKALEN Datumsteilen.
 *
 * `iso.slice(0, 7)` liefert den UTC-Monat, und der weicht ab: Eine Ladung, die
 * am 1. August um 01:00 Ortszeit beginnt, ist in UTC noch der 31. Juli. Auf
 * einem Beleg landet sie damit im falschen Monat — bei einer Abrechnung kein
 * Schönheitsfehler.
 *
 * Stand vorher dreimal wörtlich im Code (Ladebeleg, Fahrtenbericht,
 * Monatsfilter der Fahrten-CSV). Genau diese Regel ist schon zweimal
 * gebrochen worden; sie gehört an EINE Stelle.
 */
export const monthKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** Monat als „August 2026" — Überschrift beider Berichte. */
export const fmtMonth = (m: string): string =>
  new Date(`${m}-01T12:00:00Z`).toLocaleDateString('de-DE', {
    month: 'long',
    year: 'numeric',
  });

/** Zahl mit deutschen Tausender- und Dezimaltrennzeichen. */
export const fmtNum = (n: number | undefined, digits = 2): string =>
  n === undefined
    ? ''
    : n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
