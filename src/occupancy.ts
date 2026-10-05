/**
 * Who is expected in the room, and how warm it should be for them.
 *
 * Three sources decide the *plan* — the level the room should be at, ignoring
 * presence:
 *
 *  - `schedule` (an office): comfort during work hours on work days, away
 *    otherwise;
 *  - `stays` (a rental): away until a stay's arrival, day/night during it,
 *    away from its departure;
 *  - `daynight`: always occupied, day/night only.
 *
 * Motion sensors, when there are any, refine the plan:
 *
 *  - `schedule`: the arrival window assumes presence; with nobody seen by
 *    `confirmBy` the day is a day off. Then a check every `slowInterval`, and
 *    every `fastInterval` from `fastFrom`: no motion during the interval cuts.
 *    Motion after any cut restores comfort until the next empty interval.
 *    Outside work hours (evenings, week-ends) motion sustained for
 *    `sustainFor` heats, until `absentAfter` without motion.
 *  - `stays` / `daynight`: a room with no motion for `idleAfter` in the day
 *    drops to the night level; motion restores comfort.
 *
 * Pure apart from the clock it is handed: the recipe feeds it observations
 * and reads back a level, so every rule is testable minute by minute.
 */

export type Source = "schedule" | "stays" | "daynight";
export type Level = "comfort" | "night" | "away";

export type Phase =
  | "plan" // no presence refinement in play
  | "before" // work day, before work hours
  | "arrive" // arrival window, presence assumed
  | "present"
  | "dayoff"
  | "left"
  | "idle" // outside work hours, nobody (or not long enough)
  | "sustained" // outside work hours, presence confirmed
  | "roomIdle"; // stays/daynight: room unused for idleAfter

export interface OccupancyConfig {
  source: Source;
  hasMotion: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  workdays: number[];
  /** Minutes after local midnight. */
  workStart: number;
  workEnd: number;
  confirmBy: number;
  fastFrom: number;
  nightStart: number;
  nightEnd: number;
  slowIntervalMs: number;
  fastIntervalMs: number;
  sustainMs: number;
  absentAfterMs: number;
  idleAfterMs: number;
}

export interface Stay {
  /** ms epoch, or null when unknown. */
  arrival: number | null;
  departure: number | null;
  /** The publisher's own verdict, used when dates are missing. */
  occupied: boolean;
}

export interface Observation {
  now: number;
  /** A sensor reports motion right now. */
  motionNow: boolean;
  stay: Stay | null;
  /** When the current pre-heat started, if one is running or ran today. */
  preheatStartedAt: number | null;
}

export interface Verdict {
  level: Level;
  phase: Phase;
  /** Next presence check, for the tile countdown. */
  nextCheckAt: number | null;
  /** Journal lines produced by this tick (French: they reach the owner as is). */
  events: Array<{ text: string; level?: "info" | "warn" }>;
}

/** Two detections further apart than this belong to two different visits. */
export const MOTION_GAP_MS = 5 * 60_000;

export function minuteOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Wall-clock minute `minutes` of the local day containing `ms` (DST-safe). */
export function atMinute(ms: number, minutes: number): number {
  const d = new Date(ms);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
}

