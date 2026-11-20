import { EndType, FillRule, JoinType, areaD, differenceD, inflatePathsD, type PathsD } from "clipper2-ts";
import { boundsOf } from "./bounds";
import { toPath } from "./shared";
import type { Point, Ring } from "../model";

const PRECISION = 2;
const STEPS = 12;

/** Roughly the point of `area` farthest from its edges and from the no-go zones in it: where a label reads best. */
export function labelPosition(area: Ring, obstacles: readonly Ring[]): Point {
  const region = differenceD([toPath(area)], obstacles.map(toPath), FillRule.NonZero, PRECISION);
  const { minX, minY, maxX, maxY } = boundsOf(area);
  let deepest = region;
  let [inside, outside] = [0, Math.max(maxX - minX, maxY - minY) / 2];
  for (let i = 0; i < STEPS && deepest.length; i++) {
    const depth = (inside + outside) / 2;
    const inset = inflatePathsD(region, -depth, JoinType.Round, EndType.Polygon, 2, PRECISION);
    if (inset.length) [deepest, inside] = [inset, depth];
    else outside = depth;
  }
  const largest = deepest.reduce<PathsD[number] | undefined>(
    (best, path) => (Math.abs(areaD(path)) > Math.abs(areaD(best ?? [])) ? path : best),
    undefined,
  );
  return centroid(largest ?? area);
}

function centroid(ring: Ring): Point {
  let area = 0;
  let cx = 0;
  let cy = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length] ?? a;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  });
  if (Math.abs(area) > 1e-9) return { x: cx / (3 * area), y: cy / (3 * area) };
  const n = ring.length || 1;
  return { x: ring.reduce((s, p) => s + p.x, 0) / n, y: ring.reduce((s, p) => s + p.y, 0) / n };
}
