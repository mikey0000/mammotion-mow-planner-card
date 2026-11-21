import type { Feature, FeatureCollection } from "geojson";
import type { HassEntity, HomeAssistant, EntityRegistryDisplayEntry } from "../src/ha/types";

const ORIGIN = { lon: 174.7633, lat: -36.8485 };
const METERS_PER_DEGREE = 111_111;

type Xy = readonly [number, number];

const lonLat = ([x, y]: Xy): [number, number] => [
  ORIGIN.lon + x / (METERS_PER_DEGREE * Math.cos((ORIGIN.lat * Math.PI) / 180)),
  ORIGIN.lat + y / METERS_PER_DEGREE,
];

/** Each polygon's outline in metres, by name, for drawing the demo's planned routes. */
const RINGS = new Map<string, readonly Xy[]>();

const polygon = (type_name: string, hash: number, Name: string, ring: readonly Xy[]): Feature => {
  RINGS.set(Name, ring);
  return {
    type: "Feature",
    properties: { type_name, hash, Name, title: Name },
    geometry: { type: "Polygon", coordinates: [ring.map(lonLat)] },
  };
};

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

const inside = ([x, y]: Xy, ring: readonly Xy[]) =>
  ring.reduce((odd, [x1, y1], i) => {
    const [x2, y2] = ring[(i + 1) % ring.length] ?? [x1, y1];
    return y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1 ? !odd : odd;
  }, false);

