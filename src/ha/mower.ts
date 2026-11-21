import type { FeatureCollection } from "geojson";
import {
  ANGLE_MODES,
  MOW_ORDERS,
  PATTERNS,
  SWITCH_SETTINGS,
  type DetectionMode,
  type DetectionOption,
  type MowSettings,
  type Range,
  type SettingLimits,
  type SettingName,
  type SwitchSetting,
} from "../model";
import { foldAngle, foldCrossAngle } from "../geo/angles";
import type { EntityRegistryDisplayEntry, HassEntity, HomeAssistant } from "./types";

export interface AreaSwitch {
  readonly entityId: string;
  readonly hash: number;
  readonly name: string;
  readonly on: boolean;
  /** 1-based place in the integration's mowing order while on. */
  readonly order?: number;
}

export interface RunningJob {
  /** What `modify_running_job` can change on the job. */
  readonly changeable: readonly SettingName[];
  /** Hashes of the job's areas in mowing order, when the integration reports them. */
  readonly areas?: readonly number[];
}

/** Everything the card reads for one mower, resolved from the registries and states. */
export interface Mower {
  readonly entityId: string;
  readonly name: string;
  /** lawn_mower state: mowing, paused, returning, docked, idle, error, unavailable… */
  readonly state: string;
  readonly areas: readonly AreaSwitch[];
  readonly position?: { readonly lon: number; readonly lat: number; readonly headingDeg?: number };
  readonly battery?: number;
  readonly limits: SettingLimits;
  /** The values currently held by the integration's planning entities, with fallbacks where one is missing. */
  readonly settings: MowSettings;
  /** The settings that came from an entity rather than a fallback. */
  readonly heldSettings: readonly SettingName[];
  /** Present while a job is under way. */
  readonly runningJob?: RunningJob;
  /**
   * The planning entity of each setting that has one, by entity id. Only an integration that reports the
   * running job is listed: its setters touch the mower only during a job, which the card can then tell.
   */
  readonly settingEntities?: Partial<Record<SettingName, string>>;
  /** The areas the integration has picked, in mowing order; present when its area switches keep an order. */
  readonly savedAreas?: readonly number[];
}

/** An entity service call that stores a setting in its planning entity. */
export interface SettingWrite {
  readonly entityId: string;
  readonly domain: string;
  readonly service: string;
  readonly data: Record<string, unknown>;
}

const LAPS = ["none", "one", "two", "three", "four"] as const;

/** Select options by translation_key; an option's integer service code is its index. */
const OPTIONS = {
  channel_mode: PATTERNS,
  cutting_angle_mode: ANGLE_MODES,
  mowing_laps: LAPS,
  obstacle_laps: LAPS,
  border_mode: MOW_ORDERS,
} as const;

/** pymammotion's `DetectionStrategy.for_device` lists as `bypass_mode` options, with each option's `ultra_wave` code. */
const DETECTION_LISTS: readonly (readonly DetectionOption[])[] = (
  [
    [
      ["off", 0],
      ["slow_touch", 1],
      ["less_touch", 2],
    ],
    [
      ["off", 0],
      ["slow_touch", 1],
      ["less_touch", 2],
      ["standard", 10],
    ],
    [
      ["off", 1],
      ["standard", 10],
      ["sensitive", 11],
    ],
  ] satisfies (readonly [DetectionMode, number])[][]
).map((list) => list.map(([key, code]) => ({ key, code })));

const SWITCH_KEYS: Readonly<Record<SwitchSetting, string>> = {
  autoChangeDirection: "auto_change_direction",
  cutGrass: "is_mow",
  dumpGrass: "is_dump",
  cutEdges: "is_edge",
};

/** The integration's own defaults, shown while a switch has no value. */
const SWITCH_DEFAULTS: Readonly<Record<SwitchSetting, boolean>> = {
  autoChangeDirection: false,
  cutGrass: true,
  dumpGrass: true,
  cutEdges: false,
};

const ACTIVE_STATES: readonly string[] = ["mowing", "paused", "returning"];

