# Spec 003 — Cap mode: the two bounds take the relay back

Status: **implemented (v1.1.0)**, validated by Adrien on 2026-10-06 (2 min tolerance under the low bound included).
Visual summary with a simulator: `maquettes/cap-bounds.html`.

## Why

The gîte bathroom (instance `ecc7fce4`) runs the cap mode alone: its radiator only heats when the
guest presses its remote, so the relay is just a permission. Adrien wants: allowed under 21 °C,
cut above 24 °C, nothing else.

Today the cap mode only ever switches on a relay **it** switched off. A relay switched off by hand
therefore stays off forever, even at 15 °C. Adrien asked (2026-10-06) that a manual action last
only until the room reaches one of the two bounds, then the recipe takes over again.

## Rule

With `maxTemp` = 24 and `hysteresis` = 3 (restore at 21):

| Room | Relay | Manual action |
| --- | --- | --- |
| ≥ 24 °C | off | tolerated `manualGrace` (2 min), then cut again (unchanged) |
| ≤ 21 °C | **on** | **tolerated `manualGrace`, then switched back on** (new) |
| between | whatever the last action set | **kept until the next bound** (new) |

- Reaching a bound acts at once (no grace): that is the recipe doing its job.
- Between the bounds, a manual switch-on after a cut is **accepted** until 24 °C, instead of
  being re-cut after 2 min.
- The order of priority does not change: open window > bounds; frost floor; mute sensor fails
  open (the relay is handed back, never forced on).

## Out of scope

- Driven modes (`schedule`, `stays`, `daynight`): they already take the relay back after
  `manualGrace`.
- `frost` and `off` modes: unchanged.
- No new slot: the bounds are `maxTemp` and `maxTemp - hysteresis`, as today.

## Risk

A guest who switches a radiator off by hand in a cold room gets it back after 2 min. Acceptable:
only the bathroom runs the cap mode today, and the `off` mode (Pause) is the way to park a
heater.

## Release

`v1.1.0`, installed on Adrien's instance through the personal source; the bathroom instance needs
no reconfiguration.
