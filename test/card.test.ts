import type { Feature, FeatureCollection, Position } from "geojson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MowPlannerCard } from "../src/card";
import type { MowMap } from "../src/components/map-view";
import type { SegmentedControl } from "../src/components/control-segmented";
import type { SliderControl } from "../src/components/control-slider";
import type { MowSettingsPanel } from "../src/components/settings-panel";
import { CARD_TYPE, configForm, normalizeConfig } from "../src/config";
import type { MowSettings } from "../src/model";
import {
  device,
  lubaEntities,
  makeHass,
  withChanges,
  type FakeEntity,
  type FakeHass,
  entityResponse,
  serviceError,
  type ServiceCall,
} from "./ha/_helpers";

const ORIGIN = { lon: 4.9, lat: 52.3 };
const DEG_PER_M = 1 / 111_111;

const lonLat = (x: number, y: number): Position => [
  ORIGIN.lon + (x * DEG_PER_M) / Math.cos((ORIGIN.lat * Math.PI) / 180),
  ORIGIN.lat + y * DEG_PER_M,
];

const square = (
  type_name: string,
  hash: number,
  Name: string,
  x: number,
  y: number,
  size: number,
): Feature => ({
  type: "Feature",
  properties: { type_name, hash, Name, area: size * size },
  geometry: {
    type: "Polygon",
    coordinates: [[lonLat(x, y), lonLat(x + size, y), lonLat(x + size, y + size), lonLat(x, y + size)]],
  },
});

const MAP: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    square("area", 111, "Front", 0, 0, 20),
    square("area", 222, "Back", 30, 0, 16),
    {
      type: "Feature",
      properties: { type_name: "station", Name: "Dock", rotation: 90 },
      geometry: { type: "Point", coordinates: lonLat(-2, -2) },
    },
  ],
};

const MAP_WITH_NO_GO_ZONE: FeatureCollection = {
  ...MAP,
  features: [...MAP.features, square("obstacle", 333, "Pond", 8, 8, 4)],
};

const ROUTE: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { type_name: "mow_path" },
      geometry: { type: "LineString", coordinates: [lonLat(1, 1), lonLat(19, 1), lonLat(19, 2)] },
    },
  ],
};

const LUBA = "lawn_mower.luba";
const YUKA = "lawn_mower.yuka";
const LUBA_SETTINGS: MowSettings = {
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
};
const LUBA_FIELDS = {
  channel_mode: 1,
  toward_mode: 1,
  toward: 30,
  toward_included_angle: 60,
  channel_width: 28,
  mowing_laps: 2,
  obstacle_laps: 3,
  border_mode: 1,
  speed: 0.4,
  blade_height: 55,
  ride_boundary_distance: 0.5,
  ultra_wave: 10,
  start_progress: 0,
  collect_grass_frequency: 20,
  auto_change_direction: 1,
  is_mow: true,
  is_dump: false,
  is_edge: true,
};
const without = (fields: Record<string, unknown>, name: string) =>
  Object.fromEntries(Object.entries(fields).filter(([key]) => key !== name));

/** Active, but the job has reached 100 %, so there is nothing left to change. */
const homeward = () =>
  withChanges(lubaEntities(), { [LUBA]: { state: "returning" }, "sensor.luba_progress": { state: "100" } });

const FRONT = "switch.luba_area_front";
const BACK = "switch.luba_back_lawn";

type Responder = (service: string, call: ServiceCall) => unknown;

const withMap: Responder = (service) => (service === "get_geojson" ? MAP : undefined);

function deferred<T = unknown>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const lubaHass = (respond: Responder = withMap, entities: readonly FakeEntity[] = lubaEntities()): FakeHass =>
  makeHass(entities, [device("dev1", "Luba")], respond);

const twoMowers = (respond: Responder = withMap) =>
  makeHass(
    [
      ...lubaEntities(),
      ...withChanges(lubaEntities("dev2", "yuka"), {
        "switch.yuka_area_front": { state: "off" },
        "switch.yuka_back_lawn": { state: "on" },
      }),
    ],
    [device("dev1", "Luba"), device("dev2", "Yuka")],
    respond,
  );

/** A later `hass` object from HA: same registries, services and call log, new states; `null` drops a state. */
function nextHass(hass: FakeHass, changes: Readonly<Record<string, string | null>> = {}): FakeHass {
  const states = Object.entries(hass.states).flatMap(([entityId, entity]) => {
    const state = changes[entityId];
    if (state === null) return [];
    return [[entityId, state === undefined ? entity : { ...entity, state }] as const];
  });
  return { ...hass, states: Object.fromEntries(states) };
}

const mounted: MowPlannerCard[] = [];

async function settle(card: MowPlannerCard): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await card.updateComplete;
  }
}

function createCard(): MowPlannerCard {
  const card = document.createElement(CARD_TYPE);
  if (!(card instanceof MowPlannerCard)) throw new Error(`${CARD_TYPE} is not registered`);
  return card;
}

/** happy-dom's `:focus-within` ignores focus inside a shadow root; browsers match the host. */
function shimFocusWithin(card: MowPlannerCard): void {
  const matches = card.matches.bind(card);
  vi.spyOn(card, "matches").mockImplementation((selector) =>
    selector === ":focus-within" ? Boolean(card.shadowRoot?.activeElement) : matches(selector),
  );
}

async function mount(
  hass: FakeHass,
  config: Record<string, unknown> = { type: `custom:${CARD_TYPE}` },
): Promise<MowPlannerCard> {
  const card = createCard();
  shimFocusWithin(card);
  card.setConfig(config);
  card.hass = hass;
  document.body.append(card);
  mounted.push(card);
  await settle(card);
  return card;
}

async function update(card: MowPlannerCard, hass: FakeHass): Promise<void> {
  card.hass = hass;
  await settle(card);
}

const root = (card: MowPlannerCard): ShadowRoot => {
  if (!card.shadowRoot) throw new Error("no shadow root");
  return card.shadowRoot;
};

const textOf = (el: Element | ShadowRoot | null | undefined): string =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const buttons = (card: MowPlannerCard) => [...root(card).querySelectorAll("button")];

function button(card: MowPlannerCard, label: string): HTMLButtonElement {
  const found = buttons(card).find((b) => textOf(b) === label || b.getAttribute("aria-label") === label);
  if (!found) throw new Error(`no button "${label}" in: ${buttons(card).map(textOf).join(" | ")}`);
  return found;
}

const hasButton = (card: MowPlannerCard, label: string) =>
  buttons(card).some((b) => textOf(b) === label || b.getAttribute("aria-label") === label);

const chips = (card: MowPlannerCard) => [...root(card).querySelectorAll<HTMLButtonElement>("button.chip")];

function chip(card: MowPlannerCard, name: string): HTMLButtonElement {
  const found = chips(card).find((c) => textOf(c).endsWith(name));
  if (!found) throw new Error(`no chip "${name}"`);
  return found;
}

const pressed = (card: MowPlannerCard) =>
  chips(card)
    .filter((c) => c.getAttribute("aria-pressed") === "true")
    .map(textOf);

const alerts = (card: MowPlannerCard) => [...root(card).querySelectorAll('[role="alert"]')].map(textOf);

const statuses = (card: MowPlannerCard) => [...root(card).querySelectorAll('[role="status"]')].map(textOf);

const confirmation = (card: MowPlannerCard) => root(card).querySelector('[role="alertdialog"]');

const stepButtons = (card: MowPlannerCard) => [
  ...root(card).querySelectorAll<HTMLButtonElement>("button.step"),
];

const rows = (card: MowPlannerCard): Record<string, string> =>
  Object.fromEntries(
    [...root(card).querySelectorAll("dl > div")].map((row) => [
      textOf(row.querySelector("dt")),
      textOf(row.querySelector("dd")),
    ]),
  );

const mapOf = (card: MowPlannerCard) => root(card).querySelector<MowMap>("mow-planner-map");

function mapEl(card: MowPlannerCard): MowMap {
  const map = mapOf(card);
  if (!map) throw new Error("no mow-planner-map");
  return map;
}

function panel(card: MowPlannerCard): MowSettingsPanel {
  const found = root(card).querySelector<MowSettingsPanel>("mow-planner-settings");
  if (!found) throw new Error("no mow-planner-settings");
  return found;
}

function picker(card: MowPlannerCard): HTMLSelectElement {
  const select = root(card).querySelector("select");
  if (!select) throw new Error("no mower picker");
  return select;
}

async function pick(card: MowPlannerCard, entityId: string): Promise<void> {
  picker(card).value = entityId;
  picker(card).dispatchEvent(new Event("change"));
  await settle(card);
}

const currentStep = (card: MowPlannerCard) => textOf(root(card).querySelector('[aria-current="step"]'));

