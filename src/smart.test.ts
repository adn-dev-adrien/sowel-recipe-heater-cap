import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRecipe, parseTime, readMotion, readSource, readStay } from "./index.js";

// ============================================================
// A fake Sowel context driving a simulated room
// ============================================================

interface Binding {
  alias: string;
  category?: string;
  value?: unknown;
  lastUpdated?: string | null;
}
interface Eq {
  id: string;
  name: string;
  type: string;
  dataBindings: Binding[];
  orderBindings: Array<{ alias: string; category?: string; type?: string }>;
}

function parseDuration(value: unknown): number {
  if (typeof value === "number") return value;
  const m = String(value).match(/^(\d+)\s*(s|m|h)$/);
  if (!m) throw new Error(`Invalid duration: ${String(value)}`);
  const n = Number(m[1]);
  return m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000;
}
const formatDuration = (ms: number): string => `${Math.round(ms / 60_000)}min`;

const heater = (id: string): Eq => ({
  id,
  name: id,
  type: "switch",
  dataBindings: [{ alias: "state", category: "light_state", value: "OFF" }],
  orderBindings: [{ alias: "state", category: "light_toggle", type: "boolean" }],
});
const sensor = (id: string, t: number): Eq => ({
  id,
  name: id,
  type: "sensor",
  dataBindings: [{ alias: "temperature", category: "temperature", value: t }],
  orderBindings: [],
});
const pirEq = (id: string): Eq => ({
  id,
  name: id,
  type: "sensor",
  dataBindings: [{ alias: "occupancy", category: "motion", value: false }],
  orderBindings: [],
});

