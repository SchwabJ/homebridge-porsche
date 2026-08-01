# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.19.0] — 2026-08-01

### Added
- **The drivetrain is now detected**, and evaluations that cannot hold for it
  stay quiet. The vehicle list — which the plugin never fetched once a VIN was
  configured — carries a `modelType` object; measured on a Taycan it reads
  `{ code: 'Y1BBD1', year: '2023', body: 'CUV', generation: 'J1',
  model: 'TAYCAN', engine: 'BEV' }`. The `engine` field says it outright.

  This matters because measured capacity is computed from the distance
  between two charges. If a plug-in hybrid covers part of it on fuel, the
  result is not imprecise but wrong — and everything built on it (kWh per
  charge, cost, savings, consumption, the battery report) would be **quietly**
  wrong rather than visibly broken. A battery report with invented numbers,
  handed over when selling the car, is the worst kind of error there is.

  Measured capacity, the battery report and the battery warning therefore stay
  off unless the drive is confirmed electric. **Unknown counts as not
  electric**: an older account may not report a drivetrain, and Porsche may
  introduce new values — silence is better than a guess. The report says *why*
  it is empty, because a blank page without a reason reads like a fault.

## [0.18.0] — 2026-08-01

### Added
- **Charging power as a second line in the charge curve.** The curve showed
  only the state of charge; how hard the car was charging appeared solely in
  the crosshair on hover, so nowhere for anyone just looking at it. On a
  charge curve that is half the story: on AC the power runs flat, at a rapid
  charger it tapers off as the level rises, and that taper is exactly what you
  want to see. Scaled to this charge's own maximum, labelled — an 11 kW
  wallbox against a 270 kW axis would be a line stuck to the floor.
- **Warning for a slow puncture.** Tyre pressure has always been recorded, and
  each wheel had a sparkline; what was missing is the distinction that
  matters. Pressure follows temperature — a cold night against a warm
  afternoon is easily 0.1 bar — so judging one wheel on its own reports four
  flat tyres every autumn. A puncture affects **one** wheel, so what counts
  here is the loss relative to the other three.
- **Download the whole log as one file** (`/mitschrieb.jsonl`, linked from
  settings). The JSONL files are this plugin's actual capital: the only source
  for capacity, consumption and every report, and impossible to obtain
  afterwards. There was no download, no backup and no way to move to a new
  machine.

### Fixed
- **A stray `.jsonl` file in the log directory could still take everything
  down.** Day files were recognised by their extension alone, so a
  half-restored backup or an export was read as if it were a recording — one
  line without a timestamp used to put all routes on HTTP 500 permanently. The
  name is now part of the format (`YYYY-MM-DD.jsonl`). The new download makes
  this necessary rather than merely careful: it produces exactly such a file.

## [0.17.0] — 2026-08-01

### Added
- **Vehicle commands from the dashboard** — preconditioning, start and stop
  charging, lock. The commands have been built for a long time but were only
  reachable through HomeKit: whoever had the page on their home screen could
  see everything and do nothing.

  **The route requires a password.** Without `dashboardPassword` it does not
  exist, handler or not, and the buttons stay hidden. The difference from
  reading along is qualitative: seeing a charging history is unpleasant, but
  starting a stranger's air conditioning at night or stopping their charge is
  something else. Only a fixed list of five commands is accepted — what is not
  on it does not exist for the page, so the route cannot become an open door
  to whatever the backend happens to accept. Unlocking is deliberately absent:
  it needs the S-PIN, and a button that opens a car does not belong on a page
  left open in a browser.

  The bar is contextual — whatever is running gets its counterpart button —
  and stopping a charge asks first, because pressing it by accident at night
  means a car that will not get far in the morning.

### Changed
- The POST-and-same-origin check for routes with an effect lived inline in
  three places, word for word. It is now one helper. The copy you forget on
  the next route is exactly the class of gap the refresh button once had.

## [0.16.0] — 2026-08-01

### Added
- **Optional password for the dashboard**, and a configurable bind address.
  The page listens on all interfaces and handed anyone on the network your
  charging history, odometer and home/away status without asking. For a plugin
  distributed publicly that is not a hardening detail but a real gap: a guest
  on the Wi-Fi, an IoT device or a compromised TV all read along without doing
  anything wrong.

  **The default stays unprotected on purpose** — changing it would lock out
  every existing installation, and someone who trusts their home network
  should keep the choice. What is new is that the choice exists. Set
  `dashboardPassword` and any username works; only the password is checked,
  in constant time. `dashboardBind` can restrict the page to `127.0.0.1`, for
  instance behind your own reverse proxy.

  The web manifest stays open — the browser fetches it without credentials,
  and a 401 would leave the home-screen entry without an icon or name. It
  carries no vehicle data.

  The startup log now states the actual situation instead of always warning. A
  warning that also appeared with a password set would be background noise by
  the third restart — and then the people it concerns stop reading it too.

## [0.15.0] — 2026-08-01

### Added
- **Annual statement at `/jahresbeleg`**, with CSV and a link from the monthly
  receipt. Since 1 January 2026 the flat monthly allowances for company-car
  electricity charged at home no longer apply in Germany; a tax-free
  reimbursement from an employer now requires evidence of the kilowatt-hours
  charged — and that is filed per year. Until now you would have printed
  twelve monthly receipts and added them up yourself. It states monthly totals
  and the annual total, home charging first, because only that qualifies.
- **Warning when the battery has measurably degraded.** The threshold is 85 %
  of rated capacity — well above the usual 70 % warranty floor, because a
  message at the floor comes too late to prove anything: a claim needs
  evidence that has been running for a while. It fires only once the data
  supports it, at most once a month, and points at the battery report.

## [0.14.0] — 2026-08-01

### Added
- **Warning when the car loses too much while parked.** Two cases from the
  Taycan forum that both surfaced too late: one owner went from 85 to 63 % in
  three weeks on the cable and then 5 to 10 % a day — a single weak cell — and
  another reported 3 % over a few days. Both noticed only when the range was
  missing; nobody warned them, and the app does not show the figure at all.
  The analysis already existed here; it just stood silently on the status page.

  It stays quiet where it knows nothing: not on a mere upper bound (when the
  charge level barely moved, the analysis states "at most this much" rather
  than a measurement), not below three days of standstill (the level is a
  whole number, so a single point is nearly one percent), and at most once a
  week. The threshold is 2 % per day — far enough above normal (well under
  1 %) not to fire on every cold weekend, far enough below the reported faults
  to catch them.

## [0.13.0] — 2026-08-01

### Added
- **Battery report at `/batterie`** — the measured capacity as a document you
  can hand to someone, printable, in the same shape as the charging receipt
  and the trip report. Learning the state of a Taycan battery is awkwardly
  hard today: the official app does not show it, the dealer measures it on
  request, and owners resort to OBD dongles and multi-day procedures. This
  plugin measures it anyway — what was missing was the form.

  It is laid out the way a buyer or a warranty desk would check it: the figure
  with its uncertainty, then where it comes from (cycles, distance, period),
  then the monthly trend, then the method in plain words. **A loss figure only
  appears when the data supports one** — at least ten discharge cycles over at
  least sixty days. Below that, the same spot states why not: single cycles
  scatter by several percent, and over two weeks no ageing stands out from
  that, however many cycles fall inside. Showing a number and hiding its
  uncertainty would defeat the entire purpose of the page.

  Reachable through the heading of the measured-capacity tile.

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