const focused = (card: MowPlannerCard) => textOf(root(card).activeElement);

async function click(card: MowPlannerCard, target: HTMLElement): Promise<void> {
  target.click();
  await settle(card);
}

/** Runs a button's click handler even while it is disabled, as a stale or scripted click could. */
async function forceClick(card: MowPlannerCard, target: HTMLButtonElement): Promise<void> {
  const { disabled } = target;
  target.disabled = false;
  target.click();
  target.disabled = disabled;
  await settle(card);
}

async function toggleOnMap(card: MowPlannerCard, hash: number): Promise<void> {
  mapEl(card).dispatchEvent(
    new CustomEvent("area-toggle", { detail: { hash }, bubbles: true, composed: true }),
  );
  await settle(card);
}

async function editSettings(card: MowPlannerCard, change: Partial<MowSettings>): Promise<void> {
  const settings = panel(card);
  settings.dispatchEvent(
    new CustomEvent("settings-changed", {
      detail: { settings: { ...settings.settings, ...change } },
      bubbles: true,
      composed: true,
    }),
  );
  await settle(card);
}

async function toReview(card: MowPlannerCard): Promise<void> {
  await click(card, button(card, "Next"));
  await click(card, button(card, "Next"));
}

async function toReviewWith(card: MowPlannerCard, change: Partial<MowSettings>): Promise<void> {
  await click(card, button(card, "Next"));
  await editSettings(card, change);
  await click(card, button(card, "Next"));
}

async function openConfirm(card: MowPlannerCard): Promise<void> {
  await click(card, button(card, "Start mowing"));
}

async function arm(card: MowPlannerCard): Promise<void> {
  await vi.advanceTimersByTimeAsync(600);
  await settle(card);
}

async function armAndConfirm(card: MowPlannerCard, confirmLabel = "Start now"): Promise<void> {
  await arm(card);
  await click(card, button(card, confirmLabel));
}

async function startMowing(card: MowPlannerCard): Promise<void> {
  await openConfirm(card);
  await armAndConfirm(card);
}

const callsTo = (hass: FakeHass, service: string) => hass.calls.filter((c) => c.service === service);

const startData = (hass: FakeHass) => callsTo(hass, "start_mow").map((call) => call.data);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const card of mounted.splice(0)) card.remove();
  vi.useRealTimers();
});

describe("setConfig", () => {
  it("rejects an invalid config with the validation message", () => {
    const card = createCard();
    expect(() => {
      card.setConfig({ type: "x", entity: "switch.front" });
    }).toThrow('"entity" must be a lawn_mower entity id, got "switch.front".');
    expect(() => {
      card.setConfig({ exact_route: "yes" });
    }).toThrow('"exact_route" must be true or false.');
  });

  it("renders the mower for a valid config", async () => {
    const card = await mount(lubaHass());
    expect(textOf(root(card).querySelector("h2"))).toBe("Luba");
    expect(textOf(root(card).querySelector("header"))).toContain("Docked");
    expect(textOf(root(card).querySelector("header"))).toContain("87% battery");
  });

  it("uses the configured title", async () => {
    const card = await mount(lubaHass(), { type: "x", title: "Garden" });
    expect(textOf(root(card).querySelector("h2"))).toBe("Garden");
  });

  it("falls back to the mower name for an empty title", async () => {
    const card = await mount(lubaHass(), { type: "x", title: "" });
    expect(textOf(root(card).querySelector("h2"))).toBe("Luba");
  });
});

describe("no mower", () => {
  it("shows the no-mower message until a mower appears", async () => {
    const card = await mount(makeHass([{ entity_id: "light.porch", state: "on", platform: "hue" }]));
    expect(statuses(card)).toEqual(["No Mammotion mower found"]);

    const hass = lubaHass();
    await update(card, hass);

    expect(textOf(root(card).querySelector("h2"))).toBe("Luba");
    expect(callsTo(hass, "get_geojson")).toHaveLength(1);
  });

  it("ignores lawn mowers of other integrations", async () => {
    const card = await mount(
      makeHass([{ entity_id: "lawn_mower.other", state: "docked", platform: "husqvarna" }]),
    );
    expect(statuses(card)).toEqual(["No Mammotion mower found"]);
  });
});

describe("map loading", () => {
  it("asks once for the map of the mower, showing a loading message meanwhile", async () => {
    const map = deferred();
    const hass = lubaHass((service) => (service === "get_geojson" ? map.promise : undefined));
    const card = await mount(hass);

    expect(textOf(root(card).querySelector(".map"))).toBe("Loading map…");
    expect(button(card, "Refresh map").disabled).toBe(true);
    expect(hass.calls).toEqual([
      {
        domain: "mammotion",
        service: "get_geojson",
        data: {},
        target: { entity_id: LUBA },
        notifyOnError: false,
        returnResponse: true,
      },
    ]);

    map.resolve(MAP);
    await settle(card);

    expect(mapEl(card).model?.areas.map((area) => area.hash)).toEqual([111, 222]);
    expect(textOf(root(card).querySelector(".map"))).not.toContain("Loading map");
  });

  it("names map areas after their switches", async () => {
    const card = await mount(lubaHass());
    expect(mapEl(card).model?.areas.map((area) => area.name)).toEqual(["Area Front", "Back lawn"]);
  });

  it("says there is no map yet for an empty response and keeps the area chips working", async () => {
    const card = await mount(lubaHass(() => ({})));

    expect(mapOf(card)).toBeNull();
    expect(statuses(card)).toEqual(["No map from the mower yet Try again"]);
    expect(textOf(root(card).querySelector(".hint"))).toBe(
      "Choose the areas to mow, in the order you want them",
    );
    await click(card, chip(card, "Back lawn"));
    expect(pressed(card)).toEqual(["All", "1Area Front", "2Back lawn"]);
  });

  it("shows an error with a retry that asks again", async () => {
    let fail = true;
    const hass = lubaHass((service) => {
      if (fail) throw new Error("integration down");
      return service === "get_geojson" ? MAP : undefined;
    });
    const card = await mount(hass);
    expect(statuses(card)).toEqual(["Couldn't load the map Try again"]);

    fail = false;
    await click(card, button(card, "Try again"));

    expect(callsTo(hass, "get_geojson")).toHaveLength(2);
    expect(mapOf(card)).not.toBeNull();
    expect(textOf(root(card).querySelector(".hint"))).toBe(
      "Tap the areas to mow, in the order you want them",
    );
  });

  it("asks again when refreshed", async () => {
    const hass = lubaHass();
    const card = await mount(hass);

    await click(card, button(card, "Refresh map"));

    expect(callsTo(hass, "get_geojson")).toHaveLength(2);
    expect(mapOf(card)).not.toBeNull();
  });

  it("shows the latest of two overlapping loads", async () => {
    const lubaMap = deferred();
    const yukaMap: FeatureCollection = { ...MAP, features: MAP.features.slice(1) };
    const hass = twoMowers((service, call) =>
      service !== "get_geojson" ? undefined : call.target?.entity_id === LUBA ? lubaMap.promise : yukaMap,
    );
    const card = await mount(hass);
    await pick(card, YUKA);

    lubaMap.resolve(MAP);
    await settle(card);

    expect(mapEl(card).model?.areas.map((area) => area.hash)).toEqual([222]);
  });

  it("does not refetch the map on frequent hass updates", async () => {
    const hass = lubaHass();
    const card = await mount(hass);

    for (let i = 0; i < 5; i++) await update(card, nextHass(hass));
    await update(card, nextHass(hass, { "sensor.luba_battery": "60" }));

    expect(callsTo(hass, "get_geojson")).toHaveLength(1);
    expect(textOf(root(card).querySelector("header"))).toContain("60% battery");
  });
});

