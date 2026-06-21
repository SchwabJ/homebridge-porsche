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
import { PorscheClient } from './api/porscheClient';
import { VehicleState } from './api/measurements';
import { PorscheCommand } from './api/commands';
import { clampPollInterval } from './wake';
import { createKit, resolveConfig, ResolvedPorscheConfig, PLUGIN_NAME, PLATFORM_NAME } from './accessories/kit';
import chargingModule from './accessories/charging';
import climateModule from './accessories/climate';
import accessModule from './accessories/access';
import telemetryModule from './accessories/telemetry';
import { createWatchdog } from './accessories/watchdog';

export { PLATFORM_NAME };

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

  // --- Laufzeit-Zustand ------------------------------------------------------
  private client?: PorscheClient;
  private vin?: string;
  private pollTimer?: NodeJS.Timeout;

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

    this.log.info('homebridge-porsche loaded (cockpit)');

    // Accessories zuerst aufbauen, danach Tokens/Netz — siehe Klassen-Doc.
    this.api.on('didFinishLaunching', () => {
      this.setupAccessories();
      void this.start();
    });
    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
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
      let vin = this.resolvedConfig.vin;
      if (!vin) {
        const vehicles = await client.listVehicles();
        vin = vehicles[0]?.vin;
      }
      if (!vin) {
        this.log.error('No VIN found (vehicle list empty).');
        this.setHealth?.({ ok: false, message: 'no VIN' });
        return;
      }

      this.vin = vin;
      this.client = client;

      // Sofort einmal pollen, danach im geklemmten Intervall.
      void this.poll();
      this.pollTimer = setInterval(
        () => void this.poll(),
        this.pollIntervalMinutes * 60000,
      );
      if (typeof this.pollTimer.unref === 'function') {
        this.pollTimer.unref();
      }
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
    try {
      const state = await this.client.getState(this.vin, STATE_KEYS);
      this.log.info(
        `Poll OK: SoC=${state.soc}% range=${state.rangeKm}km locked=${state.locked} climate=${state.climateOn}`,
      );
      for (const update of this.updaters) {
        try {
          update(state);
        } catch (err) {
          // Ein einzelnes Modul darf den Zyklus nicht reißen.
          this.log.warn(`Module update failed: ${String(err)}`);
        }
      }
      this.setHealth?.({ ok: true });
    } catch (err) {
      this.log.warn(`Status poll failed: ${String(err)}`);
      this.setHealth?.({ ok: false, message: `Poll: ${String(err)}` });
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