/** What `mammotion.modify_running_job` takes. */
const RUNNING_JOB_SETTINGS: readonly SettingName[] = [
  "pattern",
  "spacingCm",
  "obstacleLaps",
  "speed",
  "bladeHeight",
  "obstacleDetection",
  "startProgress",
  "autoChangeDirection",
];

/** An integration without the running-job attributes resets auto-reverse from the job before sending. */
const LEGACY_RUNNING_JOB_SETTINGS = RUNNING_JOB_SETTINGS.filter((name) => name !== "autoChangeDirection");

/** Each setting's planning entity, by domain and translation key. */
const SETTING_ENTITIES: Readonly<Record<SettingName, readonly ["select" | "number" | "switch", string]>> = {
  pattern: ["select", "channel_mode"],
  angleMode: ["select", "cutting_angle_mode"],
  angle: ["number", "cutting_angle"],
  crossAngle: ["number", "toward_included_angle"],
  spacingCm: ["number", "path_spacing"],
  perimeterLaps: ["select", "mowing_laps"],
  obstacleLaps: ["select", "obstacle_laps"],
  mowOrder: ["select", "border_mode"],
  speed: ["number", "working_speed"],
  bladeHeight: ["number", "blade_height"],
  edgeDistance: ["number", "ride_boundary_distance"],
  obstacleDetection: ["select", "bypass_mode"],
  startProgress: ["number", "start_progress"],
  autoChangeDirection: ["switch", "auto_change_direction"],
  cutGrass: ["switch", "is_mow"],
  dumpGrass: ["switch", "is_dump"],
  cutEdges: ["switch", "is_edge"],
  dumpInterval: ["number", "dumping_interval"],
};

type Lookup = (key: string) => HassEntity | undefined;

interface Lookups {
  readonly select: Lookup;
  readonly number: Lookup;
  readonly toggle: Lookup;
}

