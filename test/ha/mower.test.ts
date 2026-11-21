import { describe, expect, it } from "vitest";
import type { FeatureCollection } from "geojson";
import {
  fetchMap,
  canPlanRoute,
  findMowers,
  modifyJobData,
  modifyRunningJob,
  mowerName,
  planRoute,
  readMower,
  startMow,
  startMowData,
} from "../../src/ha/mower";
import type { MowSettings } from "../../src/model";
import { device, lubaEntities, makeHass, serviceError, withChanges } from "./_helpers";

const LUBA = device("dev1", "Luba");
const UNAVAILABLE = { state: "unavailable", attributes: {} };

const PLANNING_IDS = [
  "select.luba_channel_mode",
  "select.luba_cutting_angle_mode",
  "select.luba_mowing_laps",
  "select.luba_obstacle_laps",
  "select.luba_border_mode",
  "number.luba_cutting_angle",
  "number.luba_toward_included_angle",
  "number.luba_path_spacing",
  "number.luba_working_speed",
  "number.luba_blade_height",
  "number.luba_ride_boundary_distance",
  "select.luba_bypass_mode",
  "number.luba_start_progress",
  "number.luba_dumping_interval",
  "switch.luba_auto_change_direction",
  "switch.luba_is_mow",
  "switch.luba_is_dump",
  "switch.luba_is_edge",
];

function readLuba(changes: Parameters<typeof withChanges>[1] = {}) {
  return readMower(makeHass(withChanges(lubaEntities(), changes), [LUBA]), "lawn_mower.luba");
}

const FALLBACK_LIMITS = {
  patterns: ["single_grid", "double_grid", "segment_grid", "no_grid"],
  angleModes: ["relative_angle", "absolute_angle"],
  angle: { min: -90, max: 90, step: 1 },
  crossAngle: { min: 1, max: 179, step: 1 },
  spacingCm: { min: 20, max: 35, step: 1 },
  maxPerimeterLaps: 4,
  maxObstacleLaps: 4,
  speed: { min: 0.2, max: 0.6, step: 0.1 },
};

const ALL_HELD = [
  "pattern",
  "angleMode",
  "angle",
  "crossAngle",
  "spacingCm",
  "perimeterLaps",
  "obstacleLaps",
  "mowOrder",
  "speed",
  "bladeHeight",
  "edgeDistance",
  "obstacleDetection",
  "startProgress",
  "dumpInterval",
  "autoChangeDirection",
  "cutGrass",
  "dumpGrass",
  "cutEdges",
];

const SWITCHES = ["autoChangeDirection", "cutGrass", "dumpGrass", "cutEdges"];

const NEW_DETECTION = [
  { key: "off", code: 1 },
  { key: "standard", code: 10 },
  { key: "sensitive", code: 11 },
];

const FALLBACK_SETTINGS = {
  pattern: "single_grid",
  angleMode: "relative_angle",
  angle: 0,
  crossAngle: 90,
  spacingCm: 25,
  perimeterLaps: 1,
  obstacleLaps: 1,
  mowOrder: "border_first",
  speed: 0.3,
};

describe("findMowers", () => {
  it("lists only Mammotion lawn mowers that have a state, sorted by display name", () => {
    const hass = makeHass(
      [
        { entity_id: "lawn_mower.zed", state: "docked", device_id: "d1" },
        { entity_id: "lawn_mower.alpha", state: "mowing", device_id: "d2" },
        { entity_id: "lawn_mower.husq", state: "docked", platform: "husqvarna_automower" },
        { entity_id: "lawn_mower.gone", device_id: "d3" },
        { entity_id: "switch.zed_area", state: "on", device_id: "d1" },
      ],
      [device("d1", "Aardvark"), device("d2", "Zebra"), device("d3", "Gone")],
    );

    expect(findMowers(hass)).toEqual(["lawn_mower.zed", "lawn_mower.alpha"]);
  });
});