describe("areas step", () => {
  it("offers a chip per area switch with the switched-on areas selected", async () => {
    const card = await mount(lubaHass());

    expect(chips(card).map(textOf)).toEqual(["All", "1Area Front", "Back lawn"]);
    expect(pressed(card)).toEqual(["1Area Front"]);
    expect(mapEl(card).selected).toEqual([111]);
  });

  it("numbers the chips in click order", async () => {
    const card = await mount(lubaHass());

    await click(card, chip(card, "Back lawn"));
    expect(pressed(card)).toEqual(["All", "1Area Front", "2Back lawn"]);
    await click(card, chip(card, "Area Front"));
    expect(pressed(card)).toEqual(["1Back lawn"]);
    await click(card, chip(card, "Area Front"));

    expect(pressed(card)).toEqual(["All", "2Area Front", "1Back lawn"]);
    expect(mapEl(card).selected).toEqual([222, 111]);
  });

  it("selects every area with All, and clears them when all are selected", async () => {
    const card = await mount(lubaHass());

    await click(card, chip(card, "All"));
    expect(pressed(card)).toEqual(["All", "1Area Front", "2Back lawn"]);

    await click(card, chip(card, "All"));
    expect(pressed(card)).toEqual([]);
  });

  it("toggles the same selection from the map", async () => {
    const card = await mount(lubaHass());

    await toggleOnMap(card, 222);
    expect(pressed(card)).toEqual(["All", "1Area Front", "2Back lawn"]);

    await toggleOnMap(card, 111);
    expect(pressed(card)).toEqual(["1Back lawn"]);
  });

  it("ignores map toggles for areas without a switch", async () => {
    const card = await mount(lubaHass());

    await toggleOnMap(card, 999);

    expect(pressed(card)).toEqual(["1Area Front"]);
  });

  it("disables Next with a neutral hint when nothing is selected", async () => {
    const card = await mount(lubaHass());

    await click(card, chip(card, "Area Front"));

    expect(button(card, "Next").disabled).toBe(true);
    expect(textOf(root(card).querySelector(".totals"))).toBe("Select at least one area");
    expect(alerts(card)).toEqual([]);
  });

  it("lets an unavailable mower be planned but not started", async () => {
    const card = await mount(
      lubaHass(withMap, withChanges(lubaEntities(), { [LUBA]: { state: "unavailable" } })),
    );

    expect(alerts(card)).toEqual(["Luba is unavailable"]);
    expect(button(card, "Next").disabled).toBe(false);
    await toReview(card);

    expect(currentStep(card)).toBe("3Review");
    expect(alerts(card)).toEqual(["Luba is unavailable"]);
    expect(button(card, "Start mowing").disabled).toBe(true);
  });

  it("keeps Next disabled with nothing selected while the mower is unavailable", async () => {
    const card = await mount(
      lubaHass(withMap, withChanges(lubaEntities(), { [LUBA]: { state: "unavailable" } })),
    );

    await click(card, chip(card, "Area Front"));

    expect(button(card, "Next").disabled).toBe(true);
  });
});

describe("settings step", () => {
  it("hands the mower's current settings and limits to the settings panel", async () => {
    const card = await mount(lubaHass());
    await click(card, button(card, "Next"));

    expect(currentStep(card)).toBe("2Pattern");
    expect(panel(card).settings).toEqual(LUBA_SETTINGS);
    expect(panel(card).limits).toMatchObject({
      spacingCm: { min: 20, max: 35, step: 1 },
      speed: { min: 0.2, max: 0.6, step: 0.1 },
      bladeHeight: { min: 25, max: 70, step: 1 },
    });
    expect(panel(card).language).toBe("en");
    expect(panel(card).disabled).toBe(false);
  });

  it("updates the plan from edits without writing any entity", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await click(card, button(card, "Next"));
    expect(mapEl(card).previews.every((preview) => preview.stripes.length > 0)).toBe(true);

    await editSettings(card, { pattern: "no_grid", spacingCm: 30 });

    expect(panel(card).settings).toMatchObject({ pattern: "no_grid", spacingCm: 30 });
    const previews = mapEl(card).previews;
    expect(previews.map((preview) => preview.hash)).toEqual([111]);
    expect(previews.every((preview) => preview.stripes.length === 0)).toBe(true);
    expect(previews.every((preview) => preview.perimeterLaps.length > 0)).toBe(true);

    await click(card, button(card, "Next"));
    expect(rows(card)).toMatchObject({ Pattern: "Perimeter", "Path spacing": "30 cm" });
    expect(hass.calls.map((call) => call.service)).toEqual(["get_geojson"]);
  });

  it("blocks Next for the perimeter pattern without laps", async () => {
    const card = await mount(lubaHass());
    await click(card, button(card, "Next"));

    await editSettings(card, { pattern: "no_grid", perimeterLaps: 0, obstacleLaps: 0 });

    expect(button(card, "Next").disabled).toBe(true);
    expect(alerts(card)).toEqual(["The Perimeter pattern needs at least one perimeter or no-go zone lap"]);
  });

  it("blocks Next for the perimeter pattern when only no-go laps are set and the area has no no-go zone", async () => {
    const card = await mount(lubaHass());
    await click(card, button(card, "Next"));

    await editSettings(card, { pattern: "no_grid", perimeterLaps: 0, obstacleLaps: 1 });

    expect(button(card, "Next").disabled).toBe(true);
    expect(alerts(card)).toEqual(["The Perimeter pattern needs at least one perimeter or no-go zone lap"]);
  });

  it("allows only no-go laps when the area has a no-go zone", async () => {
    const card = await mount(
      lubaHass((service) => (service === "get_geojson" ? MAP_WITH_NO_GO_ZONE : undefined)),
    );
    await click(card, button(card, "Next"));

    await editSettings(card, { pattern: "no_grid", perimeterLaps: 0, obstacleLaps: 1 });

    expect(button(card, "Next").disabled).toBe(false);
    expect(alerts(card)).toEqual([]);
  });
});

describe("review step", () => {
  it("summarises the plan", async () => {
    const card = await mount(lubaHass());
    await click(card, chip(card, "Back lawn"));
    await toReview(card);

    expect(currentStep(card)).toBe("3Review");
    expect(rows(card)).toMatchObject({
      Areas: "Area Front, Back lawn",
      Pattern: "Grid",
      "Path angle": "Custom, 30°",
      "Crossing angle": "60°",
      "Path spacing": "28 cm",
      "Perimeter laps": "2",
      "No-go zone laps": "3",
      "Mow first": "Inside",
      Speed: "0.4 m/s",
      "Cutting height": "55 mm",
      "Edge coverage": "On edge",
      "Obstacle detection": "Standard",
      "Start from": "0%",
      "Auto-reverse direction": "On",
      Mow: "On",
      "Dump grass": "Off",
      "Cut edges": "On",
    });
    expect(rows(card)).not.toHaveProperty("Dump every");
    expect(rows(card)["Path length"]).toMatch(/^\d+(\.\d)? km$/);
    expect(rows(card)["Estimated time"]).toMatch(/^about (\d+ h )?\d+ min$/);
    expect(textOf(root(card).querySelector(".totals"))).toMatch(/^2 areas · \d+ m² · about/);
  });

  it("leaves out edge coverage for a mower without it", async () => {
    const card = await mount(
      lubaHass(withMap, withChanges(lubaEntities(), { "number.luba_ride_boundary_distance": null })),
    );
    await toReview(card);

    expect(rows(card)).not.toHaveProperty("Edge coverage");
  });

  it("formats numbers for the user's language", async () => {
    const card = await mount({ ...lubaHass(), language: "de" });
    await click(card, button(card, "Weiter"));
    await click(card, button(card, "Weiter"));

    expect(rows(card)).toMatchObject({ Geschwindigkeit: "0,4 m/s" });
    expect(rows(card)["Weglänge"]).toMatch(/^\d+,\d km$/);
  });

  it("leaves out the path length and time estimate without a map", async () => {
    const card = await mount(lubaHass(() => ({})));
    await toReview(card);

    expect(rows(card)).not.toHaveProperty("Estimated time");
    expect(rows(card)).not.toHaveProperty("Path length");
    expect(rows(card)).toMatchObject({ Areas: "Area Front" });
  });

  it("shows the random angle mode without a value", async () => {
    const card = await mount(lubaHass());
    await toReviewWith(card, { angleMode: "random_angle" });

    expect(rows(card)["Path angle"]).toBe("Random");
  });

  it("makes the map read-only", async () => {
    const card = await mount(lubaHass());
    expect(mapEl(card).readonly).toBe(false);
    await toReview(card);
    expect(mapEl(card).readonly).toBe(true);
  });

  it("focuses the primary button when Next leads to the review", async () => {
    const card = await mount(lubaHass());
    await click(card, button(card, "Next"));
    const next = button(card, "Next");
    next.focus();

    await click(card, next);

    expect(focused(card)).toBe("Start mowing");
  });

  it("warns that a mower heading home from a finished job will end it", async () => {
    const card = await mount(lubaHass(withMap, homeward()));
    await toReview(card);

    expect(statuses(card)).toContain("Luba is busy. Starting will end its current job");
    expect(button(card, "Start mowing").disabled).toBe(false);
  });

  it("blocks Start for an unavailable mower", async () => {
    const card = await mount(
      lubaHass(withMap, withChanges(lubaEntities(), { [LUBA]: { state: "unavailable" } })),
    );
    await toReview(card);

    expect(alerts(card)).toEqual(["Luba is unavailable"]);
    expect(button(card, "Start mowing").disabled).toBe(true);
  });

  it("blocks Start for the perimeter pattern without laps", async () => {
    const card = await mount(lubaHass());
    await click(card, button(card, "Next"));
    await editSettings(card, { pattern: "no_grid", perimeterLaps: 0, obstacleLaps: 0 });
    await click(card, button(card, "3Review"));

    expect(currentStep(card)).toBe("3Review");
    expect(alerts(card)).toEqual(["The Perimeter pattern needs at least one perimeter or no-go zone lap"]);
    expect(button(card, "Start mowing").disabled).toBe(true);
  });

  it("blocks Start for a perimeter plan with nothing to mow", async () => {
    const card = await mount(lubaHass());
    await click(card, button(card, "Next"));
    await editSettings(card, { pattern: "no_grid", perimeterLaps: 0, obstacleLaps: 1 });
    await click(card, button(card, "3Review"));

    expect(currentStep(card)).toBe("3Review");
    expect(alerts(card)).toEqual(["The Perimeter pattern needs at least one perimeter or no-go zone lap"]);
    expect(button(card, "Start mowing").disabled).toBe(true);
  });
});

