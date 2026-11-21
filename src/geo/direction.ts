import { PointInPolygonResult, pointInPolygonD } from "clipper2-ts";
import { foldAngle } from "./angles";
import { RAD, toPath } from "./shared";
import type { Point, Zone } from "../model";

/** Directions within this many degrees of the peak count towards it, so a peak split across bins still wins. */
const POOL_DEG = 3;
/** Share of an area's planned path the dominant direction must carry to be trusted over turns and laps. */
const MIN_SHARE = 0.4;

interface Segment {
  readonly deg: number;
  readonly length: number;
}

/**
 * The direction each area's planned route mostly runs in, by area hash: degrees counter-clockwise
 * from the map x axis, folded into (−90, 90]. An area is left out when its route has no clear direction.
 */
export function plannedDirections(
  lines: readonly (readonly Point[])[],
  areas: readonly Zone[],
): Map<number, number> {
  const outlines = areas.map((area) => ({ hash: area.hash, path: toPath(area.outline) }));
  const byArea = new Map<number, Segment[]>();
  for (const line of lines) {
    line.slice(1).forEach((to, i) => {
      const from = line[i] ?? to;
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      const area = outlines.find(
        ({ path }) => pointInPolygonD(middle, path) !== PointInPolygonResult.IsOutside,
      );
      if (!area || length === 0) return;
      const deg = (((Math.atan2(to.y - from.y, to.x - from.x) / RAD) % 180) + 180) % 180;
      const segments = byArea.get(area.hash) ?? [];
      segments.push({ deg, length });
      byArea.set(area.hash, segments);
    });
  }
  const directions = new Map<number, number>();
  for (const [hash, segments] of byArea) {
    const deg = dominantDirection(segments);
    if (deg !== undefined) directions.set(hash, deg);
  }
  return directions;
}

/** Circular distance between two directions modulo 180. */
const apart = (a: number, b: number) => {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
};

function dominantDirection(segments: readonly Segment[]): number | undefined {
  const total = segments.reduce((sum, { length }) => sum + length, 0);
  const near = (peak: number) => segments.filter(({ deg }) => apart(deg, peak) <= POOL_DEG);
  const weight = (peak: number) => near(peak).reduce((sum, { length }) => sum + length, 0);
  const peak = Array.from({ length: 180 }, (_, deg) => deg).reduce((best, deg) =>
    weight(deg) > weight(best) ? deg : best,
  );
  if (total === 0 || weight(peak) / total < MIN_SHARE) return undefined;
  // Doubled angles average directions without the 0°/180° seam pulling them apart.
  const sum = near(peak).reduce(
    (acc, { deg, length }) => ({
      x: acc.x + length * Math.cos(2 * deg * RAD),
      y: acc.y + length * Math.sin(2 * deg * RAD),
    }),
    { x: 0, y: 0 },
  );
  return foldAngle(Math.atan2(sum.y, sum.x) / 2 / RAD);
}