describe("readMower", () => {
  it("returns undefined for an entity without state", () => {
    expect(readMower(makeHass([], [LUBA]), "lawn_mower.luba")).toBeUndefined();
  });

  it("reads every planning entity, area, position and battery of the mower", () => {
    expect(readLuba()).toEqual({
      entityId: "lawn_mower.luba",
      name: "Luba",
      state: "docked",
      areas: [
        { entityId: "switch.luba_area_front", hash: 111, name: "Area Front", on: true },
        { entityId: "switch.luba_back_lawn", hash: 222, name: "Back lawn", on: false },
      ],
      position: { lon: -0.1, lat: 51.5, headingDeg: 45 },
      battery: 87,
      limits: {
        patterns: ["single_grid", "double_grid", "segment_grid", "no_grid"],
        angleModes: ["relative_angle", "absolute_angle", "random_angle"],
        angle: { min: -90, max: 90, step: 1 },
        crossAngle: { min: 1, max: 179, step: 1 },
        spacingCm: { min: 20, max: 35, step: 1 },
        maxPerimeterLaps: 4,
        maxObstacleLaps: 4,
        speed: { min: 0.2, max: 0.6, step: 0.1 },
        bladeHeight: { min: 25, max: 70, step: 1 },
        edgeDistance: { min: 0, max: 1, step: 0.1 },
        obstacleDetection: NEW_DETECTION,
        startProgress: { min: 0, max: 99, step: 1 },
        dumpInterval: { min: 5, max: 100, step: 1 },
        switches: SWITCHES,
      },
      settings: {
        pattern: "double_grid",
        angleMode: "absolute_angle",
        angle: 30,
        crossAngle: 60,
        spacingCm: 28,
        perimeterLaps: 2,
        obstacleLaps: 3,
        mowOrder: "grid_first",
        speed: 0.4,
        bladeHeight: 55,
        edgeDistance: 0.5,
        obstacleDetection: 10,
        startProgress: 0,
        dumpInterval: 20,
        autoChangeDirection: true,
        cutGrass: true,
        dumpGrass: false,
        cutEdges: true,
      },
      heldSettings: ALL_HELD,
    });
  });

  it("ignores entities of other devices", () => {
    const hass = makeHass(
      [...lubaEntities(), ...lubaEntities("dev2", "yuka")],
      [LUBA, device("dev2", "Yuka")],
    );

    expect(readMower(hass, "lawn_mower.luba")?.areas.map((a) => a.entityId)).toEqual([
      "switch.luba_area_front",
      "switch.luba_back_lawn",
    ]);
  });

  it("prefers the user's device name and strips it from area names", () => {
    const hass = makeHass(
      withChanges(lubaEntities(), {
        "switch.luba_area_front": { attributes: { friendly_name: "Garden bot Area Front", hash: 111 } },
        "switch.luba_back_lawn": { attributes: { friendly_name: "Back lawn", hash: 222 } },
      }),
      [device("dev1", "Luba", "Garden bot")],
    );

    const mower = readMower(hass, "lawn_mower.luba");

    expect(mower?.name).toBe("Garden bot");
    expect(mower?.areas.map((a) => a.name)).toEqual(["Area Front", "Back lawn"]);
  });

  it("falls back to the friendly name, then the entity id, without a device", () => {
    const named = makeHass([
      { entity_id: "lawn_mower.x", state: "idle", attributes: { friendly_name: "X" } },
    ]);
    const bare = makeHass([{ entity_id: "lawn_mower.x", state: "idle" }]);

    expect(readMower(named, "lawn_mower.x")?.name).toBe("X");
    expect(readMower(bare, "lawn_mower.x")?.name).toBe("lawn_mower.x");
  });

  it("skips area switches without a numeric hash and other switches", () => {
    const mower = readLuba({
      "switch.luba_back_lawn": { attributes: { friendly_name: "Luba Back lawn", hash: "222" } },
    });

    expect(mower?.areas.map((a) => a.hash)).toEqual([111]);
  });

  it("works with only the lawn_mower entity", () => {
    const hass = makeHass([{ entity_id: "lawn_mower.luba", state: "idle", device_id: "dev1" }], [LUBA]);

    expect(readMower(hass, "lawn_mower.luba")).toEqual({
      entityId: "lawn_mower.luba",
      name: "Luba",
      state: "idle",
      areas: [],
      limits: FALLBACK_LIMITS,
      settings: FALLBACK_SETTINGS,
      heldSettings: [],
    });
  });

  it("uses fallbacks for unavailable planning entities", () => {
    const mower = readLuba(Object.fromEntries(PLANNING_IDS.map((id) => [id, UNAVAILABLE])));

    expect(mower?.limits).toEqual(FALLBACK_LIMITS);
    expect(mower?.settings).toEqual(FALLBACK_SETTINGS);
    expect(mower?.heldSettings).toEqual([]);
  });

  it("uses fallback values but live limits for unknown states", () => {
    const mower = readLuba(Object.fromEntries(PLANNING_IDS.map((id) => [id, { state: "unknown" }])));

    expect(mower?.limits.angleModes).toContain("random_angle");
    expect(mower?.limits.switches).toEqual(SWITCHES);
    expect(mower?.settings).toEqual({
      ...FALLBACK_SETTINGS,
      bladeHeight: 48,
      edgeDistance: 0.5,
      obstacleDetection: 1,
      startProgress: 0,
      dumpInterval: 10,
      autoChangeDirection: false,
      cutGrass: true,
      dumpGrass: true,
      cutEdges: false,
    });
    expect(mower?.heldSettings).toEqual([]);
  });

  it("holds only the settings whose entity has a value", () => {
    const mower = readLuba({
      "number.luba_blade_height": { state: "unknown" },
      "select.luba_border_mode": { state: "unavailable" },
      "number.luba_path_spacing": null,
      "switch.luba_is_edge": { state: "unknown" },
    });

    expect(mower?.heldSettings).toEqual(
      ALL_HELD.filter((name) => !["bladeHeight", "mowOrder", "spacingCm", "cutEdges"].includes(name)),
    );
    expect(mower?.settings).toMatchObject({
      bladeHeight: 48,
      mowOrder: "border_first",
      spacingCm: 25,
      cutEdges: false,
    });
  });

  it("reads Yuka-style limits and clamps the held spacing into them", () => {
    const mower = readLuba({
      "select.luba_cutting_angle_mode": {
        state: "relative_angle",
        attributes: { options: ["relative_angle", "absolute_angle"] },
      },
      "select.luba_channel_mode": {
        state: "single_grid",
        attributes: { options: ["single_grid", "double_grid", "zigzag_future"] },
      },
      "select.luba_mowing_laps": { state: "one", attributes: { options: ["none", "one", "two"] } },
      "number.luba_path_spacing": { state: "20", attributes: { min: 8, max: 14, step: 1 } },
      "number.luba_blade_height": null,
      "number.luba_ride_boundary_distance": null,
    });

    expect(mower?.limits).toMatchObject({
      patterns: ["single_grid", "double_grid"],
      angleModes: ["relative_angle", "absolute_angle"],
      spacingCm: { min: 8, max: 14, step: 1 },
      maxPerimeterLaps: 2,
    });
    expect(mower?.limits.bladeHeight).toBeUndefined();
    expect(mower?.settings.spacingCm).toBe(14);
    expect(mower?.settings).not.toHaveProperty("bladeHeight");
    expect(mower?.settings).not.toHaveProperty("edgeDistance");
  });

  it("clamps values and limits into the useful range", () => {
    const mower = readLuba({
      "number.luba_toward_included_angle": { state: "-30" },
      "number.luba_working_speed": { state: "0.9" },
      "select.luba_obstacle_laps": { state: "four", attributes: { options: ["none", "one"] } },
    });

    expect(mower?.limits.crossAngle).toEqual({ min: 1, max: 179, step: 1 });
    expect(mower?.settings).toMatchObject({ crossAngle: 150, speed: 0.6, obstacleLaps: 1 });
  });

  it.each([
    [-90, 90],
    [-30, 150],
    [270, 90],
    [0, 1],
    [180, 1],
    [-180, 1],
    [179, 179],
  ])("folds a stored crossing angle of %d modulo 180 into %d", (stored, folded) => {
    const mower = readLuba({ "number.luba_toward_included_angle": { state: String(stored) } });

    expect(mower?.settings.crossAngle).toBe(folded);
  });

  it.each([
    [135, -45],
    [-180, 0],
    [180, 0],
    [90, 90],
    [-90, 90],
    [-100, 80],
    [270, 90],
  ])("folds a stored angle of %d into %d", (stored, folded) => {
    expect(readLuba({ "number.luba_cutting_angle": { state: String(stored) } })?.settings.angle).toBe(folded);
  });

  it("omits position and battery when absent or not numeric", () => {
    const mower = readLuba({
      "device_tracker.luba": { attributes: { latitude: null, longitude: null } },
      "sensor.luba_battery": { state: "unavailable" },
    });

    expect(mower).not.toHaveProperty("position");
    expect(mower).not.toHaveProperty("battery");
  });

  it("omits the heading when the tracker has no direction", () => {
    const mower = readLuba({ "device_tracker.luba": { attributes: { latitude: 1, longitude: 2 } } });

    expect(mower?.position).toEqual({ lon: 2, lat: 1 });
  });
});

