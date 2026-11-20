import { afterEach, describe, expect, it } from "vitest";
import "../../src/components/settings-panel";
import type { MowSettingsPanel } from "../../src/components/settings-panel";
import type { MowSettings, SettingLimits } from "../../src/model";

const settings: MowSettings = Object.freeze({
  pattern: "single_grid",
  angleMode: "absolute_angle",
  angle: 30,
  crossAngle: 90,
  spacingCm: 25,
  perimeterLaps: 1,
  obstacleLaps: 1,
  mowOrder: "border_first",
  speed: 0.2,
  bladeHeight: 50,
  edgeDistance: 0.4,
});

const limits: SettingLimits = {
  patterns: ["single_grid", "double_grid", "segment_grid", "no_grid"],
  angleModes: ["relative_angle", "absolute_angle", "random_angle"],
  angle: { min: -90, max: 90, step: 1 },
  crossAngle: { min: 1, max: 179, step: 1 },
  spacingCm: { min: 20, max: 35, step: 1 },
  maxPerimeterLaps: 4,
  maxObstacleLaps: 3,
  speed: { min: 0.2, max: 0.6, step: 0.1 },
  bladeHeight: { min: 30, max: 70, step: 5 },
  edgeDistance: { min: 0, max: 1, step: 0.1 },
};

type Overrides = Partial<{ settings: Partial<MowSettings>; limits: Partial<SettingLimits> }>;

async function settle(root: Element): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const visit = (el: Element) => {
    if ("updateComplete" in el) pending.push(el.updateComplete as Promise<unknown>);
    el.shadowRoot?.querySelectorAll("*").forEach(visit);
  };
  visit(root);
  await Promise.all(pending);
  if (pending.length) await Promise.resolve();
}

async function mount(
  { settings: s = {}, limits: l = {} }: Overrides = {},
  extra: Partial<MowSettingsPanel> = {},
) {
  const el = document.createElement("mow-planner-settings");
  Object.assign(el, { settings: { ...settings, ...s }, limits: { ...limits, ...l }, ...extra });
  document.body.append(el);
  await el.updateComplete;
  await settle(el);
  const events: MowSettings[] = [];
  el.addEventListener("settings-changed", (e) =>
    events.push((e as CustomEvent<{ settings: MowSettings }>).detail.settings),
  );
  return { el, events };
}

const shadow = (el: Element) => {
  if (!el.shadowRoot) throw new Error(`no shadow root on ${el.localName}`);
  return el.shadowRoot;
};

const one = <E extends Element>(root: ParentNode, selector: string, type: abstract new () => E) => {
  const found = root.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`no ${selector}`);
  return found;
};

const radiogroups = (el: Element) =>
  [...shadow(el).querySelectorAll("mow-planner-segmented")].map((s) =>
    one(shadow(s), "[role=radiogroup]", Element),
  );

const group = (el: Element, label: string) => {
  const found = radiogroups(el).find((g) => g.getAttribute("aria-label") === label);
  if (!found) throw new Error(`no radiogroup "${label}"`);
  return found;
};

const radios = (g: Element) => [...g.querySelectorAll<HTMLButtonElement>("[role=radio]")];

const radio = (el: Element, groupLabel: string, label: string) => {
  const found = radios(group(el, groupLabel)).find((r) => r.getAttribute("aria-label") === label);
  if (!found) throw new Error(`no radio "${label}" in "${groupLabel}"`);
  return found;
};

const sliders = (el: Element) => [...shadow(el).querySelectorAll("mow-planner-slider")].map(shadow);

const labelOf = (slider: ShadowRoot) => one(slider, "label", Element).textContent.trim();

const sliderLabels = (el: Element) => sliders(el).map(labelOf);

const slider = (el: Element, label: string) => {
  const found = sliders(el).find((s) => labelOf(s) === label);
  if (!found) throw new Error(`no slider "${label}"`);
  return {
    input: one(found, "input[type=range]", HTMLInputElement),
    value: () => one(found, ".value", Element).textContent.trim(),
    decrease: one(found, ".row > button:first-child", HTMLButtonElement),
    increase: one(found, ".row > button:last-child", HTMLButtonElement),
  };
};

