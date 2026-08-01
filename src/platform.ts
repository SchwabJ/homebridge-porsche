import * as path from 'path';

import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { UndiciHttpClient } from './http';
import { PorscheAuth, Tokens } from './auth/porscheAuth';
import { loadTokens, saveTokens } from './auth/tokenStore';
import { PorscheClient, isPluginHybrid, type VehicleListEntry } from './api/porscheClient';
import { VehicleState } from './api/measurements';
import { PorscheCommand } from './api/commands';
import { clampPollInterval, effectivePollMinutes } from './wake';
import { chargeWindowAction, externallyPaced, parseWindow } from './chargeWindow';
import { capacityTrusted } from './capacityTrust';
import { analyzeIdle, idleAlarm, idleStats, IDLE_ALARM_PCT_PER_DAY } from './idle';
import { buildBatteryReport, healthAlarm, HEALTH_ALARM_PCT } from './batteryReport';
import { estimateCapacity } from './capacity';
import { chargingStart, chargingStop, climateStart, climateStop, lock } from './api/commands';
import { appendSample } from './chargeLog';
import { startDashboard, readSamples } from './dashboard';
import { buildSessions } from './sessions';
import { aggregate, efficiency } from './aggregate';
import {
  sendNotification,
  buildDailyMessage,
  buildSessionMessage,
  buildStallMessage,
  buildIdleMessage,
  buildHealthMessage,
  stalledToWarn,
  msUntilHour,
  type NotifyConfig,
} from './notify';
import { createKit, resolveConfig, ResolvedPorscheConfig, PLUGIN_NAME, PLATFORM_NAME } from './accessories/kit';
import chargingModule from './accessories/charging';
import climateModule from './accessories/climate';
import accessModule from './accessories/access';
import telemetryModule from './accessories/telemetry';
import { createWatchdog } from './accessories/watchdog';
import { labelsFor } from './i18n';
import { isCarHome } from './accessories/helpers';

export { PLATFORM_NAME };

/** Wie lange nach einem Rate-Limit wieder regulär gepollt wird. */
const RATE_LIMIT_COOLDOWN_MS = 30 * 60000;

/**
 * Mindestabstand zwischen zwei Ladefenster-Befehlen.
 *
 * Zehn Minuten, weil ein Befehl seinen Weg über das Backend ins Fahrzeug
 * braucht und der nächste Poll sonst noch den alten Zustand sieht — und
 * denselben Befehl nochmal schickte.
 */
const WINDOW_COMMAND_GAP_MS = 10 * 60000;

/**
 * Mindestabstand zwischen zwei Ruheverlust-Warnungen.
 *
 * Der Wert ändert sich über Tage, nicht über Stunden. Eine Warnung bei jedem
 * Poll wäre nach dem zweiten Mal nur noch Lärm — und Lärm liest niemand.
 */
const IDLE_WARN_GAP_MS = 7 * 24 * 60 * 60000;

/**
 * Mindestabstand zwischen zwei Ruheverlust-PRÜFUNGEN.
 *
 * Sie liest die ganze Historie. Sechs Stunden reichen bei einem Wert, der
 * sich über Tage bewegt, und halten die Last aus dem Poll-Takt heraus.
 */
const IDLE_CHECK_GAP_MS = 6 * 60 * 60000;

/**
 * Mindestabstand zwischen zwei Warnungen zur Batteriegesundheit.
 *
 * Deutlich länger als beim Ruheverlust: Eine Batterie altert über Jahre. Wer
 * die Meldung einmal im Monat bekommt, hat sie verstanden — häufiger wäre sie
 * eine Mahnung ohne neuen Inhalt.
 */
const HEALTH_WARN_GAP_MS = 30 * 24 * 60 * 60000;

/**
 * Wie lange ein zuletzt bekannter Steckerzustand weitergilt, wenn die API
 * keinen liefert.
 *
 * Lang genug, um die regelmäßigen Leerantworten zu überbrücken, kurz genug,
 * dass ein dauerhaft stummes Backend nicht ewig den schnellen Takt hält.
 */
const LAST_KNOWN_TTL_MS = 20 * 60000;



/**
 * ALLE Messwert-Keys, die pro Poll vom gecachten Endpunkt gelesen werden.
 *
 * Diese Liste deckt 1:1 jeden Key ab, den {@link parseMeasurements} aus der
 * PPA-Antwort dereferenziert (GROUND_TRUTH). Fehlt ein Key, blieben die davon
 * gespeisten Sensoren dauerhaft leer. Bei Änderungen am Parser MUSS diese Liste
 * mitgepflegt werden (Selbst-Check: jeder `byKey.get(...)`-Key ∈ STATE_KEYS).
 */