describe("readMower obstacle detection", () => {
  const detection = (options: readonly string[], state: string) =>
    readLuba({ "select.luba_bypass_mode": { state, attributes: { options } } });

  it.each([
    [["off", "slow_touch", "less_touch"], "off", 0],
    [["off", "slow_touch", "less_touch"], "less_touch", 2],
    [["off", "slow_touch", "less_touch", "standard"], "off", 0],
    [["off", "slow_touch", "less_touch", "standard"], "standard", 10],
    [["off", "standard", "sensitive"], "off", 1],
    [["off", "standard", "sensitive"], "sensitive", 11],
  ])("reads %j at %s as ultra_wave %d", (options, state, code) => {
    const mower = detection(options, state);

    expect(mower?.limits.obstacleDetection?.map((option) => option.key)).toEqual(options);
    expect(mower?.settings.obstacleDetection).toBe(code);
    expect(mower?.heldSettings).toContain("obstacleDetection");
  });

  it.each([
    [["off", "standard"]],
    [["off", "standard", "sensitive", "proactive"]],
    [["standard", "off", "sensitive"]],
  ])("offers no detection choice for the unknown list %j, whose codes cannot be told", (options) => {
    const mower = detection(options, "off");

    expect(mower?.limits).not.toHaveProperty("obstacleDetection");
    expect(mower?.settings).not.toHaveProperty("obstacleDetection");
    expect(mower?.heldSettings).not.toContain("obstacleDetection");
  });
});

