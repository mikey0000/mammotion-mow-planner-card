/** Local map frame: metres, x east, y north, origin at the map centre. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Open ring: the first point is not repeated at the end. */
export type Ring = readonly Point[];

export interface Zone {
  readonly hash: number;
  readonly name: string;
  readonly outline: Ring;
  readonly areaM2: number;
}

export interface Marker {
  readonly position: Point;
  /** Degrees clockwise from north, when known. */
  readonly headingDeg?: number;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface MapModel {
  readonly origin: { readonly lon: number; readonly lat: number };
  readonly bounds: Bounds;
  readonly areas: readonly Zone[];
  readonly obstacles: readonly Zone[];
  /** Channels between areas, as polylines. */
  readonly channels: readonly (readonly Point[])[];
  readonly dock?: Marker;
  readonly rtk?: Point;
}

export const PATTERNS = ["single_grid", "double_grid", "segment_grid", "no_grid"] as const;
export type Pattern = (typeof PATTERNS)[number];

export const ANGLE_MODES = ["relative_angle", "absolute_angle", "random_angle"] as const;
export type AngleMode = (typeof ANGLE_MODES)[number];

export const MOW_ORDERS = ["border_first", "grid_first"] as const;
export type MowOrder = (typeof MOW_ORDERS)[number];

export interface MowSettings {
  readonly pattern: Pattern;
  readonly angleMode: AngleMode;
  /** Path angle in degrees, counter-clockwise from the map x axis; meaningful modulo 180. */
  readonly angle: number;
  /** Angle between the two passes of `double_grid`. */
  readonly crossAngle: number;
  readonly spacingCm: number;
  readonly perimeterLaps: number;
  readonly obstacleLaps: number;
  readonly mowOrder: MowOrder;
  /** m/s */
  readonly speed: number;
  /** mm; absent on models without an adjustable deck. */
  readonly bladeHeight?: number;
  /** Ride-boundary distance; absent on models without the option. */
  readonly edgeDistance?: number;
}

export interface Range {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** What this mower lets the user choose; drives which controls are shown. */
export interface SettingLimits {
  readonly patterns: readonly Pattern[];
  readonly angleModes: readonly AngleMode[];
  readonly angle: Range;
  readonly crossAngle: Range;
  readonly spacingCm: Range;
  readonly maxPerimeterLaps: number;
  readonly maxObstacleLaps: number;
  readonly speed: Range;
  readonly bladeHeight?: Range;
  readonly edgeDistance?: Range;
}

export interface AreaPreview {
  readonly hash: number;
  /** Resolved direction of the first pass, degrees counter-clockwise from the map x axis. */
  readonly directionDeg: number;
  /** False when the mower picks the direction itself (relative or random mode). */
  readonly directionExact: boolean;
  /** Closed lap rings just inside the boundary. */
  readonly perimeterLaps: readonly Ring[];
  /** Closed lap rings around no-go zones. */
  readonly obstacleLaps: readonly Ring[];
  /** Straight passes, each a two-point segment. */
  readonly stripes: readonly (readonly [Point, Point])[];
  /** Total path length in metres. */
  readonly lengthM: number;
}