/** Passes 0.6 m apart at `deg` over an area, kept to its inside, standing in for the mower's own plan. */
function plannedPasses(ring: readonly Xy[], deg: number): Xy[][] {
  const [u, n] = [deg, deg + 90].map((d) => [Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180)]);
  const [ux = 0, uy = 0] = u ?? [];
  const [nx = 0, ny = 0] = n ?? [];
  const runs: Xy[][] = [];
  for (let t = -40; t <= 40; t += 0.6) {
    let run: Xy[] = [];
    for (let s = -40; s <= 40; s += 0.5) {
      const point: Xy = [ux * s + nx * t, uy * s + ny * t];
      if (inside(point, ring)) run.push(point);
      else if (run.length) {
        runs.push([run[0] ?? point, run.at(-1) ?? point]);
        run = [];
      }
    }
  }
  return runs;
}

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
  /** `bypass_mode` options, as the integration lists them for the model and firmware. */
  readonly detection: readonly string[];
  readonly switches: Readonly<Record<string, boolean>>;
  /** Grass collector models only. */
  readonly dumpInterval?: number;
  /** Job progress in percent. */
  readonly progress: number;
  /** The `running_job` attribute; left out to stand for an integration that predates it. */
  readonly runningJob?: Readonly<Record<string, unknown>> | null;
  readonly features: Feature[];
  /** The direction the demo mower plans each area in, by area name, for Optimal mode. */
  readonly optimal?: Readonly<Record<string, number>>;
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
    detection: ["off", "standard", "sensitive"],
    switches: {},
    progress: 0,
    runningJob: null,
    features: GARDEN,
    optimal: { "Front lawn": 30, "Back lawn": 75, "Side strip": 0 },
  },
  {
    slug: "yuka_mini",
    name: "Yuka Mini",
    model: "Yuka Mini 800",
    state: "mowing",
    battery: 54,
    position: [3, 2],
    spacing: [8, 14, 10],
    angleModes: ["relative_angle", "absolute_angle", "random_angle"],
    detection: ["off", "standard", "sensitive"],
    switches: { auto_change_direction: false },
    progress: 42,
    runningJob: {
      areas: [5500000000001],
      toward: 15,
      toward_mode: 1,
      toward_included_angle: 90,
      mowing_laps: 2,
      ride_boundary_distance: 0,
      job_mode: 4,
      job_id: 1,
      job_version: 0,
      speed: 0.5,
      channel_width: 12,
      ultra_wave: 11,
      channel_mode: 0,
      blade_height: 0,
      auto_change_direction: 1,
      border_mode: 1,
      obstacle_laps: 2,
      start_progress: 10,
    },
    features: PADDOCK,
  },
  {
    slug: "yuka",
    name: "Yuka",
    model: "Yuka 1500",
    state: "paused",
    battery: 100,
    position: [-21, -14.4],
    spacing: [20, 35, 25],
    angleModes: ["relative_angle", "absolute_angle", "random_angle"],
    detection: ["off", "slow_touch", "less_touch", "standard"],
    switches: { is_mow: true, is_dump: true, is_edge: false },
    dumpInterval: 20,
    progress: 30,
    features: GARDEN,
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
    entity(`lawn_mower.${mower.slug}`, undefined, mower.state, {
      friendly_name: mower.name,
      ...(mower.runningJob !== undefined && {
        running_job: mower.runningJob,
        running_job_modifiable: mower.runningJob !== null,
      }),
    }),
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
    select("bypass_mode", "standard", mower.detection),
    number("start_progress", 0, 0, 99, 1),
    ...(mower.dumpInterval === undefined ? [] : [number("dumping_interval", mower.dumpInterval, 5, 100, 1)]),
    ...Object.entries(mower.switches).map(([key, on]) =>
      entity(`switch.${mower.slug}_${key}`, key, on ? "on" : "off", {
        friendly_name: `${mower.name} ${key}`,
      }),
    ),
    entity(`sensor.${mower.slug}_progress`, "progress", String(mower.progress), { unit_of_measurement: "%" }),
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
          // An integration that reports the running job (0.6.25) also keeps the mowing order.
          ...(mower.runningJob !== undefined && { order: index === 0 ? 1 : null }),
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

export type SavedEntity = Pick<HassEntity, "state" | "attributes">;

export interface DemoOptions {
  /** Called for every service call instead of anything reaching a mower. */
  readonly onCall: (call: ServiceCall) => void;
  readonly language?: string;
  readonly darkMode?: boolean;
  /** `empty` simulates a mower that has no map yet; `error` a failing integration. */
  readonly map?: "ready" | "empty" | "error";
  readonly singleMower?: boolean;
  /** Stands for an integration from before `mammotion.plan_route`. */
  readonly legacy?: boolean;
  /** Entities saved by earlier visits, by entity id. */
  readonly saved?: Readonly<Record<string, SavedEntity>>;
  /** Called with the new `hass` and the entities that changed, as Home Assistant pushes a new one. */
  readonly onChange?: (hass: HomeAssistant, changed: Readonly<Record<string, SavedEntity>>) => void;
  /** Makes every entity service call fail, to try a failed save. */
  readonly failWrites?: boolean;
}

/** The frontend rejects a failed call with the server's translated error object, not an `Error`. */
const serviceError = (code: string, message: string): Promise<never> =>
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- mirrors Home Assistant's websocket error
  Promise.reject({ code, message });

/** A `hass` whose services are recorded, never executed. */
export function demoHass(options: DemoOptions): HomeAssistant {
  const mowers = options.singleMower ? MOWERS.slice(0, 1) : MOWERS;
  const pairs = mowers.flatMap(mowerEntities);
  const language = options.language ?? "en";
  const ACTIVE = ["mowing", "paused", "returning"];
  let states: Record<string, HassEntity> = Object.fromEntries(
    pairs.map(([entity]) => [entity.entity_id, { ...entity, ...options.saved?.[entity.entity_id] }]),
  );
  /** Applies what an entity service would store, refusing what Home Assistant would refuse. */
  const store = (domain: string, service: string, entityId: string, data: Record<string, unknown>) => {
    const entity = states[entityId];
    if (!entity) return serviceError("service_validation_error", `${entityId} does not exist`);
    if (options.failWrites) return serviceError("home_assistant_error", "The demo refuses to save");
    const {
      options: choices,
      min,
      max,
    } = entity.attributes as { options?: string[]; min?: number; max?: number };
    let state: string;
    if (domain === "select") {
      if (!choices?.includes(String(data.option)))
        return serviceError("service_validation_error", "Invalid option");
      state = String(data.option);
    } else if (domain === "number") {
      const value = Number(data.value);
      if (value < (min ?? -Infinity) || value > (max ?? Infinity)) {
        return serviceError("service_validation_error", `Value ${value} is out of range`);
      }
      state = String(value);
    } else {
      state = service === "turn_on" ? "on" : "off";
    }
    const changed =
      "order" in entity.attributes ? reorder(entityId, state === "on") : { [entityId]: { ...entity, state } };
    states = { ...states, ...changed };
    options.onChange?.(build(), changed);
    return Promise.resolve({});
  };
  /** Like the integration: a switch turned on joins the end of the mowing order, one turned off leaves it. */
  const reorder = (entityId: string, on: boolean): Record<string, HassEntity> => {
    const prefix = entityId.replace(/\d+$/, "");
    const siblings = Object.values(states).filter((entity) => entity.entity_id.startsWith(prefix));
    const order = (entity: HassEntity) => entity.attributes.order as number | null;
    const sequence = siblings
      .filter((entity) => order(entity) !== null)
      .sort((a, b) => (order(a) ?? 0) - (order(b) ?? 0))
      .map((entity) => entity.entity_id);
    const placed = on
      ? sequence.includes(entityId)
        ? sequence
        : [...sequence, entityId]
      : sequence.filter((id) => id !== entityId);
    return Object.fromEntries(
      siblings.map((entity) => {
        const place = placed.indexOf(entity.entity_id) + 1;
        return [
          entity.entity_id,
          {
            ...entity,
            state: place ? "on" : "off",
            attributes: { ...entity.attributes, order: place || null },
          },
        ];
      }),
    );
  };
  const build = (): HomeAssistant => ({ ...base, states });
  const base: Omit<HomeAssistant, "states"> = {
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
    services: {
      mammotion: Object.fromEntries(
        ["get_geojson", "start_mow", "modify_running_job", ...(options.legacy ? [] : ["plan_route"])].map(
          (name) => [name, {}],
        ),
      ),
    },
    callService: async (domain, service, data = {}, target) => {
      options.onCall({ domain, service, data, target });
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (["select", "number", "switch"].includes(domain) && typeof target?.entity_id === "string") {
        return store(domain, service, target.entity_id, data);
      }
      const mower = mowers.find((candidate) => target?.entity_id === `lawn_mower.${candidate.slug}`);
      if (service === "plan_route" && mower) {
        if (ACTIVE.includes(mower.state)) {
          return serviceError("service_validation_error", `${mower.name} must be idle to plan a route.`);
        }
        if (!mower.optimal) {
          return serviceError("home_assistant_error", `${mower.name} did not share the route it planned.`);
        }
        // An entity service answers by entity id, even for one entity.
        const route = { ...plannedRoute(mower), plan: { path_hash: "4242", toward: 0, toward_mode: 0 } };
        return { response: { [`lawn_mower.${mower.slug}`]: route } };
      }
      if (service !== "get_geojson") return {};
      if (options.map === "error") throw new Error("Demo: the integration did not answer");
      const response: FeatureCollection | Record<string, never> =
        options.map === "empty" || !mower ? {} : { type: "FeatureCollection", features: mower.features };
      return { response };
    },
  };
  return build();
}

/** The mower's planned route: plain stripes at each area's own direction. */
function plannedRoute(mower: DemoMower): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: mower.features.flatMap((feature) => {
      const { type_name, Name } = feature.properties as { type_name: string; Name: string };
      const deg = mower.optimal?.[Name];
      const ring = RINGS.get(Name);
      if (type_name !== "area" || deg === undefined || !ring) return [];
      return plannedPasses(ring, deg).map((run) => ({
        type: "Feature" as const,
        properties: { type_name: "mow_path" },
        geometry: { type: "LineString" as const, coordinates: run.map(lonLat) },
      }));
    }),
  };
}
