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

/** Poll-Intervall während eines laufenden Ladevorgangs in Minuten. */
const CHARGING_POLL_MINUTES = 1;

/**
 * Poll-Intervall, solange das Kabel steckt, aber (noch) nicht geladen wird.
 *
 * Gleich schnell wie beim aktiven Laden, und das aus gutem Grund: Bei
 * tarifgesteuertem Laden schaltet der Anbieter in kurzen Fenstern ein und aus,
 * teils nur 15 Minuten lang. Genau in der Wartephase muss also engmaschig
 * geschaut werden — sonst ist das Fenster vorbei, bevor es bemerkt wurde.
 *
 * Der 12V-Grund für lange Intervalle entfällt am Kabel ohnehin: Das Fahrzeug
 * hängt am Netz und lädt seine 12V-Batterie mit. Bleibt als Kostenfaktor nur
 * das Rate-Limit der API — deshalb greift dieses Intervall ausschließlich bei
 * steckendem Kabel und nie beim geparkten Auto.
 */
const PLUGGED_POLL_MINUTES = 1;

/** Untergrenze für das Intervall am Kabel — schützt vor versehentlichem Dauerfeuer. */
const MIN_PLUGGED_POLL_MINUTES = 1;

/**
 * Höchstalter der Messdaten, bis zu dem dem Lade-Flag geglaubt wird (Minuten).
 *
 * Ohne diese Schranke wäre das enge Intervall selbsterhaltend: `charging` kommt
 * aus demselben Backend-Cache wie alles andere. Friert der Cache mit
 * `status=CHARGING` ein (Verbindungsabriss, Fahrzeug schläft mitten im
 * Ladevorgang ein), bliebe das Plugin dauerhaft im Schnell-Poll – bei einem
 * längst geparkten Auto. Veralten die Daten, fällt es automatisch zurück.
 */
const MAX_DATA_AGE_MINUTES = 15;

/**
 * Liefert das Poll-Intervall für den aktuellen Fahrzeugzustand.
 *
 * Bewusste, eng begrenzte Ausnahme von {@link clampPollInterval}: NUR solange
 * das Fahrzeug nachweislich lädt, wird enger gepollt (für Ladekurve und
 * Energiemenge). Beim Laden hängt der Wagen am Netz, ist wach und die 12V-
 * Batterie wird mitversorgt – der Deep Sleep, den MIN_POLL_MINUTES schützt,
 * ist dann ohnehin nicht aktiv.
 *
 * Jeder andere Fall – nicht ladend, unbekannt (`undefined`, z. B. nach einem
 * fehlgeschlagenen Poll) – fällt auf das reguläre, geklemmte Intervall zurück.
 * Der geparkte Zustand verhält sich damit exakt wie ohne diese Funktion.
 */
export function effectivePollMinutes(
  configuredMinutes: number,
  state: {
    charging?: boolean;
    /** Kabel steckt — auch während einer Tarifpause. */
    plugged?: boolean;
    /** Alter der Backend-Daten in Minuten. */
    dataAgeMinutes?: number;
    /** Gewünschtes Intervall am Kabel (Minuten). Default {@link PLUGGED_POLL_MINUTES}. */
    pluggedMinutes?: number;
    /**
     * Rate-Limit erreicht (HTTP 429)? Dann gilt das reguläre Intervall,
     * unabhängig vom Steckerzustand — wiederholte 429er riskieren eine
     * Captcha-Sperre und damit ein neues Bootstrap des Logins.
     */
    rateLimited?: boolean;
  } = {},
): number {
  const base = clampPollInterval(configuredMinutes);
  const { charging, plugged, dataAgeMinutes, rateLimited } = state;

  if (rateLimited === true) {
    return base;
  }
  // Nur beschleunigen, wenn die Daten nachweislich frisch sind. Kein Alter
  // bekannt → im Zweifel das reguläre, 12V-sichere Intervall.
  if (dataAgeMinutes === undefined || dataAgeMinutes > MAX_DATA_AGE_MINUTES) {
    return base;
  }
  if (charging !== true && plugged !== true) {
    return base;
  }
  // Am Kabel: 12V-Grund entfällt (Fahrzeug am Netz), deshalb darf hier unter
  // die reguläre Untergrenze gegangen werden — aber nie unter eine Minute.
  const wanted = Math.max(
    MIN_PLUGGED_POLL_MINUTES,
    Math.floor(state.pluggedMinutes ?? PLUGGED_POLL_MINUTES) || PLUGGED_POLL_MINUTES,
  );
  return Math.min(base, charging === true ? Math.min(wanted, CHARGING_POLL_MINUTES) : wanted);
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
