import { describe, expect, it } from "vitest";
import { plannedDirections } from "../../src/geo/direction";
import type { Point, Ring, Zone } from "../../src/model";

const RAD = Math.PI / 180;

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const zone = (hash: number, outline: Ring): Zone => ({ hash, name: String(hash), outline, areaM2: 0 });

/** A boustrophedon over a square centred on `centre`, its passes at `deg`, joined by short turns. */
function lawnRoute(centre: Point, deg: number, size = 16, pitch = 0.5): Point[] {
  const u = { x: Math.cos(deg * RAD), y: Math.sin(deg * RAD) };
  const n = { x: -u.y, y: u.x };
  const at = (s: number, t: number) => ({ x: centre.x + u.x * s + n.x * t, y: centre.y + u.y * s + n.y * t });
  return Array.from({ length: Math.floor(size / pitch) }, (_, i) => {
    const t = -size / 2 + i * pitch;
    const ends = [at(-size / 2, t), at(size / 2, t)];
    return i % 2 ? ends.reverse() : ends;
  }).flat();
}

const WEST = zone(1, rect(-30, -15, -1, 15));
const EAST = zone(2, rect(1, -15, 30, 15));

describe("plannedDirections", () => {
  it.each([0, 30, -45, 89, 90, 120])("finds passes at %d° as the area's direction", (deg) => {
    const directions = plannedDirections([lawnRoute({ x: -15, y: 0 }, deg)], [WEST]);

    const found = directions.get(1) ?? NaN;
    const folded = ((((deg + 90) % 180) + 180) % 180) - 90;
    expect(Math.abs(found - folded) % 180).toBeLessThan(0.01);
  });

  it("works out each area on its own from one route crossing both", () => {
    const route = [...lawnRoute({ x: -15, y: 0 }, 10), ...lawnRoute({ x: 15, y: 0 }, 70)];

    const directions = plannedDirections([route], [WEST, EAST]);

    expect(directions.get(1)).toBeCloseTo(10, 5);
    expect(directions.get(2)).toBeCloseTo(70, 5);
  });

  it("averages slightly wobbly passes across the 0°/180° seam", () => {
    const route = [
      [
        { x: -20, y: 0 },
        { x: -10, y: 0.3 },
      ],
      [
        { x: -20, y: 2 },
        { x: -10, y: 1.7 },
      ],
    ];

    expect(plannedDirections(route, [WEST]).get(1)).toBeCloseTo(0, 5);
  });

  it("leaves out an area whose route has no clear direction", () => {
    const circle = Array.from({ length: 73 }, (_, i) => ({
      x: -15 + 8 * Math.cos(i * 5 * RAD),
      y: 8 * Math.sin(i * 5 * RAD),
    }));

    expect(plannedDirections([circle], [WEST]).has(1)).toBe(false);
  });

  it("ignores route outside the areas and areas the route misses", () => {
    const directions = plannedDirections([lawnRoute({ x: 15, y: 40 }, 45)], [WEST, EAST]);

    expect(directions.size).toBe(0);
  });
});
