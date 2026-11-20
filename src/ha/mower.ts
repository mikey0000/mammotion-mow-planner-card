import type { FeatureCollection } from "geojson";
import {
  ANGLE_MODES,
  MOW_ORDERS,
  PATTERNS,
  type MowSettings,
  type Range,
  type SettingLimits,
} from "../model";
import type { HassEntity, HomeAssistant } from "./types";

export interface AreaSwitch {
  readonly entityId: string;
  readonly hash: number;
  readonly name: string;
  readonly on: boolean;
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
  /** The values currently held by the integration's planning entities. */
  readonly settings: MowSettings;
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

/** Folds an angle into (−90, 90]; path angles are meaningful modulo 180. */
function foldAngle(angle: number): number {
  const half = ((angle % 180) + 180) % 180;
  return half > 90 ? half - 180 : half;
}

function stateNumber(entity?: HassEntity): number | undefined {
  return entity && entity.state.trim() !== "" ? finite(Number(entity.state)) : undefined;
}

function deviceName(hass: HomeAssistant, entityId: string): string | undefined {
  const deviceId = hass.entities[entityId]?.device_id;
  const device = deviceId === undefined ? undefined : hass.devices[deviceId];
  return device?.name_by_user ?? device?.name ?? undefined;
}

function displayName(hass: HomeAssistant, entityId: string): string {
  return deviceName(hass, entityId) ?? friendlyName(hass.states[entityId]) ?? entityId;
}

function siblings(hass: HomeAssistant, entityId: string): Sibling[] {
  const deviceId = hass.entities[entityId]?.device_id;
  if (deviceId === undefined) return [];
  return Object.values(hass.entities).flatMap((entry) => {
    const state = entry.device_id === deviceId ? hass.states[entry.entity_id] : undefined;
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

function range(entity?: HassEntity): Range | undefined {
  const attributes = available(entity)?.attributes;
  const [min, max, step] = [attributes?.min, attributes?.max, attributes?.step].map(finite);
  return min === undefined || max === undefined || step === undefined ? undefined : { min, max, step };
}

function maxLaps(entity?: HassEntity): number {
  const codes = offered(entity, LAPS).map((option) => LAPS.indexOf(option));
  return codes.length > 0 ? Math.max(...codes) : LAPS.length - 1;
}

function readLimits(select: (key: string) => HassEntity | undefined, number: typeof select): SettingLimits {
  const patterns = offered(select("channel_mode"), PATTERNS);
  const angleModes = offered(select("cutting_angle_mode"), ANGLE_MODES);
  const cross = range(number("toward_included_angle")) ?? { min: 1, max: 179, step: 1 };
  const bladeHeight = range(number("blade_height"));
  const edgeDistance = range(number("ride_boundary_distance"));
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
  };
}

function readSettings(
  select: (key: string) => HassEntity | undefined,
  number: typeof select,
  limits: SettingLimits,
): MowSettings {
  const laps = (key: string, max: number): number => {
    const option = selected(select(key), LAPS);
    return Math.min(option === undefined ? 1 : LAPS.indexOf(option), max);
  };
  const value = (key: string, fallback: number, limit: Range): number =>
    clamp(stateNumber(number(key)) ?? fallback, limit);
  const { bladeHeight, edgeDistance } = limits;
  return {
    pattern: selected(select("channel_mode"), limits.patterns) ?? "single_grid",
    angleMode: selected(select("cutting_angle_mode"), limits.angleModes) ?? "relative_angle",
    angle: clamp(foldAngle(stateNumber(number("cutting_angle")) ?? 0), limits.angle),
    crossAngle: value("toward_included_angle", 90, limits.crossAngle),
    spacingCm: value("path_spacing", 25, limits.spacingCm),
    perimeterLaps: laps("mowing_laps", limits.maxPerimeterLaps),
    obstacleLaps: laps("obstacle_laps", limits.maxObstacleLaps),
    mowOrder: selected(select("border_mode"), MOW_ORDERS) ?? "border_first",
    speed: value("working_speed", 0.3, limits.speed),
    ...(bladeHeight && { bladeHeight: value("blade_height", midpoint(bladeHeight), bladeHeight) }),
    ...(edgeDistance && {
      edgeDistance: value("ride_boundary_distance", midpoint(edgeDistance), edgeDistance),
    }),
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
    .sort((a, b) => displayName(hass, a).localeCompare(displayName(hass, b)));
}

export function readMower(hass: HomeAssistant, entityId: string): Mower | undefined {
  const mower = hass.states[entityId];
  if (!mower) return undefined;
  const entities = siblings(hass, entityId);
  const find = (domain: string, key: string): HassEntity | undefined =>
    entities.find((e) => e.key === key && e.state.entity_id.startsWith(`${domain}.`))?.state;
  const select = (key: string): HassEntity | undefined => find("select", key);
  const number = (key: string): HassEntity | undefined => find("number", key);
  const limits = readLimits(select, number);
  const position = readPosition(find("device_tracker", "device_tracker"));
  const battery = stateNumber(
    entities.find(
      (e) => e.state.entity_id.startsWith("sensor.") && e.state.attributes.device_class === "battery",
    )?.state,
  );
  return {
    entityId,
    name: displayName(hass, entityId),
    state: mower.state,
    areas: readAreas(entities, deviceName(hass, entityId)),
    ...(position && { position }),
    ...(battery !== undefined && { battery }),
    limits,
    settings: readSettings(select, number, limits),
  };
}

/** `mammotion.start_mow` service data for a new job over `areaEntityIds`, in mowing order. */
export function startMowData(
  settings: MowSettings,
  areaEntityIds: readonly string[],
  planOnly = false,
): Record<string, unknown> {
  return {
    areas: [...areaEntityIds],
    channel_mode: OPTIONS.channel_mode.indexOf(settings.pattern),
    toward_mode: OPTIONS.cutting_angle_mode.indexOf(settings.angleMode),
    toward: Math.round(settings.angle),
    toward_included_angle: Math.round(settings.crossAngle),
    channel_width: Math.round(settings.spacingCm),
    mowing_laps: settings.perimeterLaps,
    obstacle_laps: settings.obstacleLaps,
    border_mode: OPTIONS.border_mode.indexOf(settings.mowOrder),
    speed: Math.round(settings.speed * 10) / 10,
    ...(settings.bladeHeight !== undefined && { blade_height: Math.round(settings.bladeHeight) }),
    ...(settings.edgeDistance !== undefined && { ride_boundary_distance: settings.edgeDistance }),
    ...(planOnly && { plan_only: true }),
  };
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

export async function startMow(
  hass: HomeAssistant,
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await hass.callService("mammotion", "start_mow", data, { entity_id: entityId }, true, false);
}
