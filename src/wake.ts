/**
 * 12V-Schutz / 12V protection.
 *
 * Der geparkte Taycan darf NIE planmäßig geweckt werden – ein Weck-Job würde
 * die kleine 12V-Versorgungsbatterie über Nacht leeren. Deshalb wird hier
 * BEWUSST kein planmäßiges Wecken (wakeUpJob) implementiert.
 *
 * Statuslesen erfolgt ausschließlich über den gecachten Mess-Endpunkt OHNE
 * `wakeUpJob`-Parameter, und das Polling-Intervall wird nie unter 10 Minuten
 * gedrückt (clampPollInterval).
 */

/** Untere Grenze des Polling-Intervalls in Minuten (12V-Schutz). */
const MIN_POLL_MINUTES = 10;

/**
 * Erzwingt das 12V-sichere Mindest-Polling-Intervall.
 *
 * Werte unter 10 (inkl. 0, NaN) werden auf 10 angehoben; gültige Werte werden
 * auf ganze Minuten abgerundet.
 */
export function clampPollInterval(minutes: number): number {
  return Math.max(MIN_POLL_MINUTES, Math.floor(minutes) || MIN_POLL_MINUTES);
}

/**
 * Baut die URL des gecachten Mess-Endpunkts.
 *
 * Hängt NIEMALS `wakeUpJob` an – das ist die Kern-Sicherheitsgarantie, damit
 * das Statuslesen das geparkte Auto nicht weckt.
 */
export function buildMeasurementUrl(vin: string, keys: string[]): string {
  if (keys.length === 0) {
    throw new Error('keys must not be empty');
  }
  const query = keys.map((k) => 'mf=' + encodeURIComponent(k)).join('&');
  return `/connect/v1/vehicles/${vin}?${query}`;
}