describe("readMower switches", () => {
  it("offers only the switches the mower has", () => {
    const mower = readLuba({
      "switch.luba_is_mow": null,
      "switch.luba_is_dump": null,
      "switch.luba_is_edge": null,
    });

    expect(mower?.limits.switches).toEqual(["autoChangeDirection"]);
    expect(mower?.settings).not.toHaveProperty("cutGrass");
  });

  it("leaves the switches out without any", () => {
    const mower = readLuba({
      "switch.luba_auto_change_direction": null,
      "switch.luba_is_mow": null,
      "switch.luba_is_dump": { state: "unavailable" },
      "switch.luba_is_edge": null,
      "number.luba_dumping_interval": null,
    });

    expect(mower?.limits).not.toHaveProperty("switches");
    expect(mower?.limits).not.toHaveProperty("dumpInterval");
  });
});

describe("readMower running job without the integration's running-job attributes", () => {
  const CHANGEABLE = [
    "pattern",
    "spacingCm",
    "obstacleLaps",
    "speed",
    "bladeHeight",
    "obstacleDetection",
    "startProgress",
  ];

  it.each(["mowing", "paused", "returning"])(
    "lists what can change on a %s job, less auto-reverse",
    (state) => {
      expect(readLuba({ "lawn_mower.luba": { state } })?.runningJob).toEqual({ changeable: CHANGEABLE });
    },
  );

  it.each(["docked", "idle", "error", "unavailable"])("has no running job while %s", (state) => {
    expect(readLuba({ "lawn_mower.luba": { state } })).not.toHaveProperty("runningJob");
  });

  it("has no running job once the job reports 100 %, such as on the way home", () => {
    const mower = readLuba({
      "lawn_mower.luba": { state: "returning" },
      "sensor.luba_progress": { state: "100" },
    });

    expect(mower).not.toHaveProperty("runningJob");
  });

  it("counts an active job as running without a progress sensor", () => {
    const mower = readLuba({ "lawn_mower.luba": { state: "mowing" }, "sensor.luba_progress": null });

    expect(mower?.runningJob?.changeable).toEqual(CHANGEABLE);
  });

  it("allows no change on a mower without random angle, the original Luba", () => {
    const mower = readLuba({
      "lawn_mower.luba": { state: "mowing" },
      "select.luba_cutting_angle_mode": {
        state: "relative_angle",
        attributes: { options: ["relative_angle", "absolute_angle"] },
      },
    });

    expect(mower?.runningJob).toEqual({ changeable: [] });
  });

  it("allows no change when the angle mode cannot be read", () => {
    const mower = readLuba({
      "lawn_mower.luba": { state: "mowing" },
      "select.luba_cutting_angle_mode": null,
    });

    expect(mower?.runningJob).toEqual({ changeable: [] });
  });
});