describe("confirming a start", () => {
  it("asks for confirmation before sending anything", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);

    await openConfirm(card);

    expect(textOf(confirmation(card))).toMatch(
      /^Send Luba out to mow 1 area · 400 m² · about (\d+ h )?\d+ min\?/,
    );
    expect(callsTo(hass, "start_mow")).toEqual([]);
  });

  it("arms the confirm button only after a short delay", async () => {
    const card = await mount(lubaHass());
    await toReview(card);
    await openConfirm(card);

    expect(button(card, "Start now").disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(599);
    await settle(card);
    expect(button(card, "Start now").disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await settle(card);
    expect(button(card, "Start now").disabled).toBe(false);
  });

  it("keeps the confirm button disarmed for the full delay after reopening it", async () => {
    const card = await mount(lubaHass());
    await toReview(card);
    await openConfirm(card);
    await vi.advanceTimersByTimeAsync(500);
    await click(card, button(card, "Cancel"));
    await openConfirm(card);

    await vi.advanceTimersByTimeAsync(200);
    await settle(card);
    expect(button(card, "Start now").disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(400);
    await settle(card);
    expect(button(card, "Start now").disabled).toBe(false);
  });

  it("sends nothing when the disarmed confirm button is clicked anyway", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);
    await openConfirm(card);

    await forceClick(card, button(card, "Start now"));

    expect(callsTo(hass, "start_mow")).toEqual([]);
    expect(confirmation(card)).not.toBeNull();
  });

  it("returns without any call when cancelled, focusing Start again", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);
    button(card, "Start mowing").focus();
    await openConfirm(card);
    expect(focused(card)).toBe("Cancel");
    await arm(card);

    await click(card, button(card, "Cancel"));

    expect(confirmation(card)).toBeNull();
    expect(focused(card)).toBe("Start mowing");
    expect(callsTo(hass, "start_mow")).toEqual([]);
  });

  it("keeps the map from being refreshed under an open confirmation", async () => {
    const card = await mount(lubaHass());
    await toReview(card);
    expect(button(card, "Refresh map").disabled).toBe(false);

    await openConfirm(card);

    expect(button(card, "Refresh map").disabled).toBe(true);
  });

  it("cancels with Escape", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);
    await openConfirm(card);
    await arm(card);

    button(card, "Start now").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
    );
    await settle(card);

    expect(confirmation(card)).toBeNull();
    expect(callsTo(hass, "start_mow")).toEqual([]);
  });

  it("warns inside the confirmation that a busy mower will end its current job", async () => {
    const card = await mount(lubaHass(withMap, homeward()));
    await toReview(card);

    await openConfirm(card);

    expect(textOf(confirmation(card))).toContain("Luba is busy. Starting will end its current job");
  });

  it("closes itself, sending nothing, when the mower starts a job meanwhile", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);
    await openConfirm(card);
    await arm(card);
    const confirm = button(card, "Start now");

    await update(card, nextHass(hass, { [LUBA]: "mowing" }));
    await forceClick(card, confirm);

    expect(confirmation(card)).toBeNull();
    expect(callsTo(hass, "start_mow")).toEqual([]);
    expect(hasButton(card, "Apply changes")).toBe(true);
  });

  it("closes itself and shows the alert when the mower becomes unavailable", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);
    await openConfirm(card);
    await arm(card);
    const confirm = button(card, "Start now");

    await update(card, nextHass(hass, { [LUBA]: "unavailable" }));

    expect(confirmation(card)).toBeNull();
    expect(alerts(card)).toEqual(["Luba is unavailable"]);
    await forceClick(card, confirm);
    expect(callsTo(hass, "start_mow")).toEqual([]);
  });

  it("closes itself when the mower's state disappears", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);
    await openConfirm(card);
    await arm(card);
    const confirm = button(card, "Start now");

    await update(card, nextHass(hass, { [LUBA]: null }));
    await forceClick(card, confirm);
    await update(card, nextHass(hass));

    expect(confirmation(card)).toBeNull();
    expect(callsTo(hass, "start_mow")).toEqual([]);
  });
});

describe("what a start sends", () => {
  it("sends the confirmed areas in click order with every held setting", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await click(card, chip(card, "Back lawn"));
    await click(card, chip(card, "Area Front"));
    await click(card, chip(card, "Area Front"));
    await toReview(card);

    await startMowing(card);

    expect(callsTo(hass, "start_mow")).toEqual([
      {
        domain: "mammotion",
        service: "start_mow",
        data: { areas: [BACK, FRONT], ...LUBA_FIELDS },
        target: { entity_id: LUBA },
        notifyOnError: true,
        returnResponse: false,
      },
    ]);
    expect(statuses(card)).toContain("Mowing job sent to Luba");
  });

  it("sends the edited settings", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReviewWith(card, { pattern: "single_grid", spacingCm: 30, angle: -45 });

    await startMowing(card);

    expect(startData(hass)).toEqual([
      { areas: [FRONT], ...LUBA_FIELDS, channel_mode: 0, channel_width: 30, toward: -45 },
    ]);
  });

  it("leaves out a setting whose entity has no value, unless it was edited", async () => {
    const entities = withChanges(lubaEntities(), { "number.luba_blade_height": { state: "unknown" } });
    const heldFields = without(LUBA_FIELDS, "blade_height");
    const hass = lubaHass(withMap, entities);
    const card = await mount(hass);
    await toReviewWith(card, { spacingCm: 30 });

    await startMowing(card);
    expect(startData(hass)).toEqual([{ areas: [FRONT], ...heldFields, channel_width: 30 }]);

    await click(card, button(card, "New plan"));
    await toReviewWith(card, { bladeHeight: 60 });
    await startMowing(card);

    expect(startData(hass)[1]).toEqual({ areas: [FRONT], ...heldFields, blade_height: 60 });
  });

  it("shows the mower's own setting in the review for a value the card would not send", async () => {
    const entities = withChanges(lubaEntities(), { "number.luba_blade_height": { state: "unknown" } });
    const card = await mount(lubaHass(withMap, entities));
    await toReview(card);
    expect(rows(card)["Cutting height"]).toBe("Mower's own setting");

    await click(card, button(card, "2Pattern"));
    await editSettings(card, { bladeHeight: 60 });
    await click(card, button(card, "Next"));
    expect(rows(card)["Cutting height"]).toBe("60 mm");
  });

  it("sends a setting whose entity is missing only once it is edited", async () => {
    const entities = withChanges(lubaEntities(), { "number.luba_path_spacing": null });
    const heldFields = without(LUBA_FIELDS, "channel_width");
    const hass = lubaHass(withMap, entities);
    const card = await mount(hass);
    await toReview(card);

    await startMowing(card);
    expect(startData(hass)).toEqual([{ areas: [FRONT], ...heldFields }]);

    await click(card, button(card, "New plan"));
    await toReviewWith(card, { spacingCm: 22 });
    await startMowing(card);

    expect(startData(hass)[1]).toEqual({ areas: [FRONT], ...heldFields, channel_width: 22 });
  });

  it("sends the mower's current value for a setting the user did not edit", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await click(card, button(card, "Next"));
    await editSettings(card, { spacingCm: 30 });

    await update(card, nextHass(hass, { "number.luba_blade_height": "30" }));
    await click(card, button(card, "Next"));
    await startMowing(card);

    expect(startData(hass)[0]).toMatchObject({ channel_width: 30, blade_height: 30 });
  });

  it("sends the areas that were confirmed even if area switches change meanwhile", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);
    await openConfirm(card);
    await arm(card);

    await update(card, nextHass(hass, { [FRONT]: "off", [BACK]: "on" }));
    await click(card, button(card, "Start now"));

    expect(startData(hass).map((data) => data?.areas)).toEqual([[FRONT]]);
  });

  it("sends the settings that were confirmed even if the entities change meanwhile", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);
    await openConfirm(card);
    await arm(card);

    await update(
      card,
      nextHass(hass, { "number.luba_path_spacing": "33", "number.luba_blade_height": "30" }),
    );
    await click(card, button(card, "Start now"));

    expect(startData(hass)).toEqual([{ areas: [FRONT], ...LUBA_FIELDS }]);
  });

  it("cancels the confirmation when the plan is changed", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);

    for (const change of [() => toggleOnMap(card, 222), () => forceClick(card, button(card, "1Areas"))]) {
      await openConfirm(card);
      await arm(card);
      const confirm = button(card, "Start now");
      await change();
      expect(confirmation(card)).toBeNull();
      await forceClick(card, confirm);
      if (currentStep(card) !== "3Review") await toReview(card);
    }

    expect(callsTo(hass, "start_mow")).toEqual([]);
  });
});

