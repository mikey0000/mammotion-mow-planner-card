import { describe, expect, it } from "vitest";
import { previewArea } from "../../src/geo/preview";
import type { MowSettings, Point, Stripe, Zone } from "../../src/model";

const zone = (outline: [number, number][], hash = 1): Zone => ({
  hash,
  name: "z",
  outline: outline.map(([x, y]) => ({ x, y })),
  areaM2: 0,
});

const rect = (x0: number, y0: number, x1: number, y1: number, hash = 1) =>
  zone(
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    hash,
  );

const settings = (overrides: Partial<MowSettings> = {}): MowSettings => ({
  pattern: "single_grid",
  angleMode: "absolute_angle",
  angle: 0,
  crossAngle: 90,
  spacingCm: 30,
  perimeterLaps: 1,
  obstacleLaps: 1,
  mowOrder: "border_first",
  speed: 0.4,
  ...overrides,
});

const EPS = 1e-6;
const len = ({ from: a, to: b }: Stripe) => Math.hypot(b.x - a.x, b.y - a.y);
const deg = ({ from: a, to: b }: Stripe) =>
  ((((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI) % 180) + 180) % 180;
const mid = ({ from: a, to: b }: Stripe): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const perimeter = (ring: readonly Point[]) =>
  ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length] ?? p;
    return sum + Math.hypot(q.x - p.x, q.y - p.y);
  }, 0);
const inside = (p: Point, ring: readonly Point[]) =>
  ring.reduce((odd, a, i) => {
    const b = ring[(i + 1) % ring.length] ?? a;
    return a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x ? !odd : odd;
  }, false);
const nearAngle = (actual: number, expected: number, tol = 0.5) => {
  expect(Math.min(Math.abs(actual - expected), 180 - Math.abs(actual - expected))).toBeLessThan(tol);
};

const field = rect(0, 0, 20, 10);

describe("previewArea on a 20 x 10 m rectangle", () => {
  it("lays horizontal stripes on a lattice through the centre, inside the inset region", () => {
    const { stripes, directionDeg, directionExact } = previewArea(field, [], settings());
    expect(directionDeg).toBe(0);
    expect(directionExact).toBe(true);
    expect(stripes).toHaveLength(31);
    for (const stripe of stripes) {
      const { from: a, to: b } = stripe;
      expect(a.y).toBeCloseTo(b.y, 6);
      expect(len(stripe)).toBeCloseTo(19.4, 2);
      for (const p of [a, b]) {
        expect(p.x).toBeGreaterThanOrEqual(0.3 - EPS);
        expect(p.x).toBeLessThanOrEqual(19.7 + EPS);
        expect(p.y).toBeGreaterThanOrEqual(0.3 - EPS);
        expect(p.y).toBeLessThanOrEqual(9.7 + EPS);
      }
    }
    expect(stripes.map(({ from }) => from.y).sort((p, q) => p - q)[0]).toBeCloseTo(0.5, 6);
  });

  it("lays vertical stripes at 90 degrees", () => {
    const { stripes, directionDeg } = previewArea(field, [], settings({ angle: 90 }));
    expect(directionDeg).toBe(90);
    expect(stripes).toHaveLength(65);
    for (const { from, to } of stripes) expect(from.x).toBeCloseTo(to.x, 6);
  });

  it("numbers the pass lines with consecutive integers in offset order", () => {
    const { stripes, pitchM } = previewArea(field, [], settings({ angle: 30 }));
    const offset = ({ from }: Stripe) => -from.x * Math.sin(Math.PI / 6) + from.y * Math.cos(Math.PI / 6);
    const sorted = [...stripes].sort((p, q) => offset(p) - offset(q));
    const lines = sorted.map(({ line }) => line);
    expect(lines).toEqual(Array.from({ length: lines.length }, (_, i) => (lines[0] ?? 0) + i));
    expect(pitchM).toBe(0.3);
    expect(stripes.every(({ pass }) => pass === 0)).toBe(true);
  });

  it("reports the pitch in metres", () => {
    expect(previewArea(field, [], settings({ spacingCm: 8 })).pitchM).toBeCloseTo(0.08, 12);
    expect(previewArea(field, [], settings({ pattern: "no_grid", spacingCm: 25 })).pitchM).toBe(0.25);
  });

  it("normalises the direction to [0, 180)", () => {
    expect(previewArea(field, [], settings({ angle: 200 })).directionDeg).toBeCloseTo(20, 9);
    expect(previewArea(field, [], settings({ angle: -30 })).directionDeg).toBeCloseTo(150, 9);
    expect(previewArea(field, [], settings({ angle: 180 })).directionDeg).toBe(0);
  });

  it("insets the stripe region by half a pitch when there are no perimeter laps", () => {
    const { stripes, perimeterLaps } = previewArea(field, [], settings({ perimeterLaps: 0 }));
    expect(perimeterLaps).toHaveLength(0);
    expect(stripes).toHaveLength(33);
  });

  it("draws perimeter laps at (k - 0.5) pitches inside the boundary", () => {
    const { perimeterLaps } = previewArea(field, [], settings({ perimeterLaps: 3 }));
    expect(perimeterLaps.map(perimeter)).toEqual(
      [0.15, 0.45, 0.75].map((d) => expect.closeTo(60 - 8 * d, 2) as unknown as number),
    );
    for (const ring of perimeterLaps) expect(ring[0]).not.toEqual(ring.at(-1));
  });

  it("totals stripe and lap lengths", () => {
    const preview = previewArea(field, [], settings({ perimeterLaps: 2 }));
    const expected =
      preview.stripes.reduce((s, seg) => s + len(seg), 0) +
      preview.perimeterLaps.reduce((s, r) => s + perimeter(r), 0);
    expect(preview.lengthM).toBeCloseTo(expected, 6);
    expect(preview.lengthM).toBeGreaterThan(0);
  });

  it("moves stripes smoothly when the angle changes by one degree", () => {
    const at = (angle: number) =>
      previewArea(field, [], settings({ angle }))
        .stripes.map(mid)
        .sort((p, q) => p.y - q.y);
    const a = at(10);
    const b = at(11);
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(2);
    expect(at(10)).toEqual(a);
  });
});

