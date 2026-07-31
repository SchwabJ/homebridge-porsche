import { esc, socSpan, fmtStamp, fmtDur, fmtClock, monthKey, fmtNum } from '../src/format';

describe('esc', () => {
  it('escapes the four HTML-sensitive characters', () => {
    expect(esc('<b a="1">&</b>')).toBe('&lt;b a=&quot;1&quot;&gt;&amp;&lt;/b&gt;');
  });

  it('leaves plain text untouched', () => {
    expect(esc('Taycan · 20,1 kWh')).toBe('Taycan · 20,1 kWh');
  });
});

describe('socSpan', () => {
  it('renders a range with arrow and unit', () => {
    expect(socSpan(62, 80)).toBe('62 → 80 %');
  });

  it('treats 0 % as a real value, not as missing', () => {
    expect(socSpan(0, 80)).toBe('0 → 80 %');
  });

  it('falls back to a dash when either end is missing', () => {
    expect(socSpan(undefined, 80)).toBe('—');
    expect(socSpan(62, undefined)).toBe('—');
  });

  it('supports an empty fallback for CSV cells', () => {
    expect(socSpan(undefined, undefined, '')).toBe('');
  });
});

describe('fmtDur', () => {
  it('shows plain minutes below one hour', () => {
    expect(fmtDur(45)).toBe('45 min');
  });

  it('splits hours and minutes above', () => {
    expect(fmtDur(90)).toBe('1 h 30 min');
  });

  it('rounds fractional minutes', () => {
    expect(fmtDur(59.6)).toBe('60 min');
  });
});

describe('fmtClock', () => {
  it('renders hours and minutes only', () => {
    expect(fmtClock('2026-07-15T12:00:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('fmtStamp', () => {
  it('renders full date with year and minutes, no weekday', () => {
    // Mittags-UTC: Der Kalendertag ist in jeder realistischen Zeitzone derselbe.
    const s = fmtStamp('2026-07-15T12:00:00.000Z');
    expect(s).toMatch(/^15\.07\.2026, \d{2}:\d{2}$/);
  });
});

describe('monthKey', () => {
  it('bildet den Monat aus LOKALEN Datumsteilen, nicht aus UTC', () => {
    // Der Fall, der Belege zweimal in den falschen Monat gelegt hat: Am
    // 1. August um 00:30 Ortszeit ist in UTC noch der 31. Juli.
    const lokal = new Date(2026, 7, 1, 0, 30);
    expect(monthKey(lokal.toISOString())).toBe('2026-08');
  });

  it('füllt einstellige Monate auf', () => {
    expect(monthKey(new Date(2026, 0, 15, 12).toISOString())).toBe('2026-01');
  });
});

describe('fmtNum', () => {
  it('gibt für undefined einen leeren String, nicht 0', () => {
    // Eine Fahrt ohne belastbaren Verbrauch hat keinen — 0 wäre eine
    // Behauptung.
    expect(fmtNum(undefined)).toBe('');
  });

  it('formatiert mit deutschem Dezimalkomma und Tausenderpunkt', () => {
    expect(fmtNum(1234.5)).toBe('1.234,50');
    expect(fmtNum(20, 1)).toBe('20,0');
  });
});
