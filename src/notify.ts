/**
 * Push-Benachrichtigungen über ntfy.
 *
 * Der Pi baut die Verbindung ausschließlich NACH AUSSEN auf — ein einfacher
 * HTTP-POST. Damit funktioniert der Push ohne Portfreigabe, ohne VPN und ohne
 * dass der Pi von außen erreichbar wäre. Genau deshalb ist er dem Dashboard
 * überlegen, wenn man unterwegs ist: Das Dashboard hängt am Heimnetz, der Push
 * nicht.
 *
 * Das Zusammenbauen der Texte ist von ihrem Versand getrennt, damit sich der
 * Inhalt testen lässt, ohne etwas zu verschicken.
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import type { Bucket, Efficiency } from './aggregate';
import type { ChargeSession } from './sessions';

export interface NotifyConfig {
  /** ntfy-Server, Standard `https://ntfy.sh`. */
  server: string;
  /** Thema. Leer = Push abgeschaltet. */
  topic: string;
  log?: (msg: string) => void;
}

const fmtKwh = (n: number): string => `${n.toFixed(1)} kWh`;
const fmtEur = (n: number): string => `${n.toFixed(2)} €`;
const fmtDur = (min: number): string =>
  min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`;

/**
 * Tagesmeldung: gestern, laufender Monat, Verbrauch.
 *
 * `days` sind die Tagesbuckets (aufsteigend), `monthly` der laufende Monat.
 * Ohne Vortagsdaten wird bewusst nichts beschönigt — dann steht dort „keine
 * Ladung".
 */
export function buildDailyMessage(
  days: Bucket[],
  month: Bucket | undefined,
  eff: Efficiency,
): { title: string; message: string } {
  // Letzter abgeschlossener Tag = vorletzter Bucket (der letzte ist heute).
  const yesterday = days.length >= 2 ? days[days.length - 2] : undefined;

  const lines: string[] = [];
  if (yesterday && yesterday.kwh > 0) {
    lines.push(`Gestern: ${fmtKwh(yesterday.kwh)} für ${fmtEur(yesterday.cost)}`);
  } else {
    lines.push('Gestern: keine Ladung');
  }
  if (yesterday && yesterday.km > 0) {
    lines.push(`Gefahren: ${yesterday.km} km`);
  }
  if (month) {
    lines.push(`${month.label}: ${fmtKwh(month.kwh)} · ${fmtEur(month.cost)}`);
  }
  if (eff.kwhPer100km !== undefined && eff.centPerKm !== undefined) {
    lines.push(`Schnitt: ${eff.kwhPer100km.toFixed(1)} kWh/100 km · ${eff.centPerKm.toFixed(1)} ct/km`);
  }
  return { title: 'Taycan — Ladebericht', message: lines.join('\n') };
}

/** Meldung nach einem abgeschlossenen Ladevorgang. */
export function buildSessionMessage(s: ChargeSession): { title: string; message: string } {
  const lines: string[] = [];
  if (s.energyKwh !== undefined) {
    lines.push(
      `${fmtKwh(s.energyKwh)}` + (s.costEur !== undefined ? ` für ${fmtEur(s.costEur)}` : ''),
    );
  }
  if (s.startSoc !== undefined && s.endSoc !== undefined) {
    lines.push(`Ladestand: ${s.startSoc} → ${s.endSoc} %`);
  }
  lines.push(`Am Kabel: ${fmtDur(s.durationMin)}, davon ${fmtDur(s.chargingMin)} geladen`);
  if (s.peakPowerKw !== undefined) {
    lines.push(`Spitze: ${s.peakPowerKw.toFixed(1)} kW`);
  }
  return { title: 'Taycan — Ladung beendet', message: lines.join('\n') };
}

/**
 * Verschickt eine Nachricht. Wirft NIE.
 *
 * Ein nicht erreichbarer Push-Dienst darf weder den Poll-Zyklus noch HomeKit
 * beeinträchtigen — im Zweifel entfällt die Nachricht lieber stillschweigend.
 */
export function sendNotification(
  cfg: NotifyConfig,
  title: string,
  message: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!cfg.topic) {
      resolve(false);
      return;
    }
    try {
      const url = new URL(cfg.topic, cfg.server.endsWith('/') ? cfg.server : cfg.server + '/');
      const lib = url.protocol === 'http:' ? http : https;
      const body = Buffer.from(message, 'utf8');
      const req = lib.request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': body.length,
            // Umlaute im Header müssen RFC-2047-kodiert werden, sonst
            // verstümmelt ntfy den Titel.
            title: /[^\x20-\x7e]/.test(title)
              ? `=?UTF-8?B?${Buffer.from(title, 'utf8').toString('base64')}?=`
              : title,
          },
          timeout: 10000,
        },
        (res) => {
          res.resume();
          const ok = (res.statusCode ?? 0) < 400;
          if (!ok) {
            cfg.log?.(`Push notification failed: HTTP ${res.statusCode}`);
          }
          resolve(ok);
        },
      );
      req.on('error', (err) => {
        cfg.log?.(`Push notification failed: ${String(err)}`);
        resolve(false);
      });
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end(body);
    } catch (err) {
      cfg.log?.(`Push notification failed: ${String(err)}`);
      resolve(false);
    }
  });
}

/**
 * Millisekunden bis zur nächsten vollen Stunde `hour` in lokaler Zeit.
 *
 * Bewusst über Kalenderfelder statt über feste 24-Stunden-Schritte, damit die
 * Meldung auch an Sommerzeit-Wechseltagen zur richtigen Uhrzeit kommt.
 */
export function msUntilHour(hour: number, now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}
