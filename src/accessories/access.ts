/**
 * Domänen-Modul „Zugang" (Access) für das Taycan-Cockpit.
 *
 * Bündelt Verriegelung, Auffinden (Hupe/Licht), Öffnungen und den Sammel-
 * Sicherheitsstatus:
 *
 *  ESSENTIELL (immer):
 *    - Schloss (LockMechanism): echtes Schloss-Symbol mit Status. Verriegeln →
 *      LOCK. Entriegeln → S-PIN-Challenge-Flow (kit.unlock), aber nur wenn eine
 *      S-PIN konfiguriert ist; ohne S-PIN wird der Entriegeln-Target abgelehnt
 *      und auf „verriegelt" zurückgesetzt.
 *    - Lichthupe (Switch, momentan) → HONK_FLASH {mode:'FLASH'}
 *    - Hupe & Licht (Switch, momentan) → HONK_FLASH {mode:'HONK_AND_FLASH'}
 *    - Fahrzeugstatus (ContactSensor): „geschlossen" = alles sicher (verriegelt
 *      UND alle Türen/Fenster/Hauben zu), „offen" = irgendetwas offen oder das
 *      Fahrzeug entriegelt. Entspricht der Porsche-„Fahrzeugstatus"-Übersicht
 *      als OK/Nicht-OK; an dieser Kachel lässt sich ein nativer Push aktivieren.
 *
 *  GEGATET (nur 'full'):
 *    - 4 Türen, 4 Fenster, Frunk, Kofferraum (je ContactSensor: 0=zu, 1=offen)
 *      als Einzel-Aufschlüsselung des Fahrzeugstatus.
 *
 * Das Modul folgt dem {@link DomainModule}-Muster: es baut beim Aufruf seine
 * Services über die Kit-Helfer auf, verdrahtet onSet-Handler gegen
 * `kit.command(...)`, und liefert eine `update(state)`-Funktion zurück, die alle
 * seine Characteristics aus dem {@link VehicleState} aktualisiert.
 */

import type { BoundService, DomainModule, Kit } from './kit';
import { anyOpenUnsecured } from './helpers';
import { honkFlash, lock } from '../api/commands';
import type { VehicleState } from '../api/measurements';

/**
 * Stabile Seed-Namen — EIN Accessory pro Service (eigene Kachel je Funktion).
 * Stabil (kein Datum/Zufall) → Cache-Matching + Orphan-Cleanup über Neustarts.
 */
const SEEDS = {
  // Neuer Seed (war 'taycan-lock' / 'taycan-lock-button') → frische, korrekt
  // benannte Schloss-Kachel; alte Varianten werden vom Orphan-Cleanup entfernt.
  lock: 'taycan-lock-v2',
  flash: 'taycan-flash',
  honk: 'taycan-honk',
  doorFl: 'taycan-door-fl',
  doorFr: 'taycan-door-fr',
  doorRl: 'taycan-door-rl',
  doorRr: 'taycan-door-rr',
  windowFl: 'taycan-window-fl',
  windowFr: 'taycan-window-fr',
  windowRl: 'taycan-window-rl',
  windowRr: 'taycan-window-rr',
  frunk: 'taycan-frunk',
  trunk: 'taycan-trunk',
  // Neuer Seed (war 'taycan-any-open') erzwingt den neuen Kachel-Namen
  // „Fahrzeugstatus": Apple Home übernimmt ConfiguredName-Änderungen an einem
  // bestehenden Accessory nicht zuverlässig → altes Accessory wird zum Orphan
  // (Cleanup entfernt es), neues entsteht mit korrektem Namen.
  status: 'taycan-vehicle-status',
} as const;

/**
 * Baut das Zugang-Modul am übergebenen {@link Kit} auf und liefert die
 * `update(state)`-Funktion zurück.
 */
