import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL, coastTo, learnFromCooling, learnFromHeating, readModel, timeToReach } from "./thermal.js";
import { BLIND_OUTDOOR_C, buildOutside, parseHourly, snapshotAt } from "./weather.js";

const H = 3_600_000;
const T0 = new Date(2026, 9, 5, 0, 0).getTime();

describe("thermal model", () => {
  it("learns tau from a night cooling stretch", () => {
    // Real room tau = 20 h: from 20 °C with 5 °C outside, 1 h loses 0.75 °C.
    let m = { ...DEFAULT_MODEL };
    for (let i = 0; i < 6; i++) {
      m = learnFromCooling(m, { startAt: T0, endAt: T0 + H, startTemp: 20, endTemp: 19.25, outdoor: 5 }) ?? m;
    }
    expect(m.tau).toBeGreaterThan(17);
    expect(m.tau).toBeLessThan(21);
    expect(m.tauSamples).toBe(6);
  });

  it("ignores stretches that say nothing (too short, too little lead, warming)", () => {
    const m = { ...DEFAULT_MODEL };
    expect(learnFromCooling(m, { startAt: T0, endAt: T0 + 10 * 60_000, startTemp: 20, endTemp: 19.8, outdoor: 5 })).toBeNull();
    expect(learnFromCooling(m, { startAt: T0, endAt: T0 + H, startTemp: 8, endTemp: 7.9, outdoor: 6 })).toBeNull();
    expect(learnFromCooling(m, { startAt: T0, endAt: T0 + H, startTemp: 20, endTemp: 20.2, outdoor: 5 })).toBeNull();
  });

  it("learns gain from a heating stretch, loss added back", () => {
    let m = { ...DEFAULT_MODEL, tau: 20 };
    // gain 3 °C/h, mean lead 13 °C → net slope 3 − 0.65 = 2.35 °C/h.
    for (let i = 0; i < 6; i++) {
      m = learnFromHeating(m, { startAt: T0, endAt: T0 + H, startTemp: 16.825, endTemp: 19.175, outdoor: 5 }) ?? m;
    }
    expect(m.gain).toBeGreaterThan(2.8);
    expect(m.gain).toBeLessThan(3.1);
  });

  it("predicts a longer warm-up from colder rooms and colder outsides", () => {
    const m = { gain: 3, tau: 16, gainSamples: 5, tauSamples: 5 };
    const fromMild = timeToReach(m, 15, 22, T0, () => 8);
    const fromCold = timeToReach(m, 12, 22, T0, () => 8);
    const colderOut = timeToReach(m, 15, 22, T0, () => -3);
    expect(fromCold).toBeGreaterThan(fromMild);
    expect(colderOut).toBeGreaterThan(fromMild);
    expect(timeToReach(m, 23, 22, T0, () => 8)).toBe(0);
    expect(timeToReach({ ...m, gain: 0.3 }, 10, 22, T0, () => -10)).toBe(Infinity);
  });

  it("coasts down along the loss curve", () => {
    const m = { gain: 3, tau: 16, gainSamples: 0, tauSamples: 0 };
    const after = coastTo(m, 22, T0, T0 + H, () => 6);
    expect(after).toBeLessThan(22);
    expect(after).toBeGreaterThan(20.9);
  });

  it("reads a stored model defensively", () => {
    expect(readModel(null)).toEqual(DEFAULT_MODEL);
    expect(readModel({ gain: 1000, tau: -1 })).toMatchObject({ gain: 12, tau: 2 });
  });
});

describe("outside", () => {
  const series = {
    issuedAt: "x",
    hours: [0, 1, 2, 3].map((h) => ({ t: new Date(T0 + h * H).toISOString(), direct: 100 * h, diffuse: 50, temp: 10 + h })),
  };

  it("parses the plugin's series, object or JSON string", () => {
    expect(parseHourly(series)).toHaveLength(4);
    expect(parseHourly(JSON.stringify(series))).toHaveLength(4);
    expect(parseHourly("not json")).toEqual([]);
    expect(parseHourly({ hours: "nope" })).toEqual([]);
  });

  it("prefers the series, corrected by the live sensor", () => {
    const o = buildOutside(T0 + H, parseHourly(series), 13, []);
    expect(o.source).toBe("forecast");
    expect(o.outdoorAt(T0 + H)).toBeCloseTo(13); // series says 11, sensor 13 → +2 bias
    expect(o.outdoorAt(T0 + 2 * H + H / 2)).toBeCloseTo(14.5);
    expect(o.sunAt(T0 + 2 * H)).toBeCloseTo(250);
  });

  it("falls back to the sensor, then yesterday's snapshot, then a cold default", () => {
    expect(buildOutside(T0, [], 4, []).outdoorAt(T0)).toBe(4);
    const snap = buildOutside(T0, [], null, [{ date: "2026-10-05", min: 2, max: 14 }]);
    expect(snap.source).toBe("snapshot");
    expect(snap.outdoorAt(new Date(2026, 9, 5, 6).getTime())).toBeCloseTo(2);
    expect(snap.outdoorAt(new Date(2026, 9, 5, 15).getTime())).toBeCloseTo(14);
    expect(snapshotAt({ date: "x", min: 2, max: 14 }, new Date(2026, 9, 5, 10, 30).getTime())).toBeGreaterThan(2);
    const blind = buildOutside(T0, [], null, []);
    expect(blind.source).toBe("blind");
    expect(blind.outdoorAt(T0)).toBe(BLIND_OUTDOOR_C);
  });
});
