/**
 * Sowel Recipe: Heater Cap (plafond de chauffage)
 *
 * An electric heater behind a plain ON/OFF relay, a temperature sensor in the
 * room, and a guest who turns the radiator's own knob to the maximum. The
 * radiator regulates itself — this recipe never sets a setpoint, it only
 * decides when the relay is allowed to feed it.
 *
 * ── Three modes, one action pill ──────────────────────────────────────────
 *
 *  auto  (default) — the *veto* mode, the one that runs while guests are in.
 *        The room is theirs up to `maxTemp`; above it the relay opens, and it
 *        closes again once the room falls back under `maxTemp - hysteresis`.
 *        An open window opens the relay too.
 *
 *        The rule that keeps this liveable: **the recipe only ever closes a
 *        relay it opened itself**. A heater the guest switched off stays off;
 *        the recipe is a ceiling, not a thermostat.
 *
 *  frost — the *ownership* mode, for a place standing empty in winter. The
 *        relays stay open, and the recipe closes them only to hold the frost
 *        floor: heat below `frostTemp`, stop at `frostTemp + frostBand`.
 *        Switching back to `auto` hands the heaters back on, so the next guest
 *        finds a room that heats.
 *
 *  off   — recipe parked (summer). Anything it was holding open is handed back.
 *
 * ── Open windows ──────────────────────────────────────────────────────────
 *
 * Two detectors, in that order of trust:
 *
 *  1. Contacts. Either the ones listed in `windowSensors`, or — when that list
 *     is empty — whatever window contacts the zone already aggregates. An open
 *     contact must hold for a minute before it cuts (a window cracked open for
 *     twenty seconds is not worth an order), and closing restores immediately.
 *
 *  2. Temperature drop. No hardware needed: a fall of `dropDelta` inside
 *     `dropWindow` reads as an open window. It cuts, then hands the heat back
 *     when the room stops falling (the window was closed) or after
 *     `windowCutMax` at the latest — a heuristic must never be able to leave a
 *     room cold indefinitely.
 *
 * The heuristic is disabled as soon as `windowSensors` is filled in: contacts
 * say the truth, and running a guess alongside them only adds false positives.
 *
 * ── Manual overrides ──────────────────────────────────────────────────────
 *
 * Somebody pressing the wall switch while the recipe holds the relay open gets
 * `manualGrace` (2 min by default) before the recipe puts it back. Long enough
 * for the gesture not to feel broken, short enough that the cap is still a cap.
 *
 * ── Degradations ──────────────────────────────────────────────────────────
 *
 * A mute sensor (no reading, or older than `tempMaxAge`) fails *open* in `auto`
 * — the cut is released and the guests keep their heating — and fails *closed*
 * in `frost`, where the relay is held on because a burst pipe costs more than
 * the kWh. Both are logged.
 */

import {
  DEFAULT_MODEL,
  HEAT_SETTLE_MS,
  MIN_STRETCH_MS,
  coastTo,
  learnFromCooling,
  learnFromHeating,
  readModel,
  timeToReach,
  type ThermalModel,
} from "./thermal.js";
import { buildOutside, localDate, parseHourly, type DaySnapshot, type Outside } from "./weather.js";
import {
  Occupancy,
  atMinute,
  hm,
  minuteOfDay,
  planAt,
  type Level,
  type OccupancyConfig,
  type Phase,
  type Source,
  type Stay,
  type Verdict,
} from "./occupancy.js";

// ============================================================
// Types (mirrored from Sowel core — recipe packages don't import core)
// ============================================================

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type:
    | "zone"
    | "equipment"
    | "number"
    | "duration"
    | "time"
    | "boolean"
    | "text"
    | "data-key"
    | "select";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  options?: { value: string; label: string }[];
  hiddenWhen?: { slot: string; equals: string | string[] };
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
    crossZone?: boolean;
    includeDescendants?: boolean;
  };
  group?: string;
}

interface RecipeSlotI18n {
  name: string;
  description: string;
  options?: Record<string, string>;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, RecipeSlotI18n>;
  groups?: Record<string, string>;
}

interface RecipeActionDef {
  id: string;
  type: "cycle";
  stateKey: string;
  options: { value: string; label: string }[];
}

interface DataBindingLite {
  alias: string;
  value?: unknown;
  unit?: string;
  category?: string;
  enumValues?: string[];
  stale?: boolean;
  lastUpdated?: string | null;
}

interface OrderBindingLite {
  alias: string;
  type?: string;
  category?: string;
  enumValues?: string[];
}

interface EquipmentLite {
  id: string;
  name: string;
  type: string;
  status?: string;
  dataBindings: DataBindingLite[];
  orderBindings: OrderBindingLite[];
  computedData?: { alias: string; value: unknown }[];
}

interface ZoneAggregateLite {
  temperature?: number | null;
  openWindows?: number;
  openDoors?: number;
}

interface RecipeStateStore {
  get(key: string): unknown | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  clear(): void;
}

interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getById(id: string): { id: string; name: string } | null;
    getByIdWithDetails(id: string): EquipmentLite | null;
  };
  zoneManager: { getById(id: string): { id: string; name: string } | null };
  zoneAggregator?: { getByZoneId(id: string): ZoneAggregateLite | null };
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
  state: RecipeStateStore;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    parseDuration(value: unknown): number;
    formatDuration(ms: number): string;
  };
  dispatchOrder: (
    equipmentId: string,
    alias: string,
    value: unknown,
  ) => Promise<{ success: boolean; error?: string }>;
}

interface RecipeInstanceHandle {
  stop(): void;
  onAction?(action: string, payload?: Record<string, unknown>): void;
}

interface RecipeTileDef {
  icon?: string;
  summaryKey?: string;
  countdownKey?: string;
  actions?: string[];
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  actions?: RecipeActionDef[];
  tile?: RecipeTileDef;
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(params: Record<string, unknown>, ctx: RecipeContext): RecipeInstanceHandle;
}

// ============================================================
// Tuning constants — deliberately not slots
// ============================================================

/** Re-evaluation cadence. Sensors report on their own schedule; this tick is
 *  what closes the loop on everything time-based (grace delays, cut ceilings). */
const TICK_MS = 30_000;

/** A relay state that disagrees with what we ordered is only read as a human
 *  action once our own order has had time to travel and be reported back. */
const ORDER_SETTLE_MS = 60_000;

/** With no readable relay state there is nothing to compare against, so the
 *  order is simply repeated at this interval instead of every tick. */
const BLIND_REPEAT_MS = 10 * 60_000;

/** How long a contact must read "open" before it cuts the heating. */
const WINDOW_CONFIRM_MS = 60_000;

/** Rise from the lowest point that reads as "the window was closed again". */
const DROP_RECOVERY_C = 0.3;

/** Quiet period after a heuristic cut ends, so a room that keeps cooling on its
 *  own does not trigger a second cut straight away. */
const DROP_REARM_MS = 15 * 60_000;

/** A drop is only believable with a few samples behind it. */
const DROP_MIN_SAMPLES = 3;

const HEATER_TYPES = ["switch", "heater"];
const SENSOR_TYPES = ["sensor", "thermostat", "weather"];

const TEMP_ALIASES = ["temperature", "temp", "local_temperature", "current_temperature"];
const CONTACT_CATEGORIES = ["contact_window", "contact_door"];
const CONTACT_ALIASES = ["contact", "opening", "window", "door"];

type Mode = "auto" | "comfort" | "frost" | "off";
type SourceParam = "cap" | Source;
type Hold = "cap" | "window";

// ============================================================
// Pure helpers (exported for tests)
// ============================================================

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function normalizeIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && !!v);
  if (typeof value === "string" && value.length > 0) return value.split(",").filter(Boolean);
  return [];
}

/** Relay state as reported by the device. */
export function isOnValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "on" || v === "true" || v === "1" || v === "open";
  }
  return false;
}

/**
 * Contact convention, same as core's zone aggregator: Zigbee reports
 * `contact: true` when the magnet is *in place*, so `false` is the open window.
 * Strings from other bridges are accepted on top of it.
 */
export function isContactOpen(value: unknown): boolean {
  if (value === false || value === 0) return true;
  if (value === true || value === 1) return false;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "off" || v === "open" || v === "opened") return true;
    return false;
  }
  return false;
}

/** The on/off channel of a relay: `state` by convention, then the toggle
 *  category, then any ON/OFF enum (Tasmota-style `power1`), then a boolean. */