describe("previewArea on concave areas", () => {
  const u = zone([
    [0, 0],
    [30, 0],
    [30, 20],
    [20, 20],
    [20, 10],
    [10, 10],
    [10, 20],
    [0, 20],
  ]);

  it("splits stripes across the notch and keeps them inside", () => {
    const { stripes } = previewArea(u, [], settings());
    const upper = stripes.filter(({ from }) => from.y > 11);
    expect(upper.length).toBe(2 * new Set(upper.map(({ from }) => from.y.toFixed(3))).size);
    for (const line of new Set(upper.map((stripe) => stripe.line))) {
      const segments = upper.filter((stripe) => stripe.line === line);
      expect(segments).toHaveLength(2);
      expect(new Set(segments.map(({ from }) => from.y.toFixed(6))).size).toBe(1);
    }
    expect(new Set(stripes.filter(({ from }) => from.y < 9).map(({ line }) => line)).size).toBe(
      stripes.filter(({ from }) => from.y < 9).length,
    );
    for (const s of stripes) {
      expect(inside(mid(s), u.outline)).toBe(true);
      const { x, y } = mid(s);
      expect(x > 10 && x < 20 && y > 10).toBe(false);
    }
  });
});

describe("previewArea with obstacles", () => {
  const square = rect(0, 0, 20, 20);
  const tree = rect(8, 8, 12, 12, 7);
  const farAway = rect(100, 100, 102, 102, 8);
  const s = settings({ obstacleLaps: 2 });
  const preview = previewArea(square, [tree, farAway], s);

  it("keeps stripes out of the outset obstacle", () => {
    const crossing = preview.stripes.filter(({ from }) => from.y > 8 && from.y < 12);
    expect(crossing.length).toBeGreaterThan(0);
    for (const { from: a, to: b } of crossing) {
      const [lo, hi] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      expect(hi <= 7.4 + 1e-3 || lo >= 12.6 - 1e-3).toBe(true);
    }
    const outset = rect(7.4, 7.4, 12.6, 12.6).outline;
    for (const seg of preview.stripes) expect(inside(mid(seg), outset)).toBe(false);
  });

  it("surrounds the obstacle with round-joined laps", () => {
    expect(preview.obstacleLaps.map(perimeter)).toEqual(
      [0.15, 0.45].map((d) => expect.closeTo(16 + 2 * Math.PI * d, 1) as unknown as number),
    );
    for (const ring of preview.obstacleLaps) {
      expect(inside({ x: 10, y: 10 }, ring)).toBe(true);
    }
  });

  it("ignores obstacles that do not intersect the area", () => {
    const alone = previewArea(square, [farAway], s);
    expect(alone.obstacleLaps).toHaveLength(0);
    expect(alone.stripes).toEqual(previewArea(square, [], s).stripes);
  });

  it("handles either winding", () => {
    const cw = zone([
      [8, 8],
      [8, 12],
      [12, 12],
      [12, 8],
    ]);
    const reversed = previewArea(rect(0, 0, 20, 20), [cw], s);
    expect(reversed.obstacleLaps.map(perimeter)).toEqual(
      preview.obstacleLaps.map((r) => expect.closeTo(perimeter(r), 3) as unknown as number),
    );
    expect(reversed.stripes).toHaveLength(preview.stripes.length);
  });
});

