<div align="center">

# 🚗⚡ homebridge-porsche

**Bring your Porsche into Apple Home — natively, no Docker, no Home Assistant.**

A self-contained [Homebridge](https://homebridge.io) plugin that talks directly to Porsche's
Connect / PPA API and exposes your car as clean, everyday HomeKit tiles: climate as a
**thermostat**, charge level (or fuel level) as a **slider**, lock, charging, vehicle status,
find-my-car, and more — plus a **charging history** the Porsche API itself doesn't offer, with its
own dashboard on your network.

> Works with the general **Porsche Connect** API across models. **Developed and live-tested on the
> Taycan (EV);** combustion / plug-in-hybrid support (`vehicleType`) is implemented from the same API
> but not yet verified on those cars — feedback welcome.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![Homebridge](https://img.shields.io/badge/homebridge-%E2%89%A51.6-purple.svg)](https://homebridge.io)
[![Tests](https://img.shields.io/badge/tests-366%20passing-success.svg)](#-development)

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

It also keeps a record: because the API has no charging history, the plugin writes one and serves it
as a [dashboard](#-charging-history--dashboard) — when you charged, how much, how fast, and what it
cost.

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

The charging history adds `pricePerKwhCt`, `chargingBonusCt`, `capacityKwh`, `dashboardPort`,
`dayBoundaryHour`, `pluggedPollMinutes` and the `ntfy*` keys — all optional, all explained under
[Charging history & dashboard](#-charging-history--dashboard).

### 🔓 Unlocking (optional, needs your S-PIN)

Locking works out of the box. **Unlocking** requires your 4-digit Porsche **S-PIN**
(from the My Porsche app). Set it under `spin` in the plugin config and the Lock tile becomes a full
lock/unlock toggle. The S-PIN is used locally for Porsche's challenge/response
(`SPIN_CHALLENGE → SHA-512 → UNLOCK`) and is stored in plain text in your Homebridge config — only
add it if you're comfortable with that.

## ⚡ Charging history & dashboard

Porsche's API offers **no charging history** — the app shows you the present, and that's it. So the
plugin builds one itself: every poll is appended to a day-rotated JSONL file, and charging sessions
are reconstructed from that log. A small dashboard on your local network shows them by **day, week,
month and year**.

Open it at `http://<your-homebridge-host>:8099`. It's a single self-contained page — no build step,
no external assets — and installs to your home screen as a web app.

| What it shows | Notes |
| --- | --- |
| ⚡ **Energy per period** | kWh charged, with a bar chart per day/week/month/year |
| 💶 **Cost and savings** | Only if you configure a price — see below |
| 🛣️ **Range added & km/min** | Measured from the car's own range estimate, not derived from kWh |
| 📈 **Charge curve per session** | State of charge over time, with the tariff windows as bands |
| 🔋 **Measured battery capacity** | Estimated from driving data, so you can sanity-check `capacityKwh` |
| ⚠️ **Data-quality warnings** | Says so when polls were missed, instead of quietly understating |

**One session = one cable connection.** The boundary is *plugged in → unplugged*, not
*charging → not charging*. If your tariff switches the car on and off in 15-minute windows (Octopus,
Tibber and friends), that's still **one** charge, shown with its individual phases when you expand it.

### 💶 Costs are opt-in

There are two price fields, both **0 by default**:

| Key | Default | Description |
| --- | --- | --- |
| `pricePerKwhCt` | `0` | Your energy price in **cents per kWh**. At `0`, no cost figures appear anywhere |
| `chargingBonusCt` | `0` | Discount per kWh, e.g. for letting a tariff pick the charging times. The dashboard shows what you paid, what it would have cost without the bonus, and the difference |
| `capacityKwh` | `83.7` | **Set this for your car.** Charged energy is `state-of-charge delta × capacity`, so a wrong value scales every kWh figure |
| `dashboardPort` | `8099` | `0` disables the dashboard entirely |
| `dayBoundaryHour` | `0` | Set to e.g. `4` so an overnight charge counts towards the evening it started |
| `pluggedPollMinutes` | `1` | Poll interval while the cable is connected. Allowed below the 10-minute floor because the car is on mains power — short tariff windows need it |

Leaving the price at `0` is a deliberate default: an invented price would be worse than none.

### 🎯 Accuracy, honestly

- Energy comes from the **state-of-charge delta**, not from integrating power. That survives missed
  polls, but it depends on `capacityKwh` being right for *your* car — the dashboard measures your
  real capacity from driving data and shows it, so you can correct the setting.
- The figures are the energy that reached the **battery**, while your meter bills what left the
  **wall**. Expect real cost to run a few percent above what's shown.
- Where the data is too thin to say anything useful, the dashboard says so rather than printing a
  confident-looking number.

### 🔔 Push notifications (optional)

Set `ntfyTopic` to get a daily summary and a message when a charge finishes, via
[ntfy](https://ntfy.sh). Leave it empty and nothing is sent — no connection is made at all. Pick an
unguessable topic name: ntfy topics are publicly addressable.

## 🔒 Safety & privacy

- **12 V-friendly:** never schedules a wake-up; only reads the cached measurement endpoint, poll
  interval clamped to ≥ 10 min.
- **The dashboard has no authentication** and is meant for your LAN only. Anyone who can reach the
  port can read your charging history. Don't forward it through your router; it serves `GET` only
  and has no write routes, but that is not a substitute for keeping it off the internet.
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
npm test           # jest (366 tests)
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