export function findOnOffOrderAlias(eq: EquipmentLite | null): string | null {
  const orders = eq?.orderBindings ?? [];
  const byName = orders.find((o) => o.alias === "state");
  if (byName) return byName.alias;
  const byCategory = orders.find(
    (o) => o.category === "light_toggle" || o.category === "toggle_power",
  );
  if (byCategory) return byCategory.alias;
  const byEnum = orders.find(
    (o) =>
      o.enumValues?.some((v) => v.toUpperCase() === "ON") &&
      o.enumValues?.some((v) => v.toUpperCase() === "OFF"),
  );
  if (byEnum) return byEnum.alias;
  return orders.find((o) => o.type === "boolean")?.alias ?? null;
}

/** The room temperature channel: the user's explicit pick, then the category,
 *  then the usual names. */
export function findTemperatureAlias(eq: EquipmentLite | null, preferred?: string): string | null {
  if (!eq) return null;
  if (preferred && eq.dataBindings.some((b) => b.alias === preferred)) return preferred;
  const byCategory = eq.dataBindings.find((b) => b.category === "temperature");
  if (byCategory) return byCategory.alias;
  for (const alias of TEMP_ALIASES) {
    if (eq.dataBindings.some((b) => b.alias === alias)) return alias;
  }
  return null;
}

export function findContactBinding(eq: EquipmentLite | null): DataBindingLite | null {
  if (!eq) return null;
  const byCategory = eq.dataBindings.find((b) => CONTACT_CATEGORIES.includes(b.category ?? ""));
  if (byCategory) return byCategory;
  return eq.dataBindings.find((b) => CONTACT_ALIASES.includes(b.alias)) ?? null;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") return true;
    if (v === "false" || v === "0" || v === "no") return false;
  }
  return fallback;
}

function readMode(value: unknown): Mode {
  return value === "frost" || value === "off" || value === "comfort" ? value : "auto";
}

export function readSource(value: unknown): SourceParam {
  return value === "schedule" || value === "stays" || value === "daynight" ? value : "cap";
}

