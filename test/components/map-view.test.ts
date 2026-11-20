import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MowMap, type MapStrings } from "../../src/components/map-view";
import type { AreaPreview, MapModel, Ring, Stripe } from "../../src/model";

const strings: MapStrings = {
  mapLabel: "Map",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  fit: "Fit map",
  dock: "Dock",
  mower: "Mower",
  noGoZone: "No-go zone",
  area: ({ name, areaM2, order }) =>
    `${name}, ${Math.round(areaM2)} m²${order ? `, selected, position ${order}` : ""}`,
  everyNthPass: (n) => `Every ${n}. pass shown`,
};

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

const stripe = (line: number, pitchM = 0.25, pass: 0 | 1 = 0): Stripe => {
  const y = -9 + line * pitchM;
  return { from: { x: 3, y }, to: { x: 19, y }, line, pass };
};

const preview: AreaPreview = {
  hash: 202,
  directionDeg: 0,
  directionExact: true,
  perimeterLaps: [rect(2.2, -9.8, 19.8, 9.8)],
  obstacleLaps: [],
  stripes: [stripe(0, 1), stripe(1, 1), stripe(2, 1)],
  pitchM: 1,
  lengthM: 48,
};

/** 0.25 m apart: 2.2 px at the 400 px wide fit, 22 px at the 4000 px wide one. */
const densePreview: AreaPreview = {
  ...preview,
  stripes: Array.from({ length: 40 }, (_, line) => stripe(line)),
  pitchM: 0.25,
};

class FakeResizeObserver implements ResizeObserver {
  static readonly instances: FakeResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  static notify(target: Element) {
    for (const observer of this.instances.filter((o) => o.targets.has(target))) {
      observer.callback([], observer);
    }
  }
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

const created: MowMap[] = [];

/** The zoom buttons: a 42 px column 8 px from the inline-end edge. */
const CONTROLS_PX = 50;
/** The caption: one 24 px line 8 px from the bottom edge. */
const CAPTION_PX = 32;

const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

const stubRect = (el: Element | null | undefined, rect: DOMRect) => {
  if (el) Object.defineProperty(el, "getBoundingClientRect", { value: () => rect, configurable: true });
};

// happy-dom has no layout, so sizes and boxes are given explicitly.
const setSize = (map: MowMap, width: number, height: number) => {
  Object.defineProperty(map, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(map, "clientHeight", { value: height, configurable: true });
  stubRect(map, box(0, 0, width, height));
  stubRect(map.shadowRoot?.querySelector("svg"), box(0, 0, width, height));
  const rtl = map.style.direction === "rtl";
  stubRect(map.shadowRoot?.querySelector(".controls"), box(rtl ? 8 : width - CONTROLS_PX, 8, 42, 126));
  stubRect(map.shadowRoot?.querySelector(".caption"), box(8, height - CAPTION_PX, 150, 24));
};

async function settle(map: MowMap): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        setTimeout(resolve);
      });
    });
    await map.updateComplete;
  }
}

async function resize(map: MowMap, width: number, height: number): Promise<void> {
  setSize(map, width, height);
  FakeResizeObserver.notify(map);
  await settle(map);
}

