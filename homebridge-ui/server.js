/* eslint-disable */
'use strict';

/**
 * Homebridge Custom-UI-Server für den Porsche-Login.
 *
 * Fährt den interaktiven Auth0-Login (E-Mail + Passwort, ggf. Captcha) direkt in
 * der Homebridge-UI — ohne CLI/scp. Der Login ist ZWEISTUFIG: `/login/start`
 * stößt den Flow an und kehrt entweder mit dem Captcha-Bild (data-URI) zurück
 * (dann zeigt das UI das Bild und schickt die Lösung an `/login/captcha`) oder
 * direkt mit dem Ergebnis. Die Tokens landen in `porsche-tokens.json` im
 * Homebridge-Storage — derselbe Pfad, den das Plugin liest.
 *
 * Nutzt die kompilierten Module aus `dist/` (Plugin muss gebaut sein).
 */

const path = require('path');
const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const { UndiciHttpClient } = require('../dist/http');
const { PorscheAuth } = require('../dist/auth/porscheAuth');
const { saveTokens } = require('../dist/auth/tokenStore');
const { PorscheClient } = require('../dist/api/porscheClient');

class PorscheUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    /** Aktiver Login-Flow (oder null): hält Captcha-Resolver + Abschluss-Promise. */
    this.flow = null;

    this.onRequest('/login/start', (p) => this.start(p));
    this.onRequest('/login/captcha', (p) => this.solveCaptcha(p));

    this.ready();
  }

  /** Token-Datei im Homebridge-Storage (identisch zum Plugin-Default). */
  tokenPath() {
    return path.join(this.homebridgeStoragePath, 'porsche-tokens.json');
  }

  /**
   * Startet den Login. Liefert entweder { status: 'captcha', image } (dann auf
   * /login/captcha warten) oder { status: 'done', vehicles } / { status: 'error', message }.
   */
  async start(payload) {
    const email = (payload && payload.email ? String(payload.email) : '').trim();
    const password = payload && payload.password ? String(payload.password) : '';
    if (!email || !password) {
      return { status: 'error', message: 'E-Mail und Passwort sind erforderlich.' };
    }

    const http = new UndiciHttpClient();
    const auth = new PorscheAuth(http);

    // captchaReady wird resolved, sobald der Auth-Flow ein Captcha verlangt.
    let captchaReadyResolve;
    const captchaReady = new Promise((resolve) => {
      captchaReadyResolve = resolve;
    });

    const state = { captchaResolver: null, http, auth };
    this.flow = state;

    const onCaptcha = (image) =>
      new Promise((resolve) => {
        state.captchaResolver = resolve;
        captchaReadyResolve({ status: 'captcha', image });
      });

    // Login im Hintergrund; das Ergebnis (Erfolg/Fehler) wird memoisiert.
    state.done = auth
      .login(email, password, onCaptcha)
      .then(async (tokens) => {
        saveTokens(this.tokenPath(), {
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
        });
        const vehicles = await this.listVehiclesSafe(http, tokens);
        return { status: 'done', vehicles };
      })
      .catch((err) => ({ status: 'error', message: errMsg(err) }));

    // Wer zuerst kommt: das Captcha-Bild oder das Login-Ergebnis.
    return Promise.race([state.done, captchaReady]);
  }

  /** Übergibt die Captcha-Lösung an den wartenden Flow und wartet auf das Ergebnis. */
  async solveCaptcha(payload) {
    const text = payload && payload.text ? String(payload.text).trim() : '';
    if (!this.flow || !this.flow.captchaResolver) {
      return { status: 'error', message: 'Keine aktive Captcha-Anfrage. Bitte erneut anmelden.' };
    }
    if (!text) {
      return { status: 'error', message: 'Bitte den Captcha-Text eingeben.' };
    }
    this.flow.captchaResolver(text);
    return this.flow.done;
  }

  /** Lädt nach dem Login die Fahrzeugliste (nicht-fatal — leeres Array bei Fehler). */
  async listVehiclesSafe(http, tokens) {
    try {
      let current = tokens;
      const client = new PorscheClient(http, {
        getAccessToken: () => current.accessToken,
        refresh: async () => current.accessToken,
      });
      const vehicles = await client.listVehicles();
      return Array.isArray(vehicles) ? vehicles : [];
    } catch {
      return [];
    }
  }
}

/** Reduziert beliebige Fehler auf eine lesbare Meldung. */
function errMsg(err) {
  if (!err) return 'Unbekannter Fehler.';
  if (err && err.message) return String(err.message);
  return String(err);
}

(() => new PorscheUiServer())();
