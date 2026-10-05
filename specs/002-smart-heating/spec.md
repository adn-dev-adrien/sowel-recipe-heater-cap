# Spec 002 — Smart heating: occupancy sources, pre-heat, weather

Status: **implemented (v1.0.0)**, validated by Adrien on 2026-10-05.
Visual summary with a day simulator: `maquettes/smart-heating.html`.

## Why this recipe, and not a new one

Two needs share one engine:

- **Office** (zone `Bureau`): 22 °C from 06:30 on workdays, a PIR (`BureauPir`) to detect days
  off and early departures, the lowest possible consumption.
- **Gîte**: each room heated from the stay dates (guestFlow when it is installed), with a day and
  a night temperature, and nothing when the place is empty.

The gîte's rooms already run `heater-cap` (5 instances) on the very relays a second recipe would
drive, and two recipes on one relay fight. Adrien chose (2026-10-05) to **grow `heater-cap`**:
the id stays `heater-cap`, the display name becomes "Chauffage intelligent", and **an instance
with no occupancy source behaves exactly as v0.2.0** (cap, window cut-off, frost mode, manual
grace). Existing instances need no change.

## Building blocks

Every block is optional except the room. An empty block is ignored.

| Block | Slots | Used for |
| --- | --- | --- |
| Room (required) | zone, `heaters` (list, all driven together), `sensor` | Thermostat on the room sensor |
| Temperatures | `comfortTemp` (day), `nightTemp`, `frostTemp` (= absence), `maxTemp` (cap) | Targets |
| Occupancy source | `source`: `none` / `schedule` / `stays` | Decides occupied vs empty |
| Schedule | workdays, `workStart`, `workEnd` | `source = schedule` |
| Stays | `staysEquipment` (keys `occupied`, `arrival`, `departure`) | `source = stays` |
| Night | `nightStart`, `nightEnd` | Day/night switch while occupied |
| Presence | `motion` (equipment or zone motion), check intervals | Optional refinement |
| Weather | `outdoorSensor`, `forecast` (`weather_forecast`) | Pre-heat start, sun, coasting |
| Windows | unchanged from v0.2.0 | Cut-off |

`source = none` with no night window and no presence = **the v0.2.0 cap**, unchanged.

## Targets

- `auto` mode, occupied: `comfortTemp` by day, `nightTemp` in the night window.
- `auto` mode, empty: `frostTemp` (absence). Default for new instances **12 °C**; the gîte keeps
  its 7 °C.
- `maxTemp` remains a hard ceiling in every mode.
- Pill: `Auto` / `Confort` (forced until midnight) / `Absent` (stored as `frost`, unchanged value)
  / `Pause` (`off`, unchanged).
- When a source is set, the recipe **drives** the relays (thermostat, hysteresis 0.3 °C) instead
  of only vetoing them. The radiators' own thermostats must be set above `comfortTemp`.
  A wall-switch press still buys `manualGrace`.

## Occupancy sources

### `schedule` (office)

Without presence: comfort during work hours on workdays, absence otherwise.

With presence:

1. Arrival window (start → `confirmBy`, 08:00): comfort, presence assumed.
2. `confirmBy`: no motion since pre-heat started → day off, absence.
3. Until `fastFrom` (15:00): a check every `slowInterval` (1h30). From `fastFrom`: every
   `fastInterval` (30 min). No motion during the interval → absence.
4. Motion after any cut → comfort until no motion for the current interval (decision B).
5. Outside work hours and at weekends: motion with no gap > 5 min for `sustainFor` (15 min) →
   comfort, until `absentAfter` (30 min) without motion.

### `stays` (gîte)

Reads an equipment exposing `occupied` (bool), `arrival` and `departure` (ISO-8601). Empty
before `arrival` (pre-heat aims for `comfortTemp` at `arrival`), day/night during the stay,
absence from `departure`. With presence: a room with no motion for `idleAfter` (2 h) in the day
drops to `nightTemp`, motion restores comfort.

The recipe knows nothing about guestFlow. **Without guestFlow** the slot stays empty and the
owner uses the pill (`Absent` when empty, `Auto` during a stay) — today's workflow.

Where the stays come from (decided 2026-10-05): **the gate channel is reused**. guestFlow adds
a `stay` block (property, real arrival and departure) to the key list Sowel already reads hourly
over the signed channel (guestFlow `specs/sowel-stays-in-keys.md`, contract v3); the
`guestflow` plugin publishes one "Séjours" device per property (its `specs/001-stays/spec.md`).
Each of the three HTML summaries carries the same interactive overview.

### `none`

Always occupied: day/night only (with presence: same idle rule as `stays`).

## Pre-heat

Whenever the target is about to rise (work start, arrival, end of night), the recipe starts as
late as possible to reach it on time (15 min margin):

`dT/dt = gain − (Tin − Tout) / tau + sun`

- `Tout`: the forecast plugin's hourly series (`irradiance_120h` also carries an hourly
  temperature, today included — found while implementing), corrected by the live outdoor
  sensor; else the sensor alone; else the evening snapshot below; else 5 °C.
- Today's forecast: the plugin publishes J+1..J+5 only, so the recipe **snapshots `j1_*` every
  evening** — it is today's after midnight (decision D).
- `tau` learned from cooling curves (heaters off), `gain` from each pre-heat. Exponential
  average, seeded conservatively so the first mornings start early. Persisted in state.
- All heaters together (decision C).

## Saving

- **Coasting** (decision E): heaters stop early when the learned model says the room stays
  ≥ target − 1 °C until the target drops. With `schedule` it may start from `coastFrom`
  (setting, default 15:00); with the other sources at most `coastMax` (60 min) before the drop.
- **Sun**: strong irradiance forecast within the hour and the room within 0.6 °C of the target
  → heating waits.
- **Absence at 12 °C** (decision A): on one night the office never falls that low, so the gain is
  on weekends and days off (simulated: −6 kWh per cold weekend vs 15 °C). The cost is a longer
  pre-heat, which the recipe absorbs by starting earlier.

## Validation (refusals)

- `frostTemp + frostBand < nightTemp ≤ comfortTemp ≤ maxTemp − hysteresis`.
- `schedule`: `workStart < confirmBy < fastFrom < workEnd`; `coastFrom` within work hours.
- `stays` without a stays equipment → refused with a message pointing to `none` + the pill.
- Intervals: `fastInterval ≤ slowInterval`.

## Tile

Icon `Thermometer`, summary ("Préchauffe → 22 °C à 06:30", "Congé détecté — 12 °C",
"Séjour : nuit 17 °C"), countdown to the next presence check or the next change, pill.

## Out of scope

Tariff shifting, heat pumps / setpoint thermostats (`presence-thermostat` covers those).

## Risks

- A still person is invisible to a PIR: a 30-min check can cut; the next motion restores.
- Driving instead of vetoing changes the gîte's guest experience: a guest can lower a room
  with the radiator knob, not raise it above `comfortTemp` — which is a per-room setting
  (decision F, 2026-10-05: configurable, default 20 °C for the gîte).
- Migration: the five gîte instances must load v1 unchanged — covered by characterisation tests
  of v0.2.0 written before any change.
