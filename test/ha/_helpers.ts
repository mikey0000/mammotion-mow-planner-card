import type { DeviceRegistryEntry, HassEntity, HomeAssistant, ServiceCallResponse } from "../../src/ha/types";

export interface FakeEntity {
  readonly entity_id: string;
  /** Omit to register the entity without a state object. */
  readonly state?: string;
  readonly attributes?: Record<string, unknown>;
  readonly translation_key?: string;
  readonly device_id?: string;
  readonly platform?: string;
}

export interface ServiceCall {
  readonly domain: string;
  readonly service: string;
  readonly data: Record<string, unknown> | undefined;
  readonly target: { entity_id?: string | string[] } | undefined;
  readonly notifyOnError: boolean | undefined;
  readonly returnResponse: boolean | undefined;
}

export interface FakeHass extends HomeAssistant {
  readonly calls: ServiceCall[];
}

export function device(id: string, name: string, nameByUser: string | null = null): DeviceRegistryEntry {
  return { id, name, name_by_user: nameByUser, model: null };
}

/** `respond` decides each call's outcome: a value resolves as `{response}`, a thrown error rejects. */
export function makeHass(
  entities: readonly FakeEntity[],
  devices: readonly DeviceRegistryEntry[] = [],
  respond: (service: string) => unknown = () => undefined,
): FakeHass {
  const calls: ServiceCall[] = [];
  const states: Record<string, HassEntity> = {};
  for (const e of entities) {
    if (e.state !== undefined) {
      states[e.entity_id] = { entity_id: e.entity_id, state: e.state, attributes: e.attributes ?? {} };
    }
  }
  return {
    calls,
    states,
    entities: Object.fromEntries(
      entities.map((e) => [
        e.entity_id,
        {
          entity_id: e.entity_id,
          device_id: e.device_id,
          platform: e.platform ?? "mammotion",
          translation_key: e.translation_key,
        },
      ]),
    ),
    devices: Object.fromEntries(devices.map((d) => [d.id, d])),
    language: "en",
    callService<T>(
      domain: string,
      service: string,
      data?: Record<string, unknown>,
      target?: { entity_id?: string | string[] },
      notifyOnError?: boolean,
      returnResponse?: boolean,
    ): Promise<ServiceCallResponse<T>> {
      calls.push({ domain, service, data, target, notifyOnError, returnResponse });
      return Promise.resolve().then(() => ({ response: respond(service) as T }));
    },
  };
}

const LAPS = ["none", "one", "two", "three", "four"];

/** A Luba-style mower with every planning entity, named "Luba" on device "dev1". */
export function lubaEntities(deviceId = "dev1", slug = "luba"): FakeEntity[] {
  const on = (key: string, entity_id: string, state: string, attributes: Record<string, unknown> = {}) => ({
    entity_id,
    state,
    attributes,
    translation_key: key,
    device_id: deviceId,
  });
  return [
    on("mower", `lawn_mower.${slug}`, "docked", { friendly_name: "Luba" }),
    on("channel_mode", `select.${slug}_channel_mode`, "double_grid", {
      options: ["single_grid", "double_grid", "segment_grid", "no_grid"],
    }),
    on("cutting_angle_mode", `select.${slug}_cutting_angle_mode`, "absolute_angle", {
      options: ["relative_angle", "absolute_angle", "random_angle"],
    }),
    on("mowing_laps", `select.${slug}_mowing_laps`, "two", { options: LAPS }),
    on("obstacle_laps", `select.${slug}_obstacle_laps`, "three", { options: LAPS }),
    on("border_mode", `select.${slug}_border_mode`, "grid_first", {
      options: ["border_first", "grid_first"],
    }),
    on("cutting_angle", `number.${slug}_cutting_angle`, "30", { min: -180, max: 180, step: 1 }),
    on("toward_included_angle", `number.${slug}_toward_included_angle`, "60", {
      min: -180,
      max: 180,
      step: 1,
    }),
    on("path_spacing", `number.${slug}_path_spacing`, "28", { min: 20, max: 35, step: 1 }),
    on("working_speed", `number.${slug}_working_speed`, "0.4", { min: 0.2, max: 0.6, step: 0.1 }),
    on("blade_height", `number.${slug}_blade_height`, "55", { min: 25, max: 70, step: 1 }),
    on("ride_boundary_distance", `number.${slug}_ride_boundary_distance`, "0.5", {
      min: 0,
      max: 1,
      step: 0.1,
    }),
    on("area", `switch.${slug}_area_front`, "on", { friendly_name: "Luba Area Front", hash: 111 }),
    on("area_plain", `switch.${slug}_back_lawn`, "off", { friendly_name: "Luba Back lawn", hash: 222 }),
    on("device_tracker", `device_tracker.${slug}`, "not_home", {
      latitude: 51.5,
      longitude: -0.1,
      direction: 45,
    }),
    on("battery_percent", `sensor.${slug}_battery`, "87", { device_class: "battery" }),
  ];
}

/** Replace or drop (`null`) entities of a fixture by entity id. */
export function withChanges(
  entities: readonly FakeEntity[],
  changes: Readonly<Record<string, Partial<FakeEntity> | null>>,
): FakeEntity[] {
  return entities.flatMap((e) => {
    const change = changes[e.entity_id];
    if (change === null) return [];
    return [change ? { ...e, ...change } : e];
  });
}
