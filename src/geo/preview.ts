import {
  ClipType,
  ClipperD,
  EndType,
  FillRule,
  JoinType,
  areaD,
  areaPathsD,
  differenceD,
  inflatePathsD,
  intersectD,
  unionD,
  type PathD,
  type PathsD,
} from "clipper2-ts";
import { boundsOf } from "./bounds";
import type { AreaPreview, MowSettings, Point, Ring, Zone } from "../model";

type Segment = readonly [Point, Point];

const PRECISION = 3;
const ARC_TOLERANCE_M = 0.01;
const RAD = Math.PI / 180;

/** The pattern the mower would cut over `area` with `settings`, avoiding `obstacles`. */
export function previewArea(
  area: Zone,
  obstacles: readonly Zone[],
  settings: MowSettings,
  angleOffsetDeg = 0,
): AreaPreview {
  const pitch = settings.spacingCm / 100;
  const boundary = [toPath(area.outline)];
  const directionDeg = normalise(baseDirection(area, settings, angleOffsetDeg));
  const directionExact = settings.angleMode === "absolute_angle" && settings.pattern !== "segment_grid";
  const preview = { hash: area.hash, directionDeg, directionExact };
  if (!(Number.isFinite(pitch) && pitch > 0 && Math.abs(areaD(boundary[0] ?? [])) > 1e-6)) {
    return { ...preview, perimeterLaps: [], obstacleLaps: [], stripes: [], lengthM: 0 };
  }

  const inflate = (paths: PathsD, delta: number) =>
    inflatePathsD(paths, delta, JoinType.Round, EndType.Polygon, 2, PRECISION, ARC_TOLERANCE_M);
  const laps = (count: number, ringsAt: (offset: number) => PathsD) =>
    Array.from({ length: count }, (_, k) => ringsAt((k + 0.5) * pitch)).flat();
  const edge = (count: number) => (count > 0 ? count * pitch : pitch / 2);

  const holes = obstacles
    .map((o) => [toPath(o.outline)])
    .filter((hole) => areaPathsD(intersectD(boundary, hole, FillRule.NonZero, PRECISION)) !== 0);
  const perimeterLaps = laps(settings.perimeterLaps, (d) => inflate(boundary, -d)).map(toRing);
  const obstacleLaps = holes
    .flatMap((hole) =>
      laps(settings.obstacleLaps, (d) => intersectD(inflate(hole, d), boundary, FillRule.NonZero, PRECISION)),
    )
    .map(toRing);
  const region = differenceD(
    inflate(boundary, -edge(settings.perimeterLaps)),
    unionD(
      holes.flatMap((hole) => inflate(hole, edge(settings.obstacleLaps))),
      FillRule.NonZero,
    ),
    FillRule.NonZero,
    PRECISION,
  );

  const families = {
    single_grid: [0],
    segment_grid: [0],
    double_grid: [0, settings.crossAngle],
    no_grid: [],
  };
  const centre = boxCentre(area.outline);
  const stripes = families[settings.pattern].flatMap((extra) =>
    stripesAcross(region, centre, directionDeg + extra, pitch),
  );
  const lengthM =
    stripes.reduce((sum, [a, b]) => sum + distance(a, b), 0) +
    [...perimeterLaps, ...obstacleLaps].reduce((sum, ring) => sum + perimeterOf(ring), 0);
  return { ...preview, perimeterLaps, obstacleLaps, stripes, lengthM };
}

function baseDirection(area: Zone, settings: MowSettings, angleOffsetDeg: number): number {
  switch (settings.angleMode) {
    case "absolute_angle":
      return settings.angle + angleOffsetDeg;
    case "relative_angle":
      return longAxisDeg(area.outline) + settings.angle;
    case "random_angle":
      return hashDeg(area.hash);
  }
}

/** Parallel lines `pitch` apart on a lattice through `centre`, clipped to `region`. */
function stripesAcross(region: PathsD, centre: Point, deg: number, pitch: number): Segment[] {
  const u = { x: Math.cos(deg * RAD), y: Math.sin(deg * RAD) };
  const n = { x: -u.y, y: u.x };
  const at = (s: number, t: number) => ({ x: centre.x + u.x * s + n.x * t, y: centre.y + u.y * s + n.y * t });
  const local = region.flat().map((p) => ({ x: dot(p, centre, u), y: dot(p, centre, n) }));
  if (!local.length) return [];
  const { minX, minY, maxX, maxY } = boundsOf(local);

  const lines: PathsD = [];
  for (let i = Math.ceil(minY / pitch); i <= Math.floor(maxY / pitch); i++) {
    lines.push([at(minX - 1, i * pitch), at(maxX + 1, i * pitch)]);
  }
  const clipper = new ClipperD(PRECISION);
  clipper.addOpenSubjectPaths(lines);
  clipper.addClipPaths(region);
  const open: PathsD = [];
  clipper.execute(ClipType.Intersection, FillRule.NonZero, [], open);
  return open.flatMap((path) => {
    const [a] = path;
    const b = path.at(-1);
    return a && b && path.length > 1 ? [[toPoint(a), toPoint(b)] as const] : [];
  });
}

/** Long-axis orientation of the minimum-area bounding rectangle, trying each convex hull edge. */
function longAxisDeg(outline: Ring): number {
  let best = { area: Infinity, deg: 0 };
  const hull = convexHull(outline);
  hull.forEach((p, i) => {
    const q = hull[(i + 1) % hull.length] ?? p;
    const angle = Math.atan2(q.y - p.y, q.x - p.x);
    const u = { x: Math.cos(angle), y: Math.sin(angle) };
    const n = { x: -u.y, y: u.x };
    const box = boundsOf(hull.map((h) => ({ x: dot(h, p, u), y: dot(h, p, n) })));
    const length = box.maxX - box.minX;
    const width = box.maxY - box.minY;
    if (length * width < best.area) {
      best = { area: length * width, deg: angle / RAD + (length >= width ? 0 : 90) };
    }
  });
  return best.deg;
}

function convexHull(points: Ring): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (pts: Point[]) =>
    pts.reduce<Point[]>((chain, p) => {
      while (chain.length >= 2 && cross(chain.at(-2) ?? p, chain.at(-1) ?? p, p) <= 0) chain.pop();
      chain.push(p);
      return chain;
    }, []);
  const lower = half(sorted);
  const upper = half(sorted.reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function hashDeg(hash: number): number {
  let h = 2166136261;
  for (const c of String(hash)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 18000) / 100;
}

function normalise(deg: number): number {
  return ((deg % 180) + 180) % 180;
}

function boxCentre(points: Ring): Point {
  const { minX, minY, maxX, maxY } = boundsOf(points);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function dot(p: Point, origin: Point, axis: Point): number {
  return (p.x - origin.x) * axis.x + (p.y - origin.y) * axis.y;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function perimeterOf(ring: Ring): number {
  return ring.reduce((sum, p, i) => sum + distance(p, ring[(i + 1) % ring.length] ?? p), 0);
}

function toPath(ring: Ring): PathD {
  return ring.map(({ x, y }) => ({ x, y }));
}

function toPoint({ x, y }: Point): Point {
  return { x, y };
}

function toRing(path: PathD): Ring {
  return path.map(toPoint);
}
