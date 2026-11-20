import type { FeatureCollection } from "geojson";
import { describe, expect, it } from "vitest";
import { projectMap, projectPosition } from "../../src/geo/project";
import type { Point } from "../../src/model";

const LAT0 = -36.85;
const LON0 = 174.76;
const M_PER_DEG_LAT = 111_195;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

const at = (east: number, north: number): [number, number] => [
  LON0 + east / M_PER_DEG_LON,
  LAT0 + north / M_PER_DEG_LAT,
];

const feature = (type_name: string, geometry: object, properties: object = {}) => ({
  type: "Feature",
  geometry,
  properties: { type_name, ...properties },
});

const fixture = {
  type: "FeatureCollection",
  features: [
    feature(
      "area",
      { type: "Polygon", coordinates: [[at(-20, -10), at(0, -10), at(0, 10), at(-20, 10)]] },
      { hash: 111, Name: "Front", area: 123 },
    ),
    feature(
      "area",
      { type: "Polygon", coordinates: [[at(0, 10), at(20, 10), at(20, -10), at(0, -10), at(0, 10)]] },
      { hash: 222, title: "Back" },
    ),
    feature(
      "obstacle",
      { type: "Polygon", coordinates: [[at(5, 0), at(7, 0), at(7, 2), at(5, 2)]] },
      { hash: 333, Name: "Tree" },
    ),
    feature("path", { type: "LineString", coordinates: [at(-25, 0), at(-30, 0)] }),
    feature("station", { type: "Point", coordinates: at(-40, 5) }, { Name: "Dock", rotation: 90 }),
    feature("station", { type: "Point", coordinates: at(30, 30) }, { Name: "RTK Base" }),
    feature("corridor_point", { type: "MultiPoint", coordinates: [at(100, 100)] }),
    feature("svg", { type: "Polygon", coordinates: [[at(200, 0), at(210, 0), at(210, 10)]] }, { hash: 9 }),
    feature("area", { type: "MultiPolygon", coordinates: [] }, { hash: 10 }),
    null,
  ],
} as unknown as FeatureCollection;

const close = (p: Point | undefined, x: number, y: number) => {
  expect(p?.x).toBeCloseTo(x, 0);
  expect(p?.y).toBeCloseTo(y, 0);
};

describe("projectMap", () => {
  it("returns undefined without area polygons", () => {
    expect(projectMap({} as FeatureCollection)).toBeUndefined();
    expect(projectMap(null as unknown as FeatureCollection)).toBeUndefined();
    expect(projectMap({ type: "FeatureCollection", features: [] })).toBeUndefined();
    expect(
      projectMap({
        type: "FeatureCollection",
        features: [fixture.features[2]],
      } as FeatureCollection),
    ).toBeUndefined();
  });

  const map = projectMap(fixture);

  it("centres the origin on the areas' bounding box", () => {
    expect(map?.origin.lon).toBeCloseTo(LON0, 9);
    expect(map?.origin.lat).toBeCloseTo(LAT0, 9);
  });

  it("projects areas as open rings with names, hashes and areas", () => {
    expect(map?.areas.map((a) => [a.hash, a.name, a.outline.length])).toEqual([
      [111, "Front", 4],
      [222, "Back", 4],
    ]);
    const [front, back] = map?.areas ?? [];
    close(front?.outline[0], -20, -10);
    close(front?.outline[2], 0, 10);
    expect(front?.areaM2).toBe(123);
    expect(back?.areaM2).toBeGreaterThan(400 * 0.99);
    expect(back?.areaM2).toBeLessThan(400 * 1.01);
  });

  it("preserves distances", () => {
    const [front] = map?.areas ?? [];
    const [a, b] = front?.outline ?? [];
    const east = (b?.x ?? 0) - (a?.x ?? 0);
    expect(east).toBeGreaterThan(20 * 0.99);
    expect(east).toBeLessThan(20 * 1.01);
  });

  it("projects obstacles, channels, dock and RTK", () => {
    expect(map?.obstacles.map((o) => [o.hash, o.name, o.outline.length])).toEqual([[333, "Tree", 4]]);
    expect(map?.obstacles[0]?.areaM2).toBeCloseTo(4, 1);
    expect(map?.channels).toHaveLength(1);
    close(map?.channels[0]?.[1], -30, 0);
    close(map?.dock?.position, -40, 5);
    expect(map?.dock?.headingDeg).toBe(90);
    close(map?.rtk, 30, 30);
  });

  it("bounds cover areas, obstacles, channels and dock", () => {
    const b = map?.bounds;
    expect(b?.minX).toBeCloseTo(-40, 0);
    expect(b?.maxX).toBeCloseTo(20, 0);
    expect(b?.minY).toBeCloseTo(-10, 0);
    expect(b?.maxY).toBeCloseTo(10, 0);
  });

  it("omits the heading when the dock rotation is not numeric", () => {
    const docked = projectMap({
      type: "FeatureCollection",
      features: [
        fixture.features[0],
        feature("station", { type: "Point", coordinates: at(1, 1) }, { Name: "Dock" }),
      ],
    } as FeatureCollection);
    expect(docked?.dock).toBeDefined();
    expect(docked?.dock?.headingDeg).toBeUndefined();
  });
});

describe("projectPosition", () => {
  const origin = { lon: LON0, lat: LAT0 };

  it("maps the origin to zero", () => {
    close(projectPosition(origin, LON0, LAT0), 0, 0);
  });

  it("places a point 10 m east and 5 m south within 1%", () => {
    const p = projectPosition(origin, ...at(10, -5));
    expect(p.x).toBeGreaterThan(9.9);
    expect(p.x).toBeLessThan(10.1);
    expect(p.y).toBeGreaterThan(-5.05);
    expect(p.y).toBeLessThan(-4.95);
  });
});
