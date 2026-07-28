#!/usr/bin/env node
/**
 * `porsche-auth` – interaktives Einmal-Setup-CLI für das Homebridge-Taycan-Plugin.
 *
 * Zweck: einmaliger Login (E-Mail + Passwort) gegen die Porsche/Auth0-API, um
 * einen langlebigen `refresh_token` zu erhalten und auf die Platte zu schreiben.
 * Danach läuft das Plugin headless. Ein etwaiges Captcha wird hier interaktiv
 * gelöst (Bild als data-URI / SVG-Datei → der Mensch liest den Text).
 *
 * Exit-Codes:
 *   0  Login erfolgreich, Tokens gespeichert.
 *   1  Falsche/fehlende Eingabe oder unerwarteter Fehler.
 *   2  Captcha verlangt, aber nicht lösbar (sollte mit Handler nicht auftreten).
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { UndiciHttpClient } from '../http';
import { PorscheAuth, CaptchaRequiredError, Tokens } from '../auth/porscheAuth';
import { saveTokens } from '../auth/tokenStore';
import { PorscheClient } from '../api/porscheClient';

/** Default-Speicherpfad für die Token-Datei, falls kein Argument übergeben wird. */
const DEFAULT_TOKEN_PATH = './porsche-tokens.json';

/**
 * Kleiner Prompt-Helfer auf Basis EINER readline-Schnittstelle für alle Fragen.
 *
 * - Sichtbare Frage: normales `question`.
 * - Verborgene Frage (Passwort): `_writeToOutput` wird übersteuert, sodass die
 *   Tastatur-Echos unterdrückt werden (Eingabe bleibt unsichtbar wie bei `sudo`).
 * - EOF/Ctrl-D während einer Frage liefert `null` (= Abbruch).
 */
function createPrompter(): {
  ask: (question: string, hidden: boolean) => Promise<string | null>;
  close: () => void;
} {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let muted = false;
  const writable = rl as unknown as { _writeToOutput: (s: string) => void };
  writable._writeToOutput = (str: string): void => {
    if (!muted) {
      process.stdout.write(str);
    }
  };

  let pendingResolve: ((value: string | null) => void) | null = null;
  rl.on('close', () => {
    if (pendingResolve) {
      const resolveFn = pendingResolve;
      pendingResolve = null;
      if (muted) {
        muted = false;
        process.stdout.write('\n');
      }
      resolveFn(null);
    }
  });

  function ask(question: string, hidden: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      pendingResolve = resolve;
      if (hidden) {
        process.stdout.write(question);
        muted = true;
      }
      rl.question(hidden ? '' : question, (answer) => {
        pendingResolve = null;
        if (hidden) {
          muted = false;
          process.stdout.write('\n');
        }
        resolve(answer);
      });
    });
  }

  return { ask, close: () => rl.close() };
}

type Prompter = ReturnType<typeof createPrompter>;

/**
 * Fragt E-Mail + Passwort über den übergebenen Prompter ab. Liefert `null`, wenn
 * die Eingabe abgebrochen oder leer war.
 */
async function readCredentials(
  prompter: Prompter,
): Promise<{ email: string; password: string } | null> {
  const emailRaw = await prompter.ask('E-mail: ', false);
  if (emailRaw === null) {
    console.error('\nAborted: no input (EOF).');
    return null;
  }
  const email = emailRaw.trim();
  if (!email) {
    console.error('Error: no e-mail address entered.');
    return null;
  }

  const password = await prompter.ask('Password (input is hidden): ', true);
  if (password === null) {
    console.error('Aborted: no password (EOF).');
    return null;
  }
  if (!password) {
    console.error('Error: no password entered.');
    return null;
  }

  return { email, password };
}

/** Dateiendung für einen `data:image/<subtype>`-MIME-Subtyp. */
function extForSubtype(subtype: string): string {
  const s = subtype.toLowerCase();
  if (s === 'svg+xml') return 'svg';
  if (s === 'jpeg') return 'jpg';
  return s.replace(/[^a-z0-9]/g, '') || 'img';
}

/**
 * Öffnet eine Datei im Standard-Viewer des Systems (macOS `open`, Linux
 * `xdg-open`, Windows `start`). Rein optional/nicht-fatal — schlägt es fehl,
 * bleibt der ausgegebene Pfad als Fallback.
 */
function tryOpen(file: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [file], { stdio: 'ignore', detached: true }).on('error', () => undefined);
  } catch {
    /* ignorieren – Pfad wurde ausgegeben, manuelles Öffnen möglich. */
  }
}

/**
 * Captcha-Handler: wandelt die Captcha-`data:image/...;base64,...`-URI in eine
 * ECHTE Bilddatei um (PNG/JPEG/GIF/SVG), legt sie neben der Token-Datei ab und
 * öffnet sie automatisch im Bild-Viewer. Zusätzlich wird die data-URI ausgegeben
 * (Browser-Fallback). Danach wird die vom Menschen gelesene Lösung abgefragt.
 */