/** `"HH:MM"` → minutes after midnight, or null. */
export function parseTime(value: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export const WORKDAY_SETS: Record<string, number[]> = {
  "mon-fri": [1, 2, 3, 4, 5],
  "mon-sat": [1, 2, 3, 4, 5, 6],
  all: [0, 1, 2, 3, 4, 5, 6],
};

const MOTION_ALIASES = ["occupancy", "motion", "presence"];

/** A motion sensor's live verdict: `true` while it sees somebody. */
export function readMotion(eq: EquipmentLite | null): boolean | null {
  if (!eq) return null;
  const b =
    eq.dataBindings.find((x) => x.category === "motion") ??
    eq.dataBindings.find((x) => MOTION_ALIASES.includes(x.alias));
  if (!b || b.value === undefined || b.value === null) return null;
  return isOnValue(b.value);
}

/** The stays equipment published by the guestFlow plugin (or anything shaped like it). */
export function readStay(eq: EquipmentLite | null): Stay | null {
  if (!eq) return null;
  const value = (alias: string): unknown => eq.dataBindings.find((b) => b.alias === alias)?.value;
  const date = (alias: string): number | null => {
    const v = value(alias);
    if (typeof v !== "string" || v.trim() === "") return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };
  const occupied = value("occupied");
  return {
    occupied: occupied === undefined || occupied === null ? false : isOnValue(occupied),
    arrival: date("arrival"),
    departure: date("departure"),
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round1(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

// ============================================================
// Slots
// ============================================================

/**
 * `sensor` is deliberately the first single `equipment` slot: the recipe form
 * resolves a `data-key` slot's choices against that slot, so `tempKey` lists
 * the sensor's own aliases. Moving it would silently empty that dropdown.
 */
function buildSlots(): RecipeSlotDef[] {
  return [
    {
      id: "zone",
      name: "Zone",
      description: "Room the heater warms",
      type: "zone",
      required: true,
      group: "main",
    },
    {
      id: "heaters",
      name: "Heater relays",
      description: "On/off relays feeding the heaters",
      type: "equipment",
      required: true,
      list: true,
      constraints: { equipmentType: HEATER_TYPES, crossZone: true, includeDescendants: true },
      group: "main",
    },
    {
      id: "sensor",
      name: "Room sensor",
      description: "Temperature reading",
      type: "equipment",
      required: true,
      constraints: { equipmentType: SENSOR_TYPES, crossZone: true, includeDescendants: true },
      group: "main",
    },

    {
      id: "source",
      name: "Occupancy",
      description: "What decides when to heat",
      type: "select",
      required: false,
      defaultValue: "cap",
      options: [
        { value: "cap", label: "None — cap only" },
        { value: "schedule", label: "Work schedule" },
        { value: "stays", label: "Stays" },
        { value: "daynight", label: "Day / night" },
      ],
      group: "occupancy",
    },
    {
      id: "comfortTemp",
      name: "Day / comfort",
      description: "Target when occupied (°C)",
      type: "number",
      required: false,
      defaultValue: 20,
      constraints: { min: 10, max: 28 },
      hiddenWhen: { slot: "source", equals: "cap" },
      group: "occupancy",
    },
    {
      id: "nightTemp",
      name: "Night",
      description: "Target at night (°C)",
      type: "number",
      required: false,
      defaultValue: 17,
      constraints: { min: 5, max: 26 },
      hiddenWhen: { slot: "source", equals: ["cap", "schedule"] },
      group: "occupancy",
    },

    {
      id: "workdays",
      name: "Work days",
      description: "Days with work hours",
      type: "select",
      required: false,
      defaultValue: "mon-fri",
      options: [
        { value: "mon-fri", label: "Monday–Friday" },
        { value: "mon-sat", label: "Monday–Saturday" },
        { value: "all", label: "Every day" },
      ],
      hiddenWhen: { slot: "source", equals: ["cap", "stays", "daynight"] },
      group: "schedule",
    },
    {
      id: "workStart",
      name: "Work starts",
      description: "Comfort reached at",
      type: "time",
      required: false,
      defaultValue: "06:30",
      hiddenWhen: { slot: "source", equals: ["cap", "stays", "daynight"] },
      group: "schedule",
    },
    {
      id: "workEnd",
      name: "Work ends",
      description: "Planned end of the day",
      type: "time",
      required: false,
      defaultValue: "17:00",
      hiddenWhen: { slot: "source", equals: ["cap", "stays", "daynight"] },
      group: "schedule",
    },
    {
      id: "coastFrom",
      name: "Coast from",
      description: "Earliest early stop",
      type: "time",
      required: false,
      defaultValue: "15:00",
      hiddenWhen: { slot: "source", equals: ["cap", "stays", "daynight"] },
      group: "schedule",
    },

    {
      id: "stays",
      name: "Stays",
      description: "Equipment with occupied / arrival / departure",
      type: "equipment",
      required: false,
      constraints: { crossZone: true },
      hiddenWhen: { slot: "source", equals: ["cap", "schedule", "daynight"] },
      group: "stays",
    },

    {
      id: "nightStart",
      name: "Night from",
      description: "Night temperature from",
      type: "time",
      required: false,
      defaultValue: "22:00",
      hiddenWhen: { slot: "source", equals: ["cap", "schedule"] },
      group: "night",
    },
    {
      id: "nightEnd",
      name: "Night until",
      description: "Day temperature reached at",
      type: "time",
      required: false,
      defaultValue: "07:00",
      hiddenWhen: { slot: "source", equals: ["cap", "schedule"] },
      group: "night",
    },
    {
      id: "coastMax",
      name: "Coast at most",
      description: "Before a lower target",
      type: "duration",
      required: false,
      defaultValue: "60m",
      hiddenWhen: { slot: "source", equals: ["cap", "schedule"] },
      group: "night",
    },

    {
      id: "motionSensors",
      name: "Motion sensors",
      description: "Empty = no presence detection",
      type: "equipment",
      required: false,
      list: true,
      constraints: { equipmentType: ["sensor"], crossZone: true, includeDescendants: true },
      hiddenWhen: { slot: "source", equals: "cap" },
      group: "presence",
    },
    {
      id: "confirmBy",
      name: "Day off if nobody by",
      description: "Nobody seen → day off",
      type: "time",
      required: false,
      defaultValue: "08:00",
      hiddenWhen: { slot: "source", equals: ["cap", "stays", "daynight"] },
      group: "presence",
    },
    {
      id: "slowInterval",
      name: "Check every",
      description: "Until the fast checks",
      type: "duration",
      required: false,
      defaultValue: "90m",
      hiddenWhen: { slot: "source", equals: ["cap", "stays", "daynight"] },
      group: "presence",
    },
    {
      id: "fastFrom",
      name: "Fast checks from",
      description: "Closer checks from",
      type: "time",
      required: false,
      defaultValue: "15:00",
      hiddenWhen: { slot: "source", equals: ["cap", "stays", "daynight"] },
      group: "presence",
    },
    {
      id: "fastInterval",
      name: "Then every",
      description: "Fast check interval",
      type: "duration",
      required: false,
      defaultValue: "30m",
      hiddenWhen: { slot: "source", equals: ["cap", "stays", "daynight"] },
      group: "presence",
    },
    {
      id: "sustainFor",
      name: "Out of hours, after",
      description: "Presence before heating",
      type: "duration",
      required: false,
      defaultValue: "15m",
      hiddenWhen: { slot: "source", equals: ["cap", "stays", "daynight"] },
      group: "presence",
    },
    {
      id: "absentAfter",
      name: "Stop after",
      description: "Without motion, out of hours",
      type: "duration",
      required: false,
      defaultValue: "30m",
      hiddenWhen: { slot: "source", equals: ["cap", "stays", "daynight"] },
      group: "presence",
    },
    {
      id: "idleAfter",
      name: "Room idle after",
      description: "Night temperature when unused",
      type: "duration",
      required: false,
      defaultValue: "2h",
      hiddenWhen: { slot: "source", equals: ["cap", "schedule"] },
      group: "presence",
    },

    {
      id: "outdoorSensor",
      name: "Outdoor sensor",
      description: "Live outdoor temperature",
      type: "equipment",
      required: false,
      constraints: { equipmentType: ["sensor", "weather"], crossZone: true },
      hiddenWhen: { slot: "source", equals: "cap" },
      group: "weather",
    },
    {
      id: "forecast",
      name: "Forecast",
      description: "Weather forecast equipment",
      type: "equipment",
      required: false,
      constraints: { equipmentType: ["weather_forecast"], crossZone: true },
      hiddenWhen: { slot: "source", equals: "cap" },
      group: "weather",
    },

    {
      id: "maxTemp",
      name: "Cap",
      description: "Cuts above (°C)",
      type: "number",
      required: true,
      defaultValue: 24,
      constraints: { min: 10, max: 30 },
      group: "cap",
    },
    {
      id: "hysteresis",
      name: "Restores at",
      description: "Cap minus (°C)",
      type: "number",
      required: false,
      defaultValue: 0.5,
      constraints: { min: 0.1, max: 3 },
      group: "cap",
    },
    {
      id: "manualGrace",
      name: "Manual tolerance",
      description: "Before capping again",
      type: "duration",
      required: false,
      defaultValue: "2m",
      group: "cap",
    },

    {
      id: "frostTemp",
      name: "Frost floor",
      description: "Heats below (°C)",
      type: "number",
      required: false,
      defaultValue: 12,
      constraints: { min: 2, max: 15 },
      group: "frost",
    },
    {
      id: "frostBand",
      name: "Frost band",
      description: "Stops floor + (°C)",
      type: "number",
      required: false,
      defaultValue: 2,
      constraints: { min: 0.5, max: 6 },
      group: "frost",
    },

    {
      id: "windowSensors",
      name: "Window contacts",
      description: "Empty = zone contacts",
      type: "equipment",
      required: false,
      list: true,
      constraints: { equipmentType: ["sensor"], crossZone: true, includeDescendants: true },
      group: "window",
    },
    {
      id: "windowCutMax",
      name: "Cut at most",
      description: "Then heats again",
      type: "duration",
      required: false,
      defaultValue: "45m",
      group: "window",
    },
    {
      id: "dropDetection",
      name: "Detect by drop",
      description: "Off when contacts are set",
      type: "boolean",
      required: false,
      defaultValue: true,
      group: "window",
    },
    {
      id: "dropDelta",
      name: "Drop of",
      description: "Reads as open (°C)",
      type: "number",
      required: false,
      defaultValue: 0.6,
      constraints: { min: 0.2, max: 3 },
      group: "window",
    },
    {
      id: "dropWindow",
      name: "Drop within",
      description: "Observation window",
      type: "duration",
      required: false,
      defaultValue: "10m",
      group: "window",
    },

    {
      id: "tempKey",
      name: "Temp. reading",
      description: "Empty = found alone",
      type: "data-key",
      required: false,
      group: "advanced",
    },
    {
      id: "tempMaxAge",
      name: "Reading valid for",
      description: "Older = mute sensor",
      type: "duration",
      required: false,
      defaultValue: "1h",
      group: "advanced",
    },
  ];
}

// ============================================================
// French pack — the instances run in FR
// ============================================================

const FR: RecipeLangPack = {
  name: "Chauffage intelligent",
  description:
    "Chauffe une pièce par des radiateurs sur relais marche/arrêt : horaires de travail, séjours ou jour/nuit, présence facultative, préchauffe apprise pour être à température à l'heure dite, météo, fenêtre ouverte et plafond. Sans source d'occupation, simple plafond de température.",
  groups: {
    main: "Équipements",
    occupancy: "Occupation",
    schedule: "Horaires",
    stays: "Séjours",
    night: "Nuit",
    presence: "Présence",
    weather: "Météo",
    cap: "Plafond",
    frost: "Absence / hors-gel",
    window: "Fenêtre ouverte",
    advanced: "Avancé",
  },
  slots: {
    zone: { name: "Zone", description: "Pièce chauffée" },
    heaters: { name: "Radiateurs", description: "Relais marche/arrêt, pilotés ensemble" },
    sensor: { name: "Sonde de la pièce", description: "Mesure de température" },
    source: {
      name: "Occupation",
      description: "Ce qui décide quand chauffer",
      options: {
        cap: "Aucune — plafond seul",
        schedule: "Horaires de travail",
        stays: "Séjours",
        daynight: "Jour / nuit",
      },
    },
    comfortTemp: { name: "Jour / confort", description: "Consigne quand c'est occupé (°C)" },
    nightTemp: { name: "Nuit", description: "Consigne la nuit (°C)" },
    workdays: {
      name: "Jours travaillés",
      description: "Jours avec horaires",
      options: { "mon-fri": "Lundi–vendredi", "mon-sat": "Lundi–samedi", all: "Tous les jours" },
    },
    workStart: { name: "Début du travail", description: "Confort atteint à" },
    workEnd: { name: "Fin du travail", description: "Fin prévue de la journée" },
    coastFrom: { name: "Roue libre dès", description: "Arrêt anticipé possible à partir de" },
    stays: { name: "Séjours", description: "Équipement occupé / arrivée / départ" },
    nightStart: { name: "Nuit à partir de", description: "Consigne de nuit dès" },
    nightEnd: { name: "Nuit jusqu'à", description: "Consigne de jour atteinte à" },
    coastMax: { name: "Roue libre au plus", description: "Avant une consigne plus basse" },
    motionSensors: { name: "Détecteurs de présence", description: "Vide = pas de détection" },
    confirmBy: { name: "Congé si personne avant", description: "Personne vu → congé" },
    slowInterval: { name: "Vérifier toutes les", description: "Jusqu'aux vérifications rapprochées" },
    fastFrom: { name: "Vérif. rapprochées dès", description: "Heure de bascule" },
    fastInterval: { name: "Puis toutes les", description: "Vérifications rapprochées" },
    sustainFor: { name: "Hors horaires, après", description: "Présence avant de chauffer" },
    absentAfter: { name: "Arrêt après", description: "Sans mouvement, hors horaires" },
    idleAfter: { name: "Pièce vide après", description: "Consigne de nuit si inutilisée" },
    outdoorSensor: { name: "Sonde extérieure", description: "Température dehors en direct" },
    forecast: { name: "Prévisions", description: "Équipement de prévisions météo" },
    maxTemp: { name: "Plafond", description: "Coupe au-dessus (°C)" },
    hysteresis: { name: "Rétablit à", description: "Plafond moins (°C)" },
    manualGrace: { name: "Tolérance manuelle", description: "Avant de reprendre la main" },
    frostTemp: { name: "Absence / hors-gel", description: "Consigne quand c'est vide (°C)" },
    frostBand: { name: "Bande hors-gel", description: "Arrête à seuil + (°C)" },
    windowSensors: { name: "Contacts d'ouverture", description: "Vide = contacts de la zone" },
    windowCutMax: { name: "Coupure max", description: "Puis rend le chauffage" },
    dropDetection: { name: "Détection par chute", description: "Ignorée si contacts renseignés" },
    dropDelta: { name: "Chute de", description: "Vaut fenêtre ouverte (°C)" },
    dropWindow: { name: "Chute en", description: "Fenêtre d'observation" },
    tempKey: { name: "Donnée température", description: "Vide = trouvée seule" },
    tempMaxAge: { name: "Mesure valable", description: "Au-delà = sonde muette" },
  },
};

// ============================================================
// Recipe
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "heater-cap",
    name: "Smart Heating",
    description:
      "Heats a room through on/off relays: work schedule, stays or day/night, optional presence, a learned pre-heat that reaches the target on time, weather, open-window cut-off and a ceiling. With no occupancy source, a plain temperature cap.",

    slots: buildSlots(),

    actions: [
      {
        id: "set_mode",
        type: "cycle",
        stateKey: "mode",
        options: [
          { value: "auto", label: "Auto" },
          { value: "comfort", label: "Confort" },
          { value: "frost", label: "Absent" },
          { value: "off", label: "Pause" },
        ],
      },
    ],

    tile: { icon: "Thermometer", actions: ["set_mode"] },

    i18n: { fr: FR },

    validate(params: Record<string, unknown>, ctx: RecipeContext): void {
      if (!params.zone) throw new Error("Zone is required");

      const heaterIds = normalizeIds(params.heaters);
      if (heaterIds.length === 0) throw new Error("At least one heater relay is required");
      for (const id of heaterIds) {
        const eq = ctx.equipmentManager.getByIdWithDetails(id);
        if (!eq) throw new Error("A selected heater relay no longer exists");
        if (!findOnOffOrderAlias(eq)) {
          throw new Error(`"${eq.name}" has no on/off order binding (expected alias "state")`);
        }
      }

      const sensorId = String(params.sensor ?? "");
      if (!sensorId) throw new Error("A room temperature sensor is required");
      const sensor = ctx.equipmentManager.getByIdWithDetails(sensorId);
      if (!sensor) throw new Error("The selected temperature sensor no longer exists");
      if (!findTemperatureAlias(sensor, String(params.tempKey ?? ""))) {
        throw new Error(
          `"${sensor.name}" exposes no temperature reading — pick the data key explicitly`,
        );
      }

      const maxTemp = toNumber(params.maxTemp) ?? 24;
      const hysteresis = toNumber(params.hysteresis) ?? 0.5;
      const frostTemp = toNumber(params.frostTemp) ?? 7;
      const frostBand = toNumber(params.frostBand) ?? 2;

      if (hysteresis <= 0) throw new Error("The restore margin must be greater than 0 °C");
      if (frostBand <= 0) throw new Error("The frost band must be greater than 0 °C");
      // Overlapping the two would let the frost floor fight the cap: one wants
      // the relay closed at the very temperature the other wants it open.
      if (frostTemp + frostBand >= maxTemp - hysteresis) {
        throw new Error(
          `The frost band (${frostTemp} + ${frostBand} °C) must stay below the cap (${maxTemp} - ${hysteresis} °C)`,
        );
      }

      const source = readSource(params.source);
      if (source === "cap") return;

      const comfort = toNumber(params.comfortTemp) ?? 20;
      const night = toNumber(params.nightTemp) ?? 17;
      if (comfort > maxTemp - hysteresis) {
        throw new Error(`The comfort target (${comfort} °C) must stay under the cap minus its margin (${maxTemp - hysteresis} °C)`);
      }
      if (frostTemp + frostBand >= comfort) {
        throw new Error(`The away temperature (${frostTemp} + ${frostBand} °C) must stay below the comfort target (${comfort} °C)`);
      }
      if (source !== "schedule") {
        if (night > comfort) throw new Error(`The night target (${night} °C) cannot be above the day target (${comfort} °C)`);
        if (night <= frostTemp) throw new Error(`The night target (${night} °C) must be above the away temperature (${frostTemp} °C)`);
        const ns = parseTime(params.nightStart ?? "22:00");
        const ne = parseTime(params.nightEnd ?? "07:00");
        if (ns === null || ne === null) throw new Error("Night times must be HH:MM");
        if (ns === ne) throw new Error("The night cannot start and end at the same time");
      }

      if (source === "stays") {
        const staysId = String(params.stays ?? "");
        if (!staysId) {
          throw new Error(
            "Pick the stays equipment — without one, choose 'Day / night' and use the Absent / Auto pill",
          );
        }
        if (!ctx.equipmentManager.getByIdWithDetails(staysId)) {
          throw new Error("The selected stays equipment no longer exists");
        }
      }

      if (source === "schedule") {
        const t = (key: string, fallback: string): number => {
          const v = parseTime(params[key] ?? fallback);
          if (v === null) throw new Error(`${key} must be HH:MM`);
          return v;
        };
        const start = t("workStart", "06:30");
        const end = t("workEnd", "17:00");
        const coast = t("coastFrom", "15:00");
        if (start >= end) throw new Error("Work must end after it starts");
        if (coast <= start || coast > end) throw new Error("The coasting time must fall within work hours");
        if (normalizeIds(params.motionSensors).length > 0) {
          const confirm = t("confirmBy", "08:00");
          const fast = t("fastFrom", "15:00");
          if (!(start < confirm && confirm < end)) throw new Error("The day-off check must fall within work hours");
          if (!(confirm < fast && fast < end)) throw new Error("Fast checks must start between the day-off check and the end of work");
          const slow = ctx.helpers.parseDuration(params.slowInterval ?? "90m");
          const quick = ctx.helpers.parseDuration(params.fastInterval ?? "30m");
          if (quick > slow) throw new Error("Fast checks cannot be further apart than the slow ones");
          if (quick < 5 * 60_000) throw new Error("Checks closer than 5 minutes are not presence checks");
        }
      }
    },

    createInstance(params: Record<string, unknown>, ctx: RecipeContext): RecipeInstanceHandle {
      // ── Params ────────────────────────────────────────────

      const zoneId = String(params.zone ?? "");
      const heaterIds = normalizeIds(params.heaters);
      const sensorId = String(params.sensor ?? "");
      const windowIds = normalizeIds(params.windowSensors);

      const maxTemp = toNumber(params.maxTemp) ?? 24;
      const hysteresis = Math.max(0.1, toNumber(params.hysteresis) ?? 0.5);
      const frostTemp = toNumber(params.frostTemp) ?? 7;
      const frostBand = Math.max(0.5, toNumber(params.frostBand) ?? 2);
      const tempKeyParam = String(params.tempKey ?? "");

      const duration = (value: unknown, fallback: string): number => {
        try {
          const ms = ctx.helpers.parseDuration(value ?? fallback);
          return Number.isFinite(ms) && ms > 0 ? ms : ctx.helpers.parseDuration(fallback);
        } catch {
          return ctx.helpers.parseDuration(fallback);
        }
      };

      const graceMs = duration(params.manualGrace, "2m");
      const windowCutMaxMs = duration(params.windowCutMax, "45m");
      const dropWindowMs = duration(params.dropWindow, "10m");
      const tempMaxAgeMs = duration(params.tempMaxAge, "1h");
      const dropDelta = Math.max(0.2, toNumber(params.dropDelta) ?? 0.6);
      // Contacts and a guess do not belong on the same window. Once contacts
      // are configured they are the only source, false positives included.
      const dropEnabled = toBoolean(params.dropDetection, true) && windowIds.length === 0;

      // ── Smart heating params (spec 002) ───────────────────

      const source = readSource(params.source);
      const driven = source !== "cap";
      const comfortTemp = toNumber(params.comfortTemp) ?? 20;
      const nightTemp = toNumber(params.nightTemp) ?? 17;
      const motionIds = normalizeIds(params.motionSensors);
      const staysId = String(params.stays ?? "");
      const outdoorId = String(params.outdoorSensor ?? "");
      const forecastId = String(params.forecast ?? "");
      const time = (value: unknown, fallback: string): number => parseTime(value ?? fallback) ?? parseTime(fallback)!;
      const occCfg: OccupancyConfig = {
        source: source === "cap" ? "daynight" : source,
        hasMotion: motionIds.length > 0,
        workdays: WORKDAY_SETS[String(params.workdays ?? "mon-fri")] ?? WORKDAY_SETS["mon-fri"],
        workStart: time(params.workStart, "06:30"),
        workEnd: time(params.workEnd, "17:00"),
        confirmBy: time(params.confirmBy, "08:00"),
        fastFrom: time(params.fastFrom, "15:00"),
        nightStart: time(params.nightStart, "22:00"),
        nightEnd: time(params.nightEnd, "07:00"),
        slowIntervalMs: duration(params.slowInterval, "90m"),
        fastIntervalMs: duration(params.fastInterval, "30m"),
        sustainMs: duration(params.sustainFor, "15m"),
        absentAfterMs: duration(params.absentAfter, "30m"),
        idleAfterMs: duration(params.idleAfter, "2h"),
      };
      const coastFrom = time(params.coastFrom, "15:00");
      const coastMaxMs = duration(params.coastMax, "60m");

      // ── Persisted state ───────────────────────────────────

      let mode: Mode = readMode(ctx.state.get("mode"));
      /** What we last successfully *ordered*, per heater. Absence means the
       *  recipe never touched that relay — and a relay it never opened is one
       *  it must never close. */
      const commanded = new Map<string, "on" | "off">();
      const storedCommands = ctx.state.get("commanded");
      if (storedCommands && typeof storedCommands === "object") {
        for (const [id, value] of Object.entries(storedCommands as Record<string, unknown>)) {
          if (value === "on" || value === "off") commanded.set(id, value);
        }
      }
      let holding: Hold | null =
        ctx.state.get("holding") === "cap"
          ? "cap"
          : ctx.state.get("holding") === "window"
            ? "window"
            : null;
      let frostHeating = ctx.state.get("frostHeating") === true;

      let model: ThermalModel = readModel(ctx.state.get("model"));
      const occupancy = new Occupancy(occCfg, ctx.state.get("occupancy"));
      let comfortUntil = typeof ctx.state.get("comfortUntil") === "number" ? (ctx.state.get("comfortUntil") as number) : null;
      let preheat: { until: number; target: number; startedAt: number } | null = null;
      {
        const p = ctx.state.get("preheat") as { until?: unknown; target?: unknown; startedAt?: unknown } | null;
        if (p && typeof p.until === "number" && typeof p.target === "number" && typeof p.startedAt === "number") {
          preheat = { until: p.until, target: p.target, startedAt: p.startedAt };
        }
      }
      let lastPreheatStart = typeof ctx.state.get("lastPreheatStart") === "number" ? (ctx.state.get("lastPreheatStart") as number) : null;
      let snapshots: DaySnapshot[] = Array.isArray(ctx.state.get("forecastSnapshots"))
        ? (ctx.state.get("forecastSnapshots") as DaySnapshot[])
        : [];
      let heating = ctx.state.get("heating") === true;
      let coasting = false;

      // ── Volatile state ────────────────────────────────────

      const graceUntil = new Map<string, number>();
      /** Per-heater view of the order in flight: what we want, whether the
       *  relay has actually sat there during this hold, and when we last said
       *  so. Reset whenever the intent changes, so a fresh cut never inherits
       *  the previous target's grace. */
      const drive = new Map<string, { target: "on" | "off"; reached: boolean; lastSentAt: number }>();
      const samples: Array<{ t: number; v: number }> = [];
      const warned = new Set<string>();
      const published = new Map<string, unknown>();
      let contactOpenSince: number | null = null;
      let dropCutAt: number | null = null;
      let dropMin: number | null = null;
      let dropRearmAt = 0;
      let stopped = false;
      let running = false;
      const unsubs: Array<() => void> = [];

      // ── Small utilities ───────────────────────────────────

      function nameOf(id: string): string {
        return ctx.equipmentManager.getById(id)?.name ?? id.slice(0, 8);
      }

      function eqOf(id: string): EquipmentLite | null {
        try {
          return ctx.equipmentManager.getByIdWithDetails(id);
        } catch {
          return null;
        }
      }

      function warnOnce(key: string, message: string): void {
        if (warned.has(key)) return;
        warned.add(key);
        ctx.log(message, "warn");
      }

      function publish(key: string, value: unknown): void {
        if (published.get(key) === value) return;
        published.set(key, value);
        ctx.state.set(key, value);
      }

      /** State writes reach the UI over the wire: only write what changed. */
      const saved = new Map<string, string>();
      function save(key: string, value: unknown): void {
        const json = JSON.stringify(value ?? null);
        if (saved.get(key) === json) return;
        saved.set(key, json);
        ctx.state.set(key, value);
      }

      function persist(): void {
        save("mode", mode);
        save("commanded", Object.fromEntries(commanded));
        save("holding", holding);
        save("frostHeating", frostHeating);
      }

      // ── Reads ─────────────────────────────────────────────

      function tempAlias(): string | null {
        return findTemperatureAlias(eqOf(sensorId), tempKeyParam);
      }

      /** `null` means unusable: missing, non-numeric, or older than `tempMaxAge`. */
      function readTemp(now: number): number | null {
        const eq = eqOf(sensorId);
        const alias = findTemperatureAlias(eq, tempKeyParam);
        if (!eq || !alias) return null;
        const binding = eq.dataBindings.find((b) => b.alias === alias);
        if (!binding) return null;
        if (binding.lastUpdated) {
          const at = Date.parse(String(binding.lastUpdated).replace(" ", "T"));
          if (Number.isFinite(at) && now - at > tempMaxAgeMs) return null;
        } else if (binding.stale === true) {
          return null;
        }
        return toNumber(binding.value);
      }

      function readRelayState(eq: EquipmentLite | null): boolean | null {
        if (!eq) return null;
        const alias = findOnOffOrderAlias(eq);
        const binding =
          (alias ? eq.dataBindings.find((b) => b.alias === alias) : undefined) ??
          eq.dataBindings.find((b) => b.category === "light_state") ??
          eq.dataBindings.find((b) => b.alias === "state");
        if (!binding || binding.value === undefined || binding.value === null) return null;
        return isOnValue(binding.value);
      }

      /**
       * `null` when the home has nothing to say about windows — that is what
       * lets the drop heuristic be the only detector without pretending the
       * windows are all closed.
       */
      function readContacts(now: number): boolean | null {
        let sawSource = false;
        let open = false;

        for (const id of windowIds) {
          const binding = findContactBinding(eqOf(id));
          if (!binding) continue;
          sawSource = true;
          if (isContactOpen(binding.value)) open = true;
        }

        if (!sawSource && zoneId && ctx.zoneAggregator) {
          const agg = ctx.zoneAggregator.getByZoneId(zoneId);
          if (agg && typeof agg.openWindows === "number") {
            sawSource = true;
            open = agg.openWindows > 0;
          }
        }

        if (!sawSource) return null;
        if (!open) {
          contactOpenSince = null;
          return false;
        }
        if (contactOpenSince === null) {
          contactOpenSince = now;
          return false;
        }
        return now - contactOpenSince >= WINDOW_CONFIRM_MS;
      }

      // ── Open-window heuristic ─────────────────────────────

      function recordSample(now: number, temp: number | null): void {
        if (temp === null) return;
        samples.push({ t: now, v: temp });
        const keepFrom = now - dropWindowMs * 2;
        while (samples.length > 0 && samples[0].t < keepFrom) samples.shift();
      }

      function endDrop(now: number): void {
        dropCutAt = null;
        dropMin = null;
        dropRearmAt = now + DROP_REARM_MS;
        samples.length = 0;
      }

      /**
       * `suspended` is what keeps the heuristic honest. The recipe's own cuts
       * cool the room, and a frost-mode house cools all winter: sampling
       * through either would have every cap cut re-read as an open window and
       * hold the heating off for `windowCutMax`. The detector only runs while
       * the heating is actually free to work, and rearms afterwards.
       */
      function evaluateDrop(now: number, temp: number | null, suspended: boolean): boolean {
        if (!dropEnabled) return false;
        if (suspended) {
          if (dropCutAt !== null) endDrop(now);
          else {
            samples.length = 0;
            dropRearmAt = Math.max(dropRearmAt, now + DROP_REARM_MS);
          }
          return false;
        }
        if (temp === null) {
          // Cutting on a guess needs a live reading to end the cut; without one
          // the safe move is to stop guessing.
          if (dropCutAt !== null) endDrop(now);
          return false;
        }

        if (dropCutAt !== null) {
          dropMin = dropMin === null ? temp : Math.min(dropMin, temp);
          if (now - dropCutAt >= windowCutMaxMs) {
            ctx.log(
              `Fenêtre : ${ctx.helpers.formatDuration(windowCutMaxMs)} de coupure atteints, chauffage rendu`,
            );
            endDrop(now);
            return false;
          }
          if (temp >= dropMin + DROP_RECOVERY_C) {
            ctx.log(`Fenêtre : la température repart (${round1(temp)} °C), chauffage rendu`);
            endDrop(now);
            return false;
          }
          return true;
        }

        if (now < dropRearmAt) return false;
        const inWindow = samples.filter((s) => s.t >= now - dropWindowMs);
        if (inWindow.length < DROP_MIN_SAMPLES) return false;
        const peak = Math.max(...inWindow.map((s) => s.v));
        if (peak - temp < dropDelta) return false;

        dropCutAt = now;
        dropMin = temp;
        ctx.log(
          `Chute de ${round1(peak - temp)} °C en moins de ${ctx.helpers.formatDuration(dropWindowMs)} — fenêtre probablement ouverte, chauffage coupé`,
        );
        return true;
      }

      // ── Orders ────────────────────────────────────────────

      function resolveOnOffValue(eq: EquipmentLite, target: "on" | "off"): unknown {
        const alias = findOnOffOrderAlias(eq);
        const order = alias ? eq.orderBindings.find((o) => o.alias === alias) : undefined;
        if (order?.enumValues?.length) {
          return order.enumValues.find((v) => v.toLowerCase() === target) ?? target.toUpperCase();
        }
        if (order?.type === "boolean") return target === "on";
        return target.toUpperCase();
      }

      async function send(id: string, target: "on" | "off"): Promise<boolean> {
        const eq = eqOf(id);
        const alias = eq ? findOnOffOrderAlias(eq) : null;
        if (!eq || !alias) {
          warnOnce(`no-order:${id}`, `${nameOf(id)} : aucun ordre marche/arrêt disponible`);
          return false;
        }
        try {
          const res = await ctx.dispatchOrder(id, alias, resolveOnOffValue(eq, target));
          if (res && typeof res === "object" && res.success === false) {
            ctx.log(
              `${nameOf(id)} : échec de l'ordre ${target.toUpperCase()} — ${res.error ?? "erreur inconnue"}`,
              "error",
            );
            return false;
          }
          const at = Date.now();
          const d = drive.get(id);
          if (d && d.target === target) d.lastSentAt = at;
          else drive.set(id, { target, reached: false, lastSentAt: at });
          commanded.set(id, target);
          return true;
        } catch (err: unknown) {
          ctx.log(
            `${nameOf(id)} : échec de l'ordre ${target.toUpperCase()} — ${messageOf(err)}`,
            "error",
          );
          return false;
        }
      }

      /**
       * Drive one relay towards `target`, honouring the manual-override grace.
       *
       * The grace hinges on `reached`, not on who sent the last order: a relay
       * that has *sat* at the target during this hold and then leaves it was
       * moved by a human, whether the recipe opened it or found it open. That
       * distinction is the whole point — the guest who presses the wall switch
       * in an already-capped room gets the same two minutes as the one who
       * presses it after the recipe cut.
       *
       * Ownership (`commanded`) is a separate book, written only when the
       * recipe itself sends the order, so `release()` can never switch on a
       * heater the guest had switched off.
       */
      async function applyTarget(id: string, target: "on" | "off", now: number): Promise<void> {
        const eq = eqOf(id);
        if (!eq) return;
        const state = readRelayState(eq);
        const want = target === "on";

        let d = drive.get(id);
        if (!d || d.target !== target) {
          // New intent: act on it without waiting, and forget any grace that
          // belonged to the previous target.
          d = { target, reached: false, lastSentAt: 0 };
          drive.set(id, d);
          graceUntil.delete(id);
        }

        if (state === want) {
          d.reached = true;
          graceUntil.delete(id);
          return;
        }

        // Our own order may simply not have been reported back yet.
        if (d.lastSentAt > 0 && now - d.lastSentAt < ORDER_SETTLE_MS) return;

        if (state === null) {
          // Blind: nothing to compare against, so send once then refresh rarely.
          if (d.lastSentAt === 0 || now - d.lastSentAt >= BLIND_REPEAT_MS) await send(id, target);
          return;
        }

        // Neither ordered by us nor ever settled there during this hold: the
        // relay has simply never been where we want it, so this is the recipe
        // doing its job rather than a human undoing it. No grace.
        //
        // `lastSentAt` counts as well as `reached`, or a guest flipping the
        // switch back within the same tick as our cut would be re-cut on the
        // spot — the very move the tolerance exists to soften.
        if (!d.reached && d.lastSentAt === 0) {
          await send(id, target);
          return;
        }

        // It had settled at the target and left it: somebody moved it by hand.
        const until = graceUntil.get(id);
        if (until === undefined) {
          graceUntil.set(id, now + graceMs);
          ctx.log(
            `${nameOf(id)} : commande manuelle, tolérée ${ctx.helpers.formatDuration(graceMs)}`,
          );
          return;
        }
        if (now < until) return;
        graceUntil.delete(id);
        ctx.log(
          `${nameOf(id)} : fin de la tolérance, ${target === "off" ? "coupure rétablie" : "chauffage rétabli"}`,
        );
        await send(id, target);
      }

      /** Hand back every relay the recipe is holding open, and forget them. */
      async function release(reason: string): Promise<void> {
        const ids = heaterIds.filter((id) => commanded.get(id) === "off");
        holding = null;
        contactOpenSince = null;
        graceUntil.clear();
        drive.clear();
        if (ids.length === 0) {
          persist();
          return;
        }
        for (const id of ids) {
          if (await send(id, "on")) commanded.delete(id);
        }
        ctx.log(`Chauffage rendu — ${reason}`);
        persist();
      }

      // ── Modes ─────────────────────────────────────────────

      async function autoTick(now: number, temp: number | null, windowOpen: boolean): Promise<void> {
        // A room at the frost floor is a building problem, not a comfort one:
        // nothing the recipe does may keep the heating off down there.
        const frostFloor = temp !== null && temp <= frostTemp;

        let want: Hold | null = null;
        if (!frostFloor) {
          if (windowOpen) want = "window";
          else if (temp !== null) {
            if (temp >= maxTemp) want = "cap";
            // Hysteresis: once cutting, keep cutting until the room has really
            // come back down, or the relay would chatter around the cap.
            else if (holding === "cap" && temp > maxTemp - hysteresis) want = "cap";
          }
        }

        if (want === null) {
          if (holding !== null) {
            const reason =
              frostFloor && temp !== null
                ? `hors-gel prioritaire (${round1(temp)} °C)`
                : temp === null
                  ? "sonde muette"
                  : holding === "cap"
                    ? `${round1(temp)} °C, sous le plafond`
                    : "fenêtre refermée";
            await release(reason);
          }
          publish("status", temp === null ? "sensor-mute" : "normal");
          return;
        }

        if (holding !== want) {
          holding = want;
          // A new hold starts a new story per heater: whatever the relays did
          // under the previous one must not buy anyone a grace delay now.
          drive.clear();
          graceUntil.clear();
          ctx.log(
            want === "cap"
              ? `Plafond atteint (${temp === null ? "?" : round1(temp)} °C ≥ ${maxTemp} °C) — chauffage coupé`
              : "Fenêtre ouverte — chauffage coupé",
          );
          persist();
        }

        for (const id of heaterIds) await applyTarget(id, "off", now);
        publish("status", want === "cap" ? "capped" : "window");
      }

      async function frostTick(now: number, temp: number | null, windowOpen: boolean): Promise<void> {
        if (temp === null) {
          // Blind frost guard. Heating an empty house needlessly costs money;
          // letting the pipes freeze costs a plumber and a ruined season.
          warnOnce(
            "frost-blind",
            `Sonde « ${nameOf(sensorId)} » muette — hors-gel à l'aveugle, chauffage maintenu`,
          );
          frostHeating = true;
          for (const id of heaterIds) await applyTarget(id, "on", now);
          publish("status", "frost-blind");
          persist();
          return;
        }
        warned.delete("frost-blind");

        if (temp <= frostTemp) {
          if (!frostHeating) {
            frostHeating = true;
            ctx.log(`Hors-gel : ${round1(temp)} °C ≤ ${frostTemp} °C — chauffage relancé`);
            persist();
          }
          if (windowOpen) {
            warnOnce(
              "frost-window",
              "Fenêtre ouverte pendant le hors-gel — le chauffage est maintenu quand même",
            );
          }
        } else if (temp >= frostTemp + frostBand) {
          if (frostHeating) {
            frostHeating = false;
            ctx.log(`Hors-gel : ${round1(temp)} °C atteints — chauffage coupé`);
            persist();
          }
          warned.delete("frost-window");
        }

        const target = frostHeating ? "on" : "off";
        for (const id of heaterIds) await applyTarget(id, target, now);
        publish("status", frostHeating ? "frost-heating" : "frost-idle");
      }

      // ── Smart heating (spec 002) ──────────────────────────

      function readOutdoor(): number | null {
        if (!outdoorId) return null;
        const eq = eqOf(outdoorId);
        const alias = findTemperatureAlias(eq);
        const b = alias ? eq?.dataBindings.find((x) => x.alias === alias) : undefined;
        return b ? toNumber(b.value) : null;
      }

      function forecastValue(alias: string): unknown {
        if (!forecastId) return undefined;
        return eqOf(forecastId)?.dataBindings.find((b) => b.alias === alias)?.value;
      }

      /** Decision D: the plugin publishes tomorrow onwards only, so every evening
       *  the recipe keeps tomorrow's min/max — it will be "today" after midnight. */
      function snapshotForecast(now: number): void {
        if (!forecastId || new Date(now).getHours() < 20) return;
        const min = toNumber(forecastValue("j1_temp_min"));
        const max = toNumber(forecastValue("j1_temp_max"));
        if (min === null || max === null) return;
        const date = localDate(now + 24 * 3_600_000);
        if (snapshots.some((x) => x.date === date && x.min === min && x.max === max)) return;
        snapshots = [...snapshots.filter((x) => x.date !== date && x.date >= localDate(now)), { date, min, max }].slice(-3);
        ctx.state.set("forecastSnapshots", snapshots);
      }

      function outside(now: number): Outside {
        return buildOutside(now, parseHourly(forecastValue("irradiance_120h")), readOutdoor(), snapshots);
      }

      function motionNow(): boolean {
        return motionIds.some((id) => readMotion(eqOf(id)) === true);
      }

      function stayNow(): Stay | null {
        return staysId ? readStay(eqOf(staysId)) : null;
      }

      function levelTemp(level: Level): number {
        return level === "comfort" ? comfortTemp : level === "night" ? nightTemp : frostTemp;
      }

      const LOOKAHEAD_MS = 14 * 3_600_000;
      const OUTSIDE_LABEL: Record<Outside["source"], string> = {
        forecast: "prévision horaire",
        sensor: "sonde",
        snapshot: "prévision de la veille",
        blind: "estimation, aucune source",
      };
      const PREHEAT_MARGIN_MS = 15 * 60_000;
      /** Irradiance (W/m²) above which the sun is trusted to do the heating. */
      const SUN_TRUST_WM2 = 300;

      /** First instant within the look-ahead where the plan asks for more than `than`. */
      function nextRise(now: number, than: number, stay: Stay | null): { at: number; target: number } | null {
        for (let t = now + 60_000; t <= now + LOOKAHEAD_MS; t += 5 * 60_000) {
          const target = levelTemp(planAt(occCfg, t, stay));
          if (target > than) {
            // Refine to the minute.
            let at = t;
            while (at - 60_000 > now && levelTemp(planAt(occCfg, at - 60_000, stay)) > than) at -= 60_000;
            return { at, target };
          }
        }
        return null;
      }

      /** First instant within the look-ahead where the plan drops under `than`. */
      function nextDrop(now: number, than: number, stay: Stay | null): number | null {
        for (let t = now + 60_000; t <= now + LOOKAHEAD_MS; t += 60_000) {
          if (levelTemp(planAt(occCfg, t, stay)) < than) return t;
        }
        return null;
      }

      // Learning stretches.
      let stretch: { kind: "heat" | "cool"; startAt: number; startTemp: number; outdoorSum: number; n: number; sunny: boolean } | null = null;

      function feedLearning(now: number, temp: number | null, out: Outside, windowOpen: boolean): void {
        const states = heaterIds.map((id) => readRelayState(eqOf(id)));
        const kind = states.every((x) => x === true) ? "heat" : states.every((x) => x === false) ? "cool" : null;
        const close = (): void => {
          if (!stretch || temp === null) return;
          const s0 = stretch;
          stretch = null;
          const st = { startAt: s0.startAt, endAt: now, startTemp: s0.startTemp, endTemp: temp, outdoor: s0.outdoorSum / Math.max(1, s0.n) };
          const learned =
            s0.kind === "cool" ? (s0.sunny ? null : learnFromCooling(model, st)) : learnFromHeating(model, st);
          if (!learned) return;
          const before = model;
          model = learned;
          ctx.state.set("model", model);
          // Journal only what moves the needle; the state keeps every step.
          const first = before.gainSamples + before.tauSamples === 0;
          if (!first && Math.abs(model.gain - before.gain) < 0.2 && Math.abs(model.tau - before.tau) < 1) return;
          ctx.log(
            `Apprentissage : la pièce gagne ${round1(model.gain)} °C/h tous radiateurs allumés, inertie ${round1(model.tau)} h ` +
              `(${model.gainSamples} chauffe(s), ${model.tauSamples} refroidissement(s) observés)`,
          );
        };
        if (temp === null || kind === null || windowOpen) {
          close();
          stretch = null;
          return;
        }
        if (stretch && stretch.kind !== kind) close();
        if (!stretch) {
          stretch = { kind, startAt: now, startTemp: temp, outdoorSum: 0, n: 0, sunny: false };
          return;
        }
        // Skip the first minutes of a heating stretch: heaters and sensor lag.
        if (stretch.kind === "heat" && stretch.n === 0 && now - stretch.startAt < HEAT_SETTLE_MS) return;
        if (stretch.kind === "heat" && stretch.n === 0) {
          stretch.startAt = now;
          stretch.startTemp = temp;
        }
        stretch.outdoorSum += out.outdoorAt(now);
        stretch.n++;
        if (out.sunAt(now) > 50) stretch.sunny = true;
        // Close long stretches so the model keeps learning through a cold night.
        if (now - stretch.startAt >= 3 * 3_600_000 && now - stretch.startAt >= MIN_STRETCH_MS) {
          close();
          stretch = { kind, startAt: now, startTemp: temp, outdoorSum: 0, n: 0, sunny: false };
        }
      }

      function summaryFor(v: Verdict, target: number, why: string, stay: Stay | null): string {
        if (mode === "comfort") return `Confort forcé ${comfortTemp} °C jusqu'à minuit`;
        if (why === "window") return "Fenêtre ouverte — chauffage coupé";
        if (why === "mute") return "Sonde muette — radiateurs rendus";
        if (preheat) return `Préchauffe → ${preheat.target} °C à ${hm(preheat.until)}`;
        if (why === "coast") return "Roue libre — l'inertie suffit";
        if (why === "sun") return "Soleil prévu — radiateurs en attente";
        const phaseText: Partial<Record<Phase, string>> = {
          arrive: `Confort ${target} °C — arrivée attendue`,
          present: `Confort ${target} °C — présent`,
          dayoff: `Congé détecté — ${target} °C`,
          left: `Parti — ${target} °C`,
          sustained: `Présence — ${target} °C`,
          roomIdle: `Pièce vide — ${target} °C`,
        };
        if (phaseText[v.phase]) return phaseText[v.phase]!;
        if (source === "stays") {
          if (v.level === "away") {
            return stay?.arrival && stay.arrival > Date.now()
              ? `Vide — arrivée ${new Date(stay.arrival).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${hm(stay.arrival)}`
              : `Logement vide — ${target} °C`;
          }
          return v.level === "night" ? `Séjour : nuit ${target} °C` : `Séjour : jour ${target} °C`;
        }
        if (v.level === "night") return `Nuit ${target} °C`;
        if (v.level === "comfort") return source === "daynight" ? `Jour ${target} °C` : `Confort ${target} °C`;
        return `Absent — ${target} °C`;
      }

      async function driveTick(now: number, temp: number | null, windowOpen: boolean): Promise<void> {
        snapshotForecast(now);
        const out = outside(now);
        const stay = stayNow();

        if (mode === "comfort" && comfortUntil !== null && now >= comfortUntil) {
          mode = "auto";
          comfortUntil = null;
          ctx.state.delete("comfortUntil");
          publish("mode", mode);
          ctx.log("Fin du confort forcé — retour en automatique");
        }

        const verdict: Verdict =
          mode === "comfort"
            ? { level: "comfort", phase: "plan", nextCheckAt: null, events: [] }
            : occupancy.tick({ now, motionNow: motionNow(), stay, preheatStartedAt: lastPreheatStart });
        for (const e of verdict.events) ctx.log(e.text, e.level);
        save("occupancy", occupancy.snapshot());

        let target = levelTemp(verdict.level);
        const planned = levelTemp(planAt(occCfg, now, stay));

        // Pre-heat: the plan is about to ask for more than the room has.
        if (preheat && now >= preheat.until) preheat = null;
        if (mode === "auto" && temp !== null && !preheat) {
          const rise = nextRise(now, Math.max(planned, target), stay);
          if (rise) {
            const need = timeToReach(model, temp, rise.target, now, out.outdoorAt);
            if (now + need + PREHEAT_MARGIN_MS >= rise.at) {
              preheat = { until: rise.at, target: rise.target, startedAt: now };
              lastPreheatStart = now;
              ctx.state.set("lastPreheatStart", now);
              ctx.log(
                `Préchauffe : ${round1(temp)} °C dedans, ${round1(out.outdoorAt(now))} °C dehors (${OUTSIDE_LABEL[out.source]}) → ` +
                  `${rise.target} °C à ${hm(rise.at)}${Number.isFinite(need) ? `, ${Math.round(need / 60_000)} min estimées` : ", au maximum"}`,
              );
            }
          }
        }
        save("preheat", preheat);
        if (preheat) target = Math.max(target, preheat.target);

        let why = "";
        let want: boolean;
        if (temp === null) {
          // Mute sensor: nothing to regulate on. Radiators get their own
          // thermostats back — cold is the failure, not the kWh.
          warnOnce("drive-mute", `Sonde « ${nameOf(sensorId)} » muette — radiateurs rendus à leur thermostat`);
          want = true;
          why = "mute";
        } else {
          warned.delete("drive-mute");
          want = heating ? temp < target + 0.2 : temp < target - 0.3;

          // Coasting: let the room's inertia carry it to a lower target.
          const plannedTarget = target === planned && !preheat && mode === "auto";
          const drop = plannedTarget ? nextDrop(now, target, stay) : null;
          const allowed =
            drop !== null &&
            (source === "schedule" ? minuteOfDay(now) >= coastFrom : drop - now <= coastMaxMs);
          if (!allowed || temp < target - 1) coasting = false;
          else if (!coasting && temp >= target - 0.4 && coastTo(model, temp, now, drop!, out.outdoorAt) >= target - 1) {
            coasting = true;
            ctx.log(`Roue libre : l'inertie tient ≥ ${round1(target - 1)} °C jusqu'à ${hm(drop!)}`);
          }
          if (coasting) {
            want = false;
            why = "coast";
          }

          // Sun expected within the hour: let it do the work.
          if (want && !preheat && temp >= target - 0.6 && out.sunAt(now + 3_600_000) >= SUN_TRUST_WM2) {
            want = false;
            why = "sun";
          }
          if (temp >= maxTemp) want = false;
        }

        const frostFloor = temp !== null && temp <= frostTemp;
        if (windowOpen && !frostFloor) {
          want = false;
          why = "window";
        }

        if (want !== heating) {
          heating = want;
          save("heating", heating);
        }
        for (const id of heaterIds) await applyTarget(id, want ? "on" : "off", now);
        persist();

        feedLearning(now, temp, out, windowOpen);

        publish("target", target);
        publish("status", why || (want ? "heating" : "idle"));
        publish("summary", summaryFor(verdict, target, why, stay));
        const countdown = verdict.nextCheckAt ?? preheat?.until ?? null;
        if (countdown !== null && countdown > now) publish("timerExpiresAt", new Date(countdown).toISOString());
        else if (published.get("timerExpiresAt") !== undefined) {
          published.delete("timerExpiresAt");
          ctx.state.delete("timerExpiresAt");
        }
      }

      // ── Evaluation ────────────────────────────────────────

      async function evaluateInner(): Promise<void> {
        const now = Date.now();
        const temp = readTemp(now);

        if (temp === null) {
          warnOnce(
            "temp-mute",
            `Sonde « ${nameOf(sensorId)} » : aucune mesure exploitable (alias ${tempAlias() ?? "introuvable"})`,
          );
        } else {
          warned.delete("temp-mute");
        }
        publish("temperature", temp);

        // Only sample a room whose heating is free to answer: capping, frost
        // mode and the paused mode all cool it for reasons of their own.
        const suspended = mode !== "auto" || holding === "cap" || (driven && !heating);
        if (!suspended) recordSample(now, temp);
        const contacts = readContacts(now);
        const drop = contacts === true ? false : evaluateDrop(now, temp, suspended);
        const windowOpen = contacts === true || drop;

        if (mode === "off") {
          if (heaterIds.some((id) => commanded.get(id) === "off")) {
            await release("recette en pause");
          }
          publish("status", "paused");
          publish("summary", "Pause — radiateurs rendus");
          return;
        }

        if (mode === "frost") {
          await frostTick(now, temp, windowOpen);
          publish("summary", `Absent — hors-gel ${frostTemp} °C`);
          return;
        }

        if (driven || mode === "comfort") {
          await driveTick(now, temp, windowOpen);
          return;
        }

        await autoTick(now, temp, windowOpen);
        publish(
          "summary",
          holding === "cap"
            ? `Plafond atteint — coupé (${maxTemp} °C)`
            : holding === "window"
              ? "Fenêtre ouverte — chauffage coupé"
              : `Plafond ${maxTemp} °C`,
        );
      }

      async function evaluate(): Promise<void> {
        if (stopped || running) return;
        running = true;
        try {
          await evaluateInner();
        } catch (err: unknown) {
          ctx.log(`Erreur d'évaluation : ${messageOf(err)}`, "error");
        } finally {
          running = false;
        }
      }

      // ── Wiring ────────────────────────────────────────────

      const watched = new Set<string>([sensorId, ...heaterIds, ...windowIds, ...motionIds, staysId].filter(Boolean));
      unsubs.push(
        ctx.eventBus.onType("equipment.data.changed", (event) => {
          const id = String(event.equipmentId ?? "");
          if (!watched.has(id)) return;
          void evaluate();
        }),
      );

      const ticker = setInterval(() => void evaluate(), TICK_MS);

      publish("mode", mode);
      const detection = windowIds.length
        ? `${windowIds.length} contact(s) d'ouverture`
        : dropEnabled
          ? `chute de ${dropDelta} °C en ${ctx.helpers.formatDuration(dropWindowMs)}`
          : "aucune";
      if (driven) {
        const what =
          source === "schedule"
            ? `horaires ${hm(atMinute(Date.now(), occCfg.workStart))}–${hm(atMinute(Date.now(), occCfg.workEnd))}`
            : source === "stays"
              ? `séjours « ${staysId ? nameOf(staysId) : "?"} »`
              : `jour/nuit (nuit ${hm(atMinute(Date.now(), occCfg.nightStart))}–${hm(atMinute(Date.now(), occCfg.nightEnd))})`;
        ctx.log(
          `Chauffage intelligent : ${what}, confort ${comfortTemp} °C` +
            (source === "schedule" ? "" : `, nuit ${nightTemp} °C`) +
            `, absence ${frostTemp} °C, ${motionIds.length} détecteur(s) de présence, ` +
            `modèle ${round1(model.gain)} °C/h · ${round1(model.tau)} h`,
        );
      }
      ctx.log(
        `Recette démarrée — plafond ${maxTemp} °C (retour à ${round1(maxTemp - hysteresis)} °C), ` +
          `sonde « ${nameOf(sensorId)} », ${heaterIds.length} relais, ` +
          `fenêtre : ${detection}, mode ${mode}`,
      );
      void evaluate();

      return {
        stop(): void {
          stopped = true;
          clearInterval(ticker);
          for (const unsub of unsubs) {
            try {
              unsub();
            } catch {
              /* teardown must never throw */
            }
          }
          unsubs.length = 0;

          // Deliberately the opposite of the water-heater recipe: a heater the
          // recipe is holding open must not stay open once the recipe is gone.
          // A disabled or deleted instance would otherwise leave a paying guest
          // with no heating and nothing in the journal to explain it. On a mere
          // update the successor re-cuts within a tick, which costs one order.
          const held = heaterIds.filter((id) => commanded.get(id) === "off");
          for (const id of held) {
            commanded.delete(id);
            void send(id, "on").catch(() => undefined);
          }
          holding = null;
          persist();
          ctx.log(
            held.length > 0
              ? `Recette arrêtée — chauffage rendu (${held.length} relais)`
              : "Recette arrêtée",
          );
        },

        onAction(action: string, payload?: Record<string, unknown>): void {
          if (action !== "set_mode") return;
          const next = readMode(payload?.mode);
          if (next === mode) return;
          const previous = mode;
          mode = next;
          publish("mode", mode);

          // Leaving frost hands the heaters back: the place is about to be
          // occupied again, and a guest arriving to dead radiators is exactly
          // the call this recipe exists to avoid.
          if (mode === "comfort") {
            const midnight = new Date();
            midnight.setHours(24, 0, 0, 0);
            comfortUntil = midnight.getTime();
            ctx.state.set("comfortUntil", comfortUntil);
          } else {
            comfortUntil = null;
            ctx.state.delete("comfortUntil");
          }
          preheat = null;
          coasting = false;
          const handBack = previous === "frost" || mode === "off";
          if (handBack || mode === "frost") frostHeating = false;
          drive.clear();
          graceUntil.clear();

          ctx.log(
            mode === "comfort"
              ? `Confort forcé ${comfortTemp} °C jusqu'à minuit`
              : mode === "auto"
              ? driven
                ? "Mode automatique"
                : `Mode plafond (${maxTemp} °C)`
              : mode === "frost"
                ? `Mode hors-gel (${frostTemp} °C, logement vide)`
                : "Recette en pause",
          );
          persist();

          // Sequenced, not fired side by side: the hand-back and the first
          // evaluation of the new mode both order relays, and running them
          // concurrently would race over the same one.
          void (async () => {
            if (handBack) {
              await release(mode === "off" ? "recette en pause" : driven ? "retour en automatique" : "retour en mode plafond");
            }
            await evaluate();
          })();
        },
      };
    },
  };
}