const drag = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const rowValue = (el: Element, label: string) => {
  const host = [...shadow(el).querySelectorAll("mow-planner-segmented")].find(
    (s) => one(shadow(s), "[role=radiogroup]", Element).getAttribute("aria-label") === label,
  );
  if (!host) throw new Error(`no segmented "${label}"`);
  return one(shadow(host), ".value", Element);
};

const fill = (input: HTMLInputElement) =>
  ["--mmp-fill-from", "--mmp-fill-to"].map((name) => Number(input.style.getPropertyValue(name)));

const groupLabels = (el: Element) => radiogroups(el).map((g) => g.getAttribute("aria-label"));

afterEach(() => {
  document.body.replaceChildren();
});

describe("<mow-planner-settings> rendering", () => {
  it("offers the patterns in app order with labels", async () => {
    const { el } = await mount();
    expect(radios(group(el, "Pattern")).map((r) => r.getAttribute("aria-label"))).toEqual([
      "Stripes",
      "Grid",
      "Adaptive",
      "Perimeter",
    ]);
    expect(radio(el, "Pattern", "Stripes").getAttribute("aria-checked")).toBe("true");
  });

  it("spells out the selection of every choice row, hidden from screen readers", async () => {
    const { el } = await mount();
    expect(
      ["Pattern", "Path angle", "Perimeter laps", "No-go zone laps", "Mow first", "Edge coverage"].map(
        (label) => rowValue(el, label).textContent.trim(),
      ),
    ).toEqual(["Stripes", "Custom", "1", "1", "Perimeter", "On edge"]);
    expect(rowValue(el, "Pattern").closest("[aria-hidden=true]")).not.toBeNull();
  });

  it("updates the row value when the selection changes", async () => {
    const { el } = await mount();
    el.settings = {
      ...settings,
      pattern: "double_grid",
      angleMode: "relative_angle",
      mowOrder: "grid_first",
    };
    await settle(el);
    expect(rowValue(el, "Pattern").textContent.trim()).toBe("Grid");
    expect(rowValue(el, "Path angle").textContent.trim()).toBe("Optimal");
    expect(rowValue(el, "Mow first").textContent.trim()).toBe("Inside");
  });

  it("keeps a choice row reachable by keyboard when nothing in it is selected", async () => {
    const { el } = await mount({ limits: { patterns: ["double_grid", "no_grid"] } });
    expect(radios(group(el, "Pattern")).map((r) => r.tabIndex)).toEqual([0, -1]);
  });

  it("fills slider tracks from the minimum", async () => {
    const { el } = await mount();
    const [from, to] = fill(slider(el, "Path spacing").input);
    expect(from).toBe(0);
    expect(to).toBeCloseTo(1 / 3);
  });

  it("fills angle tracks from their centre", async () => {
    const { el } = await mount({ settings: { pattern: "double_grid", angle: -45, crossAngle: 120 } });
    const [angleFrom, angleTo] = fill(slider(el, "Angle").input);
    expect(angleFrom).toBeCloseTo(0.25);
    expect(angleTo).toBeCloseTo(0.5);
    const [crossFrom, crossTo] = fill(slider(el, "Crossing angle").input);
    expect(crossFrom).toBeCloseTo(89 / 178);
    expect(crossTo).toBeCloseTo(119 / 178);
  });

  it("only offers the angle modes the mower supports", async () => {
    const { el } = await mount({ limits: { angleModes: ["relative_angle", "absolute_angle"] } });
    expect(radios(group(el, "Path angle")).map((r) => r.getAttribute("aria-label"))).toEqual([
      "Optimal",
      "Custom",
    ]);
  });

  it("matches the lap choices to the limits", async () => {
    const { el } = await mount();
    expect(radios(group(el, "Perimeter laps"))).toHaveLength(5);
    expect(radios(group(el, "No-go zone laps"))).toHaveLength(4);
  });

  it("hides cutting height and edge coverage without limits", async () => {
    const { el } = await mount({ limits: { bladeHeight: undefined, edgeDistance: undefined } });
    expect(sliderLabels(el)).not.toContain("Cutting height");
    expect(groupLabels(el)).not.toContain("Edge coverage");
  });

  it("puts speed, cutting height and edge coverage in a collapsed More settings group", async () => {
    const { el } = await mount();
    const details = one(shadow(el), "details", HTMLDetailsElement);
    expect(details.open).toBe(false);
    expect(one(details, "summary", Element).textContent).toContain("More settings");
    expect([...details.querySelectorAll("mow-planner-slider, mow-planner-segmented")]).toHaveLength(3);
  });

  it("snaps a stored edge distance to the nearest choice", async () => {
    const { el } = await mount();
    expect(radio(el, "Edge coverage", "On edge").getAttribute("aria-checked")).toBe("true");
  });

  it("shows slider values with units", async () => {
    const { el } = await mount();
    expect(slider(el, "Angle").value()).toBe("30°");
    expect(slider(el, "Path spacing").value()).toBe("25 cm");
    expect(slider(el, "Speed").value()).toBe("0.2 m/s");
    expect(slider(el, "Cutting height").value()).toBe("50 mm");
  });

  it("shows the angle as an offset in Optimal mode", async () => {
    const { el } = await mount({ settings: { angleMode: "relative_angle", angle: 15 } });
    expect(slider(el, "Angle").value()).toBe("+15° from optimal");
  });

  it("explains the selected angle mode", async () => {
    const { el } = await mount({ settings: { angleMode: "random_angle" } });
    expect(shadow(el).textContent).toContain("A new direction each job");
  });

  it("renders German labels", async () => {
    const { el } = await mount({}, { language: "de" });
    expect(groupLabels(el)).toContain("Mähmuster");
    expect(sliderLabels(el)).toContain("Bahnabstand");
  });
});

