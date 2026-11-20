import type { AreaPreview, Bounds, MapModel, Point, Ring } from "../model";

/** Panzoom transform: screen = scale * (svg point + pan). SVG points are metres with y flipped. */
export interface View {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface PreviewShape {
  readonly hash: number;
  readonly laps: string;
  readonly obstacleLaps: string;
  readonly stripes: string;
  /** Distance in metres between neighbouring parallel stripes. */
  readonly pitch?: number;
}

const round = (v: number) => Math.round(v * 100) / 100;
const point = ({ x, y }: Point) => `${round(x)} ${round(-y)}`;

export const polylinePath = (points: readonly Point[]) =>
  points.length ? `M${points.map(point).join("L")}` : "";

export const ringPath = (ring: Ring) => (ring.length ? `${polylinePath(ring)}Z` : "");

export const toScreen = (view: View, { x, y }: Point): Point => ({
  x: view.scale * (x + view.x),
  y: view.scale * (view.y - y),
});

export function fitView(bounds: Bounds, width: number, height: number, margin = 0.06): View {
  const w = Math.max(bounds.maxX - bounds.minX, 1) * (1 + 2 * margin);
  const h = Math.max(bounds.maxY - bounds.minY, 1) * (1 + 2 * margin);
  const scale = Math.min(width / w, height / h);
  return {
    scale,
    x: width / (2 * scale) - (bounds.minX + bounds.maxX) / 2,
    y: height / (2 * scale) + (bounds.minY + bounds.maxY) / 2,
  };
}

export const mapKey = ({ origin, bounds }: MapModel) => JSON.stringify([origin, bounds]);

/** Area centroid, falling back to the vertex mean for degenerate rings. */
export function centroid(ring: Ring): Point {
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

export const ringWidth = (ring: Ring) => {
  const xs = ring.map((p) => p.x);
  return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
};

function stripePitch(stripes: AreaPreview["stripes"]): number | undefined {
  const first = stripes[0];
  if (!first) return undefined;
  const [a, b] = first;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!length) return undefined;
  const ux = (b.x - a.x) / length;
  const uy = (b.y - a.y) / length;
  const offsets = stripes
    .filter(
      ([p, q]) => Math.abs((q.x - p.x) * uy - (q.y - p.y) * ux) < 0.01 * Math.hypot(q.x - p.x, q.y - p.y),
    )
    .map(([p]) => (p.x - a.x) * uy - (p.y - a.y) * ux)
    .sort((m, n) => m - n);
  const gaps = offsets.slice(1).map((o, i) => o - (offsets[i] ?? o));
  const pitch = Math.min(...gaps.filter((g) => g > 0.01));
  return Number.isFinite(pitch) ? pitch : undefined;
}

export const previewShape = (preview: AreaPreview): PreviewShape => ({
  hash: preview.hash,
  laps: preview.perimeterLaps.map(ringPath).join(""),
  obstacleLaps: preview.obstacleLaps.map(ringPath).join(""),
  stripes: preview.stripes.map((segment) => polylinePath(segment)).join(""),
  pitch: stripePitch(preview.stripes),
});
