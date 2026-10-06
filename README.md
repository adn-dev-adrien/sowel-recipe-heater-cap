# Sowel recipe — Smart Heating (`heater-cap`)

> Since v1.0.0 this recipe is **Smart Heating**. The id stays `heater-cap` so existing instances
> keep running: **an instance with no occupancy source behaves exactly as v0.2.0** — the cap
> described below. Spec: `specs/002-smart-heating/spec.md`.

## Smart heating (occupancy source set)

The recipe then *drives* the relays from the room sensor (hysteresis −0.3/+0.2 °C) towards a
target picked by the occupancy source:

| Source | Plan |
| --- | --- |
| `schedule` (an office) | comfort during work hours on work days, away otherwise |
| `stays` (a rental) | away until arrival, day/night during the stay, away from departure — read from an equipment exposing `occupied`, `arrival`, `departure` (the guestFlow plugin publishes one per property) |
| `daynight` | always occupied, day/night |

**Presence (optional, `motionSensors`).** Office: presence assumed from work start; nobody seen by
`confirmBy` → day off; then a check every `slowInterval`, every `fastInterval` from `fastFrom`;
an empty interval cuts, motion restores comfort until the next empty interval. Out of hours,
`sustainFor` of motion heats until `absentAfter` without motion. Rental/day-night: a room unused
for `idleAfter` drops to the night target.

**Pre-heat.** Whenever the plan is about to rise (work start, arrival, end of night) the recipe
starts as late as possible to be on target on time, from a learned model of the room
(`dT/dt = gain − (T − Tout)/tau`): `tau` from cooling stretches at night, `gain` from heating
stretches. Outdoor temperature comes from the forecast's hourly series corrected by the live
outdoor sensor, else the sensor, else a snapshot of tomorrow's min/max taken each evening.

**Saving.** Coasting stops the heaters early when the model says the room stays within 1 °C of
the target until it drops (`coastFrom` for a schedule, at most `coastMax` before otherwise).
Strong sun forecast within the hour defers heating when the room is within 0.6 °C of target.

**Pill.** Auto / Confort (forced until midnight) / Absent (the frost mode) / Pause. A Dashboard
tile (`Thermometer`) shows the summary and the next presence check.

**Defaults changed for new instances:** the away/frost temperature defaults to 12 °C (was 7 °C);
existing instances keep the value stored in their parameters.

---

# The cap (v0.2.0 behaviour, source = none)

Caps the temperature of a room heated by an electric heater behind a plain **on/off relay**.

The heater keeps its own thermostat: guests set the knob wherever they like, and the radiator
regulates itself. This recipe never sends a setpoint — it decides *when the relay is allowed to
feed the heater*, so the room cannot be pushed past a ceiling the owner chose.

Written for a holiday rental: guests who leave the heating flat out, windows opened in January,
and weeks where the place stands empty.

## What it does

| Mode        | Behaviour                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------- |
| **auto**    | Two bounds own the relay: open at `maxTemp` and above, closed at `maxTemp − hysteresis` and below. Between them the last action stands until the next bound. An open window opens the relay too. |
| **frost**   | Ownership mode, for an empty house. Relays stay open; the recipe closes them only to hold the frost floor (heat under `frostTemp`, stop at `frostTemp + frostBand`). |
| **off**     | Parked. Anything held open is handed back.                                                     |

Modes are switched from the pill on the recipe instance (Zone page), not from a schedule — the
owner flips to `frost` when the season's last guest leaves and back to `auto` before the next
arrival. Leaving `frost` hands the heaters back on, so nobody arrives to dead radiators.

**A manual action lasts until the next bound** (spec 003). Switched by hand at either bound, the
relay gets `manualGrace` (2 min), then the bound wins again. Between the bounds, a manual switch —
on or off — is kept until the room reaches the next bound. Use the `off` mode to park a heater.

## Open windows

Two detectors, in this order of trust:

1. **Contacts** — the ones listed in `windowSensors`, or, when that list is empty, whatever
   window contacts the zone already aggregates. An open contact must hold for a minute before it
   cuts; closing restores immediately.
2. **Temperature drop** — no hardware needed. A fall of `dropDelta` inside `dropWindow` reads as
   an open window. The cut ends when the room stops falling, or after `windowCutMax` at the very
   latest, so a guess can never leave a room cold indefinitely.

The heuristic is switched off as soon as `windowSensors` is filled in, and is suspended whenever
the recipe is itself holding the heat off — otherwise every cap cut would come back as a phantom
open window.

## Manual overrides

Pressing the wall switch while the recipe holds a relay buys `manualGrace` (2 min by default)
before the recipe puts it back, and the journal says so. Long enough that the gesture does not
feel broken, short enough that the cap is still a cap.

## Degradations

A mute sensor (no reading, or older than `tempMaxAge`) fails **open** in `auto` — the cut is
released and the guests keep their heating — and fails **closed** in `frost`, where the relay is
held on because a burst pipe costs more than the kWh. Both are logged.

## Parameters

| Slot                          | Default | Meaning                                                   |
| ----------------------------- | ------- | --------------------------------------------------------- |
| `zone`, `heaters`, `sensor`   | —       | Room, on/off relays, temperature sensor                    |
| `maxTemp`                     | 24 °C   | The cap                                                    |
| `hysteresis`                  | 0.5 °C  | Restores at `maxTemp − hysteresis`                         |
| `manualGrace`                 | 2 min   | Tolerance after a manual switch                            |
| `frostTemp` / `frostBand`     | 7 / 2 °C| Frost floor and the band it heats up to                    |
| `windowSensors`               | empty   | Contacts; empty falls back to the zone's                   |
| `windowCutMax`                | 45 min  | Ceiling on a window cut                                    |
| `dropDetection`               | on      | Heuristic; ignored when contacts are configured            |
| `dropDelta` / `dropWindow`    | 0.6 °C / 10 min | What counts as a drop                              |
| `tempKey`                     | auto    | Which sensor reading to use                                |
| `tempMaxAge`                  | 1 h     | Older than this, the sensor is mute                        |

## Install

Personal source (spec 136): Plugins → Store → Personal sources → `adn-dev-adrien/sowel-recipe-heater-cap`,
then Install and confirm the SHA256 fingerprint.

## Development

```bash
npm install
npm test
npm run build
```

Releasing: bump `manifest.json` **and** `package.json` to the same version, tag `vX.Y.Z`, push the
tag. The workflow builds, tests, packages `sowel-recipe-heater-cap-X.Y.Z.tar.gz` and publishes the
release. Never replace an asset already published — installs pin it by hash.