describe("<mow-planner-settings> visibility", () => {
  it("shows the crossing angle only for checkerboard", async () => {
    expect(sliderLabels((await mount()).el)).not.toContain("Crossing angle");
    expect(sliderLabels((await mount({ settings: { pattern: "double_grid" } })).el)).toContain(
      "Crossing angle",
    );
  });

  it("hides path angle and mow order for perimeter only", async () => {
    const { el } = await mount({ settings: { pattern: "no_grid" } });
    expect(groupLabels(el)).not.toContain("Path angle");
    expect(groupLabels(el)).not.toContain("Mow first");
    expect(sliderLabels(el)).not.toContain("Angle");
    expect(shadow(el).querySelector(".dial")).toBeNull();
  });

  it("hides the angle slider and dial in random mode", async () => {
    const { el } = await mount({ settings: { angleMode: "random_angle" } });
    expect(groupLabels(el)).toContain("Path angle");
    expect(sliderLabels(el)).not.toContain("Angle");
    expect(shadow(el).querySelector(".dial")).toBeNull();
  });
});

describe("<mow-planner-settings> interaction", () => {
  const changesOnly = (events: MowSettings[], change: Partial<MowSettings>) => {
    expect(events).toEqual([{ ...settings, ...change }]);
  };

  it.each([
    ["Pattern", "Grid", { pattern: "double_grid" }],
    ["Path angle", "Optimal", { angleMode: "relative_angle" }],
    ["Perimeter laps", "3", { perimeterLaps: 3 }],
    ["No-go zone laps", "0", { obstacleLaps: 0 }],
    ["Mow first", "Inside", { mowOrder: "grid_first" }],
    ["Edge coverage", "Inside edge", { edgeDistance: 0 }],
  ] as const)("%s → %s fires one change", async (groupLabel, label, change) => {
    const { el, events } = await mount();
    radio(el, groupLabel, label).click();
    changesOnly(events, change);
  });

  it("does not fire when the selected segment is clicked again", async () => {
    const { el, events } = await mount();
    radio(el, "Pattern", "Stripes").click();
    expect(events).toEqual([]);
  });

  it.each([
    ["Angle", "45", { angle: 45 }],
    ["Path spacing", "30", { spacingCm: 30 }],
    ["Speed", "0.5", { speed: 0.5 }],
    ["Cutting height", "65", { bladeHeight: 65 }],
  ] as const)("dragging %s fires one live change", async (label, value, change) => {
    const { el, events } = await mount();
    drag(slider(el, label).input, value);
    changesOnly(events, change);
  });

  it("changes the crossing angle", async () => {
    const { el, events } = await mount({ settings: { pattern: "double_grid" } });
    drag(slider(el, "Crossing angle").input, "60");
    expect(events).toEqual([{ ...settings, pattern: "double_grid", crossAngle: 60 }]);
  });

  it("steps without float noise", async () => {
    const { el, events } = await mount();
    slider(el, "Speed").increase.click();
    expect(events.map((s) => s.speed)).toEqual([0.3]);
  });

  it("steps down", async () => {
    const { el, events } = await mount();
    slider(el, "Path spacing").decrease.click();
    changesOnly(events, { spacingCm: 24 });
  });

  it("does nothing when stepping past the end of the range", async () => {
    const { el, events } = await mount({ settings: { speed: 0.6 } });
    slider(el, "Speed").increase.click();
    expect(events).toEqual([]);
  });

  it("snaps and clamps dragged values", async () => {
    const { el, events } = await mount({ limits: { bladeHeight: { min: 30, max: 70, step: 5 } } });
    const { input } = slider(el, "Cutting height");
    input.setAttribute("max", "200");
    drag(input, "63");
    drag(input, "150");
    expect(events.map((s) => s.bladeHeight)).toEqual([65, 70]);
  });

  it("moves the segmented selection with arrow keys", async () => {
    const { el, events } = await mount();
    const stripes = radio(el, "Pattern", "Stripes");
    stripes.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    stripes.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(events.map((s) => s.pattern)).toEqual(["double_grid", "no_grid"]);
  });

  it("keeps only the selected segment in the tab order", async () => {
    const { el } = await mount();
    expect(radios(group(el, "Pattern")).map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("blocks every control when disabled", async () => {
    const { el, events } = await mount({}, { disabled: true });
    radio(el, "Pattern", "Grid").click();
    slider(el, "Speed").increase.click();
    drag(slider(el, "Angle").input, "10");
    expect(events).toEqual([]);
    const controls = [...shadow(el).querySelectorAll("mow-planner-slider, mow-planner-segmented")].flatMap(
      (c) => [...shadow(c).querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")],
    );
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((c) => c.disabled)).toBe(true);
  });

  it("rotates the dial with the angle", async () => {
    const { el } = await mount();
    const transform = () => one(shadow(el), ".dial .stripes", Element).getAttribute("transform");
    expect(transform()).toBe("rotate(-30)");
    el.settings = { ...settings, angle: -45 };
    await settle(el);
    expect(transform()).toBe("rotate(45)");
  });

  it("marks the compass directions on the dial for a custom angle", async () => {
    const { el } = await mount();
    expect(shadow(el).querySelectorAll(".dial .ticks line")).toHaveLength(4);
    expect(shadow(el).querySelector(".dial .baseline")).toBeNull();
  });

  it("draws the dial as an offset from the optimal direction in Optimal mode", async () => {
    const { el } = await mount({ settings: { angleMode: "relative_angle", angle: 15 } });
    expect(shadow(el).querySelector(".dial .ticks")).toBeNull();
    expect(shadow(el).querySelector(".dial .baseline")).not.toBeNull();
    expect(one(shadow(el), ".dial .stripes", Element).getAttribute("transform")).toBe("rotate(-15)");
  });

  it("fires a bubbling, composed event", async () => {
    const { el } = await mount();
    let seen: Event | undefined;
    document.body.addEventListener("settings-changed", (e) => (seen = e), { once: true });
    radio(el, "Pattern", "Adaptive").click();
    expect(seen?.composed).toBe(true);
  });
});

describe("<mow-planner-settings> job and collection settings", () => {
  const extras: Overrides = {
    settings: {
      obstacleDetection: 10,
      startProgress: 20,
      autoChangeDirection: false,
      cutGrass: true,
      dumpGrass: true,
      cutEdges: false,
      dumpInterval: 15,
    },
    limits: {
      obstacleDetection: [
        { key: "off", code: 1 },
        { key: "standard", code: 10 },
        { key: "sensitive", code: 11 },
      ],
      startProgress: { min: 0, max: 99, step: 1 },
      dumpInterval: { min: 5, max: 100, step: 1 },
      switches: ["autoChangeDirection", "cutGrass", "dumpGrass", "cutEdges"],
    },
  };

  it("offers the mower's obstacle detection modes and sends the chosen code", async () => {
    const { el, events } = await mount(extras);
    expect(radios(group(el, "Obstacle detection")).map((r) => r.getAttribute("aria-label"))).toEqual([
      "Off",
      "Standard",
      "Sensitive",
    ]);
    expect(rowValue(el, "Obstacle detection").textContent.trim()).toBe("Standard");

    radio(el, "Obstacle detection", "Off").click();

    expect(events.map((s) => s.obstacleDetection)).toEqual([1]);
  });

  it("shows each switch as Off / On and sends a boolean", async () => {
    const { el, events } = await mount(extras);
    expect(rowValue(el, "Auto-reverse direction").textContent.trim()).toBe("Off");
    expect(rowValue(el, "Mow").textContent.trim()).toBe("On");

    radio(el, "Auto-reverse direction", "On").click();
    radio(el, "Mow", "Off").click();

    expect(events.map((s) => [s.autoChangeDirection, s.cutGrass])).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  it("shows start progress and dumping frequency with units", async () => {
    const { el, events } = await mount(extras);
    expect(slider(el, "Start from").value()).toBe("20%");
    expect(slider(el, "Dump every").value()).toBe("15 m²");

    drag(slider(el, "Start from").input, "50");

    expect(events.map((s) => s.startProgress)).toEqual([50]);
  });

  it("groups grass collection under its own heading and hides the frequency while not dumping", async () => {
    const { el } = await mount({ ...extras, settings: { ...extras.settings, dumpGrass: false } });
    expect(shadow(el).querySelector(".group")?.textContent).toBe("Grass collection");
    expect(sliderLabels(el)).not.toContain("Dump every");
  });

  it("shows none of them on a mower without the entities", async () => {
    const { el } = await mount();
    expect(groupLabels(el)).not.toContain("Obstacle detection");
    expect(groupLabels(el)).not.toContain("Mow");
    expect(sliderLabels(el)).not.toContain("Start from");
    expect(shadow(el).querySelector(".group")).toBeNull();
  });
});

describe("<mow-planner-settings> locked settings", () => {
  const locked = ["angleMode", "angle", "perimeterLaps", "mowOrder", "edgeDistance"] as const;

  it("disables only the locked controls, which fire nothing", async () => {
    const { el, events } = await mount({}, { locked });
    expect(radios(group(el, "Path angle")).every((r) => r.disabled)).toBe(true);
    expect(slider(el, "Angle").input.disabled).toBe(true);
    expect(radios(group(el, "Perimeter laps")).every((r) => r.disabled)).toBe(true);
    expect(radios(group(el, "Pattern")).some((r) => r.disabled)).toBe(false);
    expect(slider(el, "Speed").input.disabled).toBe(false);

    radio(el, "Perimeter laps", "3").click();
    drag(slider(el, "Angle").input, "10");
    radio(el, "Pattern", "Grid").click();

    expect(events).toEqual([{ ...settings, pattern: "double_grid" }]);
  });

  it("opens More settings while settings are locked, where most changeable ones are", async () => {
    const { el } = await mount({}, { locked });
    expect(one(shadow(el), "details", HTMLDetailsElement).open).toBe(true);
  });
});
