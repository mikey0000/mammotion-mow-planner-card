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
      return [{ entityId: state.entity_id, hash, name, on: state.state === "on" }];
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
  const position = readPosition(find("device_tracker", "device_tracker"));
  const battery = stateNumber(
    entities.find(
      (e) => e.state.entity_id.startsWith("sensor.") && e.state.attributes.device_class === "battery",
    )?.state,
  );
  return {
    entityId,
    name: mowerName(hass, entityId),
    state: mower.state,
    areas: readAreas(entities, deviceName(hass, entityId)),
    ...(position && { position }),
    ...(battery !== undefined && { battery }),
    limits,
    settings: { ...settings, ...(reported && isJob(job) && jobSettings(job, limits)) },
    heldSettings,
    ...(runningJob && { runningJob }),
  };
}

const SERVICE_FIELDS: { readonly [K in SettingName]: (value: NonNullable<MowSettings[K]>) => object } = {
  pattern: (value) => ({ channel_mode: OPTIONS.channel_mode.indexOf(value) }),
  angleMode: (value) => ({ toward_mode: OPTIONS.cutting_angle_mode.indexOf(value) }),
  angle: (value) => ({ toward: Math.round(value) }),
  crossAngle: (value) => ({ toward_included_angle: Math.round(value) }),
  spacingCm: (value) => ({ channel_width: Math.round(value) }),
  perimeterLaps: (value) => ({ mowing_laps: value }),
  obstacleLaps: (value) => ({ obstacle_laps: value }),
  mowOrder: (value) => ({ border_mode: OPTIONS.border_mode.indexOf(value) }),
  speed: (value) => ({ speed: Math.round(value * 10) / 10 }),
  bladeHeight: (value) => ({ blade_height: Math.round(value) }),
  edgeDistance: (value) => ({ ride_boundary_distance: value }),
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
  planOnly = false,
): Record<string, unknown> {
  return {
    areas: [...areaEntityIds],
    ...serviceFields(settings, names),
    ...(planOnly && { plan_only: true }),
  };
}

/** `mammotion.modify_running_job` service data; the job keeps its own value for every setting left out. */
export function modifyJobData(settings: MowSettings, names: readonly SettingName[]): Record<string, unknown> {
  return serviceFields(settings, names);
}

async function fetchFeatures(
  hass: HomeAssistant,
  service: string,
  entityId: string,
): Promise<FeatureCollection | undefined> {
  const { response } = await hass.callService<{ features?: unknown }>(
    "mammotion",
    service,
    {},
    { entity_id: entityId },
    false,
    true,
  );
  return Array.isArray(response?.features) && response.features.length > 0
    ? (response as FeatureCollection)
    : undefined;
}

export function fetchMap(hass: HomeAssistant, entityId: string): Promise<FeatureCollection | undefined> {
  return fetchFeatures(hass, "get_geojson", entityId);
}

/** The mower's own planned route, once it has one; undefined otherwise. */
export function fetchPlannedRoute(
  hass: HomeAssistant,
  entityId: string,
): Promise<FeatureCollection | undefined> {
  return fetchFeatures(hass, "get_mow_path_geojson", entityId);
}

/** Asks the mower to upload the route it last planned, so `fetchPlannedRoute` can return it. */
export async function requestPlannedRoute(hass: HomeAssistant, entityId: string): Promise<void> {
  await hass.callService("mammotion", "fetch_mow_path", {}, { entity_id: entityId }, false, false);
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
