import type { Feature, FeatureCollection, Position } from "geojson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MowPlannerCard } from "../src/card";
import type { MowMap } from "../src/components/map-view";
import type { MowSettingsPanel } from "../src/components/settings-panel";
import { CARD_TYPE, configForm, normalizeConfig } from "../src/config";
import { startMowData } from "../src/ha/mower";
import type { MowSettings } from "../src/model";
import {
  device,
  lubaEntities,
  makeHass,
  withChanges,
  type FakeEntity,
  type FakeHass,
  type ServiceCall,
} from "./ha/_helpers";

const ORIGIN = { lon: 4.9, lat: 52.3 };
const DEG_PER_M = 1 / 111_111;

const lonLat = (x: number, y: number): Position => [
  ORIGIN.lon + (x * DEG_PER_M) / Math.cos((ORIGIN.lat * Math.PI) / 180),
  ORIGIN.lat + y * DEG_PER_M,
];

const square = (hash: number, Name: string, x: number, size: number): Feature => ({
  type: "Feature",
  properties: { type_name: "area", hash, Name, area: size * size },
  geometry: {
    type: "Polygon",
    coordinates: [[lonLat(x, 0), lonLat(x + size, 0), lonLat(x + size, size), lonLat(x, size)]],
  },
});

const MAP: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    square(111, "Front", 0, 20),
    square(222, "Back", 30, 16),
    {
      type: "Feature",
      properties: { type_name: "station", Name: "Dock", rotation: 90 },
      geometry: { type: "Point", coordinates: lonLat(-2, -2) },
    },
  ],
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
};
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

