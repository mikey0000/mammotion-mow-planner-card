import type { Feature, FeatureCollection } from "geojson";
import type { HassEntity, HomeAssistant, EntityRegistryDisplayEntry } from "../src/ha/types";

const ORIGIN = { lon: 174.7633, lat: -36.8485 };
const METERS_PER_DEGREE = 111_111;

type Xy = readonly [number, number];

const lonLat = ([x, y]: Xy): [number, number] => [
  ORIGIN.lon + x / (METERS_PER_DEGREE * Math.cos((ORIGIN.lat * Math.PI) / 180)),
  ORIGIN.lat + y / METERS_PER_DEGREE,
];

const polygon = (type_name: string, hash: number, Name: string, ring: readonly Xy[]): Feature => ({
  type: "Feature",
  properties: { type_name, hash, Name, title: Name },
  geometry: { type: "Polygon", coordinates: [ring.map(lonLat)] },
});

const circle = (cx: number, cy: number, r: number, n = 16): Xy[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });

const GARDEN: Feature[] = [
  polygon("area", 7218463521001, "Front lawn", [
    [-22, -14],
    [4, -14],
    [4, -4],
    [-8, -4],
    [-8, 6],
    [-22, 6],
  ]),
  polygon("area", 7218463521002, "Back lawn", [
    [8, -2],
    [30, -6],
    [34, 12],
    [22, 18],
    [10, 14],
  ]),
  polygon("area", 7218463521003, "Side strip", [
    [-20, 10],
    [4, 10],
    [4, 15],
    [-20, 15],
  ]),
  polygon("obstacle", 9100000000001, "Flower bed", circle(-15, -6, 2.4)),
  polygon("obstacle", 9100000000002, "Pond", [
    [18, 4],
    [24, 3],
    [25, 8],
    [20, 9],
  ]),
  {
    type: "Feature",
    properties: { type_name: "path" },
    geometry: {
      type: "LineString",
      coordinates: (
        [
          [3, -8],
          [6, -6],
          [9, 0],
        ] as const
      ).map(lonLat),
    },
  },
  {
    type: "Feature",
    properties: { type_name: "path" },
    geometry: {
      type: "LineString",
      coordinates: (
        [
          [-10, 5],
          [-10, 11],
        ] as const
      ).map(lonLat),
    },
  },
  {
    type: "Feature",
    properties: { type_name: "station", Name: "Dock", rotation: 90 },
    geometry: { type: "Point", coordinates: lonLat([-21, -15]) },
  },
  {
    type: "Feature",
    properties: { type_name: "station", Name: "RTK Base" },
    geometry: { type: "Point", coordinates: lonLat([-24, 8]) },
  },
];

const PADDOCK: Feature[] = [
  polygon("area", 5500000000001, "Orchard", [
    [-12, -9],
    [14, -11],
    [16, 8],
    [-10, 10],
  ]),
  polygon("obstacle", 5500000000101, "Apple tree", circle(-2, 0, 1.6)),
  polygon("obstacle", 5500000000102, "Plum tree", circle(8, -3, 1.4)),
  {
    type: "Feature",
    properties: { type_name: "station", Name: "Dock", rotation: 0 },
    geometry: { type: "Point", coordinates: lonLat([-11, -10]) },
  },
];

interface DemoMower {
  readonly slug: string;
  readonly name: string;
  readonly model: string;
  readonly state: string;
  readonly battery: number;
  readonly position: Xy;
  readonly spacing: readonly [min: number, max: number, value: number];
  readonly bladeHeight?: readonly [number, number, number];
  readonly angleModes: readonly string[];
  readonly features: Feature[];
}

const MOWERS: readonly DemoMower[] = [
  {
    slug: "luba_2",
    name: "Luba 2",
    model: "Luba 2 AWD 5000",
    state: "docked",
    battery: 86,
    position: [-21, -14.4],
    spacing: [20, 35, 25],
    bladeHeight: [25, 70, 45],
    angleModes: ["relative_angle", "absolute_angle", "random_angle"],
    features: GARDEN,
  },
  {
    slug: "yuka_mini",
    name: "Yuka Mini",
    model: "Yuka Mini 800",
    state: "mowing",
    battery: 54,
    position: [3, 2],
    spacing: [8, 14, 10],
    angleModes: ["relative_angle", "absolute_angle"],
    features: PADDOCK,
  },
];

const LAPS = ["none", "one", "two", "three", "four"];

