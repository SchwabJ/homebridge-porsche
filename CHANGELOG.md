# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.8.1] — 2026-07-31

### Fixed
- **State of charge and range disappeared from the header**, showing `—` with
  the bar at zero, and the charge-level tile vanished from the status page —
  while the value was minutes old. The API answers part of the polls with the
  charging state only; measured over five days, 7 % of samples carry no state
  of charge. A missing field there means *not sent*, not *not present*, but
  the header read the last sample verbatim. Whether you saw a number depended
  on which kind of sample happened to be last.
- **"As of HH:MM" now names the time of the reading**, not of the poll. How
  fresh the poll is already stands next to it.

## [0.8.0] — 2026-07-31

Charging history release: monthly reports, CSV exports, tariff history — and a
round of fixes that came out of running the dashboard against real data for a
week.

### Added
- **Monthly reports for both lists.** The charging receipt now has a sibling:
  a **trip report**. Both share layout, month picker, print rules and carry
  their own CSV download, reachable through the same link under each list.
- **CSV exports** for the full trip and charge lists (`/fahrten.csv`,
  `/ladungen.csv`), optionally limited to one month. Separator and decimal
  mark follow your `language` setting, so a spreadsheet opens them without
  asking.
- **Tariff history.** A price change applies from a date you pick; charges
  before it keep their old price. Without this, one price change silently
  rewrote every past receipt — which matters if you hand them in for
  reimbursement.
- **Adopt measured capacity.** Once enough discharge cycles exist, the
  measured value can replace the configured one. A new car's datasheet figure
  is simply wrong for an aged battery, and every kWh number scales with it.
- **Default view** for the dashboard (day/week/month/year).
- **Idle drain** on the status page: what the car loses standing still,
  excluding preconditioning and the first hour after a drive. States an upper
  bound instead of a made-up decimal while the state of charge barely moves.
- **Time axis under the charge curve** — start, duration and end. Previously
  there was no way to tell whether a curve covered two hours or eight.
- **Tappable bar details.** The SVG `<title>` only appears on mouse hover,
  which phones do not have. First tap shows the details, second tap on the
  same bar opens that sub-period.

### Fixed
- **A stray `.jsonl` file in the log directory took the whole dashboard
  down** — 17 of 17 routes returned HTTP 500, permanently, with no page left
  to diagnose from. A half-restored backup was enough to trigger it.
- **Measured capacity came out too high** because idle drain was subtracted
  beyond the measurement frame (107.1 instead of 100 kWh in a reproduction).
- **After a silent trip-counter reset**, the next trip inherited the discarded
  trip's distance — 40 instead of 20 kWh/100 km.
- **The day boundary corrupted hour labels and gap filling**, and at the
  daylight-saving switches one hour landed on the wrong day.
- **Kilometres without a consumption reading were counted twice** — once as
  rated, once as unrated — making the consumption tile read high.
- **A missing plug state discarded charge gains**, so kWh, cost and savings
  came out low while the session list disagreed.
- **Colour-scheme metadata contradicted the stylesheet**: light mode showed
  dark form controls and a dark browser bar on a light page.
- **The 60-second auto-reload interrupted whatever you were doing** — open
  charge curves collapsed, scroll position jumped, a half-filled price form
  was lost.
- **The refresh button reported through the `title` attribute**, which phones
  do not show: on failure or cooldown the icon simply stopped spinning with
  no explanation. It now says so visibly.
- **The empty-state box had no styling outside the dashboard.**

### Changed
- Charge curves are capped at 80 points. At 720 px chart width that is one
  point every nine pixels — finer than a screen can show, but each one used
  to travel twice into the HTML. Measured on a year of data: month page
  360 → 220 kB.
- When the instant-charge threshold and the charge target coincide, the mark
  now reads **target** instead of *instant to*. Previously the target line —
  the one that actually bounds the curve — disappeared entirely in that case.
- Explanatory sentences under the tiles and lists were removed. What explains
  *how* a number is produced belongs in the code, not on the page.

## [0.7.0] — 2026-06-21

### Added
- Multi-language UI (`language: 'en' | 'de'`, default English).
- Configurable `vehicleModel` instead of a hard-coded "Taycan".