export const accessModule: DomainModule = (kit: Kit) => {
  const { hap, log, config } = kit;
  const Characteristic = hap.Characteristic;
  const Service = hap.Service;

  // 'full' = komplettes Cockpit (Einzel-Öffnungen zusätzlich). 'essential' =
  // nur Schloss, Hupe/Licht und der Sammel-Fahrzeugstatus.
  const full = config.detailLevel === 'full';
  // Entriegeln ist nur möglich, wenn eine S-PIN konfiguriert ist.
  const canUnlock = typeof config.spin === 'string' && config.spin.length > 0;

  // --- Schloss (LockMechanism, eigenes Accessory) ---------------------------
  // ESSENTIELL. Echtes Schloss-Symbol mit Status. Verriegeln → LOCK. Entriegeln
  // → S-PIN-Challenge-Flow (kit.unlock), aber NUR wenn eine S-PIN gesetzt ist;
  // sonst wird der Entriegeln-Target abgelehnt und auf „verriegelt" zurückgesetzt.
  const lockAcc = kit.accessory(SEEDS.lock, `${config.vehicleName} Schloss`);
  const lockSvc =
    lockAcc.getServiceById(Service.LockMechanism, 'lock') ??
    lockAcc.addService(Service.LockMechanism, `${config.vehicleName} Schloss`, 'lock');
  kit.nameService(lockSvc, `${config.vehicleName} Schloss`);

  const lockCurrent = lockSvc.getCharacteristic(Characteristic.LockCurrentState);
  const lockTarget = lockSvc.getCharacteristic(Characteristic.LockTargetState);

  lockTarget.onSet((value) => {
    if (value === Characteristic.LockTargetState.SECURED) {
      void kit.command(lock());
      log.info(`${config.vehicleName}: verriegle Fahrzeug`);
      return;
    }
    // Entriegeln gewünscht (UNSECURED).
    if (canUnlock) {
      void kit.unlock().catch((err) => {
        log.warn(`${config.vehicleName}: Entriegeln fehlgeschlagen: ${String(err)}`);
        // Bei Fehler den Target zurück auf „verriegelt".
        setImmediate(() => lockTarget.updateValue(Characteristic.LockTargetState.SECURED));
      });
      log.info(`${config.vehicleName}: entriegle Fahrzeug (S-PIN)`);
    } else {
      log.info(`${config.vehicleName}: Entriegeln nicht möglich — keine S-PIN konfiguriert`);
      setImmediate(() => lockTarget.updateValue(Characteristic.LockTargetState.SECURED));
    }
  });

  // --- Lichthupe + Hupe&Licht (momentane Switches, fire-and-forget) ----------
  // ESSENTIELL. Senden beim Einschalten den Befehl und schalten automatisch zurück.
  kit.switchService(
    kit.accessory(SEEDS.flash, `${config.vehicleName} Lichthupe`),
    `${config.vehicleName} Lichthupe`,
    'flash',
    {
      momentaryMs: config.honkAutoOffSeconds * 1000,
      onSet: (on) => {
        if (on) {
          void kit.command(honkFlash('FLASH'));
          log.info(`${config.vehicleName}: Lichthupe`);
        }
      },
    },
  );

  kit.switchService(
    kit.accessory(SEEDS.honk, `${config.vehicleName} Hupe & Licht`),
    `${config.vehicleName} Hupe & Licht`,
    'honk',
    {
      momentaryMs: config.honkAutoOffSeconds * 1000,
      onSet: (on) => {
        if (on) {
          void kit.command(honkFlash('HONK_AND_FLASH'));
          log.info(`${config.vehicleName}: Hupe & Licht`);
        }
      },
    },
  );

  // --- Öffnungen: je Tür/Fenster/Deckel + Sammel-Fahrzeugstatus --------------
  /** ContactSensor auf eigenem Accessory (eigene beschriftete Kachel). */
  const contact = (seed: string, name: string, subtype: string): BoundService =>
    kit.contactSensor(kit.accessory(seed, name), name, subtype);

  // GEGATET (nur 'full'): die Einzel-Öffnungen. Im 'essential'-Modus undefined
  // (BoundService | undefined) — setContact unten ist no-op bei undefined.
  const doorFL = full ? contact(SEEDS.doorFl, `${config.vehicleName} Tür vorne links`, 'door-fl') : undefined;
  const doorFR = full ? contact(SEEDS.doorFr, `${config.vehicleName} Tür vorne rechts`, 'door-fr') : undefined;
  const doorRL = full ? contact(SEEDS.doorRl, `${config.vehicleName} Tür hinten links`, 'door-rl') : undefined;
  const doorRR = full ? contact(SEEDS.doorRr, `${config.vehicleName} Tür hinten rechts`, 'door-rr') : undefined;

  const windowFL = full ? contact(SEEDS.windowFl, `${config.vehicleName} Fenster vorne links`, 'window-fl') : undefined;
  const windowFR = full ? contact(SEEDS.windowFr, `${config.vehicleName} Fenster vorne rechts`, 'window-fr') : undefined;
  const windowRL = full ? contact(SEEDS.windowRl, `${config.vehicleName} Fenster hinten links`, 'window-rl') : undefined;
  const windowRR = full ? contact(SEEDS.windowRr, `${config.vehicleName} Fenster hinten rechts`, 'window-rr') : undefined;

  const frunk = full ? contact(SEEDS.frunk, `${config.vehicleName} Frunk`, 'frunk') : undefined;
  const trunk = full ? contact(SEEDS.trunk, `${config.vehicleName} Kofferraum`, 'trunk') : undefined;

  // ESSENTIELL (immer): Sammel-Fahrzeugstatus — „geschlossen" = alles sicher,
  // „offen" = irgendetwas offen ODER entriegelt. Liest direkt aus dem State.
  const status = contact(SEEDS.status, `${config.vehicleName} Fahrzeugstatus`, 'any-open');

  // --- Update-Funktion: spiegelt den State in alle Characteristics -----------
  return (state: VehicleState): void => {
    // Schloss: locked === true → SECURED, locked === false → UNSECURED,
    // unbekannt → SECURED (konservativ; Home-App zeigt nichts „Alarmierendes").
    const current =
      state.locked === false
        ? Characteristic.LockCurrentState.UNSECURED
        : Characteristic.LockCurrentState.SECURED;
    lockCurrent.updateValue(current);
    // Target an den Ist-Zustand angleichen, damit keine „läuft …"-Anzeige hängt.
    lockTarget.updateValue(
      state.locked === false
        ? Characteristic.LockTargetState.UNSECURED
        : Characteristic.LockTargetState.SECURED,
    );

    // Hupe/Licht sind momentan & fire-and-forget — kein State zum Spiegeln.

    // Türen
    setContact(doorFL, state.doors?.fl);
    setContact(doorFR, state.doors?.fr);
    setContact(doorRL, state.doors?.rl);
    setContact(doorRR, state.doors?.rr);

    // Fenster
    setContact(windowFL, state.windows?.fl);
    setContact(windowFR, state.windows?.fr);
    setContact(windowRL, state.windows?.rl);
    setContact(windowRR, state.windows?.rr);

    // Frunk / Kofferraum
    setContact(frunk, state.frunkOpen);
    setContact(trunk, state.trunkOpen);

    // Fahrzeugstatus: „offen"/Nicht-OK, sobald irgendwas offen/ungesichert ist.
    status.update(anyOpenUnsecured(state));
  };
};

/**
 * Setzt einen Öffnungs-ContactSensor: `true` = offen (NOT_DETECTED),
 * `false`/`undefined` = zu/unbekannt (DETECTED). Fehlende Daten lösen bewusst
 * KEINE „offen"-Meldung aus.
 *
 * `bound` darf `undefined` sein (gegateter Sensor im 'essential'-Modus nicht
 * angelegt) — dann ist der Aufruf ein No-op (Optional-Chaining).
 */
function setContact(bound: BoundService | undefined, open: boolean | undefined): void {
  bound?.update(open === true);
}

export default accessModule;