export function inWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function hm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function durationLabel(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h}h${String(rest).padStart(2, "0")}` : `${h}h`;
}

export function isWorkday(cfg: OccupancyConfig, ms: number): boolean {
  return cfg.workdays.includes(new Date(ms).getDay());
}

/** The plan for instant `t`, presence ignored. */
export function planAt(cfg: OccupancyConfig, t: number, stay: Stay | null): Level {
  const minute = minuteOfDay(t);
  const dayOrNight: Level = inWindow(minute, cfg.nightStart, cfg.nightEnd) ? "night" : "comfort";
  switch (cfg.source) {
    case "schedule":
      return isWorkday(cfg, t) && minute >= cfg.workStart && minute < cfg.workEnd ? "comfort" : "away";
    case "stays": {
      if (!stay) return "away";
      let occupied: boolean;
      if (stay.arrival !== null && stay.departure !== null) {
        occupied = t >= stay.arrival && t < stay.departure;
      } else if (stay.departure !== null) {
        occupied = stay.occupied && t < stay.departure;
      } else {
        occupied = stay.occupied;
      }
      return occupied ? dayOrNight : "away";
    }
    default:
      return dayOrNight;
  }
}

interface Persisted {
  day: number;
  phase: Phase;
  lastMotionAt: number | null;
  chainStartAt: number | null;
  cutAt: number | null;
  nextCheckAt: number | null;
  confirmed: boolean;
  comfortSince: number | null;
}

export class Occupancy {
  private s: Persisted;

  constructor(
    private readonly cfg: OccupancyConfig,
    restored?: unknown,
  ) {
    this.s = {
      day: 0,
      phase: "plan",
      lastMotionAt: null,
      chainStartAt: null,
      cutAt: null,
      nextCheckAt: null,
      confirmed: false,
      comfortSince: null,
    };
    if (restored && typeof restored === "object") {
      const r = restored as Partial<Persisted>;
      this.s = { ...this.s, ...r };
    }
  }

  snapshot(): Persisted {
    return { ...this.s };
  }

  get lastMotionAt(): number | null {
    return this.s.lastMotionAt;
  }

  /** Check instants of the local day containing `ms`, in order. */
  private checkGrid(ms: number): Array<{ at: number; interval: number }> {
    const out: Array<{ at: number; interval: number }> = [];
    const { confirmBy, fastFrom } = this.cfg;
    for (let at = atMinute(ms, confirmBy) + this.cfg.slowIntervalMs; minuteOfDay(at) < fastFrom && startOfDay(at) === startOfDay(ms); at += this.cfg.slowIntervalMs) {
      out.push({ at, interval: this.cfg.slowIntervalMs });
    }
    const end = startOfDay(ms) + 26 * 3_600_000;
    for (let at = atMinute(ms, fastFrom); at < end && startOfDay(at) === startOfDay(ms); at += this.cfg.fastIntervalMs) {
      out.push({ at, interval: this.cfg.fastIntervalMs });
    }
    return out;
  }

  private nextCheckAfter(ms: number): number | null {
    return this.checkGrid(ms).find((c) => c.at > ms)?.at ?? null;
  }

  private intervalOf(checkAt: number): number {
    return minuteOfDay(checkAt) < this.cfg.fastFrom ? this.cfg.slowIntervalMs : this.cfg.fastIntervalMs;
  }

  private observeMotion(now: number, motionNow: boolean): boolean {
    if (!motionNow) return false;
    const last = this.s.lastMotionAt;
    if (last === null || now - last > MOTION_GAP_MS) this.s.chainStartAt = now;
    this.s.lastMotionAt = now;
    return true;
  }

  private sustained(now: number): boolean {
    const { lastMotionAt, chainStartAt } = this.s;
    if (lastMotionAt === null || chainStartAt === null) return false;
    return now - lastMotionAt <= MOTION_GAP_MS && lastMotionAt - chainStartAt >= this.cfg.sustainMs;
  }

  tick(o: Observation): Verdict {
    const events: Verdict["events"] = [];
    const say = (text: string, level?: "info" | "warn"): void => void events.push({ text, level });
    const cfg = this.cfg;
    const now = o.now;
    const motion = this.observeMotion(now, o.motionNow);
    const plan = planAt(cfg, now, o.stay);

    if (!cfg.hasMotion) {
      this.s.phase = "plan";
      return { level: plan, phase: "plan", nextCheckAt: null, events };
    }

    if (cfg.source !== "schedule") {
      // Rental / day-night: only the idle-room rule.
      if (plan !== "comfort") {
        this.s.comfortSince = null;
        this.s.phase = "plan";
        return { level: plan, phase: "plan", nextCheckAt: null, events };
      }
      if (this.s.comfortSince === null) this.s.comfortSince = now;
      if (this.s.phase === "roomIdle") {
        if (motion) {
          this.s.phase = "plan";
          say("Mouvement → confort");
        } else return { level: "night", phase: "roomIdle", nextCheckAt: null, events };
      }
      const since = Math.max(this.s.lastMotionAt ?? -Infinity, this.s.comfortSince);
      if (now - since >= cfg.idleAfterMs) {
        this.s.phase = "roomIdle";
        say(`Pièce sans mouvement depuis ${durationLabel(cfg.idleAfterMs)} → température de nuit`);
        return { level: "night", phase: "roomIdle", nextCheckAt: null, events };
      }
      this.s.phase = "plan";
      return { level: "comfort", phase: "plan", nextCheckAt: null, events };
    }

    // ── Office ────────────────────────────────────────────
    const day = startOfDay(now);
    const minute = minuteOfDay(now);
    const workday = isWorkday(cfg, now);
    if (this.s.day !== day) {
      this.s.day = day;
      this.s.confirmed = false;
      this.s.cutAt = null;
      this.s.nextCheckAt = null;
      this.s.phase = workday && minute < cfg.workEnd ? "before" : "idle";
    }

    const preWork = workday && !this.s.confirmed && minute < cfg.workEnd;

    // Out-of-hours rule, shared by evenings, week-ends and early mornings.
    const outOfHours = (restPhase: Phase): Verdict => {
      if (this.s.phase === "sustained") {
        if (this.s.lastMotionAt === null || now - this.s.lastMotionAt >= cfg.absentAfterMs) {
          this.s.phase = restPhase;
          say(`${durationLabel(cfg.absentAfterMs)} sans mouvement → absence`);
          return { level: "away", phase: restPhase, nextCheckAt: null, events };
        }
        return { level: "comfort", phase: "sustained", nextCheckAt: null, events };
      }
      this.s.phase = restPhase;
      if (this.sustained(now)) {
        this.s.phase = "sustained";
        say(`Présence depuis ${durationLabel(cfg.sustainMs)} → chauffe`);
        return { level: "comfort", phase: "sustained", nextCheckAt: null, events };
      }
      return { level: "away", phase: restPhase, nextCheckAt: null, events };
    };

    if (preWork && (this.s.phase === "before" || this.s.phase === "sustained")) {
      if (minute < cfg.workStart) return outOfHours("before");
      this.s.phase = "arrive";
    }

    if (this.s.phase === "arrive") {
      if (minute < cfg.confirmBy) return { level: "comfort", phase: "arrive", nextCheckAt: atMinute(now, cfg.confirmBy), events };
      const from = Math.min(o.preheatStartedAt ?? atMinute(now, cfg.workStart), atMinute(now, cfg.workStart));
      const seen = this.s.lastMotionAt !== null && this.s.lastMotionAt >= from;
      this.s.confirmed = true;
      if (seen) {
        this.s.phase = "present";
        this.s.nextCheckAt = this.nextCheckAfter(now);
        say(`Présence vue avant ${hm(atMinute(now, cfg.confirmBy))} → journée de travail`);
      } else {
        this.s.phase = "dayoff";
        this.s.cutAt = now;
        say(`Personne avant ${hm(atMinute(now, cfg.confirmBy))} → congé, absence`);
      }
    }

    if (this.s.phase === "dayoff" || this.s.phase === "left") {
      if (motion && this.s.cutAt !== null && now > this.s.cutAt) {
        this.s.phase = "present";
        this.s.cutAt = null;
        this.s.nextCheckAt = this.nextCheckAfter(now);
        say("Mouvement → confort, jusqu'à ce qu'il n'y en ait plus");
      } else if (minute >= cfg.workEnd || !workday) {
        this.s.chainStartAt = motion ? now : null;
        return outOfHours("idle");
      } else {
        return { level: "away", phase: this.s.phase, nextCheckAt: null, events };
      }
    }

    if (this.s.phase === "present") {
      if (this.s.nextCheckAt === null) this.s.nextCheckAt = this.nextCheckAfter(now);
      if (this.s.nextCheckAt !== null && now >= this.s.nextCheckAt) {
        const interval = this.intervalOf(this.s.nextCheckAt);
        const ok = this.s.lastMotionAt !== null && this.s.lastMotionAt > this.s.nextCheckAt - interval;
        if (ok) {
          this.s.nextCheckAt = this.nextCheckAfter(now);
        } else {
          this.s.cutAt = now;
          this.s.nextCheckAt = null;
          say(`Aucun mouvement depuis ${durationLabel(interval)} → absence`);
          if (minute >= cfg.workEnd) {
            this.s.phase = "idle";
            this.s.chainStartAt = null;
            return { level: "away", phase: "idle", nextCheckAt: null, events };
          }
          this.s.phase = "left";
          return { level: "away", phase: "left", nextCheckAt: null, events };
        }
      }
      return { level: "comfort", phase: "present", nextCheckAt: this.s.nextCheckAt, events };
    }

    // idle / sustained, outside work hours.
    return outOfHours("idle");
  }
}