describe("readMower running job from the integration's attributes", () => {
  const JOB = {
    areas: [222, 111, 999],
    toward: 135,
    toward_mode: 2,
    toward_included_angle: 45,
    mowing_laps: 1,
    ride_boundary_distance: 0,
    job_mode: 4,
    job_id: 7,
    job_version: 1,
    speed: 0.3,
    channel_width: 22,
    ultra_wave: 11,
    channel_mode: 3,
    blade_height: 40,
    auto_change_direction: 0,
    border_mode: 0,
    obstacle_laps: 0,
    start_progress: 35,
  };

  const reported = (state: string, running_job: unknown, running_job_modifiable: boolean) =>
    readLuba({
      "lawn_mower.luba": {
        state,
        attributes: { friendly_name: "Luba", running_job, running_job_modifiable },
      },
    });

  it("lets every job setting change, auto-reverse included, and reports the job's areas", () => {
    expect(reported("mowing", JOB, true)?.runningJob).toEqual({
      changeable: [
        "pattern",
        "spacingCm",
        "obstacleLaps",
        "speed",
        "bladeHeight",
        "obstacleDetection",
        "startProgress",
        "autoChangeDirection",
      ],
      areas: [222, 111, 999],
    });
  });

  it("shows the running job's own values instead of the planning entities'", () => {
    const mower = reported("mowing", JOB, true);

    expect(mower?.settings).toEqual({
      pattern: "no_grid",
      angleMode: "random_angle",
      angle: -45,
      crossAngle: 45,
      spacingCm: 22,
      perimeterLaps: 1,
      obstacleLaps: 0,
      mowOrder: "border_first",
      speed: 0.3,
      bladeHeight: 40,
      edgeDistance: 0,
      obstacleDetection: 11,
      startProgress: 35,
      autoChangeDirection: false,
      cutGrass: true,
      dumpGrass: false,
      cutEdges: true,
      dumpInterval: 20,
    });
  });

  it("keeps the planning value for a field the job leaves out, leaves unset or the mower does not offer", () => {
    const mower = reported(
      "mowing",
      {
        areas: [111],
        speed: 0,
        channel_width: 0,
        blade_height: 0,
        ultra_wave: 2,
        channel_mode: 9,
        toward_mode: 2.5,
      },
      true,
    );

    expect(mower?.settings).toMatchObject({
      pattern: "double_grid",
      angleMode: "absolute_angle",
      speed: 0.4,
      spacingCm: 28,
      bladeHeight: 55,
      obstacleDetection: 10,
      autoChangeDirection: true,
      startProgress: 0,
    });
  });

  it("locks everything on a running job the integration cannot change", () => {
    expect(reported("mowing", JOB, false)?.runningJob?.changeable).toEqual([]);
  });

  it("trusts the integration over the state and the angle modes", () => {
    expect(reported("mowing", null, false)).not.toHaveProperty("runningJob");
    expect(reported("mowing", null, false)?.settings.speed).toBe(0.4);
    expect(reported("docked", JOB, true)?.runningJob?.changeable).toContain("speed");
  });

  it("reports no areas when the job lists none", () => {
    expect(reported("mowing", { ...JOB, areas: undefined }, true)?.runningJob).not.toHaveProperty("areas");
  });
});