const STATE_KEYS: string[] = [
  // Batterie / Reichweite / km-Stand
  'BATTERY_LEVEL',
  'E_RANGE',
  'MILEAGE',
  // Laden
  'CHARGING_SUMMARY',
  'CHARGING_RATE',
  'CHARGING_PROFILES',
  // Klima
  'CLIMATIZER_STATE',
  // Verriegelung
  'LOCK_STATE_VEHICLE',
  // Türen
  'OPEN_STATE_DOOR_FRONT_LEFT',
  'OPEN_STATE_DOOR_FRONT_RIGHT',
  'OPEN_STATE_DOOR_REAR_LEFT',
  'OPEN_STATE_DOOR_REAR_RIGHT',
  // Deckel (Frunk / Kofferraum)
  'OPEN_STATE_LID_FRONT',
  'OPEN_STATE_LID_REAR',
  // Fenster
  'OPEN_STATE_WINDOW_FRONT_LEFT',
  'OPEN_STATE_WINDOW_FRONT_RIGHT',
  'OPEN_STATE_WINDOW_REAR_LEFT',
  'OPEN_STATE_WINDOW_REAR_RIGHT',
  // Position
  'GPS_LOCATION',
  // Reifen
  'TIRE_PRESSURE',
  // Service
  'MAIN_SERVICE_RANGE',
  // Diskrete Zustände
  'PARKING_BRAKE',
  'PARKING_LIGHT',
  // Datenschutz / Konnektivität
  'REMOTE_ACCESS_AUTHORIZATION',
  'GLOBAL_PRIVACY_MODE',
  // Fahrstatistik — liefert den vom Fahrzeug SELBST gemessenen Verbrauch
  // (kWh/100 km). Dient als unabhängige Gegenprobe zu unserer Rechnung aus
  // geladener Energie je gefahrenem Kilometer.
  'TRIP_STATISTICS_CYCLIC',
];

/**
 * Homebridge-DynamicPlatform für den Porsche Taycan — das volle Cockpit.
 *
 * Aufbau-Reihenfolge ist bewusst „Accessories zuerst, Netz danach":
 *
 *  1. Config → {@link ResolvedPorscheConfig} (Defaults), Poll-Intervall geklemmt.
 *  2. {@link createKit} mit den gecachten Accessories + late-bindendem `command`.
 *  3. Alle Domänen-Module (Laden, Klima, Zugang, Telemetrie) + Watchdog laufen,
 *     bauen ihre Services und liefern `update(state)`-Closures.
 *  4. Neue Accessories registrieren, reused updaten, verwaiste entfernen.
 *  5. Erst danach Tokens laden / refreshen / VIN auflösen / Poll-Loop starten.
 *
 * Fehlende Tokens oder Start-/Poll-Fehler crashen das Plugin NIE: die Accessories
 * bleiben bestehen und der Verbindungs-Wächter ({@link createWatchdog}) kippt in
 * den Fehlerzustand (ContactSensor NOT_DETECTED + StatusFault GENERAL_FAULT).
 *
 * 12V-Schutz: Statuslesen läuft ausschließlich über `client.getState` (gecachter
 * Endpunkt, kein wakeUpJob); das Poll-Intervall wird per `clampPollInterval` auf
 * ≥10 Minuten geklemmt.
 */
export class PorschePlatform implements DynamicPlatformPlugin {
  /** Aus dem Cache wiederhergestellte Accessories (DynamicPlatform-Vertrag). */
  private readonly accessories: PlatformAccessory[] = [];

  // --- aufgelöste Konfiguration ---------------------------------------------
  private readonly resolvedConfig: ResolvedPorscheConfig;
  private readonly pollIntervalMinutes: number;
  private readonly tokenPath: string;
  /** Zielverzeichnis des Rohdaten-Mitschriebs (tagesrotierte JSONL-Dateien). */
  private readonly logDir: string;

  // --- Laufzeit-Zustand ------------------------------------------------------
  private client?: PorscheClient;
  private vin?: string;
  /** Das eigene Fahrzeug samt Antriebsart — Grundlage der Auswertungswahl. */
  private vehicle?: VehicleListEntry;
  /** Zeitpunkt des letzten Versuchs, die Fahrzeugliste zu lesen. */
  private vehicleTriedAt = 0;
  private pollTimer?: NodeJS.Timeout;
  /** Gesetzt beim Shutdown — verhindert, dass ein laufender Poll neu plant. */
  private stopped = false;
  /** Zuletzt eingeplantes Intervall (nur fürs Logging bei Wechseln). */
  private activePollMinutes?: number;
  /** Zeitpunkt des letzten Poll-Versuchs — deckt unerwartete Lücken auf. */
  private lastPollAt?: number;
  /** Dashboard-Server (optional, per dashboardPort=0 abschaltbar). */
  private dashboard?: import('http').Server;
  /** Timer der Tagesmeldung. */
  private dailyTimer?: NodeJS.Timeout;
  /** Letzter beobachteter Steckerzustand — erkennt das Ende einer Ladung. */
  private lastPlugged?: boolean;
  /**
   * Letzter BEKANNTER Lade-/Steckerzustand samt Zeitpunkt.
   *
   * Die API liefert regelmäßig Antworten ohne Lade-Information. Ohne diesen
   * Rückgriff fiele der Poll danach auf das reguläre Intervall zurück und
   * risse ein 20-Minuten-Loch in die Ladekurve — obwohl eine Minute zuvor
   * noch bekannt war, dass das Kabel steckt.
   */
  private lastKnown?: { plugged?: boolean; charging?: boolean; at: number };
  /**
   * Zeitpunkt, bis zu dem nach einem Rate-Limit langsam gepollt wird (ms).
   *
   * Ohne diese Sperre entstünde ein Ping-Pong: Ein 429 lässt den Poll
   * scheitern, der nächste sieht wieder ein steckendes Kabel und beschleunigt
   * erneut — bis Auth0 ein Captcha verlangt und das Login neu aufgesetzt
   * werden müsste.
   */
  private rateLimitedUntil = 0;