/** A later `hass` object from HA: same services and call log, new states. */
function nextHass(hass: FakeHass, changes: Readonly<Record<string, string>> = {}): FakeHass {
  const states = { ...hass.states };
  for (const [entityId, state] of Object.entries(changes)) {
    const current = states[entityId];
    if (current) states[entityId] = { ...current, state };
  }
  return { ...hass, states };
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

async function mount(
  hass: FakeHass,
  config: Record<string, unknown> = { type: `custom:${CARD_TYPE}` },
): Promise<MowPlannerCard> {
  const card = createCard();
  card.setConfig(config);
  card.hass = hass;
  document.body.append(card);
  mounted.push(card);
  await settle(card);
  return card;
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

const currentStep = (card: MowPlannerCard) => textOf(root(card).querySelector('[aria-current="step"]'));

async function click(card: MowPlannerCard, target: HTMLElement): Promise<void> {
  target.click();
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

async function openConfirm(card: MowPlannerCard): Promise<void> {
  await click(card, button(card, "Start mowing"));
}

async function armAndConfirm(card: MowPlannerCard): Promise<void> {
  await openConfirm(card);
  await vi.advanceTimersByTimeAsync(600);
  await settle(card);
  await click(card, button(card, "Start now"));
}

const callsTo = (hass: FakeHass, service: string) => hass.calls.filter((c) => c.service === service);

const realStarts = (hass: FakeHass) => callsTo(hass, "start_mow").filter((c) => c.data?.plan_only !== true);

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
});

describe("no mower", () => {
  it("shows the no-mower message until a mower appears", async () => {
    const card = await mount(makeHass([{ entity_id: "light.porch", state: "on", platform: "hue" }]));
    expect(statuses(card)).toEqual(["No Mammotion mower found"]);

    const hass = lubaHass();
    card.hass = hass;
    await settle(card);

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
    expect(textOf(root(card).querySelector(".map"))).toBe("No map from the mower yet");
    await click(card, chip(card, "Back lawn"));
    expect(pressed(card)).toEqual(["All", "1Area Front", "2Back lawn"]);
  });

  it("shows an error when the map call is rejected", async () => {
    const card = await mount(
      lubaHass(() => {
        throw new Error("integration down");
      }),
    );
    expect(textOf(root(card).querySelector(".map"))).toBe("Couldn't load the map");
  });

  it("asks again when refreshed", async () => {
    const hass = lubaHass();
    const card = await mount(hass);

    await click(card, button(card, "Refresh map"));

    expect(callsTo(hass, "get_geojson")).toHaveLength(2);
    expect(mapOf(card)).not.toBeNull();
  });

  it("does not refetch the map on frequent hass updates", async () => {
    const hass = lubaHass();
    const card = await mount(hass);

    for (let i = 0; i < 5; i++) {
      card.hass = nextHass(hass);
      await settle(card);
    }
    card.hass = nextHass(hass, { "sensor.luba_battery": "60" });
    await settle(card);

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

    mapEl(card).dispatchEvent(
      new CustomEvent("area-toggle", { detail: { hash: 222 }, bubbles: true, composed: true }),
    );
    await settle(card);
    expect(pressed(card)).toEqual(["All", "1Area Front", "2Back lawn"]);

    mapEl(card).dispatchEvent(
      new CustomEvent("area-toggle", { detail: { hash: 111 }, bubbles: true, composed: true }),
    );
    await settle(card);
    expect(pressed(card)).toEqual(["1Back lawn"]);
  });

  it("ignores map toggles for areas without a switch", async () => {
    const card = await mount(lubaHass());

    mapEl(card).dispatchEvent(
      new CustomEvent("area-toggle", { detail: { hash: 999 }, bubbles: true, composed: true }),
    );
    await settle(card);

    expect(pressed(card)).toEqual(["1Area Front"]);
  });

  it("blocks Next with an alert when nothing is selected", async () => {
    const card = await mount(lubaHass());

    await click(card, chip(card, "Area Front"));

    expect(button(card, "Next").disabled).toBe(true);
    expect(alerts(card)).toEqual(["Select at least one area"]);
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
});

describe("review step", () => {
  it("summarises the plan", async () => {
    const card = await mount(lubaHass());
    await click(card, chip(card, "Back lawn"));
    await toReview(card);

    expect(currentStep(card)).toBe("3Review");
    expect(rows(card)).toMatchObject({
      Areas: "Area Front → Back lawn",
      Pattern: "Grid",
      "Path angle": "Custom, 30°",
      "Crossing angle": "60°",
      "Path spacing": "28 cm",
      "Perimeter laps": "2",
      "No-go zone laps": "3",
      "Mow first": "Inside",
      Speed: "0.4 m/s",
      "Cutting height": "55 mm",
    });
    expect(rows(card)["Estimated time"]).toMatch(/^about (\d+ h )?\d+ min$/);
    expect(rows(card)["Path length"]).toMatch(/^\d+\.\d km$/);
    expect(textOf(root(card).querySelector(".totals"))).toMatch(/^2 areas · \d+ m² · about/);
  });

  it("leaves out the time estimate without a map", async () => {
    const card = await mount(lubaHass(() => ({})));
    await toReview(card);

    expect(rows(card)).not.toHaveProperty("Estimated time");
    expect(rows(card)).toMatchObject({ Areas: "Area Front" });
  });

  it("shows the random angle mode without a value", async () => {
    const card = await mount(lubaHass());
    await click(card, button(card, "Next"));
    await editSettings(card, { angleMode: "random_angle" });
    await click(card, button(card, "Next"));

    expect(rows(card)["Path angle"]).toBe("Random");
  });

  it("makes the map read-only", async () => {
    const card = await mount(lubaHass());
    expect(mapEl(card).readonly).toBe(false);
    await toReview(card);
    expect(mapEl(card).readonly).toBe(true);
  });

  it("warns that a busy mower will end its current job", async () => {
    const card = await mount(lubaHass(withMap, withChanges(lubaEntities(), { [LUBA]: { state: "mowing" } })));
    await toReview(card);

    expect(alerts(card)).toEqual(["Luba is busy. Starting will end its current job"]);
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
    await click(card, button(card, "Next"));

    expect(alerts(card)).toEqual(["The Perimeter pattern needs at least one perimeter or no-go zone lap"]);
    expect(button(card, "Start mowing").disabled).toBe(true);
  });
});

describe("starting", () => {
  it("asks for confirmation before sending anything", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);

    await openConfirm(card);

    const dialog = root(card).querySelector('[role="alertdialog"]');
    expect(textOf(dialog)).toMatch(/^Send Luba out to mow 1 area · 400 m² · about (\d+ h )?\d+ min\?/);
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

  it.fails(
    "keeps the confirm button disarmed for the full delay after reopening it (BUG: stale arm timer)",
    async () => {
      const card = await mount(lubaHass());
      await toReview(card);
      await openConfirm(card);
      await vi.advanceTimersByTimeAsync(500);
      await click(card, button(card, "Cancel"));
      await openConfirm(card);

      await vi.advanceTimersByTimeAsync(200);
      await settle(card);

      expect(button(card, "Start now").disabled).toBe(true);
    },
  );

  it("returns without any call when cancelled", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await toReview(card);
    await openConfirm(card);
    await vi.advanceTimersByTimeAsync(600);

    await click(card, button(card, "Cancel"));

    expect(root(card).querySelector('[role="alertdialog"]')).toBeNull();
    expect(hasButton(card, "Start mowing")).toBe(true);
    expect(callsTo(hass, "start_mow")).toEqual([]);
  });

  it("sends one start_mow with the confirmed areas in click order and the edited settings", async () => {
    const hass = lubaHass();
    const card = await mount(hass);
    await click(card, chip(card, "Back lawn"));
    await click(card, chip(card, "Area Front"));
    await click(card, chip(card, "Area Front"));
    await click(card, button(card, "Next"));
    await editSettings(card, { pattern: "single_grid", spacingCm: 30, angle: -45 });
    const settings = panel(card).settings;
    await click(card, button(card, "Next"));

    await armAndConfirm(card);

    const starts = callsTo(hass, "start_mow");
    expect(starts).toEqual([
      {
        domain: "mammotion",
        service: "start_mow",
        data: startMowData(settings, [BACK, FRONT]),
        target: { entity_id: LUBA },
        notifyOnError: true,
        returnResponse: false,
      },
    ]);
    expect(starts[0]?.data).toMatchObject({
      areas: [BACK, FRONT],
      channel_mode: 0,
      channel_width: 30,
      toward: -45,
    });
    expect(starts[0]?.data).not.toHaveProperty("plan_only");
    expect(statuses(card)).toContain("Mowing job sent to Luba");
  });

  it("does not send twice while the first start is in flight", async () => {
    const started = deferred();
    const hass = lubaHass((service) =>
      service === "start_mow" ? started.promise : service === "get_geojson" ? MAP : undefined,
    );
    const card = await mount(hass);
    await toReview(card);
    await openConfirm(card);
    await vi.advanceTimersByTimeAsync(600);
    await settle(card);
    const confirm = button(card, "Start now");

    await click(card, confirm);
    await click(card, confirm);

    expect(button(card, "Starting…").disabled).toBe(true);
    await click(card, button(card, "Starting…"));
    expect(callsTo(hass, "start_mow")).toHaveLength(1);

    started.resolve(undefined);
    await settle(card);
    expect(statuses(card)).toContain("Mowing job sent to Luba");
    expect(callsTo(hass, "start_mow")).toHaveLength(1);
  });

  it("reports a failed start and lets the user retry", async () => {
    let fail = true;
    const hass = lubaHass((service) => {
      if (service === "start_mow" && fail) throw new Error("rejected");
      return service === "get_geojson" ? MAP : undefined;
    });
    const card = await mount(hass);
    await toReview(card);

    await armAndConfirm(card);
    expect(alerts(card)).toEqual(["Couldn't start mowing"]);
    expect(button(card, "Start mowing").disabled).toBe(false);

    fail = false;
    await armAndConfirm(card);
    expect(callsTo(hass, "start_mow")).toHaveLength(2);
    expect(statuses(card)).toContain("Mowing job sent to Luba");
  });

  it.fails(
    "sends the areas that were confirmed even if area switches change meanwhile (BUG: unconfirmed areas sent)",
    async () => {
      const hass = lubaHass();
      const card = await mount(hass);
      await toReview(card);
      await openConfirm(card);
      await vi.advanceTimersByTimeAsync(600);
      card.hass = nextHass(hass, { [FRONT]: "off", [BACK]: "on" });
      await settle(card);

      await click(card, button(card, "Start now"));

      expect(callsTo(hass, "start_mow")[0]?.data?.areas).toEqual([FRONT]);
    },
  );

  it("never starts a mow from any control other than the confirm button", async () => {
    const hass = makeHass(
      [...lubaEntities(), ...lubaEntities("dev2", "yuka")],
      [device("dev1", "Luba"), device("dev2", "Yuka")],
      withMap,
    );
    const card = await mount(hass, { type: "x", exact_route: false });

    await click(card, chip(card, "All"));
    await click(card, chip(card, "All"));
    await click(card, chip(card, "Back lawn"));
    mapEl(card).dispatchEvent(
      new CustomEvent("area-toggle", { detail: { hash: 111 }, bubbles: true, composed: true }),
    );
    await click(card, button(card, "Refresh map"));
    await click(card, button(card, "Next"));
    await editSettings(card, { pattern: "segment_grid", speed: 0.6 });
    for (const step of [...root(card).querySelectorAll<HTMLButtonElement>("button.step")]) {
      await click(card, step);
    }
    await click(card, button(card, "Back"));
    await click(card, button(card, "Next"));
    await openConfirm(card);
    await vi.advanceTimersByTimeAsync(600);
    await click(card, button(card, "Cancel"));
    for (const control of buttons(card).filter((b) => !b.disabled && textOf(b) !== "Start mowing")) {
      control.click();
    }
    await settle(card);
    const picker = root(card).querySelector("select");
    if (!picker) throw new Error("no mower picker");
    picker.value = "lawn_mower.yuka";
    picker.dispatchEvent(new Event("change"));
    await settle(card);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(callsTo(hass, "start_mow")).toEqual([]);
    expect(new Set(hass.calls.map((call) => call.service))).toEqual(new Set(["get_geojson"]));
  });
});

describe("mower picker", () => {
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

  const picker = (card: MowPlannerCard): HTMLSelectElement => {
    const select = root(card).querySelector("select");
    if (!select) throw new Error("no mower picker");
    return select;
  };

  async function pick(card: MowPlannerCard, entityId: string): Promise<void> {
    picker(card).value = entityId;
    picker(card).dispatchEvent(new Event("change"));
    await settle(card);
  }

  it("lists every mower", async () => {
    const card = await mount(twoMowers());

    expect(picker(card).getAttribute("aria-label")).toBe("Mower");
    expect([...picker(card).options].map((option) => [option.value, textOf(option)])).toEqual([
      [LUBA, "Luba"],
      ["lawn_mower.yuka", "Yuka"],
    ]);
    expect(root(card).querySelector("h2")).toBeNull();
  });

  it("loads the picked mower's map and starts its plan afresh", async () => {
    const hass = twoMowers();
    const card = await mount(hass);
    await click(card, chip(card, "Back lawn"));
    await click(card, button(card, "Next"));
    await editSettings(card, { spacingCm: 33 });

    await pick(card, "lawn_mower.yuka");
    card.hass = nextHass(hass);
    await settle(card);

    expect(callsTo(hass, "get_geojson").map((call) => call.target)).toEqual([
      { entity_id: LUBA },
      { entity_id: "lawn_mower.yuka" },
    ]);
    expect(currentStep(card)).toBe("1Areas");
    expect(pressed(card)).toEqual(["1Luba Back lawn"]);

    await pick(card, LUBA);
    card.hass = nextHass(hass);
    await settle(card);
    expect(currentStep(card)).toBe("1Areas");
    expect(pressed(card)).toEqual(["1Area Front"]);
    await click(card, button(card, "Next"));
    expect(panel(card).settings).toEqual(LUBA_SETTINGS);
  });

  it("starts the picked mower once HA has sent its next update", async () => {
    const hass = twoMowers();
    const card = await mount(hass);
    await pick(card, "lawn_mower.yuka");
    card.hass = nextHass(hass);
    await settle(card);
    await toReview(card);

    await armAndConfirm(card);

    expect(callsTo(hass, "start_mow").map((call) => [call.target, call.data?.areas])).toEqual([
      [{ entity_id: "lawn_mower.yuka" }, ["switch.yuka_back_lawn"]],
    ]);
  });

  it.fails(
    "shows and starts the picked mower straight away (BUG: picker keeps the previous mower until the next hass update)",
    async () => {
      const hass = twoMowers();
      const card = await mount(hass);
      await pick(card, "lawn_mower.yuka");

      expect(pressed(card)).toEqual(["1Luba Back lawn"]);
      await toReview(card);
      await armAndConfirm(card);

      expect(callsTo(hass, "start_mow").map((call) => [call.target, call.data?.areas])).toEqual([
        [{ entity_id: "lawn_mower.yuka" }, ["switch.yuka_back_lawn"]],
      ]);
    },
  );

  it("offers only the configured mowers", async () => {
    const hass = twoMowers();
    const card = await mount(hass, { type: "x", entities: ["lawn_mower.yuka"] });

    expect(root(card).querySelector("select")).toBeNull();
    expect(textOf(root(card).querySelector("h2"))).toBe("Yuka");
    expect(callsTo(hass, "get_geojson").map((call) => call.target)).toEqual([
      { entity_id: "lawn_mower.yuka" },
    ]);
  });
});

describe("exact route", () => {
  const routeHass = (route: unknown, state = "docked") =>
    lubaHass(
      (service) => (service === "get_geojson" ? MAP : service === "get_mow_path_geojson" ? route : undefined),
      withChanges(lubaEntities(), { [LUBA]: { state } }),
    );

  it("is not offered by default", async () => {
    const card = await mount(lubaHass());
    await toReview(card);
    expect(hasButton(card, "Get route from mower")).toBe(false);
  });

  it("plans on the mower, then fetches and shows its route", async () => {
    const hass = routeHass(ROUTE);
    const card = await mount(hass, { type: "x", exact_route: true });
    await toReview(card);

    await click(card, button(card, "Get route from mower"));
    expect(button(card, "Getting route from mower…").disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await settle(card);

    expect(hass.calls.map((call) => call.service)).toEqual([
      "get_geojson",
      "start_mow",
      "fetch_mow_path",
      "get_mow_path_geojson",
    ]);
    expect(callsTo(hass, "start_mow")[0]?.data).toEqual(startMowData(LUBA_SETTINGS, [FRONT], true));
    expect(callsTo(hass, "get_mow_path_geojson")[0]).toMatchObject({
      target: { entity_id: LUBA },
      returnResponse: true,
    });
    const route = mapEl(card).route;
    expect(route).toHaveLength(1);
    expect(route?.[0]).toHaveLength(3);
    expect(realStarts(hass)).toEqual([]);
  });

  it("reports when the mower shares no route", async () => {
    const hass = routeHass({});
    const card = await mount(hass, { type: "x", exact_route: true });
    await toReview(card);

    await click(card, button(card, "Get route from mower"));
    await vi.advanceTimersByTimeAsync(20_000);
    await settle(card);

    expect(callsTo(hass, "get_mow_path_geojson")).toHaveLength(10);
    expect(statuses(card)).toContain("The mower didn't share a route");
    expect(mapEl(card).route).toBeUndefined();
  });

  it("is not offered while the mower is mowing", async () => {
    const card = await mount(routeHass(ROUTE, "mowing"), { type: "x", exact_route: true });
    await toReview(card);
    expect(hasButton(card, "Get route from mower")).toBe(false);
  });
});

describe("registration", () => {
  it("defines the custom element", () => {
    expect(customElements.get(CARD_TYPE)).toBe(MowPlannerCard);
  });

  it.fails(
    "lists the card once in window.customCards even when loaded twice (BUG: duplicate entry / redefinition)",
    async () => {
      vi.resetModules();
      await import("../src/card");
      expect(window.customCards?.filter((card) => card.type === CARD_TYPE)).toHaveLength(1);
    },
  );

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
    expect([...root(card).querySelectorAll("button.step")].map(textOf)).toEqual([
      "1Flächen",
      "2Muster",
      "3Übersicht",
    ]);
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