describe("while a start is in flight", () => {
  async function sending(respond: Responder = withMap) {
    const started = deferred();
    const hass = twoMowers((service, call) =>
      service === "start_mow" ? started.promise : respond(service, call),
    );
    const card = await mount(hass);
    await toReview(card);
    await openConfirm(card);
    await arm(card);
    const confirm = button(card, "Start now");
    await click(card, confirm);
    return { hass, card, confirm, started };
  }

  it("disables every control and makes the map read-only", async () => {
    const { card } = await sending();

    expect(button(card, "Starting…").disabled).toBe(true);
    expect(button(card, "Back").disabled).toBe(true);
    expect(button(card, "Refresh map").disabled).toBe(true);
    expect(stepButtons(card).map((step) => step.disabled)).toEqual([true, true, true]);
    expect(picker(card).disabled).toBe(true);
    expect(mapEl(card).readonly).toBe(true);
  });

  it("cannot send a second start by any path", async () => {
    const { hass, card, confirm, started } = await sending();

    await forceClick(card, confirm);
    await forceClick(card, button(card, "Starting…"));
    for (const step of stepButtons(card)) await forceClick(card, step);
    await forceClick(card, button(card, "Back"));
    await toggleOnMap(card, 222);
    await forceClick(card, button(card, "Starting…"));
    await arm(card);
    await forceClick(card, confirm);
    expect(callsTo(hass, "start_mow")).toHaveLength(1);
    expect(currentStep(card)).toBe("3Review");

    started.resolve(undefined);
    await settle(card);
    await forceClick(card, confirm);

    expect(statuses(card)).toContain("Mowing job sent to Luba");
    expect(callsTo(hass, "start_mow")).toHaveLength(1);
    expect(startData(hass)).toEqual([{ areas: [FRONT], ...LUBA_FIELDS }]);
  });

  it("ignores a mower pick in flight and shows the outcome only for its own mower", async () => {
    const { hass, card, started } = await sending();

    await pick(card, YUKA);
    started.resolve(undefined);
    await settle(card);
    expect(statuses(card)).toContain("Mowing job sent to Luba");

    await pick(card, YUKA);
    await toReview(card);

    expect(statuses(card).join()).not.toContain("Mowing job sent");
    await startMowing(card);
    expect(callsTo(hass, "start_mow").map((call) => call.target)).toEqual([
      { entity_id: LUBA },
      { entity_id: YUKA },
    ]);
  });
});

describe("after a start", () => {
  it("starts the new plan afresh, without the last plan's area picks or edits", async () => {
    const card = await mount(lubaHass());
    await click(card, chip(card, "Back lawn"));
    await toReviewWith(card, { spacingCm: 30 });
    await startMowing(card);

    await click(card, button(card, "New plan"));

    expect(pressed(card)).toEqual(["1Area Front"]);
    await click(card, button(card, "Next"));
    expect(panel(card).settings).toEqual(LUBA_SETTINGS);
  });

  it("offers a new plan instead of a second start", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);
    await startMowing(card);

    expect(statuses(card)).toContain("Mowing job sent to Luba");
    expect(hasButton(card, "Start mowing")).toBe(false);
    const callCount = hass.calls.length;

    await click(card, button(card, "New plan"));

    expect(currentStep(card)).toBe("1Areas");
    expect(hass.calls).toHaveLength(callCount);
    await toReview(card);
    expect(statuses(card).join()).not.toContain("Mowing job sent");
    expect(button(card, "Start mowing").disabled).toBe(false);
  });

  it("reports a failed start and lets the user retry", async () => {
    let fail = true;
    const hass = lubaHass((service) => {
      if (service === "start_mow" && fail) throw new Error("rejected");
      return service === "get_geojson" ? MAP : undefined;
    });
    const card = await mount(hass);
    await toReview(card);

    await startMowing(card);
    expect(alerts(card)).toEqual(["Couldn't start mowing"]);
    expect(button(card, "Start mowing").disabled).toBe(false);

    fail = false;
    await startMowing(card);
    expect(callsTo(hass, "start_mow")).toHaveLength(2);
    expect(statuses(card)).toContain("Mowing job sent to Luba");
  });

  it("never starts a mow from any control other than the confirm button", async () => {
    const hass = twoMowers();
    const card = await mount(hass, { type: "x", exact_route: false });

    await click(card, chip(card, "All"));
    await click(card, chip(card, "All"));
    await click(card, chip(card, "Back lawn"));
    await toggleOnMap(card, 111);
    await click(card, button(card, "Refresh map"));
    await click(card, button(card, "Next"));
    await editSettings(card, { pattern: "segment_grid", speed: 0.6 });
    for (const step of stepButtons(card)) await click(card, step);
    await click(card, button(card, "Back"));
    await click(card, button(card, "Next"));
    await openConfirm(card);
    await arm(card);
    await click(card, button(card, "Cancel"));
    for (const control of buttons(card).filter((b) => !b.disabled && textOf(b) !== "Start mowing")) {
      control.click();
    }
    await settle(card);
    await pick(card, YUKA);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(callsTo(hass, "start_mow")).toEqual([]);
    expect(new Set(hass.calls.map((call) => call.service))).toEqual(new Set(["get_geojson"]));
  });
});

