import { describe, it, expect } from "vitest";
import { Occupancy, planAt, type OccupancyConfig, type Stay, type Verdict } from "./occupancy.js";

// Monday 5 October 2026 and Saturday 10 October 2026, local time.
const MON = (h: number, m = 0): number => new Date(2026, 9, 5, h, m).getTime();
const SAT = (h: number, m = 0): number => new Date(2026, 9, 10, h, m).getTime();
const MIN = 60_000;

const OFFICE: OccupancyConfig = {
  source: "schedule",
  hasMotion: true,
  workdays: [1, 2, 3, 4, 5],
  workStart: 6 * 60 + 30,
  workEnd: 17 * 60,
  confirmBy: 8 * 60,
  fastFrom: 15 * 60,
  nightStart: 22 * 60,
  nightEnd: 7 * 60,
  slowIntervalMs: 90 * MIN,
  fastIntervalMs: 30 * MIN,
  sustainMs: 15 * MIN,
  absentAfterMs: 30 * MIN,
  idleAfterMs: 120 * MIN,
};

/** Detections every `every` minutes from `from` to `to` (inclusive), local day of `base`. */
function pir(base: (h: number, m?: number) => number, from: string, to: string, every = 8): Set<number> {
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  const out = new Set<number>();
  for (let t = base(fh, fm); t <= base(th, tm); t += every * MIN) out.add(t);
  return out;
}

/** Runs a whole day minute by minute; returns the verdict per minute and the journal. */
function runDay(
  cfg: OccupancyConfig,
  base: (h: number, m?: number) => number,
  motion: Set<number>,
  stay: Stay | null = null,
): { at: (h: number, m?: number) => Verdict; log: string[] } {
  const occ = new Occupancy(cfg);
  const verdicts = new Map<number, Verdict>();
  const log: string[] = [];
  for (let t = base(0, 0); t < base(0, 0) + 24 * 60 * MIN; t += MIN) {
    const v = occ.tick({ now: t, motionNow: motion.has(t), stay, preheatStartedAt: base(3, 0) });
    verdicts.set(t, v);
    for (const e of v.events) log.push(`${new Date(t).getHours()}:${String(new Date(t).getMinutes()).padStart(2, "0")} ${e.text}`);
  }
  return { at: (h, m = 0) => verdicts.get(base(h, m))!, log };
}

describe("plan", () => {
  it("schedule: comfort in work hours on work days only", () => {
    expect(planAt(OFFICE, MON(6, 29), null)).toBe("away");
    expect(planAt(OFFICE, MON(6, 30), null)).toBe("comfort");
    expect(planAt(OFFICE, MON(16, 59), null)).toBe("comfort");
    expect(planAt(OFFICE, MON(17, 0), null)).toBe("away");
    expect(planAt(OFFICE, SAT(10, 0), null)).toBe("away");
  });

  it("stays: away before arrival, day/night during, away after departure", () => {
    const cfg = { ...OFFICE, source: "stays" as const };
    const stay: Stay = { occupied: false, arrival: MON(16, 0), departure: SAT(10, 0) };
    expect(planAt(cfg, MON(15, 59), stay)).toBe("away");
    expect(planAt(cfg, MON(16, 0), stay)).toBe("comfort");
    expect(planAt(cfg, MON(23, 0), stay)).toBe("night");
    expect(planAt(cfg, SAT(9, 59), stay)).toBe("comfort");
    expect(planAt(cfg, SAT(10, 0), stay)).toBe("away");
    expect(planAt(cfg, MON(12, 0), null)).toBe("away");
  });

  it("stays without dates trusts the publisher's occupied flag", () => {
    const cfg = { ...OFFICE, source: "stays" as const };
    expect(planAt(cfg, MON(12, 0), { occupied: true, arrival: null, departure: null })).toBe("comfort");
    expect(planAt(cfg, MON(12, 0), { occupied: false, arrival: null, departure: null })).toBe("away");
  });

  it("day/night: the night window wraps past midnight", () => {
    const cfg = { ...OFFICE, source: "daynight" as const };
    expect(planAt(cfg, MON(6, 59), null)).toBe("night");
    expect(planAt(cfg, MON(7, 0), null)).toBe("comfort");
    expect(planAt(cfg, MON(22, 0), null)).toBe("night");
  });
});

