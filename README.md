<div align="center">

# 🚗⚡ homebridge-porsche

**Bring your Porsche into Apple Home — natively, no Docker, no Home Assistant.**

A self-contained [Homebridge](https://homebridge.io) plugin that talks directly to Porsche's
Connect / PPA API and exposes your car as clean, everyday HomeKit tiles: climate as a
**thermostat**, charge level (or fuel level) as a **slider**, lock, charging, vehicle status,
find-my-car, and more.

> Works with the general **Porsche Connect** API across models. **Developed and live-tested on the
> Taycan (EV);** combustion / plug-in-hybrid support (`vehicleType`) is implemented from the same API
> but not yet verified on those cars — feedback welcome.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![Homebridge](https://img.shields.io/badge/homebridge-%E2%89%A51.6-purple.svg)](https://homebridge.io)
[![Tests](https://img.shields.io/badge/tests-214%20passing-success.svg)](#-development)

</div>

> ⚠️ **Unofficial project.** Not affiliated with, endorsed by, or supported by Dr. Ing. h.c. F. Porsche AG.
> It uses a reverse-engineered, undocumented API that can change or break at any time. Use at your own risk,
> with your own Porsche ID account.
>
> **Porsche** and **Taycan** are trademarks of Dr. Ing. h.c. F. Porsche AG. They are used here for
> identification and compatibility purposes only — no Porsche logo or crest is used. See [NOTICE](NOTICE)
> for third-party attribution. This is a **non-commercial, community project**; should the rights-holder
> object to the name, it will be renamed.

---

## ✨ Why this plugin

Most "car in HomeKit" setups need a Docker stack or Home Assistant bridge. This one is a **single
Homebridge plugin** — install it, log in once, done. It runs **headless** afterwards on a refresh
token and is built to be gentle on the car's 12 V battery (it never force-wakes the vehicle; it only
polls the cached status endpoint on a clamped interval).

## 🎛️ What you get in Apple Home

A focused set of **everyday tiles** (`detailLevel: "essential"`, the default):

| Tile | HomeKit type | What it does |
| --- | --- | --- |
| 🌡️ **Climate** | Thermostat | Pre-conditioning as a real thermostat — set the target temperature, it's sent to the car; off/heat toggles it |
| 🔋 **Charge level** | Dimmer slider | State of charge as a slider you read at a glance |
| 🛣️ **Range** | Light sensor | Remaining range (HomeKit has no "km" unit, so the value shows as "lx" — the number is the range) |
| 🔌 **Charging** | Switch | Start / stop charging |
| 🎯 **Charge limit** | Dimmer | Target state of charge (e.g. 80 %) |
| 🪫 **Battery** | Battery | Level + charging state + low-battery warning |
| 🚨 **Battery low** | Contact sensor | Opens at/under the threshold → native low-battery push notification |
| 🔒 **Lock** | Lock mechanism | Lock the car; unlock via S-PIN (optional, see below) |
| 🛡️ **Vehicle status** | Contact sensor | "secure" = locked + everything closed; "open" otherwise |
| 📣 **Flash / Honk** | Switches | Find the car (flash lights / honk + flash) |
| 🏠 **Car at home** | Occupancy sensor | Detected when the car is within your home radius (GPS) |
| 📡 **Connection** | Contact sensor | Plugin/auth health |

Set `detailLevel: "full"` to additionally expose the complete cockpit: per-tyre pressures &
warnings, odometer & service range, individual doors/windows/frunk/trunk, climate zones, parking
brake, heading, privacy mode and more (≈ 55 tiles).

> 💡 **Tip:** Put the plugin on its own **child bridge** (Homebridge UI → plugin settings → *Bridge*)
> to give the Taycan its own room in Apple Home.

## 📦 Installation

Search for **`homebridge-porsche`** in the Homebridge UI, or:

```bash
npm install -g homebridge-porsche
```

## 🔑 First-time login

You sign in **once** with your Porsche ID — the plugin then keeps a long-lived **refresh token** and
runs fully headless afterwards. Pick whichever is easier; both end up writing the same token file.

### 🌐 Option A — right in your browser (recommended)

No terminal, no `scp`. Open the **Homebridge UI**, go to the plugin's **Settings**, and a login card
greets you at the top:

```text
┌────────────────────────────────────────────────┐
│  🔑  Sign in to Porsche                          │
│                                                  │
│   E-mail (Porsche ID)   [ name@example.com    ]  │
│   Password              [ ••••••••            ]  │
│                                   [  Sign in  ]  │
│                                                  │
│   ↳ captcha required? it appears here as an image│
│      ┌──────────────┐                            │
│      │   a 7 X q 2  │   [ enter text ]  [  OK  ] │
│      └──────────────┘                            │
└────────────────────────────────────────────────┘
```

1. Enter your **Porsche ID e-mail** and **password**, then hit **Sign in**.
2. If Porsche requires a **captcha**, it's rendered **as a real image right in the page** — read it,
   type the text, confirm.
3. On success the card lists your detected vehicle(s). **Restart Homebridge** and your tiles appear.

Your password is used only for this login and is **never stored** — only the refresh token is written
to `porsche-tokens.json` in your Homebridge storage directory.

> The browser login is powered by a [custom Homebridge UI](https://github.com/homebridge/plugin-ui-utils)
> — it runs locally inside your Homebridge instance; credentials never leave your network except to
> Porsche's own login endpoint.

### 💻 Option B — via CLI (headless setups)

Running Homebridge somewhere without convenient UI access? Use the bundled CLI **once** on the host:

```bash
porsche-auth                       # writes ./porsche-tokens.json
# or choose where the token file goes:
porsche-auth /var/lib/homebridge/porsche-tokens.json
```

It asks for your Porsche ID **e-mail + password** (entered interactively, never stored), obtains the
long-lived **refresh token**, and writes it to a `0600` token file.

#### 🖼️ Captcha → image (automatic)

If Porsche asks for a captcha, `porsche-auth` decodes the `data:image/...;base64,...` payload into a
**real image file** (PNG/JPEG/GIF/SVG) next to your token file and **opens it automatically**:

```
⚠  Porsche requires a captcha – solve it once.
   • Captcha saved as image: /var/lib/homebridge/porsche-captcha.png
     (opens automatically; on a headless server copy it over via scp)
   • Alternatively paste this whole line into a browser address bar:
   data:image/png;base64,iVBORw0KGgo…
Captcha text from the image:
```

On a headless server, `scp` the image to your machine (or use the printed data-URI in any browser),
read the text, type it in.

## ⚙️ Configuration

Add the **Porsche** platform via the Homebridge UI, or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "Porsche",
      "name": "Porsche",
      "vehicleName": "Porsche",
      "language": "en",
      "vehicleModel": "Porsche",
      "vin": "",
      "detailLevel": "essential",
      "vehicleType": "ev",
      "homeLat": 0,
      "homeLon": 0,
      "homeRadiusM": 150,
      "pollIntervalMinutes": 15,
      "defaultTargetTemp": 21
    }
  ]
}
```

| Key | Default | Description |
| --- | --- | --- |
| `vehicleName` | `Porsche` | Display-name prefix for all tiles (set this to your model, e.g. `Macan`, `911`) |
| `language` | `en` | Language of the tile names — `en` or `de` |
| `vehicleModel` | `Porsche` | Shown as the *Model* in each accessory's HomeKit details |
| `vin` | _(first vehicle)_ | Fix a VIN if the account has several cars |
| `detailLevel` | `essential` | `essential` (everyday tiles) or `full` (entire cockpit) |
| `vehicleType` | `ev` | `ev` (charge/range/charging), `combustion` (fuel level + range) or `phev` (both) |
| `homeLat` / `homeLon` | `0` / `0` | Home coordinates for "car at home" — **set these**, `0/0` disables it |
| `homeRadiusM` | `150` | Home radius in metres |
| `pollIntervalMinutes` | `15` | Status poll interval (clamped to **≥ 10 min** for 12 V safety) |
| `defaultTargetTemp` | `21` | Default climate target (°C) until the car reports its own |
| `spin` | _(empty)_ | Porsche **S-PIN** — required only for **unlocking** (see below) |

### 🔓 Unlocking (optional, needs your S-PIN)

Locking works out of the box. **Unlocking** requires your 4-digit Porsche **S-PIN**
(from the My Porsche app). Set it under `spin` in the plugin config and the Lock tile becomes a full
lock/unlock toggle. The S-PIN is used locally for Porsche's challenge/response
(`SPIN_CHALLENGE → SHA-512 → UNLOCK`) and is stored in plain text in your Homebridge config — only
add it if you're comfortable with that.

## 🔒 Safety & privacy

- **12 V-friendly:** never schedules a wake-up; only reads the cached measurement endpoint, poll
  interval clamped to ≥ 10 min.
- **Tokens** live solely in your local token file (`0600`), never transmitted anywhere but Porsche.
- **Lock** is a HomeKit *secure accessory*: unlocking via Siri/automation requires Face ID / passcode.

## 🤖 Automations

Because everything is native HomeKit, you can build automations in the Home app — e.g. pre-condition
on a schedule, "battery low" push notifications (via the **Battery low** contact tile's native
notification toggle), or charge-on-arrival via **Car at home**.

## 🧑‍💻 Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # jest (214 tests)
```

The codebase is split by domain: `src/api` (PPA client, commands, measurements, auth),
`src/accessories` (one module per domain: charging, climate, access, telemetry, watchdog) and
`src/platform.ts` (orchestration + poll loop).

## 🙏 Credits

The Porsche Connect / PPA API behaviour (endpoint URLs, the `key` command wire field, the
201 → job-poll flow and the S-PIN challenge hash) was **independently re-implemented in TypeScript**
with reference to [**pyporscheconnectapi**](https://github.com/CJNE/pyporscheconnectapi) by
Johan Isacsson (MIT-licensed). This project contains **no copied source code** — see
[NOTICE](NOTICE) for the full attribution. Thank you, Johan! 🙏

## 📄 License

[MIT](LICENSE) © SchwabJ
