# Sowel recipe — Heater Cap

Caps the temperature of a room heated by an electric heater behind a plain **on/off relay**.

The heater keeps its own thermostat: guests set the knob wherever they like, and the radiator
regulates itself. This recipe never sends a setpoint — it decides *when the relay is allowed to
feed the heater*, so the room cannot be pushed past a ceiling the owner chose.

Written for a holiday rental: guests who leave the heating flat out, windows opened in January,
and weeks where the place stands empty.

## What it does

| Mode        | Behaviour                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------- |
| **auto**    | Veto mode. The room is the guest's up to `maxTemp`; above it the relay opens and closes back once the room falls under `maxTemp − hysteresis`. An open window opens the relay too. |
| **frost**   | Ownership mode, for an empty house. Relays stay open; the recipe closes them only to hold the frost floor (heat under `frostTemp`, stop at `frostTemp + frostBand`). |
| **off**     | Parked. Anything held open is handed back.                                                     |

Modes are switched from the pill on the recipe instance (Zone page), not from a schedule — the
owner flips to `frost` when the season's last guest leaves and back to `auto` before the next
arrival. Leaving `frost` hands the heaters back on, so nobody arrives to dead radiators.

**The recipe only ever closes a relay it opened itself.** A heater the guest switched off stays
off: this is a ceiling, not a thermostat. (`frost` is the exception — an empty house is the
recipe's to drive.)

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