describe("during a running job", () => {
  const mowing = (changes: Parameters<typeof withChanges>[1] = {}) =>
    lubaHass(withMap, withChanges(lubaEntities(), { [LUBA]: { state: "mowing" }, ...changes }));

  /** The settings controls by label, telling which are disabled. */
  const controls = (card: MowPlannerCard): Record<string, boolean> =>
    Object.fromEntries(
      [
        ...(panel(card).shadowRoot?.querySelectorAll<SegmentedControl | SliderControl>(
          "mow-planner-segmented, mow-planner-slider",
        ) ?? []),
      ].map((control) => [control.label, control.disabled]),
    );

  const notes = (card: MowPlannerCard) => [...root(card).querySelectorAll('[role="note"]')].map(textOf);

  async function toSettings(card: MowPlannerCard): Promise<void> {
    await click(card, button(card, "2Pattern"));
  }

  async function apply(card: MowPlannerCard): Promise<void> {
    await click(card, button(card, "Apply changes"));
    await armAndConfirm(card, "Apply now");
  }

  it("locks the areas and the map", async () => {
    const card = await mount(mowing());

    expect(textOf(root(card).querySelector(".hint"))).toBe("Areas can't change during a job");
    expect(chips(card).every((c) => c.disabled)).toBe(true);
    expect(mapEl(card).readonly).toBe(true);
    await toggleOnMap(card, 222);
    expect(pressed(card)).toEqual(["1Area Front"]);
    expect(button(card, "Next").disabled).toBe(false);
  });

  it("enables only what the running job can change, with one hint", async () => {
    const card = await mount(mowing());
    await toSettings(card);

    expect(notes(card)).toEqual(["Luba is on a job. Greyed-out settings can't change until it ends"]);
    expect(controls(card)).toEqual({
      Pattern: false,
      "Path angle": true,
      Angle: true,
      "Crossing angle": true,
      "Path spacing": false,
      "Perimeter laps": true,
      "No-go zone laps": false,
      "Mow first": true,
      Speed: false,
      "Cutting height": false,
      "Edge coverage": true,
      "Obstacle detection": false,
      "Auto-reverse direction": true,
      "Start from": false,
      Mow: true,
      "Dump grass": true,
      "Cut edges": true,
    });
  });

  it("shows the values the integration holds", async () => {
    const card = await mount(mowing());
    await toSettings(card);

    expect(panel(card).settings).toEqual(LUBA_SETTINGS);
  });

  it("locks every setting on a mower that cannot change a running job", async () => {
    const hass = mowing({
      "select.luba_cutting_angle_mode": {
        state: "relative_angle",
        attributes: { options: ["relative_angle", "absolute_angle"] },
      },
    });
    const card = await mount(hass);
    await toSettings(card);

    expect(notes(card)).toEqual(["Luba can't change a running job. Settings are shown for reference"]);
    expect(Object.values(controls(card)).every(Boolean)).toBe(true);

    await editSettings(card, { speed: 0.5 });
    await click(card, button(card, "Next"));
    expect(button(card, "Apply changes").disabled).toBe(true);
    await forceClick(card, button(card, "Apply changes"));
    expect(confirmation(card)).toBeNull();
  });

  it("offers Apply changes instead of Start, once something changeable is edited", async () => {
    const card = await mount(mowing());
    await click(card, button(card, "3Review"));

    expect(hasButton(card, "Start mowing")).toBe(false);
    expect(button(card, "Apply changes").disabled).toBe(true);
    expect(textOf(root(card).querySelector(".totals"))).toBe("No changes yet");
    expect(statuses(card)).toEqual([]);

    await toSettings(card);
    await editSettings(card, { speed: 0.5, bladeHeight: 40 });
    await click(card, button(card, "Next"));

    expect(button(card, "Apply changes").disabled).toBe(false);
    expect(textOf(root(card).querySelector(".totals"))).toBe("2 changes");
  });

  it("ignores edits to settings the job cannot change", async () => {
    const card = await mount(mowing());
    await toSettings(card);

    await editSettings(card, { angle: 10, perimeterLaps: 0 });

    expect(panel(card).settings).toEqual(LUBA_SETTINGS);
  });

  it("asks for confirmation, then sends only the edited settings to the running job", async () => {
    const hass = mowing();
    const card = await mount(hass);
    await toSettings(card);
    await editSettings(card, { speed: 0.5, obstacleDetection: 11, startProgress: 30 });
    await click(card, button(card, "Next"));

    await click(card, button(card, "Apply changes"));
    expect(textOf(confirmation(card))).toMatch(
      /^Change Speed, Obstacle detection, Start from on Luba's current job\?/,
    );
    expect(callsTo(hass, "modify_running_job")).toEqual([]);
    await armAndConfirm(card, "Apply now");

    expect(callsTo(hass, "modify_running_job")).toEqual([
      {
        domain: "mammotion",
        service: "modify_running_job",
        data: { speed: 0.5, ultra_wave: 11, start_progress: 30 },
        target: { entity_id: LUBA },
        notifyOnError: true,
        returnResponse: false,
      },
    ]);
    expect(callsTo(hass, "start_mow")).toEqual([]);
    expect(statuses(card)).toContain("Changes sent to Luba");
    expect(button(card, "Apply changes").disabled).toBe(true);

    await toSettings(card);
    await editSettings(card, { speed: 0.6 });
    await click(card, button(card, "Next"));
    expect(button(card, "Apply changes").disabled).toBe(false);
  });

  it("reports a failed change and lets the user retry", async () => {
    let refuse = true;
    const card = await mount(
      lubaHass(
        (service, call) => {
          if (service === "modify_running_job" && refuse) throw new Error("no_running_job");
          return withMap(service, call);
        },
        withChanges(lubaEntities(), { [LUBA]: { state: "mowing" } }),
      ),
    );
    await toSettings(card);
    await editSettings(card, { speed: 0.5 });
    await click(card, button(card, "Next"));

    await apply(card);
    expect(alerts(card)).toEqual(["Couldn't change the running job"]);

    refuse = false;
    await apply(card);
    expect(statuses(card)).toContain("Changes sent to Luba");
  });

  it("drops edits made before the job started", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await click(card, button(card, "Next"));
    await editSettings(card, { speed: 0.5 });

    await update(card, nextHass(hass, { [LUBA]: "mowing" }));

    expect(panel(card).settings.speed).toBe(0.4);
    await click(card, button(card, "Next"));
    expect(button(card, "Apply changes").disabled).toBe(true);
  });

  it("closes the confirmation, sending nothing, when the job ends meanwhile", async () => {
    const hass = mowing();
    const card = await mount(hass);
    await toSettings(card);
    await editSettings(card, { speed: 0.5 });
    await click(card, button(card, "Next"));
    await click(card, button(card, "Apply changes"));
    await arm(card);
    const confirm = button(card, "Apply now");

    await update(card, nextHass(hass, { [LUBA]: "docked" }));
    await forceClick(card, confirm);

    expect(confirmation(card)).toBeNull();
    expect(callsTo(hass, "modify_running_job")).toEqual([]);
    expect(hasButton(card, "Start mowing")).toBe(true);
  });

  it("disables everything while the change is in flight and sends it once", async () => {
    const applied = deferred();
    const hass = lubaHass(
      (service, call) => (service === "modify_running_job" ? applied.promise : withMap(service, call)),
      withChanges(lubaEntities(), { [LUBA]: { state: "mowing" } }),
    );
    const card = await mount(hass);
    await toSettings(card);
    await editSettings(card, { speed: 0.5 });
    await click(card, button(card, "Next"));
    await click(card, button(card, "Apply changes"));
    await arm(card);
    const confirm = button(card, "Apply now");
    await click(card, confirm);

    expect(button(card, "Applying…").disabled).toBe(true);
    expect(stepButtons(card).every((step) => step.disabled)).toBe(true);
    await forceClick(card, confirm);
    await forceClick(card, button(card, "Applying…"));
    applied.resolve(undefined);
    await settle(card);

    expect(callsTo(hass, "modify_running_job")).toHaveLength(1);
  });
});

describe("during a running job the integration reports", () => {
  const JOB = {
    areas: [222],
    speed: 0.3,
    channel_width: 22,
    ultra_wave: 1,
    auto_change_direction: 0,
    toward: 15,
  };

  const reporting = (running_job: unknown = JOB, running_job_modifiable = true) =>
    lubaHass(
      withMap,
      withChanges(lubaEntities(), {
        [LUBA]: {
          state: "mowing",
          attributes: { friendly_name: "Luba", running_job, running_job_modifiable },
        },
      }),
    );

  const disabled = (card: MowPlannerCard, label: string) =>
    [
      ...(panel(card).shadowRoot?.querySelectorAll<SegmentedControl | SliderControl>(
        "mow-planner-segmented, mow-planner-slider",
      ) ?? []),
    ].find((control) => control.label === label)?.disabled;

  it("selects the job's own areas", async () => {
    const card = await mount(reporting());

    expect(pressed(card)).toEqual(["1Back lawn"]);
  });

  it("shows the job's values and lets auto-reverse change", async () => {
    const hass = reporting();
    const card = await mount(hass);
    await click(card, button(card, "2Pattern"));

    expect(panel(card).settings).toMatchObject({
      speed: 0.3,
      spacingCm: 22,
      obstacleDetection: 1,
      autoChangeDirection: false,
      angle: 15,
      bladeHeight: 55,
    });
    expect(disabled(card, "Auto-reverse direction")).toBe(false);
    expect(disabled(card, "Angle")).toBe(true);

    await editSettings(card, { autoChangeDirection: true, speed: 0.3 });
    await click(card, button(card, "Next"));
    await click(card, button(card, "Apply changes"));
    await armAndConfirm(card, "Apply now");

    expect(callsTo(hass, "modify_running_job").map((call) => call.data)).toEqual([
      { auto_change_direction: 1 },
    ]);
  });

  it("locks everything with the hint when the integration says the job cannot change", async () => {
    const card = await mount(reporting(JOB, false));
    await click(card, button(card, "2Pattern"));

    expect(textOf(root(card).querySelector('[role="note"]'))).toBe(
      "Luba can't change a running job. Settings are shown for reference",
    );
    expect(disabled(card, "Speed")).toBe(true);
    expect(disabled(card, "Auto-reverse direction")).toBe(true);
  });

  it("plans a new job when the integration reports none, despite a mowing state", async () => {
    const card = await mount(reporting(null, false));
    await toReview(card);

    expect(hasButton(card, "Start mowing")).toBe(true);
    expect(statuses(card)).toContain("Luba is busy. Starting will end its current job");
  });
});

