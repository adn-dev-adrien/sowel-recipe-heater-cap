/**
 * The room as a single thermal mass, learned from what the recipe observes.
 *
 *   dT/dt = gain·heating − (T − Tout) / tau          (°C per hour)
 *
 * `gain` is how fast every heater together warms the room when it is as warm
 * as outside; `tau` is how long the room takes to lose about two thirds of its
 * lead over outside. Both are learned on the fly:
 *
 *  - `tau` from cooling stretches (heaters off for a while, at night, so the
 *    sun does not pass for good insulation);
 *  - `gain` from heating stretches (heaters on for a while), once the loss the
 *    room suffered meanwhile has been added back.
 *
 * Seeds are deliberately pessimistic — a weak heater in a leaky room — so the
 * first pre-heats start early rather than late: arriving to a warm room twenty
 * minutes early costs a little, arriving to a cold one is the failure.
 */

export interface ThermalModel {
  /** °C/h added by all heaters together, at zero loss. */
  gain: number;
  /** Hours. */
  tau: number;
  gainSamples: number;
  tauSamples: number;
}

export const DEFAULT_MODEL: ThermalModel = { gain: 2.5, tau: 15, gainSamples: 0, tauSamples: 0 };

const GAIN_RANGE: [number, number] = [0.3, 12];
const TAU_RANGE: [number, number] = [2, 120];
/** Learning weight of a new observation while the model is young, then settled. */
const ALPHA_YOUNG = 0.5;
const ALPHA_SETTLED = 0.2;
/** A stretch shorter than this says more about sensor noise than about the room. */
export const MIN_STRETCH_MS = 45 * 60_000;
/** Heaters and sensors lag: the first minutes of a heating stretch are skipped. */
export const HEAT_SETTLE_MS = 15 * 60_000;
/** Below this lead over outside a cooling slope is mostly noise. */
const MIN_LEAD_C = 4;

const clamp = (v: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, v));

export function readModel(value: unknown): ThermalModel {
  if (!value || typeof value !== "object") return { ...DEFAULT_MODEL };
  const v = value as Record<string, unknown>;
  const num = (x: unknown, fallback: number): number =>
    typeof x === "number" && Number.isFinite(x) ? x : fallback;
  return {
    gain: clamp(num(v.gain, DEFAULT_MODEL.gain), GAIN_RANGE),
    tau: clamp(num(v.tau, DEFAULT_MODEL.tau), TAU_RANGE),
    gainSamples: Math.max(0, Math.floor(num(v.gainSamples, 0))),
    tauSamples: Math.max(0, Math.floor(num(v.tauSamples, 0))),
  };
}

function blend(old: number, observed: number, samples: number): number {
  const alpha = samples < 3 ? ALPHA_YOUNG : ALPHA_SETTLED;
  return old + alpha * (observed - old);
}

export interface Stretch {
  startAt: number;
  endAt: number;
  startTemp: number;
  endTemp: number;
  /** Mean outdoor temperature over the stretch. */
  outdoor: number;
}

/** Folds a cooling stretch (heaters off) into `tau`. Returns null when the stretch says nothing. */
export function learnFromCooling(model: ThermalModel, s: Stretch): ThermalModel | null {
  const hours = (s.endAt - s.startAt) / 3_600_000;
  if (hours * 3_600_000 < MIN_STRETCH_MS) return null;
  const slope = (s.endTemp - s.startTemp) / hours;
  const lead = (s.startTemp + s.endTemp) / 2 - s.outdoor;
  if (lead < MIN_LEAD_C || slope >= -0.05) return null;
  const observed = clamp(lead / -slope, TAU_RANGE);
  return { ...model, tau: blend(model.tau, observed, model.tauSamples), tauSamples: model.tauSamples + 1 };
}

/** Folds a heating stretch (every heater on) into `gain`. */
export function learnFromHeating(model: ThermalModel, s: Stretch): ThermalModel | null {
  const hours = (s.endAt - s.startAt) / 3_600_000;
  if (hours * 3_600_000 < MIN_STRETCH_MS - HEAT_SETTLE_MS) return null;
  const slope = (s.endTemp - s.startTemp) / hours;
  if (slope <= 0) return null;
  const lead = (s.startTemp + s.endTemp) / 2 - s.outdoor;
  const observed = clamp(slope + lead / model.tau, GAIN_RANGE);
  return { ...model, gain: blend(model.gain, observed, model.gainSamples), gainSamples: model.gainSamples + 1 };
}

const STEP_MS = 60_000;
const STEP_H = STEP_MS / 3_600_000;

/**
 * Minutes needed to bring the room from `temp` to `target` with every heater
 * on, given the outdoor temperature over time. `Infinity` when the heaters
 * cannot get there within `horizonMs` — the room's balance point is below the
 * target on a cold night.
 */
export function timeToReach(
  model: ThermalModel,
  temp: number,
  target: number,
  from: number,
  outdoorAt: (t: number) => number,
  horizonMs = 14 * 3_600_000,
): number {
  let t = temp;
  for (let k = 0; k * STEP_MS <= horizonMs; k++) {
    if (t >= target) return k * STEP_MS;
    const at = from + k * STEP_MS;
    t += (model.gain - (t - outdoorAt(at)) / model.tau) * STEP_H;
  }
  return Infinity;
}

/** Room temperature at `until` if every heater stays off from `from`. */
export function coastTo(
  model: ThermalModel,
  temp: number,
  from: number,
  until: number,
  outdoorAt: (t: number) => number,
): number {
  let t = temp;
  for (let at = from; at < until; at += STEP_MS) t -= ((t - outdoorAt(at)) / model.tau) * STEP_H;
  return t;
}