describe("mowerName", () => {
  it("prefers the user's device name, then the device name, the friendly name and the entity id", () => {
    const entities = [
      { entity_id: "lawn_mower.a", state: "idle", device_id: "d1", attributes: { friendly_name: "A" } },
      { entity_id: "lawn_mower.b", state: "idle", device_id: "d2", attributes: { friendly_name: "B" } },
      { entity_id: "lawn_mower.c", state: "idle", attributes: { friendly_name: "C" } },
      { entity_id: "lawn_mower.d", state: "idle" },
    ];
    const hass = makeHass(entities, [device("d1", "Luba", "Garden bot"), device("d2", "Yuka")]);

    expect(["a", "b", "c", "d", "missing"].map((id) => mowerName(hass, `lawn_mower.${id}`))).toEqual([
      "Garden bot",
      "Yuka",
      "C",
      "lawn_mower.d",
      "lawn_mower.missing",
    ]);
  });
});

describe("readMower across hass updates", () => {
  it("reads fresh states from a new hass that shares the entity registry", () => {
    const hass = makeHass(lubaEntities(), [LUBA]);
    expect(readMower(hass, "lawn_mower.luba")?.settings.spacingCm).toBe(28);
    const spacing = hass.states["number.luba_path_spacing"];
    if (!spacing) throw new Error("no spacing entity");

    const next = {
      ...hass,
      states: { ...hass.states, "number.luba_path_spacing": { ...spacing, state: "31" } },
    };

    expect(next.entities).toBe(hass.entities);
    expect(readMower(next, "lawn_mower.luba")?.settings.spacingCm).toBe(31);
  });

  it("picks up entities added in a new entity registry", () => {
    const hass = makeHass(withChanges(lubaEntities(), { "switch.luba_back_lawn": null }), [LUBA]);
    expect(readMower(hass, "lawn_mower.luba")?.areas.map((a) => a.hash)).toEqual([111]);

    const added = makeHass(lubaEntities(), [LUBA]);

    expect(
      readMower({ ...hass, states: added.states, entities: added.entities }, "lawn_mower.luba")?.areas.map(
        (a) => a.hash,
      ),
    ).toEqual([111, 222]);
  });
});

