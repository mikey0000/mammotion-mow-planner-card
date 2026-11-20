import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAP_STRINGS, MowMap } from "../../src/components/map-view";
import type { AreaPreview, MapModel, Point, Ring } from "../../src/model";

// Vitest resolves the package's UMD `main`, which has no ES default export; load the real ES build instead.
const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const model: MapModel = {
  origin: { lon: 4.9, lat: 52.3 },
  bounds: { minX: -20, minY: -10, maxX: 20, maxY: 10 },
  areas: [
    { hash: 101, name: "Front lawn", outline: rect(-20, -10, -2, 10), areaM2: 360 },
    { hash: 202, name: "Back lawn", outline: rect(2, -10, 20, 10), areaM2: 402.4 },
  ],
  obstacles: [{ hash: 303, name: "Pond", outline: rect(-12, -2, -8, 2), areaM2: 16 }],
  channels: [
    [
      { x: -2, y: 0 },
      { x: 2, y: 0 },
    ],
  ],
  dock: { position: { x: 0, y: -9 }, headingDeg: 90 },
};

const stripe = (y: number): readonly [Point, Point] => [
  { x: 3, y },
  { x: 19, y },
];

const preview: AreaPreview = {
  hash: 202,
  directionDeg: 0,
  directionExact: true,
  perimeterLaps: [rect(2.2, -9.8, 19.8, 9.8)],
  obstacleLaps: [],
  stripes: [stripe(-9), stripe(-8.75), stripe(-8.5)],
  lengthM: 48,
};

const created: MowMap[] = [];

async function renderMap(props: Partial<MowMap> = {}): Promise<MowMap> {
  const map = Object.assign(new MowMap(), { model }, props);
  created.push(map);
  document.body.append(map);
  await map.updateComplete;
  return map;
}

const root = (map: MowMap): ShadowRoot => {
  if (!map.shadowRoot) throw new Error("no shadow root");
  return map.shadowRoot;
};

const areaEls = (map: MowMap) => [...root(map).querySelectorAll<SVGElement>("[data-hash]")];
const areaEl = (map: MowMap, hash: number) => {
  const el = root(map).querySelector<SVGElement>(`[data-hash="${hash}"]`);
  if (!el) throw new Error(`no area ${hash}`);
  return el;
};

function recordToggles(map: MowMap): number[] {
  const hashes: number[] = [];
  map.addEventListener("area-toggle", (event) => {
    hashes.push((event as CustomEvent<{ hash: number }>).detail.hash);
  });
  return hashes;
}

const pointer = (type: string, clientX: number, clientY: number) =>
  new PointerEvent(type, { bubbles: true, composed: true, clientX, clientY, isPrimary: true });

const countMoves = (d: string | null) => (d ?? "").match(/M/g)?.length ?? 0;

afterEach(() => {
  created.splice(0).forEach((map) => {
    map.remove();
  });
});

