/**
 * What the recipe knows about outside, from the best source available:
 *
 *  1. the forecast plugin's hourly series (`irradiance_120h`: irradiance AND
 *     temperature per hour, today included), corrected by the live outdoor
 *     sensor when there is one — the series is right about the shape of the
 *     day, the sensor about the level right now;
 *  2. the live outdoor sensor alone, held flat;
 *  3. yesterday evening's snapshot of `j1_temp_min/max` (the plugin only
 *     publishes tomorrow onwards, so the recipe keeps its own copy for "today"),
 *     drawn as a min at 06:00 and a max at 15:00;
 *  4. a cold default, so a blind recipe errs on the side of pre-heating early.
 */

export interface HourPoint {
  t: number;
  temp: number | null;
  /** W/m², direct + diffuse. */
  sun: number;
}

export interface DaySnapshot {
  /** Local calendar day the values describe, `YYYY-MM-DD`. */
  date: string;
  min: number;
  max: number;
}

export const BLIND_OUTDOOR_C = 5;
/** Past this, a sensor/series disagreement is a broken source, not a bias. */
const MAX_BIAS_C = 8;
/** A series point only describes its own neighbourhood. */
const MAX_GAP_MS = 90 * 60_000;

export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parses the forecast plugin's hourly series; tolerant of a JSON string. */
export function parseHourly(value: unknown): HourPoint[] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  const hours = v && typeof v === "object" ? (v as { hours?: unknown }).hours : null;
  if (!Array.isArray(hours)) return [];
  const out: HourPoint[] = [];
  for (const h of hours) {
    if (!h || typeof h !== "object") continue;
    const r = h as Record<string, unknown>;
    const t = Date.parse(String(r.t ?? ""));
    if (!Number.isFinite(t)) continue;
    const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
    out.push({ t, temp: num(r.temp), sun: Math.max(0, (num(r.direct) ?? 0) + (num(r.diffuse) ?? 0)) });
  }
  return out.sort((a, b) => a.t - b.t);
}

function interpolate(points: HourPoint[], t: number, pick: (p: HourPoint) => number | null): number | null {
  if (points.length === 0) return null;
  let before: HourPoint | null = null;
  let after: HourPoint | null = null;
  for (const p of points) {
    if (pick(p) === null) continue;
    if (p.t <= t) before = p;
    else {
      after = p;
      break;
    }
  }
  if (before && after) {
    if (after.t - before.t > MAX_GAP_MS * 2) return null;
    const f = (t - before.t) / (after.t - before.t);
    return pick(before)! + f * (pick(after)! - pick(before)!);
  }
  const only = before ?? after;
  if (only && Math.abs(only.t - t) <= MAX_GAP_MS) return pick(only);
  return null;
}

/** Min at 06:00, max at 15:00, cosine in between — good enough for a pre-heat. */
export function snapshotAt(snap: DaySnapshot, t: number): number {
  const d = new Date(t);
  const h = d.getHours() + d.getMinutes() / 60;
  let f: number;
  if (h >= 6 && h <= 15) f = (1 - Math.cos((Math.PI * (h - 6)) / 9)) / 2;
  else {
    const since = h > 15 ? h - 15 : h + 9;
    f = (1 + Math.cos((Math.PI * since) / 15)) / 2;
  }
  return snap.min + (snap.max - snap.min) * f;
}

export interface Outside {
  outdoorAt(t: number): number;
  sunAt(t: number): number;
  /** Which source answered, for the journal. */
  source: "forecast" | "sensor" | "snapshot" | "blind";
}

export function buildOutside(
  now: number,
  hourly: HourPoint[],
  live: number | null,
  snapshots: DaySnapshot[],
): Outside {
  const seriesNow = interpolate(hourly, now, (p) => p.temp);
  if (seriesNow !== null) {
    const raw = live === null ? 0 : live - seriesNow;
    const bias = Math.abs(raw) <= MAX_BIAS_C ? raw : 0;
    return {
      source: "forecast",
      outdoorAt: (t) => {
        const v = interpolate(hourly, t, (p) => p.temp);
        return v === null ? seriesNow + bias : v + bias;
      },
      sunAt: (t) => interpolate(hourly, t, (p) => p.sun) ?? 0,
    };
  }
  const sunAt = (t: number): number => interpolate(hourly, t, (p) => p.sun) ?? 0;
  if (live !== null) return { source: "sensor", outdoorAt: () => live, sunAt };
  const byDate = new Map(snapshots.map((s) => [s.date, s]));
  if (byDate.size > 0) {
    return {
      source: "snapshot",
      outdoorAt: (t) => {
        const s = byDate.get(localDate(t));
        return s ? snapshotAt(s, t) : BLIND_OUTDOOR_C;
      },
      sunAt,
    };
  }
  return { source: "blind", outdoorAt: () => BLIND_OUTDOOR_C, sunAt };
}