describe("mower picker", () => {
  it("lists every mower as the heading", async () => {
    const card = await mount(twoMowers());

    expect(picker(card).getAttribute("aria-label")).toBe("Mower");
    expect([...picker(card).options].map((option) => [option.value, textOf(option)])).toEqual([
      [LUBA, "Luba"],
      [YUKA, "Yuka"],
    ]);
    expect(root(card).querySelector("h2")).toBeNull();
  });

  it("shows the picked mower straight away with a fresh plan", async () => {
    const hass = twoMowers();
    const card = await mount(hass);
    await click(card, chip(card, "Back lawn"));
    await click(card, button(card, "Next"));
    await editSettings(card, { spacingCm: 33 });

    await pick(card, YUKA);

    expect(currentStep(card)).toBe("1Areas");
    expect(pressed(card)).toEqual(["1Luba Back lawn"]);
    expect(callsTo(hass, "get_geojson").map((call) => call.target)).toEqual([
      { entity_id: LUBA },
      { entity_id: YUKA },
    ]);

    await pick(card, LUBA);
    expect(pressed(card)).toEqual(["1Area Front"]);
    await click(card, button(card, "Next"));
    expect(panel(card).settings).toEqual(LUBA_SETTINGS);
  });

  it("starts the picked mower without waiting for a hass update", async () => {
    const hass = twoMowers();
    const card = await mount(hass);
    await pick(card, YUKA);
    await toReview(card);

    await startMowing(card);

    expect(callsTo(hass, "start_mow").map((call) => [call.target, call.data?.areas])).toEqual([
      [{ entity_id: YUKA }, ["switch.yuka_back_lawn"]],
    ]);
  });

  it("loads each mower's map once while switching back and forth", async () => {
    const hass = twoMowers();
    const card = await mount(hass);

    await pick(card, YUKA);
    await pick(card, LUBA);
    await pick(card, YUKA);

    expect(callsTo(hass, "get_geojson").map((call) => call.target)).toEqual([
      { entity_id: LUBA },
      { entity_id: YUKA },
    ]);
    expect(mapOf(card)).not.toBeNull();

    await click(card, button(card, "Refresh map"));
    expect(callsTo(hass, "get_geojson").map((call) => call.target)).toContainEqual({ entity_id: YUKA });
    expect(callsTo(hass, "get_geojson")).toHaveLength(3);
  });

  it("names a mower's map areas after its own switches when its map arrives after a switch", async () => {
    const lubaMap = deferred();
    const hass = twoMowers((service, call) =>
      service === "get_geojson" && call.target?.entity_id === LUBA ? lubaMap.promise : withMap(service, call),
    );
    const card = await mount(hass);
    await pick(card, YUKA);

    lubaMap.resolve(MAP);
    await settle(card);
    await pick(card, LUBA);

    expect(mapEl(card).model?.areas.map((area) => area.name)).toEqual(["Area Front", "Back lawn"]);
  });

  it("keeps the picked mower while its state is briefly missing", async () => {
    const hass = twoMowers();
    const card = await mount(hass);
    await pick(card, YUKA);

    await update(card, nextHass(hass, { [YUKA]: null }));
    await update(card, nextHass(hass));

    expect(picker(card).value).toBe(YUKA);
    expect(pressed(card)).toEqual(["1Luba Back lawn"]);
    expect(callsTo(hass, "get_geojson")).toHaveLength(2);
  });

  it("offers only the configured mowers", async () => {
    const hass = twoMowers();
    const card = await mount(hass, { type: "x", entities: [YUKA] });

    expect(root(card).querySelector("select")).toBeNull();
    expect(textOf(root(card).querySelector("h2"))).toBe("Yuka");
    expect(callsTo(hass, "get_geojson").map((call) => call.target)).toEqual([{ entity_id: YUKA }]);
  });

  it("still lists a configured mower that has no state", async () => {
    const card = await mount(lubaHass(), { type: "x", entities: [LUBA, "lawn_mower.gone"] });

    expect([...picker(card).options].map((option) => option.value)).toEqual([LUBA, "lawn_mower.gone"]);
    expect(textOf(root(card).querySelector("header"))).toContain("Docked");
  });

  it("lets the user pick another mower when the first configured one has no state", async () => {
    const card = await mount(lubaHass(), { type: "x", entities: ["lawn_mower.gone", LUBA] });

    expect(root(card).querySelector("select")).not.toBeNull();
  });
});

describe("exact route", () => {
  const routeHass = (route: unknown, state = "docked") =>
    lubaHass(
      (service, call) =>
        service === "get_geojson"
          ? MAP
          : service === "plan_route"
            ? typeof route === "function"
              ? (route as Responder)(service, call)
              : entityResponse(LUBA, route)
            : undefined,
      withChanges(lubaEntities(), { [LUBA]: { state } }),
    );

  const ROUTE_CONFIRM = "Ask Luba to plan this route? It won't start mowing.";

  const planData = (hass: FakeHass) => callsTo(hass, "plan_route").map((call) => call.data);

  it("is not offered by default", async () => {
    const card = await mount(lubaHass());
    await toReview(card);
    expect(hasButton(card, "Get route from mower")).toBe(false);
  });

  it("is not offered by an integration without mammotion.plan_route", async () => {
    const hass = { ...routeHass(ROUTE), services: { mammotion: { start_mow: {} } } };
    const card = await mount(hass, { type: "x", exact_route: true });
    await toReview(card);
    expect(hasButton(card, "Get route from mower")).toBe(false);
  });

  it("asks for confirmation before asking the mower", async () => {
    const hass = routeHass(ROUTE);
    const card = await mount(hass, { type: "x", exact_route: true });
    await toReview(card);

    await click(card, button(card, "Get route from mower"));

    expect(textOf(confirmation(card)?.querySelector("p"))).toBe(ROUTE_CONFIRM);
    expect(button(card, "Get route").disabled).toBe(true);
    expect(hass.calls.map((call) => call.service)).toEqual(["get_geojson"]);
    await click(card, button(card, "Cancel"));
    expect(hass.calls.map((call) => call.service)).toEqual(["get_geojson"]);
  });

  it("plans once confirmed, in one call that returns the plan's own route, and shows it", async () => {
    const hass = routeHass({ ...ROUTE, plan: { path_hash: "77" } });
    const card = await mount(hass, { type: "x", exact_route: true });
    await toReview(card);

    await click(card, button(card, "Get route from mower"));
    await armAndConfirm(card, "Get route");

    expect(hass.calls.map((call) => call.service)).toEqual(["get_geojson", "plan_route"]);
    expect(planData(hass)).toEqual([{ areas: [FRONT], ...LUBA_FIELDS }]);
    expect(callsTo(hass, "plan_route")[0]).toMatchObject({
      target: { entity_id: LUBA },
      returnResponse: true,
    });
    const route = mapEl(card).route;
    expect(route).toHaveLength(1);
    expect(route?.[0]).toHaveLength(3);
    expect(callsTo(hass, "start_mow")).toEqual([]);
  });

  it("sends only held or edited settings with the route request", async () => {
    const hass = lubaHass(
      (service) =>
        service === "get_geojson" ? MAP : service === "plan_route" ? entityResponse(LUBA, ROUTE) : undefined,
      withChanges(lubaEntities(), { "number.luba_blade_height": { state: "unknown" } }),
    );
    const card = await mount(hass, { type: "x", exact_route: true });
    await toReview(card);

    await click(card, button(card, "Get route from mower"));
    await armAndConfirm(card, "Get route");

    expect(planData(hass)).toEqual([{ areas: [FRONT], ...without(LUBA_FIELDS, "blade_height") }]);
  });

  it("disables everything and starts nothing while the mower plans", async () => {
    const planned = deferred();
    const hass = routeHass(() => planned.promise);
    const card = await mount(hass, { type: "x", exact_route: true });
    await toReview(card);
    await click(card, button(card, "Get route from mower"));
    await armAndConfirm(card, "Get route");

    expect(button(card, "Getting route from mower…").disabled).toBe(true);
    expect(button(card, "Start mowing").disabled).toBe(true);
    expect(button(card, "Back").disabled).toBe(true);
    expect(button(card, "Refresh map").disabled).toBe(true);
    expect(stepButtons(card).every((step) => step.disabled)).toBe(true);
    expect(mapEl(card).readonly).toBe(true);
    await forceClick(card, button(card, "Start mowing"));
    await forceClick(card, button(card, "Getting route from mower…"));
    await arm(card);
    planned.resolve(entityResponse(LUBA, ROUTE));
    await settle(card);

    expect(confirmation(card)).toBeNull();
    expect(callsTo(hass, "plan_route")).toHaveLength(1);
    expect(callsTo(hass, "start_mow")).toEqual([]);
    expect(mapEl(card).route).toHaveLength(1);
  });

  it("shows the integration's reason when the mower shares no route", async () => {
    const hass = routeHass(() => serviceError("Luba did not share the route it planned."));
    const card = await mount(hass, { type: "x", exact_route: true });
    await toReview(card);

    await click(card, button(card, "Get route from mower"));
    await armAndConfirm(card, "Get route");

    expect(statuses(card)).toContain("Luba did not share the route it planned.");
    expect(mapEl(card).route).toBeUndefined();
    expect(button(card, "Start mowing").disabled).toBe(false);
  });

  it("falls back to a general message when the integration gives none", async () => {
    const card = await mount(routeHass({ type: "FeatureCollection", features: [] }), {
      type: "x",
      exact_route: true,
    });
    await toReview(card);

    await click(card, button(card, "Get route from mower"));
    await armAndConfirm(card, "Get route");

    expect(statuses(card)).toContain("The mower didn't share a route");
  });

  it.each(["mowing", "paused", "returning"])("is not offered while the mower is %s", async (state) => {
    const card = await mount(routeHass(ROUTE, state), { type: "x", exact_route: true });
    await toReview(card);
    expect(hasButton(card, "Get route from mower")).toBe(false);
  });

  it("is not offered while a start is being confirmed or has been sent", async () => {
    const card = await mount(routeHass(ROUTE), { type: "x", exact_route: true });
    await toReview(card);

    await openConfirm(card);
    expect(hasButton(card, "Get route from mower")).toBe(false);
    await armAndConfirm(card);

    expect(statuses(card)).toContain("Mowing job sent to Luba");
    expect(hasButton(card, "Get route from mower")).toBe(false);
  });

  it("does not plan once the mower has started a job meanwhile", async () => {
    const hass = routeHass(ROUTE);
    const card = await mount(hass, { type: "x", exact_route: true });
    await toReview(card);
    await click(card, button(card, "Get route from mower"));
    await arm(card);

    await update(card, nextHass(hass, { [LUBA]: "mowing" }));
    if (confirmation(card)) await click(card, button(card, "Get route"));

    expect(callsTo(hass, "plan_route")).toEqual([]);
  });
});