describe("mmp-map", () => {
  it("is registered as mmp-map", () => {
    expect(customElements.get("mmp-map")).toBe(MowMap);
  });

  it("renders no svg without a model", async () => {
    const map = await renderMap({ model: undefined });
    expect(root(map).querySelector("svg")).toBeNull();
  });

  it("labels the map as a group", async () => {
    const svg = root(await renderMap()).querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("group");
    expect(svg?.getAttribute("aria-label")).toBe(DEFAULT_MAP_STRINGS.mapLabel);
  });

  it("renders one checkbox per area with name, size and order", async () => {
    const map = await renderMap({ selected: [202] });
    const areas = areaEls(map);
    expect(areas.map((el) => el.getAttribute("role"))).toEqual(["checkbox", "checkbox"]);
    expect(areas.map((el) => el.getAttribute("tabindex"))).toEqual(["0", "0"]);
    expect(areaEl(map, 101).getAttribute("aria-checked")).toBe("false");
    expect(areaEl(map, 202).getAttribute("aria-checked")).toBe("true");
    expect(areaEl(map, 101).getAttribute("aria-label")).toBe("Front lawn, 360 m²");
    expect(areaEl(map, 202).getAttribute("aria-label")).toBe("Back lawn, 402 m², selected, position 1");
  });

  it("uses the given strings", async () => {
    const strings = { ...DEFAULT_MAP_STRINGS, area: ({ name }: { name: string }) => `Zone ${name}` };
    const map = await renderMap({ strings });
    expect(areaEl(map, 101).getAttribute("aria-label")).toBe("Zone Front lawn");
  });

  it("shows order badges in selection order", async () => {
    const map = await renderMap({ selected: [202, 101] });
    const badges = [...root(map).querySelectorAll(".badge")].map((el) => el.textContent.trim());
    expect(badges.sort()).toEqual(["1", "2"]);
    expect(areaEl(map, 101).getAttribute("aria-label")).toContain("position 2");
  });

  it("fires area-toggle on click, Enter and Space without changing the selection", async () => {
    const map = await renderMap({ selected: [] });
    const toggles = recordToggles(map);
    const area = areaEl(map, 101);
    area.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    area.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true }));
    await map.updateComplete;
    expect(toggles).toEqual([101, 101, 101]);
    expect(map.selected).toEqual([]);
  });

  it("toggles on a tap with a little jitter but not after a drag", async () => {
    const map = await renderMap();
    const toggles = recordToggles(map);
    const area = areaEl(map, 202);

    area.dispatchEvent(pointer("pointerdown", 100, 100));
    area.dispatchEvent(pointer("pointermove", 102, 101));
    area.dispatchEvent(pointer("pointerup", 102, 101));
    area.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    area.dispatchEvent(pointer("pointerdown", 100, 100));
    area.dispatchEvent(pointer("pointermove", 140, 100));
    area.dispatchEvent(pointer("pointermove", 100, 100));
    area.dispatchEvent(pointer("pointerup", 100, 100));
    area.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(toggles).toEqual([202]);
  });

  it("is not toggleable when readonly", async () => {
    const map = await renderMap({ readonly: true, selected: [101] });
    const toggles = recordToggles(map);
    const area = areaEl(map, 101);
    area.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    expect(toggles).toEqual([]);
    expect(map.hasAttribute("readonly")).toBe(true);
    expect(root(map).querySelector('[role="checkbox"]')).toBeNull();
    expect(root(map).querySelector("[data-hash][tabindex]")).toBeNull();
  });

  it("draws previews as one path per layer with a segment per stripe", async () => {
    const map = await renderMap({ previews: [preview] });
    const previews = root(map).querySelectorAll(".preview");
    expect(previews).toHaveLength(1);
    expect(countMoves(root(map).querySelector(".stripes")?.getAttribute("d") ?? null)).toBe(3);
    expect(countMoves(root(map).querySelector(".laps")?.getAttribute("d") ?? null)).toBe(1);
    expect(root(map).querySelector(".route")).toBeNull();
  });

  it("draws the exact route instead of previews", async () => {
    const route = [
      [
        { x: 3, y: -9 },
        { x: 19, y: -9 },
        { x: 19, y: -8 },
      ],
      [
        { x: -19, y: 9 },
        { x: -3, y: 9 },
      ],
    ];
    const map = await renderMap({ previews: [preview], route });
    expect(root(map).querySelector(".preview")).toBeNull();
    expect(countMoves(root(map).querySelector(".route")?.getAttribute("d") ?? null)).toBe(2);
  });

  it("falls back to previews when the route is empty", async () => {
    const map = await renderMap({ previews: [preview], route: [] });
    expect(root(map).querySelector(".preview")).not.toBeNull();
  });

  it("renders dock and mower markers", async () => {
    const map = await renderMap({ mower: { position: { x: 5, y: 5 }, headingDeg: 45 } });
    expect(root(map).querySelector(`[aria-label="${DEFAULT_MAP_STRINGS.dock}"]`)).not.toBeNull();
    expect(root(map).querySelector(`[aria-label="${DEFAULT_MAP_STRINGS.mower}"]`)).not.toBeNull();
  });

  it("omits the mower marker when no position is known", async () => {
    const map = await renderMap();
    expect(root(map).querySelector(`[aria-label="${DEFAULT_MAP_STRINGS.mower}"]`)).toBeNull();
  });

  it("labels no-go zones", async () => {
    const map = await renderMap();
    expect(root(map).querySelector(`[aria-label="${DEFAULT_MAP_STRINGS.noGoZone}: Pond"]`)).not.toBeNull();
  });

  it("offers zoom in, zoom out and fit buttons", async () => {
    const map = await renderMap();
    const labels = [...root(map).querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      DEFAULT_MAP_STRINGS.zoomIn,
      DEFAULT_MAP_STRINGS.zoomOut,
      DEFAULT_MAP_STRINGS.fit,
    ]);
    root(map)
      .querySelectorAll("button")
      .forEach((button) => {
        button.click();
      });
  });

  it("survives disconnect and reconnect", async () => {
    const map = await renderMap();
    map.remove();
    document.body.append(map);
    await map.updateComplete;
    map.remove();
    expect(() => {
      map.remove();
    }).not.toThrow();
    document.body.append(map);
    await map.updateComplete;
    expect(areaEls(map)).toHaveLength(2);
  });
});
