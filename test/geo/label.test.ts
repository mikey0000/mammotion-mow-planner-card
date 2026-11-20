import { describe, expect, it } from "vitest";
import { labelPosition } from "../../src/geo/label";
import type { Point, Ring } from "../../src/model";

const ring = (points: [number, number][]): Ring => points.map(([x, y]) => ({ x, y }));
const rect = (x0: number, y0: number, x1: number, y1: number) =>
  ring([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);

const distanceToEdges = (p: Point, rings: readonly Ring[]) =>
  Math.min(
    ...rings.flatMap((r) =>
      r.map((a, i) => {
        const b = r[(i + 1) % r.length] ?? a;
        const t = Math.max(
          0,
          Math.min(
            1,
            ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2),
          ),
        );
        return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y));
      }),
    ),
  );

describe("labelPosition", () => {
  it("is the centre of a plain rectangle", () => {
    const p = labelPosition(rect(0, 0, 20, 10), []);
    expect(p.x).toBeCloseTo(10, 1);
    expect(p.y).toBeCloseTo(5, 1);
  });

  it("moves off a no-go zone sitting on the centroid", () => {
    const area = rect(0, 0, 20, 20);
    const pond = rect(6, 6, 14, 14);
    const p = labelPosition(area, [pond]);
    expect(p.x > 6 && p.x < 14 && p.y > 6 && p.y < 14).toBe(false);
    expect(distanceToEdges(p, [area, pond])).toBeGreaterThan(2.5);
  });

  it("stays inside a concave area whose centroid lies outside", () => {
    const u = ring([
      [0, 0],
      [30, 0],
      [30, 30],
      [20, 30],
      [20, 8],
      [10, 8],
      [10, 30],
      [0, 30],
    ]);
    const p = labelPosition(u, []);
    expect(p.x > 10 && p.x < 20 && p.y > 8).toBe(false);
    expect(distanceToEdges(p, [u])).toBeGreaterThan(3.5);
  });

  it("ignores no-go zones outside the area", () => {
    const p = labelPosition(rect(0, 0, 20, 10), [rect(50, 50, 60, 60)]);
    expect(p.x).toBeCloseTo(10, 1);
    expect(p.y).toBeCloseTo(5, 1);
  });

  it("falls back to the vertex mean for a degenerate outline", () => {
    expect(
      labelPosition(
        ring([
          [0, 0],
          [3, 3],
          [6, 6],
        ]),
        [],
      ),
    ).toEqual({ x: 3, y: 3 });
  });
});