describe("office with a PIR", () => {
  it("a normal day: confirmed at 08:00, checks every 1h30 then 30 min, cut after leaving", () => {
    const motion = new Set([...pir(MON, "06:35", "11:55"), ...pir(MON, "13:10", "16:55")]);
    const { at, log } = runDay(OFFICE, MON, motion);
    expect(at(6, 0).level).toBe("away");
    expect(at(6, 45)).toMatchObject({ level: "comfort", phase: "arrive" });
    expect(at(8, 1)).toMatchObject({ level: "comfort", phase: "present" });
    expect(at(12, 45).level).toBe("comfort"); // lunch is shorter than 1h30
    expect(at(17, 15).level).toBe("comfort"); // still there at the 17:00 check
    expect(at(17, 31).level).toBe("away");
    expect(log.some((l) => l.includes("journée de travail"))).toBe(true);
  });

  it("nobody by 08:00 is a day off", () => {
    const { at, log } = runDay(OFFICE, MON, new Set());
    expect(at(7, 59).level).toBe("comfort");
    expect(at(8, 1)).toMatchObject({ level: "away", phase: "dayoff" });
    expect(at(14, 0).level).toBe("away");
    expect(log.join("\n")).toContain("congé");
  });

  it("decision B: motion after a cut restores comfort until the next empty interval", () => {
    const motion = pir(MON, "10:00", "11:00", 9);
    const { at } = runDay(OFFICE, MON, motion);
    expect(at(9, 0).level).toBe("away");
    expect(at(10, 0).level).toBe("comfort");
    // Next grid check after 10:00 is 11:00 (motion at 10:57) → ok; 12:30 → nothing since 11:00.
    expect(at(12, 0).level).toBe("comfort");
    expect(at(12, 31).level).toBe("away");
  });

  it("after 15:00 a 30-minute silence cuts, and the room can be re-heated by motion", () => {
    const motion = new Set([...pir(MON, "06:35", "14:00"), ...pir(MON, "16:05", "16:55")]);
    const { at } = runDay(OFFICE, MON, motion);
    expect(at(14, 59).level).toBe("comfort");
    expect(at(15, 1)).toMatchObject({ level: "away", phase: "left" });
    expect(at(16, 5).level).toBe("comfort");
  });

  it("week-end: 15 minutes of presence heats, 30 minutes without stops", () => {
    const { at } = runDay(OFFICE, SAT, pir(SAT, "10:00", "10:40", 4));
    expect(at(10, 10).level).toBe("away");
    expect(at(10, 16)).toMatchObject({ level: "comfort", phase: "sustained" });
    expect(at(11, 5).level).toBe("comfort");
    expect(at(11, 11).level).toBe("away");
  });

  it("week-end: a short visit heats nothing", () => {
    const { at } = runDay(OFFICE, SAT, pir(SAT, "10:00", "10:05", 2));
    for (const h of [10, 11, 12]) expect(at(h, 6).level).toBe("away");
  });

  it("the next check is published for the tile countdown", () => {
    const motion = pir(MON, "06:35", "16:55");
    const { at } = runDay(OFFICE, MON, motion);
    expect(at(8, 30).nextCheckAt).toBe(MON(9, 30));
    expect(at(15, 10).nextCheckAt).toBe(MON(15, 30));
  });

  it("survives a restart mid-day from its snapshot", () => {
    const occ = new Occupancy(OFFICE);
    for (let t = MON(6, 0); t <= MON(9, 0); t += MIN) {
      occ.tick({ now: t, motionNow: t === MON(7, 0), stay: null, preheatStartedAt: MON(4, 0) });
    }
    const revived = new Occupancy(OFFICE, JSON.parse(JSON.stringify(occ.snapshot())));
    const v = revived.tick({ now: MON(9, 1), motionNow: false, stay: null, preheatStartedAt: MON(4, 0) });
    expect(v).toMatchObject({ level: "comfort", phase: "present" });
  });
});

describe("office without a PIR", () => {
  it("follows the schedule, nothing else", () => {
    const { at, log } = runDay({ ...OFFICE, hasMotion: false }, MON, new Set());
    expect(at(8, 30).level).toBe("comfort");
    expect(at(17, 30).level).toBe("away");
    expect(log).toEqual([]);
  });
});

describe("rental room with a PIR", () => {
  it("drops to night after idleAfter without motion in the day, motion restores", () => {
    const cfg = { ...OFFICE, source: "stays" as const };
    const stay: Stay = { occupied: true, arrival: MON(0, 0) - 86_400_000, departure: SAT(10, 0) };
    const motion = new Set([...pir(MON, "07:30", "10:00", 10), ...pir(MON, "18:00", "21:50", 10)]);
    const { at } = runDay(cfg, MON, motion, stay);
    expect(at(11, 0).level).toBe("comfort");
    expect(at(12, 5)).toMatchObject({ level: "night", phase: "roomIdle" });
    expect(at(18, 0).level).toBe("comfort");
    expect(at(23, 0).level).toBe("night"); // the night plan, not idleness
  });
});