async function renderMap(props: Partial<MowMap> = {}, size?: readonly [number, number]): Promise<MowMap> {
  const map = Object.assign(new MowMap(), { model, strings }, props);
  if (size) setSize(map, ...size);
  created.push(map);
  document.body.append(map);
  await map.updateComplete;
  if (size) await resize(map, ...size);
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

const pointer = (type: string, clientX: number, clientY: number, buttons = 0) =>
  new PointerEvent(type, {
    bubbles: true,
    composed: true,
    clientX,
    clientY,
    buttons,
    pointerType: "mouse",
    isPrimary: true,
  });

const touch = (type: string, pointerId: number, clientX: number, clientY: number) =>
  new PointerEvent(type, {
    bubbles: true,
    composed: true,
    clientX,
    clientY,
    buttons: type === "pointerup" ? 0 : 1,
    pointerId,
    pointerType: "touch",
    isPrimary: pointerId === 1,
  });

const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

function one(map: MowMap, selector: string): Element {
  const el = root(map).querySelector(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
}

const svgOf = (map: MowMap) => one(map, "svg") as SVGSVGElement;
const caption = (map: MowMap) => one(map, ".caption") as HTMLElement;
const captionLines = (map: MowMap) =>
  caption(map).hidden ? [] : [...caption(map).children].map((el) => el.textContent.trim());

const translation = (el: Element | null): [number, number] => {
  const [, x, y] = /translate\(([\d.e-]+) ([\d.e-]+)\)/.exec(el?.getAttribute("transform") ?? "") ?? [];
  return [Number(x), Number(y)];
};

const countMoves = (d: string | null) => (d ?? "").match(/M/g)?.length ?? 0;

afterEach(() => {
  created.splice(0).forEach((map) => {
    map.remove();
  });
});

describe("mow-planner-map", () => {
  it("is registered as mow-planner-map", () => {
    expect(customElements.get("mow-planner-map")).toBe(MowMap);
  });

  it("renders no svg without a model", async () => {
    const map = await renderMap({ model: undefined });
    expect(root(map).querySelector("svg")).toBeNull();
  });

  it("renders nothing until it has strings", async () => {
    const map = await renderMap({ strings: undefined });
    expect(root(map).querySelector("svg")).toBeNull();
    map.strings = strings;
    await map.updateComplete;
    expect(areaEls(map)).toHaveLength(2);
  });

  it("labels the map as a group", async () => {
    const svg = root(await renderMap()).querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("group");
    expect(svg?.getAttribute("aria-label")).toBe(strings.mapLabel);
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
    const map = await renderMap({ strings: { ...strings, area: ({ name }) => `Zone ${name}` } });
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
    const map = await renderMap({ previews: [preview] }, [400, 300]);
    await settle(map);
    const previews = root(map).querySelectorAll(".preview");
    expect(previews).toHaveLength(1);
    expect(countMoves(root(map).querySelector(".stripes")?.getAttribute("d") ?? null)).toBe(3);
    expect(countMoves(root(map).querySelector(".laps")?.getAttribute("d") ?? null)).toBe(1);
    expect(root(map).querySelector(".route")).toBeNull();
  });

  it("draws only every n-th pass line while lines are dense on screen, all of them once zoomed in", async () => {
    const map = await renderMap({ previews: [densePreview] }, [400, 300]);
    await settle(map);
    const drawnLines = () => {
      const d = root(map).querySelector(".stripes")?.getAttribute("d") ?? "";
      return [...d.matchAll(/M[\d.-]+ ([\d.-]+)/g)].map(([, y]) => Math.round((Number(y) * -1 + 9) / 0.25));
    };
    expect(drawnLines()).toEqual(Array.from({ length: 14 }, (_, i) => 3 * i));
    expect(root(map).querySelector(".stripes")?.getAttribute("opacity")).toBeNull();

    await resize(map, 4000, 3000);
    expect(drawnLines()).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("draws the crossing pass as its own path", async () => {
    const crossing = { ...preview, stripes: [stripe(0, 1), stripe(1, 1, 1), stripe(2, 1, 1)] };
    const map = await renderMap({ previews: [crossing] }, [400, 300]);
    await settle(map);
    expect(countMoves(root(map).querySelector(".stripes:not(.crossing)")?.getAttribute("d") ?? null)).toBe(1);
    expect(countMoves(root(map).querySelector(".stripes.crossing")?.getAttribute("d") ?? null)).toBe(2);
    expect(countMoves(root(map).querySelector(".laps")?.getAttribute("d") ?? null)).toBe(1);
  });

  it("draws no crossing path for a single pass", async () => {
    const map = await renderMap({ previews: [preview] }, [400, 300]);
    expect(root(map).querySelector(".crossing")).toBeNull();
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
    expect(root(map).querySelector(`[aria-label="${strings.dock}"]`)).not.toBeNull();
    expect(root(map).querySelector(`[aria-label="${strings.mower}"]`)).not.toBeNull();
  });

  it("omits the mower marker when no position is known", async () => {
    const map = await renderMap();
    expect(root(map).querySelector(`[aria-label="${strings.mower}"]`)).toBeNull();
  });

  it("labels no-go zones", async () => {
    const map = await renderMap();
    expect(root(map).querySelector(`[aria-label="${strings.noGoZone}: Pond"]`)).not.toBeNull();
  });

  it("offers zoom in, zoom out and fit buttons", async () => {
    const map = await renderMap();
    const labels = [...root(map).querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([strings.zoomIn, strings.zoomOut, strings.fit]);
    root(map)
      .querySelectorAll("button")
      .forEach((button) => {
        button.click();
      });
  });

  it("places area labels off the no-go zones in them", async () => {
    const map = await renderMap({}, [400, 300]);
    await settle(map);
    const label = root(map).querySelector(".label");
    const dock = root(map).querySelector(".dock");
    const [lx, ly] = translation(label);
    const [dockX, dockY] = translation(dock);
    const scale = (dockY - 150) / 9;
    const pond = { x: dockX - 10 * scale, y: 150 };
    expect(Math.hypot(lx - pond.x, ly - pond.y)).toBeGreaterThan(4 * scale);
  });

  it("separates the order badge from the area name", async () => {
    const map = await renderMap({ selected: [101] }, [400, 300]);
    await settle(map);
    const label = root(map).querySelector(".label");
    const nameY = Number(label?.querySelector(".name")?.getAttribute("y"));
    const badgeY = Number(label?.querySelector(".badge-bg")?.getAttribute("cy"));
    const badgeR = Number(label?.querySelector(".badge-bg")?.getAttribute("r"));
    expect(nameY - badgeY - badgeR).toBeGreaterThanOrEqual(8);
  });

  it("draws the mower above the dock", async () => {
    const map = await renderMap({ mower: { position: { x: 0, y: -9 } } });
    const markers = [...root(map).querySelectorAll(".dock, .mower")].map((el) => el.getAttribute("class"));
    expect(markers).toEqual(["dock", "mower"]);
  });

  it("fits the map centred beside the zoom buttons", async () => {
    const map = await renderMap({}, [400, 300]);
    const [x, y] = translation(root(map).querySelector(".dock"));
    expect(x).toBeCloseTo((400 - CONTROLS_PX) / 2, 1);
    expect(y).toBeCloseTo(150 + 9 * Math.min((400 - CONTROLS_PX) / 44.8, 300 / 22.4), 1);
  });

  it("keeps the zoom buttons on the inline-end side clear in right-to-left layouts", async () => {
    const map = await renderMap();
    map.style.direction = "rtl";
    await resize(map, 400, 300);
    expect(translation(root(map).querySelector(".dock"))[0]).toBeCloseTo(
      CONTROLS_PX + (400 - CONTROLS_PX) / 2,
      1,
    );
  });

  it("fits the map above the caption", async () => {
    const map = await renderMap({ note: "Approximate" }, [800, 300]);
    const [, y] = translation(root(map).querySelector(".dock"));
    expect(y).toBeCloseTo((300 - CAPTION_PX) / 2 + 9 * ((300 - CAPTION_PX) / 22.4), 1);
  });

  it("re-fits when the container is resized and the user has not moved the view", async () => {
    const map = await renderMap({}, [400, 300]);
    await settle(map);
    await resize(map, 600, 700);
    expect(translation(root(map).querySelector(".dock"))[0]).toBeCloseTo((600 - CONTROLS_PX) / 2, 1);
  });

  it("still re-fits on resize after a tap that jittered by a pixel", async () => {
    const map = await renderMap({}, [400, 300]);
    await settle(map);
    const area = areaEl(map, 202);
    area.dispatchEvent(pointer("pointerdown", 300, 150));
    area.dispatchEvent(pointer("pointermove", 301, 151, 1));
    area.dispatchEvent(pointer("pointerup", 301, 151));
    await settle(map);
    await resize(map, 600, 700);
    expect(translation(root(map).querySelector(".dock"))[0]).toBeCloseTo((600 - CONTROLS_PX) / 2, 1);
  });

  it("keeps the user's view on resize after a drag, until Fit is pressed", async () => {
    const map = await renderMap({}, [400, 300]);
    await settle(map);
    const area = areaEl(map, 202);
    area.dispatchEvent(pointer("pointerdown", 300, 150));
    area.dispatchEvent(pointer("pointermove", 340, 150, 1));
    area.dispatchEvent(pointer("pointerup", 340, 150));
    await settle(map);
    const dragged = translation(root(map).querySelector(".dock"));

    await resize(map, 600, 700);
    expect(translation(root(map).querySelector(".dock"))).toEqual(dragged);

    root(map).querySelector<HTMLButtonElement>(`[aria-label="${strings.fit}"]`)?.click();
    await settle(map);
    expect(translation(root(map).querySelector(".dock"))[0]).toBeCloseTo((600 - CONTROLS_PX) / 2, 1);
  });

  it("says when only every n-th pass line is drawn", async () => {
    const map = await renderMap({ previews: [densePreview] }, [400, 300]);
    expect(caption(map).getAttribute("role")).toBe("note");
    expect(captionLines(map)).toEqual(["Every 3. pass shown"]);
    expect(getComputedStyle(caption(map)).pointerEvents).toBe("none");

    await resize(map, 4000, 3000);
    expect(captionLines(map)).toEqual([]);
  });

  it("reports the sparsest drawn preview and ignores previews without stripes or area", async () => {
    const fine: AreaPreview = {
      ...preview,
      hash: 101,
      stripes: Array.from({ length: 10 }, (_, line) => stripe(line, 0.1)),
      pitchM: 0.1,
    };
    const lapsOnly: AreaPreview = { ...preview, hash: 101, stripes: [], pitchM: 0.01 };
    const unknown: AreaPreview = { ...densePreview, hash: 999, pitchM: 0.01 };
    const map = await renderMap({ previews: [densePreview, fine, unknown] }, [400, 300]);
    expect(captionLines(map)).toEqual(["Every 7. pass shown"]);

    map.previews = [preview, lapsOnly];
    await settle(map);
    expect(captionLines(map)).toEqual([]);
  });

  it("shows the note in the caption, below the thinning line", async () => {
    const map = await renderMap({ previews: [densePreview], note: "Preview is approximate" }, [400, 300]);
    expect(captionLines(map)).toEqual(["Every 3. pass shown", "Preview is approximate"]);
  });

  it("drops the thinning line when the exact route is drawn", async () => {
    const route = [
      [
        { x: 3, y: -9 },
        { x: 19, y: -9 },
      ],
    ];
    const map = await renderMap({ previews: [densePreview], route, note: "Exact" }, [400, 300]);
    expect(captionLines(map)).toEqual(["Exact"]);
  });

  it("lets taps on a no-go zone or a preview reach the area under it", async () => {
    const map = await renderMap({ previews: [preview] }, [400, 300]);
    for (const selector of [".nogo", ".preview"]) {
      expect(getComputedStyle(one(map, selector)).pointerEvents).toBe("none");
    }
  });

  it("leaves one-finger swipes to the page and does not toggle when the browser takes the gesture", async () => {
    const map = await renderMap({}, [400, 300]);
    const toggles = recordToggles(map);
    const area = areaEl(map, 202);
    const before = translation(root(map).querySelector(".dock"));
    expect(svgOf(map).style.touchAction).toBe("pan-x pan-y");

    area.dispatchEvent(touch("pointerdown", 1, 300, 150));
    area.dispatchEvent(touch("pointermove", 1, 300, 154));
    area.dispatchEvent(touch("pointercancel", 1, 300, 154));
    click(area);
    area.dispatchEvent(touch("pointerdown", 1, 300, 150));
    area.dispatchEvent(touch("pointermove", 1, 300, 250));
    area.dispatchEvent(touch("pointerup", 1, 300, 250));
    await settle(map);

    expect(toggles).toEqual([]);
    expect(translation(root(map).querySelector(".dock"))).toEqual(before);
    await resize(map, 600, 700);
    expect(translation(root(map).querySelector(".dock"))[0]).toBeCloseTo((600 - CONTROLS_PX) / 2, 1);
  });

  it("pans and pinch-zooms with two fingers about their midpoint, without toggling", async () => {
    const map = await renderMap({}, [400, 300]);
    const toggles = recordToggles(map);
    const svg = svgOf(map);
    const [dx, dy] = translation(root(map).querySelector(".dock"));

    svg.dispatchEvent(touch("pointerdown", 1, 100, 150));
    svg.dispatchEvent(touch("pointerdown", 2, 300, 150));
    svg.dispatchEvent(touch("pointermove", 2, 500, 150));
    svg.dispatchEvent(touch("pointerup", 2, 500, 150));
    svg.dispatchEvent(touch("pointerup", 1, 100, 150));
    click(svg);
    await settle(map);

    const [x, y] = translation(root(map).querySelector(".dock"));
    expect(x).toBeCloseTo(300 + (dx - 200) * 2, 1);
    expect(y).toBeCloseTo(150 + (dy - 150) * 2, 1);
    expect(toggles).toEqual([]);
    await resize(map, 600, 700);
    expect(translation(root(map).querySelector(".dock"))).toEqual([x, y]);
  });

  it.each([
    ["in", -100, 1.2, 1.25],
    ["out", 100, 1 / 1.25, 1 / 1.2],
  ])("zooms %s by about a fifth per wheel notch, about the cursor", async (_, deltaY, min, max) => {
    const map = await renderMap({}, [400, 300]);
    const [dx, dy] = translation(root(map).querySelector(".dock"));
    const wheel = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
    // happy-dom's WheelEvent ignores the MouseEvent coordinates in its init dictionary.
    Object.defineProperties(wheel, { clientX: { value: 100 }, clientY: { value: 80 } });
    svgOf(map).dispatchEvent(wheel);
    await settle(map);

    const [x, y] = translation(root(map).querySelector(".dock"));
    const factor = (x - 100) / (dx - 100);
    expect(wheel.defaultPrevented).toBe(true);
    expect(factor).toBeGreaterThan(min);
    expect(factor).toBeLessThan(max);
    expect((y - 80) / (dy - 80)).toBeCloseTo(factor, 6);
  });

  it.each([
    ["Zoom in", (f: number) => f > 1],
    ["Zoom out", (f: number) => f < 1],
  ])("%s keeps the centre of the visible map in place", async (label, grows) => {
    const map = await renderMap({ mower: { position: { x: 15, y: 6 } } }, [400, 300]);
    const markers = () => [translation(one(map, ".dock")), translation(one(map, ".mower"))] as const;
    const [[d0x, d0y], [m0x, m0y]] = markers();
    root(map).querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click();
    await settle(map);

    const [[d1x, d1y], [m1x, m1y]] = markers();
    const factor = (d1x - m1x) / (d0x - m0x);
    expect(grows(factor)).toBe(true);
    expect((d1x - factor * d0x) / (1 - factor)).toBeCloseTo((400 - CONTROLS_PX) / 2, 1);
    expect((d1y - factor * d0y) / (1 - factor)).toBeCloseTo(150, 1);
    expect((d1y - m1y) / (d0y - m0y)).toBeCloseTo(factor, 6);
  });

  it("moves an area label off the mower marker", async () => {
    const map = await renderMap({}, [400, 300]);
    const labelOf202 = () => translation(root(map).querySelectorAll(".label")[1] ?? null);
    const free = labelOf202();

    map.mower = { position: { x: 11, y: 0.3 } };
    await settle(map);
    const [lx, ly] = labelOf202();
    const [mx, my] = translation(root(map).querySelector(".mower"));
    expect(Math.hypot(lx - mx, ly - my)).toBeGreaterThanOrEqual(24 - 1e-6);

    map.mower = { position: { x: 11, y: 8 } };
    await settle(map);
    expect(labelOf202()).toEqual(free);
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
