import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRecipe,
  findOnOffOrderAlias,
  findTemperatureAlias,
  isContactOpen,
  isOnValue,
  normalizeIds,
} from "./index.js";

// ============================================================
// Fake Sowel context
// ============================================================

interface FakeBinding {
  alias: string;
  category?: string;
  value?: unknown;
  stale?: boolean;
  lastUpdated?: string | null;
}

interface FakeEquipment {
  id: string;
  name: string;
  type: string;
  dataBindings: FakeBinding[];
  orderBindings: Array<{ alias: string; category?: string; type?: string; enumValues?: string[] }>;
}

function parseDuration(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw new Error(`Invalid duration: ${String(value)}`);
  const match = value.match(/^(\d+)\s*(s|m|h)$/);
  if (!match) throw new Error(`Invalid duration format: ${value}`);
  const num = parseInt(match[1], 10);
  return match[2] === "s" ? num * 1000 : match[2] === "m" ? num * 60_000 : num * 3_600_000;
}

function formatDuration(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}min`;
  return `${Math.round(ms / 1000)}s`;
}

function makeHeater(id: string, name: string, on: boolean): FakeEquipment {
  return {
    id,
    name,
    type: "switch",
    dataBindings: [{ alias: "state", category: "light_state", value: on ? "ON" : "OFF" }],
    orderBindings: [{ alias: "state", category: "light_toggle", type: "boolean" }],
  };
}

function makeSensor(id: string, name: string, temperature: number | null): FakeEquipment {
  return {
    id,
    name,
    type: "sensor",
    dataBindings: [
      { alias: "battery", category: "battery", value: 100 },
      { alias: "temperature", category: "temperature", value: temperature },
    ],
    orderBindings: [],
  };
}

function makeContact(id: string, name: string, open: boolean): FakeEquipment {
  return {
    id,
    name,
    type: "sensor",
    // Zigbee convention: contact === false means the window is open.
    dataBindings: [{ alias: "contact", category: "contact_window", value: !open }],
    orderBindings: [],
  };
}

function setTemp(sensor: FakeEquipment, value: number | null, stale = false): void {
  const binding = sensor.dataBindings.find((b) => b.alias === "temperature")!;
  binding.value = value;
  binding.stale = stale;
}

function setRelay(heater: FakeEquipment, on: boolean): void {
  heater.dataBindings.find((b) => b.alias === "state")!.value = on ? "ON" : "OFF";
}

function relayOn(heater: FakeEquipment): boolean {
  return heater.dataBindings.find((b) => b.alias === "state")!.value === "ON";
}

function makeCtx(equipments: FakeEquipment[], aggregate?: { openWindows: number }) {
  const byId = new Map(equipments.map((e) => [e.id, e]));
  const orders: Array<{ id: string; alias: string; value: unknown }> = [];
  const logs: string[] = [];
  const state = new Map<string, unknown>();
  const subscriptions: Array<{ type: string; handler: (e: Record<string, unknown>) => void }> = [];

  const ctx = {
    eventBus: {
      onType(type: string, handler: (e: Record<string, unknown>) => void) {
        const entry = { type, handler };
        subscriptions.push(entry);
        return () => {
          const i = subscriptions.indexOf(entry);
          if (i >= 0) subscriptions.splice(i, 1);
        };
      },
    },
    equipmentManager: {
      getById: (id: string) => byId.get(id) ?? null,
      getByIdWithDetails: (id: string) => byId.get(id) ?? null,
    },
    zoneManager: { getById: (id: string) => ({ id, name: "Chambre" }) },
    zoneAggregator: aggregate ? { getByZoneId: () => aggregate } : undefined,
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
      orders.push({ id, alias, value });
      const eq = byId.get(id);
      const binding = eq?.dataBindings.find((b) => b.alias === alias);
      // A real relay reports its new state back within a second or so.
      if (binding) binding.value = value === true || value === "ON" ? "ON" : "OFF";
      return { success: true };
    },
  };

  return { ctx, orders, logs, state, subscriptions };
}

const BASE_PARAMS = {
  zone: "zone-1",
  heaters: ["heater-1"],
  sensor: "sensor-1",
  maxTemp: 24,
  hysteresis: 0.5,
  manualGrace: "2m",
  frostTemp: 7,
  frostBand: 2,
  windowCutMax: "45m",
  dropDetection: true,
  dropDelta: 0.6,
  dropWindow: "10m",
  tempMaxAge: "1h",
};

const TICK = 30_000;

/** Let the instance's floating promises settle. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

async function ticks(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(n * TICK);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T08:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// Probing helpers
// ============================================================

describe("probing helpers", () => {
  it("reads the Zigbee contact convention (false = open)", () => {
    expect(isContactOpen(false)).toBe(true);
    expect(isContactOpen(0)).toBe(true);
    expect(isContactOpen("OFF")).toBe(true);
    expect(isContactOpen("open")).toBe(true);
    expect(isContactOpen(true)).toBe(false);
    expect(isContactOpen("ON")).toBe(false);
    expect(isContactOpen(undefined)).toBe(false);
  });

  it("reads a relay state from strings and booleans", () => {
    expect(isOnValue("ON")).toBe(true);
    expect(isOnValue(true)).toBe(true);
    expect(isOnValue("OFF")).toBe(false);
    expect(isOnValue(null)).toBe(false);
  });

  it("finds the on/off order and the temperature reading", () => {
    const heater = makeHeater("h", "Radiateur", true);
    expect(findOnOffOrderAlias(heater)).toBe("state");
    expect(findTemperatureAlias(makeSensor("s", "Sonde", 20))).toBe("temperature");
    expect(findTemperatureAlias(makeSensor("s", "Sonde", 20), "battery")).toBe("battery");
    expect(findTemperatureAlias(makeHeater("h", "Radiateur", true))).toBeNull();
  });

  it("normalises equipment id lists", () => {
    expect(normalizeIds(["a", "b"])).toEqual(["a", "b"]);
    expect(normalizeIds("a,b")).toEqual(["a", "b"]);
    expect(normalizeIds(undefined)).toEqual([]);
  });
});

// ============================================================
// validate()
// ============================================================

describe("validate", () => {
  it("refuses a heater with no on/off order binding", () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    heater.orderBindings = [];
    const { ctx } = makeCtx([heater, makeSensor("sensor-1", "Sonde", 20)]);
    expect(() => createRecipe().validate(BASE_PARAMS, ctx as never)).toThrow(/on\/off order/);
  });

  it("refuses a sensor with no temperature reading", () => {
    const sensor = makeSensor("sensor-1", "Sonde", 20);
    sensor.dataBindings = [{ alias: "battery", category: "battery", value: 90 }];
    const { ctx } = makeCtx([makeHeater("heater-1", "Radiateur", true), sensor]);
    expect(() => createRecipe().validate(BASE_PARAMS, ctx as never)).toThrow(/temperature reading/);
  });

  it("refuses a frost band that overlaps the cap", () => {
    const { ctx } = makeCtx([
      makeHeater("heater-1", "Radiateur", true),
      makeSensor("sensor-1", "Sonde", 20),
    ]);
    expect(() =>
      createRecipe().validate({ ...BASE_PARAMS, maxTemp: 8, frostTemp: 7, frostBand: 2 }, ctx as never),
    ).toThrow(/frost band/);
  });

  it("accepts a sane configuration", () => {
    const { ctx } = makeCtx([
      makeHeater("heater-1", "Radiateur", true),
      makeSensor("sensor-1", "Sonde", 20),
    ]);
    expect(() => createRecipe().validate(BASE_PARAMS, ctx as never)).not.toThrow();
  });
});

// ============================================================
// Cap
// ============================================================

describe("temperature cap", () => {
  it("cuts above the cap and restores below the hysteresis", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 25);
    const { ctx, orders } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);

    await flush();
    expect(relayOn(heater)).toBe(false);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ id: "heater-1", alias: "state", value: false });

    // Still inside the hysteresis band — the relay stays open.
    setTemp(sensor, 23.7);
    await ticks(2);
    expect(relayOn(heater)).toBe(false);

    setTemp(sensor, 23.2);
    await ticks(1);
    expect(relayOn(heater)).toBe(true);
    expect(orders).toHaveLength(2);

    // The cut cooled the room by nearly 2 °C. That is the recipe's own doing,
    // and must never come back as a phantom open window.
    setTemp(sensor, 22.4);
    await ticks(1);
    setTemp(sensor, 21.9);
    await ticks(1);
    expect(relayOn(heater)).toBe(true);
    expect(orders).toHaveLength(2);

    handle.stop();
  });

  it("never switches on a heater the guest switched off", async () => {
    const heater = makeHeater("heater-1", "Radiateur", false);
    const sensor = makeSensor("sensor-1", "Sonde", 25);
    const { ctx, orders } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);

    await flush();
    expect(orders).toHaveLength(0);

    setTemp(sensor, 18);
    await ticks(2);
    expect(orders).toHaveLength(0);
    expect(relayOn(heater)).toBe(false);

    handle.stop();
    expect(orders).toHaveLength(0);
  });

  it("tolerates a manual switch-on for the grace delay, then caps again", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 25);
    const { ctx, orders, logs } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);

    await flush();
    expect(relayOn(heater)).toBe(false);

    // The guest presses the wall switch.
    setRelay(heater, true);
    await vi.advanceTimersByTimeAsync(90_000); // past ORDER_SETTLE_MS
    expect(relayOn(heater)).toBe(true);
    expect(logs.some((l) => l.includes("commande manuelle"))).toBe(true);
    expect(orders).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(150_000); // past the 2 min tolerance
    expect(relayOn(heater)).toBe(false);
    expect(orders).toHaveLength(2);
    expect(logs.some((l) => l.includes("fin de la tolérance"))).toBe(true);

    handle.stop();
  });

  it("releases the cut when the sensor goes mute", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 25);
    const { ctx, logs } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);

    await flush();
    expect(relayOn(heater)).toBe(false);

    setTemp(sensor, 25, true);
    await ticks(1);
    expect(relayOn(heater)).toBe(true);
    expect(logs.some((l) => l.includes("muette"))).toBe(true);

    handle.stop();
  });
});

// ============================================================
// Windows
// ============================================================

describe("open window", () => {
  it("cuts on a confirmed contact and restores when it closes", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 21);
    const contact = makeContact("window-1", "Fenêtre chambre", false);
    const { ctx } = makeCtx([heater, sensor, contact]);
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, windowSensors: ["window-1"] },
      ctx as never,
    );

    await flush();
    expect(relayOn(heater)).toBe(true);

    contact.dataBindings[0].value = false; // opened
    await ticks(1);
    expect(relayOn(heater)).toBe(true); // not confirmed yet

    await ticks(2); // past WINDOW_CONFIRM_MS
    expect(relayOn(heater)).toBe(false);

    contact.dataBindings[0].value = true; // closed
    await ticks(1);
    expect(relayOn(heater)).toBe(true);

    handle.stop();
  });

  it("uses the zone's own window contacts when none is configured", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 21);
    const aggregate = { openWindows: 1 };
    const { ctx } = makeCtx([heater, sensor], aggregate);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);

    await flush();
    await ticks(3);
    expect(relayOn(heater)).toBe(false);

    aggregate.openWindows = 0;
    await ticks(1);
    expect(relayOn(heater)).toBe(true);

    handle.stop();
  });

  it("falls back to the temperature drop when no contact exists", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 21);
    const { ctx, logs } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);

    await flush();
    await ticks(3); // a few samples at 21 °C
    expect(relayOn(heater)).toBe(true);

    setTemp(sensor, 20.2); // -0.8 °C, over the 0.6 °C threshold
    await ticks(1);
    expect(relayOn(heater)).toBe(false);
    expect(logs.some((l) => l.includes("fenêtre probablement ouverte"))).toBe(true);

    // Room stops falling and creeps back up: the window was closed again.
    setTemp(sensor, 20.6);
    await ticks(1);
    expect(relayOn(heater)).toBe(true);

    handle.stop();
  });

  it("never leaves the room cold longer than windowCutMax", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 21);
    const { ctx } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);

    await flush();
    await ticks(3);
    setTemp(sensor, 20.2);
    await ticks(1);
    expect(relayOn(heater)).toBe(false);

    // A room that keeps cooling never "recovers" — only the ceiling ends this.
    for (let i = 0; i < 90; i++) {
      setTemp(sensor, 20.2 - i * 0.01);
      await ticks(1);
    }
    expect(relayOn(heater)).toBe(true);

    handle.stop();
  });

  it("ignores the drop heuristic once contacts are configured", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 21);
    const contact = makeContact("window-1", "Fenêtre chambre", false);
    const { ctx } = makeCtx([heater, sensor, contact]);
    const handle = createRecipe().createInstance(
      { ...BASE_PARAMS, windowSensors: ["window-1"] },
      ctx as never,
    );

    await flush();
    await ticks(3);
    setTemp(sensor, 19.5); // a 1.5 °C drop, contact still closed
    await ticks(2);
    expect(relayOn(heater)).toBe(true);

    handle.stop();
  });
});

// ============================================================
// Frost mode
// ============================================================

describe("frost mode", () => {
  it("holds the relays open, heats under the floor, stops on the band", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 12);
    const { ctx } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);
    await flush();

    handle.onAction?.("set_mode", { mode: "frost" });
    await ticks(1);
    expect(relayOn(heater)).toBe(false); // empty house: heating off

    setTemp(sensor, 6.5);
    await ticks(1);
    expect(relayOn(heater)).toBe(true);

    setTemp(sensor, 8.5); // still inside the band
    await ticks(1);
    expect(relayOn(heater)).toBe(true);

    setTemp(sensor, 9.2); // floor + band reached
    await ticks(1);
    expect(relayOn(heater)).toBe(false);

    handle.stop();
  });

  it("keeps the heater on when the sensor is mute", async () => {
    const heater = makeHeater("heater-1", "Radiateur", false);
    const sensor = makeSensor("sensor-1", "Sonde", null);
    const { ctx, logs } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);
    await flush();

    handle.onAction?.("set_mode", { mode: "frost" });
    await ticks(1);
    expect(relayOn(heater)).toBe(true);
    expect(logs.some((l) => l.includes("hors-gel à l'aveugle"))).toBe(true);

    handle.stop();
  });

  it("hands the heaters back when leaving frost mode", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 12);
    const { ctx } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);
    await flush();

    handle.onAction?.("set_mode", { mode: "frost" });
    await ticks(1);
    expect(relayOn(heater)).toBe(false);

    handle.onAction?.("set_mode", { mode: "auto" });
    await ticks(1);
    expect(relayOn(heater)).toBe(true);

    handle.stop();
  });
});

// ============================================================
// Lifecycle
// ============================================================

describe("lifecycle", () => {
  it("pausing hands the heating back", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 25);
    const { ctx } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);

    await flush();
    expect(relayOn(heater)).toBe(false);

    handle.onAction?.("set_mode", { mode: "off" });
    await ticks(1);
    expect(relayOn(heater)).toBe(true);

    setTemp(sensor, 28);
    await ticks(2);
    expect(relayOn(heater)).toBe(true); // paused: no more capping

    handle.stop();
  });

  it("stop() restores what it opened, unsubscribes and clears the ticker", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 25);
    const { ctx, orders, subscriptions } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);

    await flush();
    expect(relayOn(heater)).toBe(false);
    expect(subscriptions).toHaveLength(1);

    handle.stop();
    await flush();
    expect(relayOn(heater)).toBe(true);
    expect(subscriptions).toHaveLength(0);

    const after = orders.length;
    await ticks(4);
    expect(orders).toHaveLength(after);

    handle.stop(); // idempotent
  });

  it("re-evaluates on an equipment data change without waiting for the tick", async () => {
    const heater = makeHeater("heater-1", "Radiateur", true);
    const sensor = makeSensor("sensor-1", "Sonde", 20);
    const { ctx, orders, subscriptions } = makeCtx([heater, sensor]);
    const handle = createRecipe().createInstance(BASE_PARAMS, ctx as never);

    await flush();
    expect(orders).toHaveLength(0);

    setTemp(sensor, 26);
    subscriptions[0].handler({ equipmentId: "sensor-1", alias: "temperature", value: 26 });
    await flush();
    expect(relayOn(heater)).toBe(false);

    handle.stop();
  });
});