interface Sibling {
  readonly key: string | undefined;
  readonly state: HassEntity;
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const available = (entity?: HassEntity): HassEntity | undefined =>
  entity?.state === "unavailable" ? undefined : entity;

const friendlyName = (entity?: HassEntity): string | undefined =>
  typeof entity?.attributes.friendly_name === "string" ? entity.attributes.friendly_name : undefined;

const clamp = (value: number, range: Range): number => Math.min(Math.max(value, range.min), range.max);

const midpoint = (range: Range): number =>
  range.min + Math.round((range.max - range.min) / 2 / range.step) * range.step;

function stateNumber(entity?: HassEntity): number | undefined {
  return entity && entity.state.trim() !== "" ? finite(Number(entity.state)) : undefined;
}

function deviceName(hass: HomeAssistant, entityId: string): string | undefined {
  const deviceId = hass.entities[entityId]?.device_id;
  const device = deviceId === undefined ? undefined : hass.devices[deviceId];
  return device?.name_by_user ?? device?.name ?? undefined;
}

/** What the user calls the mower: its device name, else the entity's. */
export function mowerName(hass: HomeAssistant, entityId: string): string {
  return deviceName(hass, entityId) ?? friendlyName(hass.states[entityId]) ?? entityId;
}

type Registry = HomeAssistant["entities"];

/** `hass` is replaced on every state change but the registry object only on registry changes. */
const entriesByDevice = new WeakMap<Registry, Map<string, EntityRegistryDisplayEntry[]>>();

function deviceEntries(registry: Registry, deviceId: string): readonly EntityRegistryDisplayEntry[] {
  let devices = entriesByDevice.get(registry);
  if (!devices) {
    devices = new Map();
    for (const entry of Object.values(registry)) {
      if (entry.device_id === undefined) continue;
      devices.set(entry.device_id, [...(devices.get(entry.device_id) ?? []), entry]);
    }
    entriesByDevice.set(registry, devices);
  }
  return devices.get(deviceId) ?? [];
}

function siblings(hass: HomeAssistant, entityId: string): Sibling[] {
  const deviceId = hass.entities[entityId]?.device_id;
  if (deviceId === undefined) return [];
  return deviceEntries(hass.entities, deviceId).flatMap((entry) => {
    const state = hass.states[entry.entity_id];
    return state ? [{ key: entry.translation_key, state }] : [];
  });
}

function offered<T extends string>(entity: HassEntity | undefined, allowed: readonly T[]): T[] {
  const options = available(entity)?.attributes.options;
  return Array.isArray(options) ? allowed.filter((option) => options.includes(option)) : [];
}

function selected<T extends string>(entity: HassEntity | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((option) => option === entity?.state);
}

function onOff(entity?: HassEntity): boolean | undefined {
  return entity?.state === "on" ? true : entity?.state === "off" ? false : undefined;
}

/** Only an exact known list is trusted: "off" stands for 0 on some lists and 1 on others. */
function detectionOptions(entity?: HassEntity): SettingLimits["obstacleDetection"] {
  const options = available(entity)?.attributes.options;
  return Array.isArray(options)
    ? DETECTION_LISTS.find(
        (list) => list.length === options.length && list.every((option, i) => option.key === options[i]),
      )
    : undefined;
}

function range(entity?: HassEntity): Range | undefined {
  const attributes = available(entity)?.attributes;
  const [min, max, step] = [attributes?.min, attributes?.max, attributes?.step].map(finite);
  return min === undefined || max === undefined || step === undefined ? undefined : { min, max, step };
}

function maxLaps(entity?: HassEntity): number {
  const codes = offered(entity, LAPS).map((option) => LAPS.indexOf(option));
  return codes.length > 0 ? Math.max(...codes) : LAPS.length - 1;
}

function readLimits({ select, number, toggle }: Lookups): SettingLimits {
  const patterns = offered(select("channel_mode"), PATTERNS);
  const angleModes = offered(select("cutting_angle_mode"), ANGLE_MODES);
  const cross = range(number("toward_included_angle")) ?? { min: 1, max: 179, step: 1 };
  const bladeHeight = range(number("blade_height"));
  const edgeDistance = range(number("ride_boundary_distance"));
  const obstacleDetection = detectionOptions(select("bypass_mode"));
  const startProgress = range(number("start_progress"));
  const dumpInterval = range(number("dumping_interval"));
  const switches = SWITCH_SETTINGS.filter((name) => available(toggle(SWITCH_KEYS[name])));
  return {
    patterns: patterns.length > 0 ? patterns : PATTERNS,
    angleModes: angleModes.length > 0 ? angleModes : ["relative_angle", "absolute_angle"],
    angle: { min: -90, max: 90, step: 1 },
    crossAngle: { min: Math.max(cross.min, 1), max: Math.min(cross.max, 179), step: cross.step },
    spacingCm: range(number("path_spacing")) ?? { min: 20, max: 35, step: 1 },
    maxPerimeterLaps: maxLaps(select("mowing_laps")),
    maxObstacleLaps: maxLaps(select("obstacle_laps")),
    speed: range(number("working_speed")) ?? { min: 0.2, max: 0.6, step: 0.1 },
    ...(bladeHeight && { bladeHeight }),
    ...(edgeDistance && { edgeDistance }),
    ...(obstacleDetection && { obstacleDetection }),
    ...(startProgress && { startProgress }),
    ...(dumpInterval && { dumpInterval }),
    ...(switches.length > 0 && { switches }),
  };
}

function readSettings(
  { select, number, toggle }: Lookups,
  limits: SettingLimits,
): Pick<Mower, "settings" | "heldSettings"> {
  const held: Partial<MowSettings> = {};
  const hold = <K extends SettingName>(name: K, value: MowSettings[K] | undefined): void => {
    if (value !== undefined) held[name] = value;
  };
  const laps = (key: string, max: number): number | undefined => {
    const option = selected(select(key), LAPS);
    return option === undefined ? undefined : Math.min(LAPS.indexOf(option), max);
  };
  const value = (key: string, limit: Range | undefined, fold = (n: number) => n): number | undefined => {
    const held = stateNumber(number(key));
    return held === undefined || !limit ? undefined : clamp(fold(held), limit);
  };
  hold("pattern", selected(select("channel_mode"), limits.patterns));
  hold("angleMode", selected(select("cutting_angle_mode"), limits.angleModes));
  hold("angle", value("cutting_angle", limits.angle, foldAngle));
  hold("crossAngle", value("toward_included_angle", limits.crossAngle, foldCrossAngle));
  hold("spacingCm", value("path_spacing", limits.spacingCm));
  hold("perimeterLaps", laps("mowing_laps", limits.maxPerimeterLaps));
  hold("obstacleLaps", laps("obstacle_laps", limits.maxObstacleLaps));
  hold("mowOrder", selected(select("border_mode"), MOW_ORDERS));
  hold("speed", value("working_speed", limits.speed));
  hold("bladeHeight", value("blade_height", limits.bladeHeight));
  hold("edgeDistance", value("ride_boundary_distance", limits.edgeDistance));
  const detection = select("bypass_mode")?.state;
  hold("obstacleDetection", limits.obstacleDetection?.find((option) => option.key === detection)?.code);
  hold("startProgress", value("start_progress", limits.startProgress));
  hold("dumpInterval", value("dumping_interval", limits.dumpInterval));
  const switches = limits.switches ?? [];
  for (const name of switches) hold(name, onOff(toggle(SWITCH_KEYS[name])));
  const { bladeHeight, edgeDistance, startProgress, dumpInterval } = limits;
  const [detectionDefault] = limits.obstacleDetection ?? [];
  return {
    settings: {
      pattern: "single_grid",
      angleMode: "relative_angle",
      angle: 0,
      crossAngle: 90,
      spacingCm: clamp(25, limits.spacingCm),
      perimeterLaps: Math.min(1, limits.maxPerimeterLaps),
      obstacleLaps: Math.min(1, limits.maxObstacleLaps),
      mowOrder: "border_first",
      speed: clamp(0.3, limits.speed),
      ...(bladeHeight && { bladeHeight: midpoint(bladeHeight) }),
      ...(edgeDistance && { edgeDistance: midpoint(edgeDistance) }),
      ...(detectionDefault && { obstacleDetection: detectionDefault.code }),
      ...(startProgress && { startProgress: clamp(0, startProgress) }),
      ...(dumpInterval && { dumpInterval: clamp(10, dumpInterval) }),
      ...Object.fromEntries(switches.map((name) => [name, SWITCH_DEFAULTS[name]])),
      ...held,
    },
    heldSettings: Object.keys(held) as SettingName[],
  };
}

function readAreas(entities: readonly Sibling[], deviceLabel: string | undefined): AreaSwitch[] {
  const prefix = deviceLabel === undefined ? undefined : `${deviceLabel} `;
  return entities
    .flatMap(({ key, state }) => {
      const hash = finite(state.attributes.hash);
      if (
        !state.entity_id.startsWith("switch.") ||
        (key !== "area" && key !== "area_plain") ||
        hash === undefined
      )
        return [];
      const fullName = friendlyName(state) ?? state.entity_id;
      const name = prefix && fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName;
      const order = finite(state.attributes.order);
      return [
        {
          entityId: state.entity_id,
          hash,
          name,
          on: state.state === "on",
          ...(order !== undefined && { order }),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

type JobFields = Readonly<Record<string, unknown>>;

const isJob = (value: unknown): value is JobFields => typeof value === "object" && value !== null;

/** For an integration without the `running_job` attributes: its own test reads values no entity has. */
function approximateRunningJob(
  state: string,
  progress?: HassEntity,
  angleMode?: HassEntity,
): RunningJob | undefined {
  if (!ACTIVE_STATES.includes(state) || stateNumber(progress) === 100) return undefined;
  // Random angle is missing only on the original Luba, whose running job the integration refuses to change.
  return {
    changeable: offered(angleMode, ANGLE_MODES).includes("random_angle") ? LEGACY_RUNNING_JOB_SETTINGS : [],
  };
}

function reportedRunningJob(job: JobFields, modifiable: boolean): RunningJob {
  const areas = Array.isArray(job.areas)
    ? job.areas.filter((hash): hash is number => finite(hash) !== undefined)
    : undefined;
  return { changeable: modifiable ? RUNNING_JOB_SETTINGS : [], ...(areas && { areas }) };
}

/** The running job's own values, by `start_mow` field, as settings within this mower's limits. */
function jobSettings(job: JobFields, limits: SettingLimits): Partial<MowSettings> {
  const code = (key: string) => (Number.isInteger(job[key]) ? (job[key] as number) : undefined);
  const option = <T extends string>(key: string, all: readonly T[], allowed: readonly T[]) => {
    const value = all[code(key) ?? -1];
    return value && allowed.includes(value) ? value : undefined;
  };
  // 0 is the unset value of these, never a real one.
  const set = (key: string) => {
    const value = finite(job[key]);
    return value === 0 ? undefined : value;
  };
  const within = (value: number | undefined, limit?: Range, fold = (n: number) => n) =>
    value === undefined || !limit ? undefined : clamp(fold(value), limit);
  const laps = (key: string, max: number) => {
    const value = code(key);
    return value === undefined ? undefined : Math.min(value, max);
  };
  const detection = code("ultra_wave");
  const autoChange = code("auto_change_direction");
  const values: Partial<Record<SettingName, unknown>> = {
    pattern: option("channel_mode", PATTERNS, limits.patterns),
    angleMode: option("toward_mode", ANGLE_MODES, limits.angleModes),
    angle: within(finite(job.toward), limits.angle, foldAngle),
    crossAngle: within(finite(job.toward_included_angle), limits.crossAngle, foldCrossAngle),
    spacingCm: within(set("channel_width"), limits.spacingCm),
    perimeterLaps: laps("mowing_laps", limits.maxPerimeterLaps),
    obstacleLaps: laps("obstacle_laps", limits.maxObstacleLaps),
    mowOrder: option("border_mode", MOW_ORDERS, MOW_ORDERS),
    speed: within(set("speed"), limits.speed),
    bladeHeight: within(set("blade_height"), limits.bladeHeight),
    edgeDistance: within(finite(job.ride_boundary_distance), limits.edgeDistance),
    obstacleDetection: limits.obstacleDetection?.find((o) => o.code === detection)?.code,
    startProgress: within(finite(job.start_progress), limits.startProgress),
    autoChangeDirection:
      limits.switches?.includes("autoChangeDirection") && autoChange !== undefined
        ? autoChange === 1
        : undefined,
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function readPosition(tracker?: HassEntity): Mower["position"] {
  const lat = finite(tracker?.attributes.latitude);
  const lon = finite(tracker?.attributes.longitude);
  const headingDeg = finite(tracker?.attributes.direction);
  if (lat === undefined || lon === undefined) return undefined;
  return { lon, lat, ...(headingDeg !== undefined && { headingDeg }) };
}

/** Entity ids of every Mammotion `lawn_mower`, sorted by name. */
export function findMowers(hass: HomeAssistant): string[] {
  return Object.values(hass.entities)
    .filter(
      (e) => e.platform === "mammotion" && e.entity_id.startsWith("lawn_mower.") && hass.states[e.entity_id],
    )
    .map((e) => e.entity_id)
    .sort((a, b) => mowerName(hass, a).localeCompare(mowerName(hass, b)));
}

export function readMower(hass: HomeAssistant, entityId: string): Mower | undefined {
  const mower = hass.states[entityId];
  if (!mower) return undefined;
  const entities = siblings(hass, entityId);
  const find = (domain: string, key: string): HassEntity | undefined =>
    entities.find((e) => e.key === key && e.state.entity_id.startsWith(`${domain}.`))?.state;
  const lookups: Lookups = {
    select: (key) => find("select", key),
    number: (key) => find("number", key),
    toggle: (key) => find("switch", key),
  };
  const limits = readLimits(lookups);
  const { running_job: job, running_job_modifiable: modifiable } = mower.attributes;
  const reported = typeof modifiable === "boolean";
  const runningJob = !reported
    ? approximateRunningJob(mower.state, find("sensor", "progress"), lookups.select("cutting_angle_mode"))
    : isJob(job)
      ? reportedRunningJob(job, modifiable)
      : undefined;
  const { settings, heldSettings } = readSettings(lookups, limits);
  const settingEntities = Object.fromEntries(
    reported
      ? (Object.keys(SETTING_ENTITIES) as SettingName[]).flatMap((name) => {
          const entity = available(find(...SETTING_ENTITIES[name]));
          return entity ? [[name, entity.entity_id]] : [];
        })
      : [],
  );
  const position = readPosition(find("device_tracker", "device_tracker"));
  const battery = stateNumber(
    entities.find(
      (e) => e.state.entity_id.startsWith("sensor.") && e.state.attributes.device_class === "battery",
    )?.state,
  );
  const areas = readAreas(entities, deviceName(hass, entityId));
  const ordered =
    reported &&
    areas.length > 0 &&
    areas.every((area) => "order" in (hass.states[area.entityId]?.attributes ?? {}));
  const savedAreas = areas
    .filter((area) => area.on && area.order !== undefined)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((area) => area.hash);
  return {
    entityId,
    name: mowerName(hass, entityId),
    state: mower.state,
    areas,
    ...(position && { position }),
    ...(battery !== undefined && { battery }),
    limits,
    settings: { ...settings, ...(reported && isJob(job) && jobSettings(job, limits)) },
    heldSettings,
    ...(runningJob && { runningJob }),
    ...(Object.keys(settingEntities).length > 0 && { settingEntities }),
    ...(ordered && { savedAreas }),
  };
}

/** Strips float noise (0.30000000000000004) without coarsening a finer step than the slider's. */
const hundredths = (value: number) => Math.round(value * 100) / 100;

const SERVICE_FIELDS: { readonly [K in SettingName]: (value: NonNullable<MowSettings[K]>) => object } = {
  pattern: (value) => ({ channel_mode: OPTIONS.channel_mode.indexOf(value) }),
  angleMode: (value) => ({ toward_mode: OPTIONS.cutting_angle_mode.indexOf(value) }),
  angle: (value) => ({ toward: Math.round(value) }),
  crossAngle: (value) => ({ toward_included_angle: Math.round(value) }),
  spacingCm: (value) => ({ channel_width: Math.round(value) }),
  perimeterLaps: (value) => ({ mowing_laps: value }),
  obstacleLaps: (value) => ({ obstacle_laps: value }),
  mowOrder: (value) => ({ border_mode: OPTIONS.border_mode.indexOf(value) }),
  speed: (value) => ({ speed: hundredths(value) }),
  bladeHeight: (value) => ({ blade_height: Math.round(value) }),
  edgeDistance: (value) => ({ ride_boundary_distance: hundredths(value) }),
  obstacleDetection: (value) => ({ ultra_wave: value }),
  startProgress: (value) => ({ start_progress: Math.round(value) }),
  autoChangeDirection: (value) => ({ auto_change_direction: value ? 1 : 0 }),
  cutGrass: (value) => ({ is_mow: value }),
  dumpGrass: (value) => ({ is_dump: value }),
  cutEdges: (value) => ({ is_edge: value }),
  dumpInterval: (value) => ({ collect_grass_frequency: Math.round(value) }),
};

function serviceFields(settings: MowSettings, names: readonly SettingName[]): Record<string, unknown> {
  const field = (name: SettingName): object => {
    const value = settings[name];
    return value === undefined ? {} : (SERVICE_FIELDS[name] as (value: unknown) => object)(value);
  };
  return Object.assign({}, ...names.map(field)) as Record<string, unknown>;
}

/**
 * `mammotion.start_mow` service data for a new job over `areaEntityIds`, in mowing order.
 * Only `names` are sent; the integration keeps its own value for every setting left out.
 */
export function startMowData(
  settings: MowSettings,
  names: readonly SettingName[],
  areaEntityIds: readonly string[],
): Record<string, unknown> {
  return { areas: [...areaEntityIds], ...serviceFields(settings, names) };
}

/** The entity's own option key for a select setting's value, when the mower offers one. */
function optionOf(name: SettingName, value: unknown, limits: SettingLimits): string | undefined {
  if (name === "perimeterLaps" || name === "obstacleLaps") return LAPS[value as number];
  if (name === "obstacleDetection")
    return limits.obstacleDetection?.find((option) => option.code === value)?.key;
  return String(value);
}

/** The call that stores `value` in the setting's planning entity, or undefined when it has none. */
export function settingWrite(mower: Mower, name: SettingName, value: unknown): SettingWrite | undefined {
  const entityId = mower.settingEntities?.[name];
  if (!entityId || value === undefined) return undefined;
  const [domain] = SETTING_ENTITIES[name];
  if (domain === "switch") return { entityId, domain, service: value ? "turn_on" : "turn_off", data: {} };
  if (domain === "number") {
    const number = name === "speed" || name === "edgeDistance" ? hundredths(value as number) : value;
    return { entityId, domain, service: "set_value", data: { value: number } };
  }
  const option = optionOf(name, value, mower.limits);
  return option === undefined ? undefined : { entityId, domain, service: "select_option", data: { option } };
}

/**
 * The switch calls that turn the saved areas into `target`, in order. The integration only appends a switch
 * turned on, so the longest start of `target` already in order stays and every other area is turned off,
 * then the rest of `target` is turned on one by one.
 */
export function areaWrites(mower: Mower, target: readonly number[]): SettingWrite[] {
  const current = mower.savedAreas ?? [];
  const kept = current.reduce((count, hash) => (hash === target[count] ? count + 1 : count), 0);
  const steps = [
    ...current.filter((hash) => !target.slice(0, kept).includes(hash)).map((hash) => [hash, false] as const),
    ...target.slice(kept).map((hash) => [hash, true] as const),
  ];
  return steps.flatMap(([hash, on]) => {
    const entityId = mower.areas.find((area) => area.hash === hash)?.entityId;
    return entityId ? [{ entityId, domain: "switch", service: on ? "turn_on" : "turn_off", data: {} }] : [];
  });
}

export async function writeSetting(
  hass: HomeAssistant,
  { entityId, domain, service, data }: SettingWrite,
): Promise<void> {
  await hass.callService(domain, service, data, { entity_id: entityId }, false, false);
}

/** `mammotion.modify_running_job` service data; the job keeps its own value for every setting left out. */
export function modifyJobData(settings: MowSettings, names: readonly SettingName[]): Record<string, unknown> {
  return serviceFields(settings, names);
}

const asFeatures = (value: unknown): FeatureCollection | undefined =>
  typeof value === "object" &&
  value !== null &&
  "features" in value &&
  Array.isArray(value.features) &&
  value.features.length > 0
    ? (value as FeatureCollection)
    : undefined;

async function responseOf(
  hass: HomeAssistant,
  service: string,
  entityId: string,
  data: Record<string, unknown> = {},
): Promise<unknown> {
  const { response } = await hass.callService(
    "mammotion",
    service,
    data,
    { entity_id: entityId },
    false,
    true,
  );
  return response;
}

export async function fetchMap(
  hass: HomeAssistant,
  entityId: string,
): Promise<FeatureCollection | undefined> {
  return asFeatures(await responseOf(hass, "get_geojson", entityId));
}

/** Whether the integration can plan a route and hand it back, which `mammotion.plan_route` brought. */
export const canPlanRoute = (hass: HomeAssistant): boolean => Boolean(hass.services?.mammotion?.plan_route);

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "";

/**
 * Plans `data` (`start_mow` fields) without starting it and returns that plan's own route.
 * Rejects with the integration's message, empty when it gave none, if it refuses or gets no route.
 */
export async function planRoute(
  hass: HomeAssistant,
  entityId: string,
  data: Record<string, unknown>,
): Promise<FeatureCollection> {
  let response: unknown;
  try {
    response = await responseOf(hass, "plan_route", entityId, data);
  } catch (error) {
    throw new Error(messageOf(error), { cause: error });
  }
  // An entity service answers by entity id, even for one entity.
  const route = asFeatures(
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>)[entityId]
      : undefined,
  );
  if (!route) throw new Error("");
  return route;
}

export async function modifyRunningJob(
  hass: HomeAssistant,
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await hass.callService("mammotion", "modify_running_job", data, { entity_id: entityId }, true, false);
}

export async function startMow(
  hass: HomeAssistant,
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await hass.callService("mammotion", "start_mow", data, { entity_id: entityId }, true, false);
}
