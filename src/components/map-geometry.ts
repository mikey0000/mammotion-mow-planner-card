import type { AreaPreview, Bounds, MapModel, Point, Ring, Stripe } from "../model";

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
  /** Only every `step`-th pass line is drawn. */
  readonly step: number;
  readonly stripes: string;
  readonly crossingStripes: string;
}

const MIN_STRIPE_PITCH_PX = 5;

const round = (v: number) => Math.round(v * 100) / 100;
const point = ({ x, y }: Point) => `${round(x)} ${round(-y)}`;

export const polylinePath = (points: readonly Point[]) =>
  points.length ? `M${points.map(point).join("L")}` : "";

export const ringPath = (ring: Ring) => (ring.length ? `${polylinePath(ring)}Z` : "");

export const toScreen = (view: View, { x, y }: Point): Point => ({
  x: view.scale * (x + view.x),
  y: view.scale * (view.y - y),
});

/** How far overlays reach into the map from its edges, in px. */
export interface Insets {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

/** The view that shows `bounds` whole in a `width` x `height` px map, clear of `insets`. */
export function fitView(
  bounds: Bounds,
  width: number,
  height: number,
  { left, right, bottom }: Insets,
  margin = 0.06,
): View {
  const free = { width: Math.max(width - left - right, 1), height: Math.max(height - bottom, 1) };
  const w = Math.max(bounds.maxX - bounds.minX, 1) * (1 + 2 * margin);
  const h = Math.max(bounds.maxY - bounds.minY, 1) * (1 + 2 * margin);
  const scale = Math.min(free.width / w, free.height / h);
  return {
    scale,
    x: (left + free.width / 2) / scale - (bounds.minX + bounds.maxX) / 2,
    y: free.height / (2 * scale) + (bounds.minY + bounds.maxY) / 2,
  };
}

/** `point`, pushed straight away from `from` until it is at least `distance` from it. */
export function clearOf(point: Point, from: Point, distance: number): Point {
  const [dx, dy] = [point.x - from.x, point.y - from.y];
  const gap = Math.hypot(dx, dy);
  if (gap >= distance) return point;
  return gap
    ? { x: from.x + (dx / gap) * distance, y: from.y + (dy / gap) * distance }
    : { x: point.x, y: from.y + distance };
}

export const mapKey = ({ origin, bounds }: MapModel) => JSON.stringify([origin, bounds]);

export const ringWidth = (ring: Ring) => {
  const xs = ring.map((p) => p.x);
  return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
};

/** Smallest n such that drawing every n-th pass line keeps them a comfortable distance apart on screen. */
export const stripeStep = (pitchM: number, scale: number) => {
  const pitchPx = pitchM * scale;
  return pitchPx > 0 ? Math.max(1, Math.ceil(MIN_STRIPE_PITCH_PX / pitchPx)) : 1;
};

const stripePath = (stripes: readonly Stripe[]) =>
  stripes.map(({ from, to }) => polylinePath([from, to])).join("");

export function previewShape(preview: AreaPreview, step: number): PreviewShape {
  const shown = preview.stripes.filter(({ line }) => line % step === 0);
  return {
    hash: preview.hash,
    laps: preview.perimeterLaps.map(ringPath).join(""),
    obstacleLaps: preview.obstacleLaps.map(ringPath).join(""),
    step,
    stripes: stripePath(shown.filter(({ pass }) => pass === 0)),
    crossingStripes: stripePath(shown.filter(({ pass }) => pass === 1)),
  };
}