function makeCaptchaHandler(prompter: Prompter, tokenPath: string) {
  return async (image: string): Promise<string> => {
    console.log('');
    console.log('\u26a0  Porsche requires a captcha - solve it once.');

    const m = image.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
    if (m) {
      const ext = extForSubtype(m[1]);
      const file = path.join(path.dirname(path.resolve(tokenPath)), `porsche-captcha.${ext}`);
      try {
        // base64 → Bild: Binärformate als Bytes, SVG als UTF-8-Text.
        const data =
          ext === 'svg' ? Buffer.from(m[2], 'base64').toString('utf8') : Buffer.from(m[2], 'base64');
        fs.writeFileSync(file, data);
        console.log(`   \u2022 Captcha saved as image: ${file}`);
        tryOpen(file);
        console.log('     (opens automatically; if not, open the file manually -');
        console.log('      on a headless server copy it over via scp/Samba)');
      } catch {
        console.log('   \u2022 Could not save the image - use the data URI below in a browser.');
      }
    }
    console.log('   \u2022 Alternatively paste this whole line into a browser address bar:');
    console.log('');
    console.log(image);
    console.log('');

    const solution = await prompter.ask('Captcha text from the image: ', false);
    return (solution ?? '').trim();
  };
}

/** Reduziert beliebige Fehler auf eine lesbare Meldung. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lädt nach erfolgreichem Login die Fahrzeugliste (nicht-fatal) und gibt VINs aus. */
async function printVehicles(
  http: UndiciHttpClient,
  auth: PorscheAuth,
  tokens: Tokens,
  tokenPath: string,
): Promise<void> {
  let current = tokens;
  const client = new PorscheClient(http, {
    getAccessToken: () => current.accessToken,
    refresh: async () => {
      const t = await auth.refresh(current.refreshToken);
      current = t;
      saveTokens(tokenPath, {
        refreshToken: t.refreshToken,
        accessToken: t.accessToken,
        expiresAt: t.expiresAt,
      });
      return t.accessToken;
    },
  });

  const vehicles = await client.listVehicles();
  if (vehicles.length === 0) {
    console.log('Keine Fahrzeuge im Konto gefunden.');
    return;
  }
  console.log('');
  console.log('Vehicles found (for the plugin config):');
  for (const v of vehicles) {
    const model = v.modelName ? ` (${v.modelName})` : '';
    console.log(`  • VIN: ${v.vin}${model}`);
  }
}

/** Hauptablauf. Liefert den Exit-Code zurück. */
async function main(): Promise<number> {
  const tokenPath = process.argv[2] ?? DEFAULT_TOKEN_PATH;

  console.log('porsche-auth - one-time login for the homebridge-porsche plugin');
  console.log('----------------------------------------------------------------');
  console.log(`Token file: ${tokenPath}`);
  console.log('');

  const prompter = createPrompter();
  try {
    const credentials = await readCredentials(prompter);
    if (!credentials) {
      return 1;
    }
    const { email, password } = credentials;

    const http = new UndiciHttpClient();
    const auth = new PorscheAuth(http);
    const onCaptcha = makeCaptchaHandler(prompter, tokenPath);

    let tokens: Tokens;
    try {
      console.log('');
      console.log('Melde an … (kann einen Moment dauern)');
      tokens = await auth.login(email, password, onCaptcha);
    } catch (err) {
      if (err instanceof CaptchaRequiredError) {
        console.error('');
        console.error('\u2717 A captcha was required but could not be solved.');
        console.error('  Please try again.');
        return 2;
      }
      console.error('');
      console.error(`✗ Login fehlgeschlagen: ${errorMessage(err)}`);
      console.error('  Check your e-mail/password (and the captcha) and try again.');
      return 1;
    }

    try {
      saveTokens(tokenPath, {
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
      });
    } catch (err) {
      console.error('');
      console.error(`\u2717 Login succeeded, but writing the token file failed: ${errorMessage(err)}`);
      console.error(`  Check write permissions for ${tokenPath}.`);
      return 1;
    }

    console.log('');
    console.log('\u2713 Login successful - tokens have been saved.');
    console.log(`  File: ${tokenPath} (mode 0600)`);

    try {
      await printVehicles(http, auth, tokens, tokenPath);
    } catch (err) {
      console.warn('');
      console.warn(`Hinweis: Fahrzeugliste nicht ladbar (nicht fatal): ${errorMessage(err)}`);
    }

    console.log('');
    console.log('Fertig. Das Plugin kann nun headless starten.');
    return 0;
  } finally {
    prompter.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Unexpected error:', errorMessage(err));
    process.exit(1);
  });