describe("startMowData", () => {
  const settings: MowSettings = {
    pattern: "single_grid",
    angleMode: "relative_angle",
    angle: -45.4,
    crossAngle: 90,
    spacingCm: 25,
    perimeterLaps: 1,
    obstacleLaps: 0,
    mowOrder: "border_first",
    speed: 0.30000000000000004,
  };
  const areas = ["switch.luba_area_front", "switch.luba_back_lawn"];
  const all = [
    "pattern",
    "angleMode",
    "angle",
    "crossAngle",
    "spacingCm",
    "perimeterLaps",
    "obstacleLaps",
    "mowOrder",
    "speed",
    "bladeHeight",
    "edgeDistance",
  ] as const;

  it("sends only the areas when no setting is named", () => {
    expect(startMowData(settings, [], areas)).toEqual({ areas });
  });

  it("sends only the named settings", () => {
    expect(startMowData({ ...settings, bladeHeight: 48 }, ["spacingCm", "speed"], areas)).toEqual({
      areas,
      channel_width: 25,
      speed: 0.3,
    });
  });

  it("encodes every named setting", () => {
    expect(startMowData(settings, all, areas)).toEqual({
      areas,
      channel_mode: 0,
      toward_mode: 0,
      toward: -45,
      toward_included_angle: 90,
      channel_width: 25,
      mowing_laps: 1,
      obstacle_laps: 0,
      border_mode: 0,
      speed: 0.3,
    });
  });

  it.each([
    ["single_grid", 0],
    ["double_grid", 1],
    ["segment_grid", 2],
    ["no_grid", 3],
  ] as const)("encodes pattern %s as %d", (pattern, code) => {
    expect(startMowData({ ...settings, pattern }, ["pattern"], areas).channel_mode).toBe(code);
  });

  it.each([
    ["relative_angle", 0],
    ["absolute_angle", 1],
    ["random_angle", 2],
  ] as const)("encodes angle mode %s as %d", (angleMode, code) => {
    expect(startMowData({ ...settings, angleMode }, ["angleMode"], areas).toward_mode).toBe(code);
  });

  it("rounds blade height and spacing", () => {
    const data = startMowData(
      { ...settings, mowOrder: "grid_first", bladeHeight: 55.4, edgeDistance: 0.5, spacingCm: 12.6 },
      all,
      areas,
    );

    expect(data).toMatchObject({
      border_mode: 1,
      blade_height: 55,
      ride_boundary_distance: 0.5,
      channel_width: 13,
    });
    expect(data).not.toHaveProperty("plan_only");
  });

  it("leaves out a named optional setting the mower does not have", () => {
    const data = startMowData(settings, ["bladeHeight", "edgeDistance"], areas);

    expect(data).toEqual({ areas });
  });

  it("encodes detection, start progress, the switches and the dumping interval", () => {
    const data = startMowData(
      {
        ...settings,
        obstacleDetection: 11,
        startProgress: 24.6,
        autoChangeDirection: true,
        cutGrass: false,
        dumpGrass: true,
        cutEdges: false,
        dumpInterval: 30.2,
      },
      [
        "obstacleDetection",
        "startProgress",
        "autoChangeDirection",
        "cutGrass",
        "dumpGrass",
        "cutEdges",
        "dumpInterval",
      ],
      areas,
    );

    expect(data).toEqual({
      areas,
      ultra_wave: 11,
      start_progress: 25,
      auto_change_direction: 1,
      is_mow: false,
      is_dump: true,
      is_edge: false,
      collect_grass_frequency: 30,
    });
  });

  it("strips float noise from speed and edge coverage without coarsening a finer step", () => {
    const data = startMowData(
      { ...settings, speed: 0.25, edgeDistance: 0.30000000000000004 },
      ["speed", "edgeDistance"],
      areas,
    );

    expect(data).toEqual({ areas, speed: 0.25, ride_boundary_distance: 0.3 });
  });

  it("sends auto-reverse off as 0", () => {
    expect(startMowData({ ...settings, autoChangeDirection: false }, ["autoChangeDirection"], areas)).toEqual(
      {
        areas,
        auto_change_direction: 0,
      },
    );
  });

  it("copies the area list in mowing order", () => {
    const order = ["switch.b", "switch.a"];
    const data = startMowData(settings, [], order);
    order.push("switch.c");

    expect(data.areas).toEqual(["switch.b", "switch.a"]);
  });
});

describe("modifyJobData", () => {
  it("sends only the named settings, without areas", () => {
    const settings: MowSettings = {
      pattern: "double_grid",
      angleMode: "relative_angle",
      angle: 10,
      crossAngle: 90,
      spacingCm: 25,
      perimeterLaps: 1,
      obstacleLaps: 2,
      mowOrder: "border_first",
      speed: 0.5,
      bladeHeight: 40,
      obstacleDetection: 10,
    };

    expect(modifyJobData(settings, ["speed", "bladeHeight", "obstacleDetection"])).toEqual({
      speed: 0.5,
      blade_height: 40,
      ultra_wave: 10,
    });
    expect(modifyJobData(settings, [])).toEqual({});
  });
});

const COLLECTION: FeatureCollection = {
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} }],
};

