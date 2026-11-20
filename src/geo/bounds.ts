import type { Bounds, Point } from "../model";

export function boundsOf(points: readonly Point[]): Bounds {
  return points.reduce(
    (b, { x, y }) => ({
      minX: Math.min(b.minX, x),
      minY: Math.min(b.minY, y),
      maxX: Math.max(b.maxX, x),
      maxY: Math.max(b.maxY, y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}
