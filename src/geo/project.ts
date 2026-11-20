import { areaD } from "clipper2-ts";
import type { Feature, FeatureCollection } from "geojson";
import type { MapModel, Marker, Point, Zone } from "../model";
import { boundsOf } from "./bounds";
import { RAD, toPath } from "./shared";

type LonLat = readonly [number, number];

const EARTH_RADIUS_M = 6_371_008.8;

/** Builds the local-metre map from the integration's `get_geojson` response; undefined when it has no areas. */
export function projectMap(geojson: FeatureCollection): MapModel | undefined {
  const features = (geojson as Partial<FeatureCollection> | null)?.features;
  const all: readonly (Partial<Feature> | null | undefined)[] = Array.isArray(features) ? features : [];
  const of = (kind: string, type: string) =>
    all.filter((f): f is Feature => f?.properties?.type_name === kind && f.geometry?.type === type);

  const areaRings = of("area", "Polygon").flatMap(withRing);
  if (!areaRings.length) return undefined;

  const extent = boundsOf(areaRings.flatMap(([, ring]) => ring.map(([x, y]) => ({ x, y }))));
  const origin = { lon: (extent.minX + extent.maxX) / 2, lat: (extent.minY + extent.maxY) / 2 };
  const project = (ring: readonly LonLat[]) => ring.map(([lon, lat]) => projectPosition(origin, lon, lat));
  const toZone = ([f, ring]: readonly [Feature, LonLat[]]): Zone => {
    const outline = project(ring);
    const { hash, Name, title, area } = f.properties ?? {};
    return {
      hash: typeof hash === "number" ? hash : 0,
      name: String(Name ?? title ?? ""),
      outline,
      areaM2: typeof area === "number" && area > 0 ? area : Math.abs(areaD(toPath(outline))),
    };
  };

  const areas = areaRings.map(toZone);
  const obstacles = of("obstacle", "Polygon").flatMap(withRing).map(toZone);
  const channels = of("path", "LineString")
    .map((f) => project(positions(geometryCoordinates(f))))
    .filter((line) => line.length >= 2);
  const stations = of("station", "Point").flatMap((f) => {
    const [at] = positions([geometryCoordinates(f)]);
    return at ? [{ f, position: projectPosition(origin, ...at) }] : [];
  });
  const dockStation = stations.find(({ f }) => f.properties?.Name === "Dock");
  const rotation: unknown = dockStation?.f.properties?.rotation;
  const dock: Marker | undefined = dockStation && {
    position: dockStation.position,
    ...(typeof rotation === "number" && { headingDeg: rotation }),
  };
  const rtk = stations.find(({ f }) => f.properties?.Name === "RTK Base")?.position;

  const bounds = boundsOf([
    ...[...areas, ...obstacles].flatMap((z) => z.outline),
    ...channels.flat(),
    ...(dock ? [dock.position] : []),
  ]);
  return { origin, bounds, areas, obstacles, channels, ...(dock && { dock }), ...(rtk && { rtk }) };
}

export function projectPosition(origin: MapModel["origin"], lon: number, lat: number): Point {
  return {
    x: (lon - origin.lon) * RAD * EARTH_RADIUS_M * Math.cos(origin.lat * RAD),
    y: (lat - origin.lat) * RAD * EARTH_RADIUS_M,
  };
}

function geometryCoordinates(f: Feature): unknown {
  return (f.geometry as { coordinates?: unknown }).coordinates;
}

function positions(value: unknown): LonLat[] {
  return Array.isArray(value)
    ? value.filter((p): p is LonLat => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    : [];
}

function withRing(f: Feature): [readonly [Feature, LonLat[]]] | [] {
  const coordinates = geometryCoordinates(f);
  const ring = positions(Array.isArray(coordinates) ? coordinates[0] : undefined);
  const [first] = ring;
  const last = ring.at(-1);
  if (ring.length > 1 && first?.[0] === last?.[0] && first?.[1] === last?.[1]) ring.pop();
  return ring.length >= 3 ? [[f, ring]] : [];
}