function mowerEntities(mower: DemoMower): [HassEntity, EntityRegistryDisplayEntry][] {
  const device_id = `device_${mower.slug}`;
  const entity = (
    entity_id: string,
    translation_key: string | undefined,
    state: string,
    attributes: Record<string, unknown>,
  ): [HassEntity, EntityRegistryDisplayEntry] => [
    { entity_id, state, attributes },
    { entity_id, device_id, platform: "mammotion", translation_key },
  ];
  const select = (key: string, state: string, options: readonly string[]) =>
    entity(`select.${mower.slug}_${key}`, key, state, { options, friendly_name: `${mower.name} ${key}` });
  const number = (key: string, value: number, min: number, max: number, step: number) =>
    entity(`number.${mower.slug}_${key}`, key, String(value), {
      min,
      max,
      step,
      friendly_name: `${mower.name} ${key}`,
    });
  const [lon, lat] = lonLat(mower.position);
  return [
    entity(`lawn_mower.${mower.slug}`, undefined, mower.state, { friendly_name: mower.name }),
    entity(`device_tracker.${mower.slug}`, "device_tracker", "home", {
      latitude: lat,
      longitude: lon,
      direction: 40,
    }),
    entity(`sensor.${mower.slug}_battery`, "battery", String(mower.battery), {
      device_class: "battery",
      unit_of_measurement: "%",
    }),
    select("channel_mode", "single_grid", ["single_grid", "double_grid", "segment_grid", "no_grid"]),
    select("cutting_angle_mode", "relative_angle", mower.angleModes),
    select("mowing_laps", "one", LAPS),
    select("obstacle_laps", "one", LAPS),
    select("border_mode", "border_first", ["border_first", "grid_first"]),
    number("cutting_angle", 0, -180, 180, 1),
    number("toward_included_angle", 90, -180, 180, 1),
    number("path_spacing", mower.spacing[2], mower.spacing[0], mower.spacing[1], 1),
    number("working_speed", 0.4, 0.2, 0.6, 0.1),
    ...(mower.bladeHeight
      ? [number("blade_height", mower.bladeHeight[2], mower.bladeHeight[0], mower.bladeHeight[1], 5)]
      : []),
    ...(mower.bladeHeight ? [number("ride_boundary_distance", 0.5, 0, 1, 0.1)] : []),
    ...mower.features
      .filter((feature) => feature.properties?.type_name === "area")
      .map((feature, index) => {
        const { hash, Name } = feature.properties as { hash: number; Name: string };
        return entity(`switch.${mower.slug}_area_${index + 1}`, "area_plain", index === 0 ? "on" : "off", {
          hash,
          friendly_name: `${mower.name} ${Name}`,
        });
      }),
  ];
}

export interface ServiceCall {
  readonly domain: string;
  readonly service: string;
  readonly data: Record<string, unknown>;
  readonly target?: { entity_id?: string | string[] };
}

export interface DemoOptions {
  /** Called for every service call instead of anything reaching a mower. */
  readonly onCall: (call: ServiceCall) => void;
  readonly language?: string;
  readonly darkMode?: boolean;
  /** `empty` simulates a mower that has no map yet; `error` a failing integration. */
  readonly map?: "ready" | "empty" | "error";
  readonly singleMower?: boolean;
}

/** A `hass` whose services are recorded, never executed. */
export function demoHass(options: DemoOptions): HomeAssistant {
  const mowers = options.singleMower ? MOWERS.slice(0, 1) : MOWERS;
  const pairs = mowers.flatMap(mowerEntities);
  const language = options.language ?? "en";
  return {
    states: Object.fromEntries(pairs.map(([state]) => [state.entity_id, state])),
    entities: Object.fromEntries(pairs.map(([, entry]) => [entry.entity_id, entry])),
    devices: Object.fromEntries(
      mowers.map((mower) => [
        `device_${mower.slug}`,
        { id: `device_${mower.slug}`, name: mower.name, name_by_user: null, model: mower.model },
      ]),
    ),
    language,
    locale: { language },
    themes: { darkMode: options.darkMode ?? false },
    translationMetadata: { translations: { he: { isRTL: true }, ar: { isRTL: true } } },
    callService: (async (domain, service, data = {}, target) => {
      options.onCall({ domain, service, data, target });
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (service !== "get_geojson") return {};
      if (options.map === "error") throw new Error("Demo: the integration did not answer");
      const mower = mowers.find((candidate) => target?.entity_id === `lawn_mower.${candidate.slug}`);
      const response: FeatureCollection | Record<string, never> =
        options.map === "empty" || !mower ? {} : { type: "FeatureCollection", features: mower.features };
      return { response };
    }) as HomeAssistant["callService"],
  };
}
