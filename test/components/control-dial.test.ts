import { afterEach, describe, expect, it } from "vitest";
import "../../src/components/control-dial";
import type { AngleDial } from "../../src/components/control-dial";

const RAD = Math.PI / 180;
/** The dial is drawn 120 px square at the page origin; its 120-unit viewBox maps one unit to one px. */
const SIZE = 120;

async function mount(props: Partial<AngleDial> = {}) {
  const el = document.createElement("mow-planner-dial");
  Object.assign(el, { angleLabel: "Angle", crossLabel: "Crossing angle", ...props });
  document.body.append(el);
  await el.updateComplete;
  const svg = el.shadowRoot?.querySelector("svg");
  if (!svg) throw new Error("no svg");
  svg.getBoundingClientRect = () => new DOMRect(0, 0, SIZE, SIZE);
  const events: { hand: string; value: number }[] = [];
  el.addEventListener("value-changed", (e) =>
    events.push((e as CustomEvent<{ hand: string; value: number }>).detail),
  );
  return { el, svg, events };
}

const knob = (el: AngleDial, label: string) => {
  const found = el.shadowRoot?.querySelector<SVGGElement>(`[role=slider][aria-label="${label}"]`);
  if (!found) throw new Error(`no knob "${label}"`);
  return found;
};

/** Where the knob sits, as a direction from the dial's centre in degrees counter-clockwise from east. */
const pointing = (el: AngleDial, label: string) => {
  const [x = 0, y = 0] = (
    knob(el, label)
      .getAttribute("transform")
      ?.match(/-?[\d.]+(e-?\d+)?/g) ?? []
  ).map(Number);
  return Math.round(Math.atan2(-y, x) / RAD);
};

const key = (target: Element, name: string, shiftKey = false) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true }));

/** Drags `target` to the point `deg` degrees counter-clockwise from east of the dial's centre. */
function drag(svg: SVGSVGElement, target: Element, ...degrees: number[]) {
  target.setPointerCapture = () => undefined;
  target.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
  for (const deg of degrees) {
    const at = { clientX: SIZE / 2 + 40 * Math.cos(deg * RAD), clientY: SIZE / 2 - 40 * Math.sin(deg * RAD) };
    target.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, bubbles: true, ...at }));
  }
  target.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
  svg.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: SIZE, clientY: SIZE / 2 }));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("<mow-planner-dial> hands", () => {
  it("points the hand along the base plus the angle, with ticks every 15°", async () => {
    const { el } = await mount({ angle: 30, base: 10 });
    expect(pointing(el, "Angle")).toBe(40);
    expect(el.shadowRoot?.querySelectorAll(".ticks line")).toHaveLength(24);
    expect(el.shadowRoot?.querySelector("[aria-label='Crossing angle']")).toBeNull();
  });

  it("measures the crossing hand from the first", async () => {
    const { el } = await mount({ angle: 20, crossAngle: 90 });
    expect(pointing(el, "Crossing angle")).toBe(110);
    el.angle = 50;
    await el.updateComplete;
    expect(pointing(el, "Crossing angle")).toBe(140);
  });

  it("draws the optimal direction only when asked", async () => {
    expect((await mount()).el.shadowRoot?.querySelector(".reference")).toBeNull();
    expect((await mount({ reference: true })).el.shadowRoot?.querySelector(".reference")).not.toBeNull();
  });

  it("describes each knob as a slider", async () => {
    const { el } = await mount({ angle: -15, crossAngle: 60, format: (v) => `${v} degrees` });
    const first = knob(el, "Angle");
    expect([first.getAttribute("aria-valuenow"), first.getAttribute("aria-valuetext")]).toEqual([
      "-15",
      "-15 degrees",
    ]);
    expect([first.getAttribute("aria-valuemin"), first.getAttribute("aria-valuemax")]).toEqual(["-90", "90"]);
    expect(knob(el, "Crossing angle").getAttribute("aria-valuemin")).toBe("1");
    expect(first.tabIndex).toBe(0);
  });
});

describe("<mow-planner-dial> keyboard", () => {
  it("turns by a degree with the arrows and by a tick with Shift", async () => {
    const { el, events } = await mount({ angle: 10 });
    key(knob(el, "Angle"), "ArrowLeft");
    key(knob(el, "Angle"), "ArrowDown");
    key(knob(el, "Angle"), "ArrowUp", true);
    key(knob(el, "Angle"), "Enter");
    expect(events).toEqual([
      { hand: "angle", value: 11 },
      { hand: "angle", value: 9 },
      { hand: "angle", value: 25 },
    ]);
  });

  it("wraps the path angle round, since a path is a line, but stops the crossing angle at its ends", async () => {
    const { el, events } = await mount({ angle: 90, crossAngle: 179 });
    key(knob(el, "Angle"), "ArrowLeft");
    key(knob(el, "Crossing angle"), "ArrowLeft");
    expect(events).toEqual([{ hand: "angle", value: -89 }]);
  });
});

describe("<mow-planner-dial> dragging", () => {
  it("follows the pointer in whole degrees, catching on the 15° ticks", async () => {
    const { el, svg, events } = await mount({ angle: 0 });
    drag(svg, knob(el, "Angle"), 37.4, 44, 120);
    expect(events.map((e) => e.value)).toEqual([37, 45, -60]);
  });

  it("measures a dragged angle from the base", async () => {
    const { el, svg, events } = await mount({ angle: 0, base: 20 });
    drag(svg, knob(el, "Angle"), 50);
    expect(events).toEqual([{ hand: "angle", value: 30 }]);
  });

  it("measures the dragged crossing hand from the first hand", async () => {
    const { el, svg, events } = await mount({ angle: 30, crossAngle: 90 });
    drag(svg, knob(el, "Crossing angle"), 100, 200, 29);
    expect(events).toEqual([
      { hand: "crossAngle", value: 70 },
      { hand: "crossAngle", value: 170 },
      { hand: "crossAngle", value: 179 },
    ]);
  });

  it("stops following once released", async () => {
    const { el, svg, events } = await mount({ angle: 0 });
    drag(svg, knob(el, "Angle"));
    expect(events).toEqual([]);
  });
});

describe("<mow-planner-dial> disabled", () => {
  it("cannot be turned or focused", async () => {
    const { el, svg, events } = await mount({ angle: 0, crossAngle: 90, disabled: true });
    drag(svg, knob(el, "Angle"), 45);
    key(knob(el, "Crossing angle"), "ArrowLeft");
    expect(events).toEqual([]);
    expect(knob(el, "Angle").getAttribute("tabindex")).toBe("-1");
    expect(knob(el, "Angle").getAttribute("aria-disabled")).toBe("true");
  });
});