  /** Update-Closures aller Domänen-Module (bei jedem Poll mit dem State gefüttert). */
  private updaters: Array<(state: VehicleState) => void> = [];
  /** Health-Kanal des Wächters (Verbindungs-/Auth-Status, separat vom State). */
  private setHealth?: (health: { ok: boolean; message?: string }) => void;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    // (1) Config auflösen; Poll-Intervall SEPARAT klemmen (resolveConfig klemmt bewusst nicht).
    this.resolvedConfig = resolveConfig(config as unknown as Record<string, unknown>);
    this.pollIntervalMinutes = clampPollInterval(this.resolvedConfig.pollIntervalMinutes);
    this.tokenPath =
      (config.tokenPath as string) ||
      path.join(api.user.storagePath(), 'porsche-tokens.json');
    this.logDir = path.join(api.user.storagePath(), 'porsche-log');

    this.log.info('homebridge-porsche loaded (cockpit)');

    // Accessories zuerst aufbauen, danach Tokens/Netz — siehe Klassen-Doc.
    this.api.on('didFinishLaunching', () => {
      this.setupAccessories();
      void this.start();
      const c = this.resolvedConfig;
      this.dashboard = startDashboard({
        port: c.dashboardPort,
        password: c.dashboardPassword,
        // Als Funktion: Das Dashboard startet, bevor die Fahrzeugliste
        // abgerufen ist. Ein hier eingefrorener Wert wäre immer „unbekannt".
        pureElectric: () => isPluginHybrid(this.vehicle) === false,
        // Ebenfalls als Funktion, aus demselben Grund: Das Fahrzeug steht
        // beim Start des Dashboards noch nicht fest.
        capacityTrusted: () =>
          capacityTrusted({
            fromUser: c.capacityFromUser,
            engine: this.vehicle?.engine,
            model: this.vehicle?.model,
          }),
        bindAddress: c.dashboardBind,
        logDir: this.logDir,
        capacityKwh: c.capacityKwh,
        // Effektivpreis = Arbeitspreis abzüglich Ladebonus, in EUR/kWh.
        pricePerKwh: (c.pricePerKwhCt - c.chargingBonusCt) / 100,
        priceCt: c.pricePerKwhCt,
        bonusCt: c.chargingBonusCt,
        externalPriceCt: c.externalPricePerKwhCt,
        dayBoundaryHour: c.dayBoundaryHour,
        vehicleName: c.vehicleName,
        uiPort: 8581,
        labels: labelsFor(c.language),
        log: (m) => this.log.info(m),
        // Manueller Abruf aus dem Dashboard: derselbe Poll wie der zyklische,
        // inklusive Mitschrieb und Neuplanung des nächsten Laufs.
        onRefresh: () => this.poll(),
        // Fahrzeugbefehle aus dem Browser. Die Zuordnung steht HIER und nicht
        // im Dashboard: Dort gehört das Wissen über die Seite hin, hier das
        // über das Fahrzeug. Die Liste im Dashboard ist fest, es kann also
        // nichts ankommen, das hier keine Entsprechung hat.
        onCommand: async (command) => {
          const cmd =
            command === 'climate-start'
              ? climateStart(c.defaultTargetTemp)
              : command === 'climate-stop'
                ? climateStop()
                : command === 'charge-start'
                  ? chargingStart()
                  : command === 'charge-stop'
                    ? chargingStop()
                    : lock();
          if (!this.client || !this.vin) {
            throw new Error('no connection to the vehicle');
          }
          await this.client.sendCommand(this.vin, cmd);
          this.log.info(`Command from the dashboard executed: ${command}.`);
          // Sofort nachfassen, damit die Seite den neuen Zustand zeigt statt
          // bis zum nächsten regulären Poll den alten.
          void this.poll();
        },
      });
      this.scheduleDailyPush();
    });

