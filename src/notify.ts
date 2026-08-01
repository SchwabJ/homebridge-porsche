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
import { fill, type Labels } from './i18n';

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
  L: Labels,
  vehicleName: string,
): { title: string; message: string } {
  // Letzter abgeschlossener Tag = vorletzter Bucket (der letzte ist heute).
  const yesterday = days.length >= 2 ? days[days.length - 2] : undefined;

  const lines: string[] = [];
  if (yesterday && yesterday.kwh > 0) {
    lines.push(
      `${L.pushYesterday}: ${fmtKwh(yesterday.kwh)} ${L.pushFor} ${fmtEur(yesterday.cost)}`,
    );
  } else {
    lines.push(`${L.pushYesterday}: ${L.pushNoCharge}`);
  }
  if (yesterday && yesterday.km > 0) {
    lines.push(`${L.pushDriven}: ${yesterday.km} km`);
  }
  if (month) {
    lines.push(`${month.label}: ${fmtKwh(month.kwh)} · ${fmtEur(month.cost)}`);
  }
  if (eff.kwhPer100km !== undefined && eff.centPerKm !== undefined) {
    lines.push(
      `${L.pushAverage}: ${eff.kwhPer100km.toFixed(1)} kWh/100 km · ` +
        `${eff.centPerKm.toFixed(1)} ct/km`,
    );
  }
  return { title: `${vehicleName} — ${L.pushReportTitle}`, message: lines.join('\n') };
}

/**
 * Meldung nach einem abgeschlossenen Ladevorgang.
 *
 * Endete die Ladung als ABBRUCH, sagt die Meldung das — im Titel und in der
 * ersten Zeile. Vorher lautete sie auch dann „Ladung beendet" und nannte einen
 * Ladestand, ohne mit einem Wort zu erwähnen, dass das Auto am Kabel stand und
 * aufgehört hatte. Wer sie morgens überfliegt, hielt das für einen normalen
 * Ladeschluss.
 *
 * Unter Taycan-Fahrern ist eine Meldung bei misslungenem Laden der am
 * häufigsten geäußerte Wunsch: Die Porsche-App schickt dazu nichts, auch dann
 * nicht, wenn die Wallbox mitten in der Nacht aussteigt.
 */
export function buildSessionMessage(
  s: ChargeSession,
  L: Labels,
  vehicleName: string,
): { title: string; message: string } {
  const lines: string[] = [];
  // Der Abbruch gehört nach ganz oben, nicht in eine Fußnote: Eine
  // Push-Meldung wird überflogen, nicht gelesen.
  if (s.aborted === true && s.endSoc !== undefined && s.targetSoc !== undefined) {
    lines.push(
      `${fill(L.pushAbortedLine, s.endSoc, s.targetSoc)} — ${L.pushAbortedCable}`,
    );
  }
  if (s.energyKwh !== undefined) {
    lines.push(
      `${fmtKwh(s.energyKwh)}` +
        (s.costEur !== undefined ? ` ${L.pushFor} ${fmtEur(s.costEur)}` : ''),
    );
  }
  if (s.startSoc !== undefined && s.endSoc !== undefined) {
    lines.push(`${L.pushLevel}: ${s.startSoc} → ${s.endSoc} %`);
  }
  // Die ganze Zeile als ein Label, nicht aus Fragmenten zusammengesetzt: Im
  // Deutschen steht „geladen" hinter der Zeitangabe, im Englischen davor.
  lines.push(fill(L.pushCableLine, fmtDur(s.durationMin), fmtDur(s.chargingMin)));
  if (s.peakPowerKw !== undefined) {
    lines.push(`${L.pushPeak}: ${s.peakPowerKw.toFixed(1)} kW`);
  }
  return {
    title: `${vehicleName} — ${s.aborted === true ? L.pushAbortedTitle : L.pushSessionTitle}`,
    message: lines.join('\n'),
  };
}

/**
 * Warnung bei hängender LAUFENDER Ladung.
 *
 * Das Gegenstück zum rückblickenden Abbruch, aber VOR dem Ausstecken — nur so
 * kann die Meldung noch in der Nacht kommen statt am Morgen. Ein Abbruch, den
 * man erst morgens auf der Statusseite sieht, kostet die Nacht, und morgens
 * fehlt dann die Reichweite.
 */
export function buildStallMessage(
  s: ChargeSession,
  L: Labels,
  vehicleName: string,
): { title: string; message: string } {
  const lines: string[] = [];
  lines.push(
    s.endSoc !== undefined && s.targetSoc !== undefined
      ? fill(L.pushStallLine, s.endSoc, s.targetSoc)
      : L.pushStallLinePlain,
  );
  lines.push(fill(L.pushStallSince, fmtDur(s.durationMin)));
  return { title: `${vehicleName} — ${L.pushStallTitle}`, message: lines.join('\n') };
}

/**
 * Die hängende laufende Ladung, vor der noch nicht gewarnt wurde.
 *
 * Der Poll läuft alle paar Minuten, die Warnung darf trotzdem nur EINMAL je
 * Ladung kommen. `warnedFor` ist der Startzeitpunkt der bereits gemeldeten
 * Ladung — derselbe stabile Schlüssel, den auch die Preisdatei nutzt.
 */
export function stalledToWarn(
  sessions: ChargeSession[],
  warnedFor: string | undefined,
): ChargeSession | undefined {
  const open = sessions.find((s) => !s.complete && s.stalled);
  if (!open || open.startedAt === warnedFor) {
    return undefined;
  }
  return open;
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

/**
 * Meldung, wenn das Fahrzeug im Stehen auffällig viel verliert.
 *
 * Der Wert ist keine Rechnung über eine Nacht, sondern über alle beobachteten
 * Ruhephasen — deshalb steht die Beobachtungsdauer dabei. Ohne sie wäre die
 * Zahl nicht einzuordnen, und eine Warnung, die man nicht einordnen kann,
 * ignoriert man beim zweiten Mal.
 *
 * Was der Fahrer damit anfangen soll, steht dabei: Der belegte Fall aus dem
 * Forum war eine einzelne schwache Zelle, und die findet nur die Werkstatt.
 */
export function buildIdleMessage(
  a: { socPerDay: number; kwhPerDay: number },
  observedDays: number,
  L: Labels,
  vehicleName: string,
): { title: string; message: string } {
  return {
    title: `${vehicleName} — ${L.pushIdleTitle}`,
    message: [
      fill(
        L.pushIdleLine,
        a.socPerDay.toFixed(1),
        a.kwhPerDay.toFixed(1),
        observedDays.toFixed(1),
      ),
      L.pushIdleAdvice,
    ].join('\n'),
  };
}