function makeCtx(equipments: Eq[]) {
  const byId = new Map(equipments.map((e) => [e.id, e]));
  const logs: string[] = [];
  const state = new Map<string, unknown>();
  const ctx = {
    eventBus: { onType: () => () => undefined },
    equipmentManager: {
      getById: (id: string) => byId.get(id) ?? null,
      getByIdWithDetails: (id: string) => byId.get(id) ?? null,
    },
    zoneManager: { getById: (id: string) => ({ id, name: "Bureau" }) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    state: {
      get: (k: string) => state.get(k) ?? null,
      set: (k: string, v: unknown) => void state.set(k, v),
      delete: (k: string) => void state.delete(k),
      clear: () => state.clear(),
    },
    log: (message: string) => void logs.push(message),
    helpers: { parseDuration, formatDuration },
    dispatchOrder: async (id: string, alias: string, value: unknown) => {
      const b = byId.get(id)?.dataBindings.find((x) => x.alias === alias);
      if (b) b.value = value === true || value === "ON" ? "ON" : "OFF";
      return { success: true };
    },
  };
  return { ctx, logs, state };
}

const on = (e: Eq): boolean => e.dataBindings[0].value === "ON";
const at = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime();

/** The real room: 3.3 °C/h with both heaters, tau 16 h. */
function simulateRoom(room: Eq, heaters: Eq[], outdoor: number, temp: { v: number }): void {
  const share = heaters.filter(on).length / heaters.length;
  temp.v += (3.3 * share - (temp.v - outdoor) / 16) / 60;
  room.dataBindings[0].value = Math.round(temp.v * 100) / 100;
}

async function runUntil(
  until: number,
  step: (now: number) => void,
): Promise<void> {
  while (Date.now() < until) {
    step(Date.now());
    await vi.advanceTimersByTimeAsync(60_000);
  }
}

const OFFICE_PARAMS = {
  zone: "z",
  heaters: ["h1", "h2"],
  sensor: "room",
  source: "schedule",
  comfortTemp: 22,
  frostTemp: 12,
  maxTemp: 26,
  motionSensors: ["pir"],
  outdoorSensor: "out",
};

describe("readers", () => {
  it("parse times, sources, motion and stays", () => {
    expect(parseTime("06:30")).toBe(390);
    expect(parseTime("25:00")).toBeNull();
    expect(readSource(undefined)).toBe("cap");
    expect(readSource("stays")).toBe("stays");
    expect(readMotion(pirEq("p"))).toBe(false);
    const stays: Eq = {
      id: "s",
      name: "Séjours Gîte",
      type: "sensor",
      dataBindings: [
        { alias: "occupied", value: true },
        { alias: "arrival", value: "2026-10-06T16:00:00+02:00" },
        { alias: "departure", value: "" },
      ],
      orderBindings: [],
    };
    expect(readStay(stays)).toEqual({ occupied: true, arrival: Date.parse("2026-10-06T16:00:00+02:00"), departure: null });
  });
});

describe("validate (smart heating)", () => {
  const eqs = [heater("h1"), heater("h2"), sensor("room", 18), pirEq("pir")];
  const v = (params: Record<string, unknown>) => () => createRecipe().validate(params, makeCtx(eqs).ctx as never);

  it("accepts the office", () => expect(v(OFFICE_PARAMS)).not.toThrow());
  it("refuses comfort above the cap", () => expect(v({ ...OFFICE_PARAMS, comfortTemp: 26 })).toThrow(/cap/));
  it("refuses an away temperature too close to comfort", () =>
    expect(v({ ...OFFICE_PARAMS, frostTemp: 15, comfortTemp: 16 })).toThrow(/away/));
  it("refuses coasting outside work hours", () => expect(v({ ...OFFICE_PARAMS, coastFrom: "18:00" })).toThrow(/coasting/));
  it("refuses fast checks further apart than slow ones", () =>
    expect(v({ ...OFFICE_PARAMS, fastInterval: "2h" })).toThrow(/Fast checks/));
  it("refuses stays without a stays equipment, pointing at day/night", () =>
    expect(v({ ...OFFICE_PARAMS, source: "stays" })).toThrow(/Day \/ night/));
  it("refuses a night warmer than the day", () =>
    expect(v({ ...OFFICE_PARAMS, source: "daynight", comfortTemp: 19, nightTemp: 20 })).toThrow(/night/));
  it("leaves cap-only instances to the v0.2 rules", () =>
    expect(v({ zone: "z", heaters: ["h1"], sensor: "room", maxTemp: 24, frostTemp: 7 })).not.toThrow());
});

describe("office day, simulated room", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function day(motion: (now: number) => boolean) {
    vi.setSystemTime(at(5, 0, 0));
    const h1 = heater("h1");
    const h2 = heater("h2");
    const room = sensor("room", 14);
    const pir = pirEq("pir");
    const out = sensor("out", 3);
    const { ctx, logs, state } = makeCtx([h1, h2, room, pir, out]);
    const temp = { v: 14 };
    const handle = createRecipe().createInstance(OFFICE_PARAMS, ctx as never);
    const samples = new Map<string, { temp: number; h1: boolean; h2: boolean }>();
    await runUntil(at(5, 20, 0), (now) => {
      simulateRoom(room, [h1, h2], 3, temp);
      pir.dataBindings[0].value = motion(now);
      const d = new Date(now);
      samples.set(`${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`, { temp: temp.v, h1: on(h1), h2: on(h2) });
    });
    handle.stop();
    return { samples, logs, state };
  }

  const workday = (now: number): boolean => {
    const d = new Date(now);
    const m = d.getHours() * 60 + d.getMinutes();
    return m >= 395 && m <= 1015 && m % 8 === 0;
  };

  it("is at 22 °C when work starts, with both heaters, and not hours before", async () => {
    const { samples, logs } = await day(workday);
    expect(samples.get("6:30")!.temp).toBeGreaterThanOrEqual(21.6);
    expect(samples.get("0:30")!.h1).toBe(false); // no heating in the middle of the night
    const pre = logs.find((l) => l.startsWith("Préchauffe"));
    expect(pre).toBeDefined();
    expect(samples.get("5:00")!.h1).toBe(samples.get("5:00")!.h2); // decision C: together
  });

  it("holds comfort through the day and stops after the last motion", async () => {
    const { samples } = await day(workday);
    expect(samples.get("11:00")!.temp).toBeGreaterThan(21.4);
    expect(samples.get("11:00")!.temp).toBeLessThan(22.6);
    expect(samples.get("19:00")!.h1).toBe(false);
    expect(samples.get("19:00")!.temp).toBeLessThan(21);
  });

  it("cuts at 08:00 on a day off", async () => {
    const { samples, logs } = await day(() => false);
    expect(logs.some((l) => l.includes("congé"))).toBe(true);
    expect(samples.get("8:05")!.h1).toBe(false);
    expect(samples.get("12:00")!.temp).toBeLessThan(20);
  });

  it("learns the room as it goes", async () => {
    const { state } = await day(workday);
    const model = state.get("model") as { gain: number; gainSamples: number; tauSamples: number } | undefined;
    expect(model).toBeDefined();
    expect(model!.gainSamples + model!.tauSamples).toBeGreaterThan(0);
  });

  it("publishes a tile summary and a check countdown", async () => {
    vi.setSystemTime(at(5, 9, 0));
    const h1 = heater("h1");
    const room = sensor("room", 22);
    const pir = pirEq("pir");
    const { ctx, state } = makeCtx([h1, heater("h2"), room, pir, sensor("out", 5)]);
    pir.dataBindings[0].value = true;
    const handle = createRecipe().createInstance(OFFICE_PARAMS, ctx as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(String(state.get("summary"))).toMatch(/Confort 22 °C/);
    expect(typeof state.get("timerExpiresAt")).toBe("string");
    handle.stop();
  });
});

describe("modes in smart heating", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("forced comfort heats until midnight, then hands back to auto", async () => {
    vi.setSystemTime(at(10, 21, 0)); // Saturday evening: the plan says away
    const h1 = heater("h1");
    const room = sensor("room", 16);
    const { ctx, state, logs } = makeCtx([h1, heater("h2"), room, pirEq("pir"), sensor("out", 5)]);
    const handle = createRecipe().createInstance(OFFICE_PARAMS, ctx as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(on(h1)).toBe(false);
    handle.onAction!("set_mode", { mode: "comfort" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(on(h1)).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(state.get("mode")).toBe("auto");
    expect(logs.some((l) => l.includes("Fin du confort forcé"))).toBe(true);
    handle.stop();
  });

  it("an open window stops the heating even while the plan wants comfort", async () => {
    vi.setSystemTime(at(5, 10, 0));
    const h1 = heater("h1");
    const contact: Eq = {
      id: "win",
      name: "win",
      type: "sensor",
      dataBindings: [{ alias: "contact", category: "contact_window", value: false }],
      orderBindings: [],
    };
    const pir = pirEq("pir");
    pir.dataBindings[0].value = true;
    const { ctx } = makeCtx([h1, heater("h2"), sensor("room", 18), pir, contact, sensor("out", 5)]);
    const handle = createRecipe().createInstance({ ...OFFICE_PARAMS, windowSensors: ["win"] }, ctx as never);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(on(h1)).toBe(false);
    contact.dataBindings[0].value = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(on(h1)).toBe(true);
    handle.stop();
  });

  it("a stays room is cold before arrival and pre-heats for it", async () => {
    vi.setSystemTime(at(6, 8, 0));
    const h1 = heater("h1");
    const room = sensor("room", 12);
    const stays: Eq = {
      id: "stays",
      name: "Séjours Gîte",
      type: "sensor",
      dataBindings: [
        { alias: "occupied", value: false },
        { alias: "arrival", value: new Date(at(6, 16, 0)).toISOString() },
        { alias: "departure", value: new Date(at(9, 10, 0)).toISOString() },
      ],
      orderBindings: [],
    };
    const { ctx, logs } = makeCtx([h1, room, stays, sensor("out", 5)]);
    const handle = createRecipe().createInstance(
      { zone: "z", heaters: ["h1"], sensor: "room", source: "stays", stays: "stays", comfortTemp: 20, nightTemp: 17, frostTemp: 7, outdoorSensor: "out" },
      ctx as never,
    );
    const temp = { v: 12 };
    await runUntil(at(6, 16, 0), () => simulateRoom(room, [h1], 5, temp));
    expect(logs.some((l) => l.startsWith("Préchauffe"))).toBe(true);
    expect(temp.v).toBeGreaterThanOrEqual(19.6);
    handle.stop();
  });
});