    this.api.on('shutdown', () => {
      this.stopped = true;
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
      }
      this.dashboard?.close();
      if (this.dailyTimer) {
        clearTimeout(this.dailyTimer);
      }
    });

  }

  /** DynamicPlatform: aus dem Cache geladene Accessories nur merken. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  // ===========================================================================
  // Accessory-Aufbau (netz-unabhängig)
  // ===========================================================================

  /**
   * Baut das gesamte Cockpit auf: Kit + alle Domänen-Module + Watchdog, sammelt
   * deren `update`-Closures, registriert neue Accessories, aktualisiert reused
   * und entfernt verwaiste (gecachte, aber nicht mehr genutzte) Accessories.
   */
  private setupAccessories(): void {
    // (2) Kit mit late-bindendem `command`/`unlock` (Client/VIN existieren hier noch nicht).
    const command = (cmd: PorscheCommand): Promise<void> => this.runCommand(cmd);
    const unlock = (): Promise<void> => this.runUnlock();

    const { kit, registerNewAccessories, touchedUuids } = createKit({
      api: this.api,
      log: this.log,
      config: this.resolvedConfig,
      cachedAccessories: this.accessories,
      command,
      unlock,
    });

    // (3) Alle Domänen-Module + Watchdog → Update-Closures sammeln.
    const watchdog = createWatchdog(kit);
    this.setHealth = watchdog.setHealth;

    this.updaters = [
      chargingModule(kit),
      climateModule(kit),
      accessModule(kit),
      telemetryModule(kit),
      watchdog.update,
    ];

    // (4a) Neue Accessories registrieren.
    registerNewAccessories();

    // (4b) Reused (gecachte, weiterhin genutzte) Accessories in den HB-Cache schreiben.
    const reused = this.accessories.filter((a) => touchedUuids.has(a.UUID));
    if (reused.length > 0) {
      this.api.updatePlatformAccessories(reused);
    }

    // (4c) Verwaiste Accessories (gecacht, aber nie angefordert) entfernen.
    const orphans = this.accessories.filter((a) => !touchedUuids.has(a.UUID));
    if (orphans.length > 0) {
      this.log.info(
        `Removing ${orphans.length} orphaned accessory(s): ` +
          orphans.map((a) => a.displayName).join(', '),
      );
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphans);
    }
  }

  // ===========================================================================
  // Netz-Bootstrap + Poll-Loop
  // ===========================================================================

  /**
   * Lädt Tokens, refresht proaktiv, löst die VIN auf und startet die Poll-Loop.
   * Wirft niemals nach außen: Fehler melden Health(ok:false) an den Wächter.
   */
  private async start(): Promise<void> {
    const stored = loadTokens(this.tokenPath);
    if (!stored) {
      this.log.error('No tokens — run `porsche-auth` once.');
      this.setHealth?.({ ok: false, message: 'no tokens (porsche-auth missing)' });
      return;
    }

    // StoredTokens (accessToken/expiresAt optional) → vollständige Tokens.
    let tokens: Tokens = {
      accessToken: stored.accessToken ?? '',
      refreshToken: stored.refreshToken,
      expiresAt: stored.expiresAt ?? 0,
    };

    const http = new UndiciHttpClient();
    const auth = new PorscheAuth(http);
    const getAccessToken = (): string => tokens.accessToken;

    // Single-Flight-Refresh: der Refresh-Token rotiert bei jedem Tausch. Parallele
    // 401 (z. B. Poll + User-Command) dürfen NICHT beide auf demselben (alten)
    // Refresh-Token refreshen — sonst nutzt der zweite einen bereits rotierten,
    // ungültigen Token. Darum genau EIN in-flight Refresher (memoized Promise).
    let refreshing: Promise<string> | undefined;
    const refresh = (): Promise<string> => {
      if (!refreshing) {
        refreshing = auth
          .refresh(tokens.refreshToken)
          .then((next) => {
            tokens = next;
            saveTokens(this.tokenPath, tokens);
            return tokens.accessToken;
          })
          .finally(() => {
            refreshing = undefined;
          });
      }
      return refreshing;
    };

    const client = new PorscheClient(http, { getAccessToken, refresh });

    try {
      // Proaktiv refreshen, falls expiresAt fehlt/abgelaufen ist.
      const nowSec = Math.floor(Date.now() / 1000);
      if (!tokens.expiresAt || tokens.expiresAt <= nowSec) {
        await refresh();
      }

      // VIN bestimmen: aus Config oder erstes Fahrzeug der Liste.
      // Die Liste wird EINMAL beim Start auch dann abgefragt, wenn die VIN
      // konfiguriert ist. Bisher unterblieb das — womit das Plugin nie
      // erfuhr, welches Modell dort steht. Für ein Plugin, das für alle
      // Porsche dieser Generation taugen soll, ist das die Grundlage: Ein
      // Plug-in-Hybrid braucht andere Auswertungen als ein Elektrofahrzeug.
      let vin = this.resolvedConfig.vin;
      try {
        const vehicles = await client.listVehicles();
        if (vehicles.length > 0) {
          this.log.info(
            `${vehicles.length} vehicle(s) in the account: ${vehicles
              .map((v) => `${v.modelName ?? 'no model name'}${v.engine ? ` (${v.engine})` : ''}`)
              .join(', ')}`,
          );
        }
        if (!vin) {
          vin = vehicles[0]?.vin;
        }
        this.vehicle = vin ? vehicles.find((v) => v.vin === vin) : vehicles[0];
        this.vehicleTriedAt = Date.now();
        const hybrid = isPluginHybrid(this.vehicle);
        if (hybrid === true) {
          this.log.warn(
            'Plug-in hybrid detected. Evaluations that assume a purely electric ' +
              'drive — measured capacity, the battery report and the consumption ' +
              'derived from them — stay switched off: between two charges this car ' +
              'also runs on fuel, and computing over that would produce plausible ' +
              'but wrong numbers.',
          );
        } else if (hybrid === undefined && this.vehicle) {
          this.log.info(
            'Drivetrain unknown — evaluations that assume a purely electric drive ' +
              'stay off as a precaution.',
          );
        }
      } catch (err) {
        this.log.warn(`Vehicle list unavailable: ${String(err)}`);
      }
      if (!vin) {
        this.log.error('No VIN found (vehicle list empty).');
        this.setHealth?.({ ok: false, message: 'no VIN' });
        return;
      }

      this.vin = vin;
      this.client = client;

      // Sofort einmal pollen; poll() plant den jeweils nächsten Lauf selbst.
      void this.poll();
      this.log.info(
        `Poll loop started (every ${this.pollIntervalMinutes} min) for VIN ${vin}.`,
      );
    } catch (err) {
      this.log.warn(`Startup failed (auth/network): ${String(err)}`);
      this.setHealth?.({ ok: false, message: `Startup: ${String(err)}` });
    }
  }

  /**
   * Liest den Fahrzeugzustand über den gecachten Endpunkt und füttert ALLE
   * Update-Closures. Bei Fehlern: Health(ok:false) — kein Crash.
   */
  private async poll(): Promise<void> {
    if (!this.client || !this.vin) {
      return;
    }
    // Unerwartete Lücke aufdecken: Weicht der tatsächliche Abstand deutlich
    // vom eingeplanten ab, fehlt ein Stück Ladekurve — das soll auffallen,
    // statt still in den Daten zu verschwinden.
    const now = Date.now();
    if (this.lastPollAt !== undefined && this.activePollMinutes !== undefined) {
      const actual = (now - this.lastPollAt) / 60000;
      if (actual > this.activePollMinutes * 2 + 1) {
        this.log.warn(
          `Messlücke: ${actual.toFixed(0)} min statt ${this.activePollMinutes} min ` +
            '— in diesem Zeitraum fehlen Datenpunkte.',
        );
      }
    }
    this.lastPollAt = now;

    let charging: boolean | undefined;
    let plugged: boolean | undefined;
    let dataAgeMinutes: number | undefined;
    try {
      const state = await this.client.getState(this.vin, STATE_KEYS);
      charging = state.charging;
      plugged = state.plugged;
      if (typeof state.dataTimestamp === 'number') {
        dataAgeMinutes = Math.max(0, (Date.now() - state.dataTimestamp) / 60000);
      }
      // Rohdaten festhalten, bevor irgendein Modul den State anfasst.
      // Position nur als „zuhause ja/nein" — kein Bewegungsprofil im Mitschrieb.
      const c = this.resolvedConfig;
      const atHome =
        state.lat !== undefined && state.lon !== undefined
          ? isCarHome(state, c.homeLat, c.homeLon, c.homeRadiusM)
          : undefined;
      appendSample(this.logDir, state, new Date(), atHome);
      this.checkChargeEnd(state.plugged);
      this.checkChargeStall(state.plugged);
      void this.applyChargeWindow(state);
      // Die Antriebsart nachholen, falls der Listenabruf beim Start scheiterte.
      // Ohne das bliebe die gemessene Kapazität nach einem einzelnen
      // Netzfehler bis zum nächsten Neustart verborgen.
      if (!this.vehicle) {
        void this.resolveVehicle();
      }
      this.checkIdleDrain();
      if (state.plugged !== undefined) {
        this.lastKnown = { plugged: state.plugged, charging: state.charging, at: Date.now() };
      }
      this.log.info(
        `Poll OK: SoC=${state.soc}% Reichweite=${state.rangeKm}km verriegelt=${state.locked} Klima=${state.climateOn}`,
      );
      for (const update of this.updaters) {
        try {
          update(state);
        } catch (err) {
          // Ein einzelnes Modul darf den Zyklus nicht reißen.
          this.log.warn(`Accessory update failed: ${String(err)}`);
        }
      }
      this.setHealth?.({ ok: true });
    } catch (err) {
      const msg = String(err);
      if (/\b429\b|rate.?limit/i.test(msg)) {
        this.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        this.log.warn(
          `Rate-Limit erreicht — ${RATE_LIMIT_COOLDOWN_MS / 60000} min lang reguläres Poll-Intervall.`,
        );
      }
      this.log.warn(`Status poll failed: ${msg}`);
      this.setHealth?.({ ok: false, message: `Poll: ${msg}` });
    } finally {
      // Bei Fehlern bleiben beide Werte undefined → reguläres 12V-sicheres Intervall.
      this.scheduleNextPoll({ charging, plugged, dataAgeMinutes });
    }
  }

  /** Push-Konfiguration; `topic` leer bedeutet: Push abgeschaltet. */
  private notifyConfig(): NotifyConfig {
    return {
      server: this.resolvedConfig.ntfyServer,
      topic: this.resolvedConfig.ntfyTopic ?? '',
      log: (m) => this.log.warn(m),
    };
  }

  /** Effektivpreis in EUR/kWh (Arbeitspreis abzüglich Ladebonus). */
  private effectivePrice(): number {
    return (this.resolvedConfig.pricePerKwhCt - this.resolvedConfig.chargingBonusCt) / 100;
  }

  /**
   * Meldet eine soeben beendete Ladung.
   *
   * Ausgelöst wird am Übergang eingesteckt → ausgesteckt, nicht am Ende des
   * Ladens: Bei preisgesteuertem Laden pausiert der Tarif ständig, das wäre
   * ein Dauerfeuer an Meldungen.
   */
  /** Zeitpunkt des letzten Ladefenster-Befehls — schützt vor Dauerfeuer. */
  private lastWindowCommandAt = 0;
  /** Die Meldung über fremde Taktung gehört einmal ins Log, nicht bei jedem Poll. */
  private pacedNoted = false;

  /**
   * Setzt das Ladefenster durch: starten, wenn es beginnt, stoppen, wenn es
   * endet.
   *
   * Die Entscheidung selbst liegt in {@link chargeWindowAction} und ist rein
   * — hier steht nur die Ausführung. Ohne konfiguriertes Fenster geschieht
   * nichts; das ist der Standard.
   *
   * SPERRE GEGEN DAUERFEUER: Nach jedem Befehl vergehen mindestens
   * {@link WINDOW_COMMAND_GAP_MS}, bevor ein nächster gesendet wird. Nimmt
   * das Fahrzeug einen Befehl nicht an — weil die Wallbox klemmt oder die
   * Ladung fremdgesteuert ist —, sähe der nächste Poll denselben Zustand und
   * schickte denselben Befehl erneut. Am Kabel wären das alle drei Minuten
   * einer, bis das Rate-Limit greift.
   */
  private async applyChargeWindow(state: VehicleState): Promise<void> {
    const c = this.resolvedConfig;
    const fenster = parseWindow(c.chargeWindowFrom ?? '', c.chargeWindowTo ?? '');
    if (!fenster || !this.client || !this.vin) {
      return;
    }
    const action = chargeWindowAction(new Date(), fenster, {
      plugged: state.plugged,
      charging: state.charging,
      soc: state.soc,
      targetSoc: state.targetSoc,
      minSoc: state.minSocProfile,
    });
    if (!action) {
      return;
    }
    if (Date.now() - this.lastWindowCommandAt < WINDOW_COMMAND_GAP_MS) {
      return;
    }
    // Erst JETZT die teure Frage, ob überhaupt eingegriffen werden darf:
    // Taktet bereits jemand anders — ein Tarif wie Intelligent Octopus Go
    // oder Tibber, oder ein Ladeplan im Fahrzeug —, wäre ein zweites Fenster
    // daneben kein Sparprogramm, sondern ein Wettlauf. Der Anbieter startet,
    // wir stoppen, der Anbieter startet erneut.
    //
    // Die Prüfung steht bewusst hinter der Sperre und nicht vor der
    // Entscheidung: Sie liest die ganze Historie und liefe sonst bei jedem
    // Poll mit, obwohl fast nie etwas zu tun ist.
    try {
      const sessions = buildSessions(readSamples(this.logDir), {
        capacityKwh: c.capacityKwh,
      });
      if (externallyPaced(sessions)) {
        if (!this.pacedNoted) {
          this.pacedNoted = true;
          this.log.info(
            'Charging window stays idle: charging is already paced externally ' +
              '(tariff or a plan in the car). Two controllers side by side would ' +
              'override each other.',
          );
        }
        return;
      }
      this.pacedNoted = false;
    } catch (err) {
      // Im Zweifel nicht eingreifen — dieselbe Regel wie überall hier.
      this.log.warn(`Charging window: pacing check failed: ${String(err)}`);
      return;
    }
    this.lastWindowCommandAt = Date.now();
    try {
      await this.client.sendCommand(this.vin, action === 'start' ? chargingStart() : chargingStop());
      this.log.info(
        `Charging window ${c.chargeWindowFrom}–${c.chargeWindowTo}: charging ${action}ed ` +
          `(level ${state.soc} %).`,
      );
    } catch (err) {
      // Nicht erneut versuchen: Die Sperre oben lässt den nächsten Versuch
      // ohnehin erst später zu, und ein klemmender Befehl wird durch
      // Wiederholung nicht besser.
      this.log.warn(`Charging-window command failed: ${String(err)}`);
    }
  }

  /** Zeitpunkt der letzten Ruheverlust-Warnung. */
  private idleWarnedAt = 0;
  /** Zeitpunkt der letzten Warnung zur Batteriegesundheit. */
  private healthWarnedAt = 0;
  /** Zeitpunkt der letzten Ruheverlust-PRÜFUNG — sie ist teuer. */
  private idleCheckedAt = 0;

  /**
   * Warnt, wenn das Fahrzeug im Stehen auffällig viel verliert.
   *
   * Zwei Fälle aus dem Taycan-Forum, die beide zu spät auffielen: Ein
   * Besitzer verlor 85 auf 63 % in drei Wochen am Kabel und danach 5 bis 10 %
   * je Tag — Ursache war eine einzelne schwache Zelle. Ein zweiter meldete 3 %
   * über wenige Tage. Gemerkt haben es beide erst, als die Reichweite fehlte.
   *
   * HÖCHSTENS EINMAL JE WOCHE. Der Wert ändert sich über Tage, nicht über
   * Stunden — eine Warnung bei jedem Poll wäre nach dem zweiten Mal nur noch
   * Lärm, und Lärm liest niemand.
   */
  private checkIdleDrain(): void {
    const c = this.resolvedConfig;
    // ZWEI Sperren, und die erste ist die wichtige: Ohne sie liefe die
    // Auswertung über die ganze Historie bei JEDEM Poll — die Warnsperre
    // greift ja erst, wenn tatsächlich gewarnt wurde, also nie im Normalfall.
    const jetzt = Date.now();
    if (!c.ntfyTopic || jetzt - this.idleCheckedAt < IDLE_CHECK_GAP_MS) {
      return;
    }
    this.idleCheckedAt = jetzt;
    try {
      // Direkt statt über den Statistik-Cache: Gebraucht wird allein die
      // Ruhebilanz, und die hängt an keinem Preis.
      const samples = readSamples(this.logDir);
      const stats = idleStats(analyzeIdle(samples), c.capacityKwh);
      const alarm = idleAlarm(stats, IDLE_ALARM_PCT_PER_DAY);
      if (alarm && stats && jetzt - this.idleWarnedAt >= IDLE_WARN_GAP_MS) {
        this.idleWarnedAt = jetzt;
        const { title, message } = buildIdleMessage(
          alarm,
          stats.observedDays,
          labelsFor(c.language),
          c.vehicleName,
        );
        void sendNotification(this.notifyConfig(), title, message);
        this.log.warn(`High idle drain reported: ${alarm.socPerDay.toFixed(1)} %/day.`);
      }
      // Dieselbe Gelegenheit für die Batteriegesundheit: Beide Auswertungen
      // brauchen die Historie, und die ist gerade gelesen. Eigene Sperre,
      // damit nicht eine Warnung die andere unterdrückt.
      // Die Batteriewarnung setzt dieselbe Messung voraus wie der Nachweis —
      // ohne gesicherten Elektroantrieb wäre sie eine Warnung auf Basis einer
      // Zahl, die nicht stimmt.
      if (
        isPluginHybrid(this.vehicle) === false &&
        jetzt - this.healthWarnedAt >= HEALTH_WARN_GAP_MS
      ) {
        const bericht = buildBatteryReport(estimateCapacity(samples), c.capacityKwh);
        const h = healthAlarm(bericht, HEALTH_ALARM_PCT);
        if (h) {
          this.healthWarnedAt = jetzt;
          const { title, message } = buildHealthMessage(h, labelsFor(c.language), c.vehicleName);
          void sendNotification(this.notifyConfig(), title, message);
          this.log.warn(`Battery health reported: ${h.healthPct.toFixed(1)} %.`);
        }
      }
    } catch (err) {
      this.log.warn(`Idle-drain check failed: ${String(err)}`);
    }
  }

  /**
   * Holt die Antriebsart nach, wenn sie beim Start nicht zu haben war.
   *
   * Höchstens stündlich: Ein Konto, dessen Liste dauerhaft nicht antwortet,
   * soll nicht bei jedem Poll dagegenlaufen.
   */
  private async resolveVehicle(): Promise<void> {
    if (!this.client || Date.now() - this.vehicleTriedAt < 60 * 60000) {
      return;
    }
    this.vehicleTriedAt = Date.now();
    try {
      const vehicles = await this.client.listVehicles();
      this.vehicle = this.vin ? vehicles.find((v) => v.vin === this.vin) : vehicles[0];
      if (this.vehicle) {
        this.log.info(
          `Vehicle determined later: ${this.vehicle.modelName ?? '?'}${
            this.vehicle.engine ? ` (${this.vehicle.engine})` : ''
          }`,
        );
      }
    } catch {
      // Still: Der nächste Versuch kommt in einer Stunde von selbst.
    }
  }

  /** Startzeitpunkt der Ladung, vor deren Hängen bereits gewarnt wurde. */
  private stallWarnedFor?: string;

  /**
   * Warnt, wenn die LAUFENDE Ladung hängt — noch am Kabel, Ziel verfehlt,
   * seit Stunden stromlos (siehe {@link ChargeSession.stalled}).
   *
   * Anders als Tagesbericht und Ladeende-Meldung hängt die Warnung an KEINEM
   * eigenen Schalter, nur am ntfy-Topic: Sie ist der einzige Push, der ein
   * Eingreifen erlaubt, solange es noch etwas nützt. Wer den Kanal
   * konfiguriert, bekommt sie; die Berichte bleiben einzeln schaltbar.
   */
  private checkChargeStall(plugged: boolean | undefined): void {
    if (plugged !== true || !this.resolvedConfig.ntfyTopic) {
      return;
    }
    try {
      const sessions = buildSessions(readSamples(this.logDir), {
        capacityKwh: this.resolvedConfig.capacityKwh,
      });
      const open = stalledToWarn(sessions, this.stallWarnedFor);
      if (!open) {
        return;
      }
      this.stallWarnedFor = open.startedAt;
      const { title, message } = buildStallMessage(
        open,
        labelsFor(this.resolvedConfig.language),
        this.resolvedConfig.vehicleName,
      );
      void sendNotification(this.notifyConfig(), title, message);
      this.log.warn('Stalled charge reported.');
    } catch (err) {
      this.log.warn(`Stalled-charge warning failed: ${String(err)}`);
    }
  }

  private checkChargeEnd(plugged: boolean | undefined): void {
    if (plugged === undefined) {
      return; // fehlgeschlagener Poll ist kein Ausstecken
    }
    const was = this.lastPlugged;
    this.lastPlugged = plugged;
    if (was !== true || plugged !== false) {
      return;
    }
    if (!this.resolvedConfig.pushOnChargeEnd || !this.resolvedConfig.ntfyTopic) {
      return;
    }
    try {
      const sessions = buildSessions(readSamples(this.logDir), {
        capacityKwh: this.resolvedConfig.capacityKwh,
        pricePerKwh: this.effectivePrice(),
        grossPricePerKwh: this.resolvedConfig.pricePerKwhCt / 100,
      });
      const last = sessions[sessions.length - 1];
      // Kurzes Ein- und Ausstecken ohne nennenswerte Energie nicht melden.
      if (!last || (last.energyKwh ?? 0) < 0.5) {
        return;
      }
      const { title, message } = buildSessionMessage(
        last,
        labelsFor(this.resolvedConfig.language),
        this.resolvedConfig.vehicleName,
      );
      void sendNotification(this.notifyConfig(), title, message);
      this.log.info('Ladeende gemeldet.');
    } catch (err) {
      this.log.warn(`Charge-finished notification failed: ${String(err)}`);
    }
  }

  /**
   * Plant die Tagesmeldung zur konfigurierten Stunde.
   *
   * Nach jedem Versand wird neu geplant statt ein 24-Stunden-Intervall zu
   * setzen — so bleibt die Uhrzeit auch über Sommerzeitwechsel korrekt.
   */
  private scheduleDailyPush(): void {
    const hour = this.resolvedConfig.dailyPushHour;
    if (this.stopped || hour < 0 || !this.resolvedConfig.ntfyTopic) {
      return;
    }
    const delay = msUntilHour(hour, new Date());
    this.dailyTimer = setTimeout(() => {
      this.sendDailyPush();
      this.scheduleDailyPush();
    }, delay);
    if (typeof this.dailyTimer.unref === 'function') {
      this.dailyTimer.unref();
    }
    this.log.info(
      `Tagesmeldung um ${hour}:00 Uhr (in ${Math.round(delay / 60000)} min).`,
    );
  }

  /** Baut und verschickt die Tagesmeldung. */
  private sendDailyPush(): void {
    try {
      const samples = readSamples(this.logDir);
      const opts = {
        capacityKwh: this.resolvedConfig.capacityKwh,
        pricePerKwh: this.effectivePrice(),
        grossPricePerKwh: this.resolvedConfig.pricePerKwhCt / 100,
        dayBoundaryHour: this.resolvedConfig.dayBoundaryHour,
        labels: labelsFor(this.resolvedConfig.language),
      };
      const days = aggregate(samples, 'day', opts);
      const months = aggregate(samples, 'month', opts);
      const { title, message } = buildDailyMessage(
        days,
        months[months.length - 1],
        efficiency(months),
        labelsFor(this.resolvedConfig.language),
        this.resolvedConfig.vehicleName,
      );
      void sendNotification(this.notifyConfig(), title, message);
    } catch (err) {
      this.log.warn(`Daily report failed: ${String(err)}`);
    }
  }

  /**
   * Plant den nächsten Poll.
   *
   * Das Intervall folgt dem Ladezustand ({@link effectivePollMinutes}): eng nur
   * während eines laufenden Ladevorgangs, in JEDEM anderen Fall – auch bei
   * unbekanntem Zustand nach einem Fehler – das reguläre, geklemmte Intervall.
   */
  private scheduleNextPoll(state: {
    charging?: boolean;
    plugged?: boolean;
    dataAgeMinutes?: number;
  }): void {
    if (this.stopped) {
      return;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    // Ist der Zustand unbekannt (leere Antwort oder Fehler), gilt der zuletzt
    // bekannte weiter — aber nur begrenzt lange, damit ein dauerhaft stummes
    // Backend nicht ewig den schnellen Takt aufrechterhält.
    const known =
      this.lastKnown && Date.now() - this.lastKnown.at <= LAST_KNOWN_TTL_MS
        ? this.lastKnown
        : undefined;
    const minutes = effectivePollMinutes(this.resolvedConfig.pollIntervalMinutes, {
      ...state,
      plugged: state.plugged ?? known?.plugged,
      charging: state.charging ?? known?.charging,
      // Bei unbekanntem Zustand zählt das Alter des zuletzt bekannten.
      dataAgeMinutes:
        state.dataAgeMinutes ??
        (known ? (Date.now() - known.at) / 60000 : undefined),
      pluggedMinutes: this.resolvedConfig.pluggedPollMinutes,
      rateLimited: Date.now() < this.rateLimitedUntil,
    });
    if (minutes !== this.activePollMinutes) {
      this.log.info(
        `Poll-Intervall: ${minutes} min (Kabel=${state.plugged === true ? 'ja' : 'nein'}, ` +
          `Laden=${state.charging === true ? 'ja' : 'nein'}).`,
      );
      this.activePollMinutes = minutes;
    }
    this.pollTimer = setTimeout(() => void this.poll(), minutes * 60000);
    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  /**
   * Sendet einen Fahrzeugbefehl defensiv (late-bind). Wirft NIE nach außen — die
   * Module rufen `void command(...)` ohne `.catch`. No-op, solange Client/VIN
   * fehlen.
   */
  private async runCommand(cmd: PorscheCommand): Promise<void> {
    if (!this.client || !this.vin) {
      this.log.warn(`Command ${cmd.commandName}: not ready yet (no tokens/VIN).`);
      return;
    }
    try {
      await this.client.sendCommand(this.vin, cmd);
      this.log.info(`Command ${cmd.commandName} sent.`);
    } catch (err) {
      this.log.warn(`Command ${cmd.commandName} failed: ${String(err)}`);
    }
  }

  /**
   * Entriegelt das Fahrzeug über den S-PIN-Challenge-Flow. WIRFT bei Fehler
   * (keine S-PIN, nicht bereit, Backend-Ablehnung), damit das Schloss-Accessory
   * den Target zurück auf „verriegelt" setzen kann.
   */
  private async runUnlock(): Promise<void> {
    if (!this.client || !this.vin) {
      this.log.warn('Unlock: not ready yet (no tokens/VIN).');
      throw new Error('Plugin not ready');
    }
    const spin = this.resolvedConfig.spin;
    if (!spin) {
      throw new Error('no S-PIN configured');
    }
    await this.client.unlock(this.vin, spin);
    this.log.info('Vehicle unlocked.');
  }
}