describe("previewArea direction modes", () => {
  const rotated = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    return zone(
      field.outline.map(({ x, y }) => [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)]),
      42,
    );
  };

  it("follows the long axis in relative mode", () => {
    const relative = settings({ angleMode: "relative_angle" });
    const preview = previewArea(rotated(30), [], relative, 15);
    nearAngle(preview.directionDeg, 30);
    expect(preview.directionExact).toBe(false);
    nearAngle(previewArea(rotated(30), [], { ...relative, angle: 10 }).directionDeg, 40);
    nearAngle(previewArea(rotated(120), [], relative).directionDeg, 120);
    for (const seg of preview.stripes) nearAngle(deg(seg), 30);
  });

  it("applies the angle offset only to absolute mode", () => {
    const absolute = previewArea(field, [], settings(), 15);
    expect(absolute.directionDeg).toBe(15);
    expect(absolute.directionExact).toBe(true);
    for (const seg of absolute.stripes) nearAngle(deg(seg), 15);
  });

  it("picks a deterministic example direction per hash in random mode", () => {
    const random = settings({ angleMode: "random_angle" });
    const direction = (hash: number) => previewArea(rect(0, 0, 20, 10, hash), [], random, 15).directionDeg;
    expect(direction(5)).toBe(direction(5));
    expect(previewArea(field, [], random).directionExact).toBe(false);
    const directions = Array.from({ length: 20 }, (_, i) => direction(i + 1));
    expect(new Set(directions).size).toBeGreaterThan(10);
    for (const d of directions) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(180);
    }
  });
});

describe("previewArea patterns", () => {
  it("adds a crossing family for double_grid", () => {
    const { stripes, directionDeg } = previewArea(field, [], settings({ pattern: "double_grid" }));
    expect(directionDeg).toBe(0);
    expect(stripes.filter((s) => deg(s) < 1)).toHaveLength(31);
    expect(stripes.filter((s) => Math.abs(deg(s) - 90) < 1)).toHaveLength(65);
    for (const s of stripes) expect(s.pass).toBe(deg(s) < 1 ? 0 : 1);

    const skew = previewArea(field, [], settings({ pattern: "double_grid", crossAngle: 60 })).stripes;
    expect(skew.some((s) => Math.abs(deg(s) - 60) < 0.5)).toBe(true);
    expect(skew.every((s) => deg(s) < 0.5 || Math.abs(deg(s) - 60) < 0.5)).toBe(true);
  });

  it("draws only laps for no_grid", () => {
    const preview = previewArea(field, [], settings({ pattern: "no_grid", perimeterLaps: 2 }));
    expect(preview.stripes).toHaveLength(0);
    expect(preview.perimeterLaps).toHaveLength(2);
    expect(preview.lengthM).toBeCloseTo(
      preview.perimeterLaps.reduce((s, r) => s + perimeter(r), 0),
      6,
    );
  });

  it("draws segment_grid like single_grid, flagged not exact", () => {
    const segment = previewArea(field, [], settings({ pattern: "segment_grid" }));
    expect(segment.directionExact).toBe(false);
    expect(segment.stripes).toEqual(previewArea(field, [], settings()).stripes);
  });
});

describe("previewArea edge cases", () => {
  it("drops laps that collapse in a tiny area", () => {
    const preview = previewArea(rect(0, 0, 1, 1), [], settings({ perimeterLaps: 4 }));
    expect(preview.perimeterLaps).toHaveLength(2);
    expect(preview.stripes).toHaveLength(0);
  });

  it.each([
    [
      "two points",
      zone([
        [0, 0],
        [1, 1],
      ]),
      settings(),
    ],
    [
      "zero area",
      zone([
        [0, 0],
        [1, 1],
        [2, 2],
      ]),
      settings(),
    ],
    [
      "NaN coordinates",
      zone([
        [0, 0],
        [Number.NaN, 1],
        [2, 0],
      ]),
      settings(),
    ],
    ["zero spacing", field, settings({ spacingCm: 0 })],
    ["negative spacing", field, settings({ spacingCm: -5 })],
    ["NaN spacing", field, settings({ spacingCm: Number.NaN })],
  ])("returns an empty preview for %s", (_, area, s) => {
    const preview = previewArea(area, [], s);
    expect(preview).toMatchObject({ perimeterLaps: [], obstacleLaps: [], stripes: [], lengthM: 0 });
    expect(preview.hash).toBe(area.hash);
  });

  it("previews 2,000 m2 at 8 cm quickly", () => {
    const side = Math.sqrt(2000);
    const area = zone(
      Array.from({ length: 64 }, (_, i): [number, number] => {
        const t = (i / 64) * 2 * Math.PI;
        return [side * (0.5 + 0.5 * Math.cos(t)) + Math.sin(3 * t), side * (0.5 + 0.45 * Math.sin(t))];
      }),
    );
    const s = settings({
      spacingCm: 8,
      perimeterLaps: 2,
      obstacleLaps: 2,
      pattern: "double_grid",
      angle: 17,
    });
    const started = performance.now();
    const preview = previewArea(area, [rect(20, 20, 24, 23, 2)], s);
    expect(performance.now() - started).toBeLessThan(500);
    expect(preview.stripes.length).toBeGreaterThan(500);
  });
});