describe.each([["fetchMap", fetchMap, "get_geojson"]] as const)("%s", (_name, fetch, service) => {
  it("calls the response-only service on the mower", async () => {
    const hass = makeHass([], [], () => COLLECTION);

    await expect(fetch(hass, "lawn_mower.luba")).resolves.toEqual(COLLECTION);
    expect(hass.calls).toEqual([
      {
        domain: "mammotion",
        service,
        data: {},
        target: { entity_id: "lawn_mower.luba" },
        notifyOnError: false,
        returnResponse: true,
      },
    ]);
  });

  it.each([{}, { type: "FeatureCollection", features: [] }, undefined, "nope"])(
    "resolves undefined for an empty response %j",
    async (response) => {
      await expect(
        fetch(
          makeHass([], [], () => response),
          "lawn_mower.luba",
        ),
      ).resolves.toBeUndefined();
    },
  );

  it("propagates a rejected call", async () => {
    const hass = makeHass([], [], () => {
      throw new Error("offline");
    });

    await expect(fetch(hass, "lawn_mower.luba")).rejects.toThrow("offline");
  });
});

describe("startMow", () => {
  it("calls mammotion.start_mow on the mower with the data", async () => {
    const hass = makeHass([]);
    const data = { areas: ["switch.a"], channel_mode: 0 };

    await expect(startMow(hass, "lawn_mower.luba", data)).resolves.toBeUndefined();
    expect(hass.calls).toEqual([
      {
        domain: "mammotion",
        service: "start_mow",
        data,
        target: { entity_id: "lawn_mower.luba" },
        notifyOnError: true,
        returnResponse: false,
      },
    ]);
  });

  it("propagates a rejected call", async () => {
    const hass = makeHass([], [], () => {
      throw new Error("refused");
    });

    await expect(startMow(hass, "lawn_mower.luba", {})).rejects.toThrow("refused");
  });
});

describe("modifyRunningJob", () => {
  it("calls mammotion.modify_running_job on the mower with the data", async () => {
    const hass = makeHass([]);

    await modifyRunningJob(hass, "lawn_mower.luba", { speed: 0.4 });

    expect(hass.calls).toEqual([
      {
        domain: "mammotion",
        service: "modify_running_job",
        data: { speed: 0.4 },
        target: { entity_id: "lawn_mower.luba" },
        notifyOnError: true,
        returnResponse: false,
      },
    ]);
  });

  it("propagates a rejected call", async () => {
    const hass = makeHass([], [], () => {
      throw new Error("no running job");
    });

    await expect(modifyRunningJob(hass, "lawn_mower.luba", {})).rejects.toThrow("no running job");
  });
});

describe("canPlanRoute", () => {
  it("needs an integration that registers mammotion.plan_route", () => {
    const hass = makeHass([]);

    expect(canPlanRoute(hass)).toBe(true);
    expect(canPlanRoute({ ...hass, services: { mammotion: { start_mow: {} } } })).toBe(false);
    expect(canPlanRoute({ ...hass, services: undefined })).toBe(false);
  });
});

describe("planRoute", () => {
  const data = { areas: ["switch.a"], channel_mode: 0 };

  it("plans in one response-only call and returns the plan's route", async () => {
    const hass = makeHass([], [], () => ({ ...COLLECTION, plan: { path_hash: "123" } }));

    await expect(planRoute(hass, "lawn_mower.luba", data)).resolves.toMatchObject(COLLECTION);
    expect(hass.calls).toEqual([
      {
        domain: "mammotion",
        service: "plan_route",
        data,
        target: { entity_id: "lawn_mower.luba" },
        notifyOnError: false,
        returnResponse: true,
      },
    ]);
  });

  it("rejects with the integration's own message", async () => {
    const hass = makeHass([], [], () => serviceError("Luba did not share the route it planned."));

    await expect(planRoute(hass, "lawn_mower.luba", data)).rejects.toThrow(
      "Luba did not share the route it planned.",
    );
  });

  it("rejects without a message for a response with no route", async () => {
    await expect(
      planRoute(
        makeHass([], [], () => ({ type: "FeatureCollection", features: [] })),
        "x",
        data,
      ),
    ).rejects.toThrow(/^$/);
  });
});