describe("optimal direction from a plan", () => {
  /** Passes 0.5 m apart at `deg` across the Front square (0..20 m), as the mower's planned route. */
  const plannedRoute = (deg: number): FeatureCollection => {
    const u = { x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) };
    const at = (s: number, t: number) => lonLat(10 + u.x * s - u.y * t, 10 + u.y * s + u.x * t);
    return {
      type: "FeatureCollection",
      features: Array.from({ length: 20 }, (_, i) => ({
        type: "Feature",
        properties: { type_name: "mow_path" },
        geometry: { type: "LineString", coordinates: [at(-6, -5 + i * 0.5), at(6, -5 + i * 0.5)] },
      })),
    };
  };

  const optimalHass = (route: unknown, state = "docked") =>
    lubaHass(
      (service) => {
        if (service === "get_geojson") return MAP;
        if (service !== "plan_route") return undefined;
        if (route instanceof Error) return serviceError(route.message);
        return entityResponse(LUBA, route);
      },
      withChanges(lubaEntities(), {
        [LUBA]: { state },
        "select.luba_cutting_angle_mode": {
          state: "relative_angle",
          attributes: { options: ["relative_angle", "absolute_angle", "random_angle"] },
        },
        "number.luba_cutting_angle": { state: "10" },
      }),
    );

  const status = (card: MowPlannerCard) => textOf(panel(card).shadowRoot?.querySelector(".optimal"));

  async function findOptimal(card: MowPlannerCard): Promise<void> {
    const find = panel(card).shadowRoot?.querySelector<HTMLButtonElement>(".optimal button");
    if (!find) throw new Error("no Find optimal direction button");
    find.click();
    await settle(card);
    await armAndConfirm(card, "Ask mower");
  }

  it("guesses the direction until asked, and says so", async () => {
    const card = await mount(optimalHass(plannedRoute(60)));
    await click(card, button(card, "Next"));

    expect(status(card)).toBe("The preview guesses the mower's direction Find optimal direction");
    expect(mapEl(card).note).toBe("Preview is approximate: the mower picks the final direction");
    expect(panel(card).angleBase).toBe(0);
  });

  it("plans plain stripes at no offset after confirmation, then draws at the planned direction plus the angle", async () => {
    const hass = optimalHass(plannedRoute(60));
    const card = await mount(hass);
    await click(card, button(card, "Next"));

    await findOptimal(card);

    expect(textOf(confirmation(card))).toBe("");
    expect(hass.calls.map((call) => call.service)).toEqual(["get_geojson", "plan_route"]);
    expect(callsTo(hass, "plan_route")[0]?.data).toEqual({
      areas: [FRONT],
      ...LUBA_FIELDS,
      channel_mode: 0,
      toward_mode: 0,
      toward: 0,
    });
    expect(status(card)).toBe("Direction from the mower's plan");
    expect(panel(card).angleBase).toBeCloseTo(60, 3);
    expect(mapEl(card).previews[0]?.directionDeg).toBeCloseTo(70, 3);
    expect(mapEl(card).note).toBeUndefined();
  });

  it("shows the confirmation text before asking", async () => {
    const hass = optimalHass(plannedRoute(60));
    const card = await mount(hass);
    await click(card, button(card, "Next"));
    panel(card).shadowRoot?.querySelector<HTMLButtonElement>(".optimal button")?.click();
    await settle(card);

    expect(textOf(confirmation(card)?.querySelector("p"))).toBe(
      "Ask Luba to plan these areas to learn its direction? It won't start mowing.",
    );
    expect(callsTo(hass, "plan_route")).toEqual([]);
  });

  it("asks again for an area added later, keeping what it learnt", async () => {
    const card = await mount(optimalHass(plannedRoute(60)));
    await click(card, button(card, "Next"));
    await findOptimal(card);

    await click(card, button(card, "1Areas"));
    await click(card, chip(card, "Back lawn"));
    await click(card, button(card, "Next"));

    expect(status(card)).toBe("The preview guesses the mower's direction Find optimal direction");
    expect(panel(card).angleBase).toBeCloseTo(60, 3);
  });

  it("reports a route without a clear direction and offers to ask again", async () => {
    const card = await mount(optimalHass({ type: "FeatureCollection", features: [] }));
    await click(card, button(card, "Next"));

    await findOptimal(card);

    expect(status(card)).toBe("The mower didn't share a plan Find optimal direction");
  });

  it("shows the integration's own reason when it refuses or gets no route", async () => {
    const card = await mount(optimalHass(new Error("Luba did not share the route it planned.")));
    await click(card, button(card, "Next"));

    await findOptimal(card);

    expect(status(card)).toBe("Luba did not share the route it planned. Find optimal direction");
  });

  it("says a newer integration is needed instead of offering it on one without mammotion.plan_route", async () => {
    const hass = { ...optimalHass(plannedRoute(60)), services: { mammotion: { start_mow: {} } } };
    const card = await mount(hass);
    await click(card, button(card, "Next"));

    expect(status(card)).toBe("Finding it needs Mammotion integration 0.6.24 or newer");
    expect(mapEl(card).note).toBe("Preview is approximate: the mower picks the final direction");
  });

  it("never asks a busy mower", async () => {
    const hass = optimalHass(plannedRoute(60), "paused");
    const card = await mount(hass);
    await click(card, button(card, "2Pattern"));

    expect(panel(card).shadowRoot?.querySelector(".optimal")).toBeNull();
    expect(callsTo(hass, "plan_route")).toEqual([]);
  });

  it("turns the dial's zero by the angle offset in Custom mode", async () => {
    const card = await mount(lubaHass(), { type: "x", angle_offset: 25 });
    await click(card, button(card, "Next"));

    expect(panel(card).angleBase).toBe(25);
  });
});

describe("registration", () => {
  it("defines the custom element", () => {
    expect(customElements.get(CARD_TYPE)).toBe(MowPlannerCard);
  });

  it("survives the bundle being loaded twice, listing the card once", async () => {
    vi.resetModules();
    await expect(import("../src/card")).resolves.toHaveProperty("MowPlannerCard");

    expect(window.customCards?.filter((card) => card.type === CARD_TYPE)).toHaveLength(1);
    expect(customElements.get(CARD_TYPE)).toBe(MowPlannerCard);
    for (const tag of [
      "mow-planner-map",
      "mow-planner-settings",
      "mow-planner-segmented",
      "mow-planner-slider",
    ]) {
      expect(customElements.get(tag), tag).toBeDefined();
    }
  });

  it("provides a valid stub config, the editor form and layout hints", async () => {
    expect(normalizeConfig(MowPlannerCard.getStubConfig())).toEqual(MowPlannerCard.getStubConfig());
    expect(MowPlannerCard.getConfigForm()).toBe(configForm);
    const card = await mount(lubaHass());
    expect(card.getCardSize()).toBeGreaterThan(0);
    expect(card.getGridOptions()).toHaveProperty("columns");
  });
});

describe("language", () => {
  it("renders the steps in the user's language", async () => {
    const card = await mount({ ...lubaHass(), language: "de" });
    expect(stepButtons(card).map(textOf)).toEqual(["1Flächen", "2Muster", "3Übersicht"]);
  });

  it("lays out right-to-left for an RTL language", async () => {
    const rtl = await mount({
      ...lubaHass(),
      language: "he",
      translationMetadata: { translations: { he: { isRTL: true } } },
    });
    const ltr = await mount(lubaHass());
    expect(rtl.dir).toBe("rtl");
    expect(ltr.dir).toBe("ltr");
  });
});
