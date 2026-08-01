# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.12.0] — 2026-08-01

### Fixed
- **The charging window now stays out of the way when a tariff is already
  pacing the charge.** With Intelligent Octopus Go, Tibber, a controlling
  wallbox or a plan in the car, a second window beside it is not a saving
  scheme but a race: the provider starts, we stop, the provider starts again.
  It is recognisable from the pauses in recent charges — a charge interrupted
  repeatedly while still short of its target was interrupted by someone else.
  What counts is the level *before* each pause, not at the end: a paced tariff
  also charges up to the target eventually, so judging the charge as a whole
  would miss the most common case entirely. With no history at all the answer
  is "hands off".

### Changed
- **Four lines of height reclaimed in the header**, without losing a single
  statement. Gone are the charging rate in km/min (the finish forecast one
  line below answers the same question, better), the word "Monitoring" in
  front of the age of the last reading, the date on a charge that is running
  *right now*, and "instead of €19.41" in the cost tile — that is the saving
  computed backwards, and the saving itself already stands next to it.

## [0.11.0] — 2026-08-01

### Changed
- **The running charge moved into the status area at the top**, and the
  separate card below the tiles is gone. The card repeated the charge level
  and target that already stood at the top, while sitting far down the page —
  anyone asking what the car is doing *right now* looks up, so everything
  about the present belongs in one place.
- **It leads with the energy charged so far** instead of the starting level.
  That is the number which grows during a charge; the starting level stands
  still and says nothing about how much is already in the battery.
- **Cable time and actual charging time are now shown separately.** Seeing
  "2.5 kWh" next to "charging at 10.1 kW" invites the wrong arithmetic: the
  cable had been connected for 24 minutes, but current had only been flowing
  for 17. Both numbers were right; side by side they looked wrong. The charge
  list has made this distinction for a while.

## [0.10.0] — 2026-08-01

### Added
- **Charging window.** Charge only between two times you choose — `00:30` to
  `04:30` for a night tariff, for instance. The car's own timer knows a
  departure time but no window, which owners have been asking for for years;
  one put it plainly: *"all I require is a timer to only charge in this time
  range. i didn't realise it would be so complicated."* There are also
  documented cases of a working charging plan silently reverting to instant
  charging, and of a running charge that cannot be stopped from the app at
  all. This plugin runs in your house and polls every three minutes while
  plugged in, so it can simply start and stop charging itself.

  Restraint is the rule. Nothing happens without a configured window (the
  default), without a cable, or on any unknown reading — the API answers some
  polls without values, and stopping a charge on a guessed state of charge
  would be the worst mistake this feature could make. The car's own
  instant-charge threshold is never overridden: below it the car charges
  whatever the clock says, because a usable car is worth more than cheap
  electricity. A mistyped window is rejected rather than guessed.

## [0.9.0] — 2026-08-01

### Added
- **Warning when a charge stalls.** The car is still plugged in, the target is
  far off, and no power has flowed for hours — the message goes out that night
  instead of the next morning, while there is still time to react. Among
  Taycan owners this is the most frequently voiced wish: the Porsche app sends
  nothing when a wallbox drops out mid-charge.
- **A failed charge is reported as failed.** The plugin already detected it and
  showed it on the status page, but the push still read "charging finished"
  and quoted a level, never mentioning that the car had been plugged in and
  had stopped. Now the title says so and the first line contrasts the level
  reached with the one wanted.
- **The vehicle's own trip counter** — distance, driving time and average
  speed — is now read and recorded, not just consumption. Note that this is
  the resettable counter the car keeps, not a monthly history: the API offers
  no trip history at all (`TRIP_STATISTICS_LONG_TERM` and friends return
  nothing), which is why a monthly report can only cover what this plugin has
  recorded itself.
- **Nine further fields are now recorded** that were parsed and thrown away:
  the car's own remaining-charge estimate, parking light and brake, privacy
  mode and remote access, the active charging profile, and doors, windows and
  lids separately instead of one combined flag. A window left open overnight
  is not the same thing as a door opened briefly.

### Changed
- **Push messages follow the `language` setting.** They were the only texts in
  the plugin hard-wired to German — an owner in England got an English screen
  and a German notification on their phone. The title also uses the configured
  vehicle name instead of a fixed "Taycan".

## [0.8.2] — 2026-07-31

### Added
- **Estimated finish time for the running charge.** Computed from the state of
  charge left times capacity, divided by the *average* power of the charging
  phases so far — not the instantaneous reading, which is zero during every
  slot pause. A clock time appears only when charging has run essentially
  without pauses; under a time-of-use tariff the future slots belong to the
  provider, and a guessed time would be worse than none. Then it states the
  pure charging time and says so. A stalled charge gets the warning instead of
  a forecast.

### Fixed
- **An unknown plug state was claimed to be "not plugged in."** `!undefined`
  is `true`, so a poll the API answered without any readings read as unplugged.
  Measured over a week of logs: at 14 samples the cable was demonstrably
  connected — they sit between two `plugged: true` readings, and across two of
  them about 10 kW kept flowing. The badge now says the state is unknown and
  stays grey; carrying the last known value forward was rejected because it
  only trades this false claim for the opposite one. The same branch also
  covers the state before the first sample ever arrives.

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
