/**
 * Pure planar geometry helpers for parcel polygons (#686). No I/O.
 *
 * Parcels are small (tens of metres), so lon/lat is treated as a plane — the
 * distortion is irrelevant for picking a point that lies inside the lot.
 */

export interface LonLat {
  readonly lon: number;
  readonly lat: number;
}

type Ring = ReadonlyArray<readonly [number, number]>;

function isPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function toRing(value: unknown): Ring | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  if (!value.every(isPosition)) return null;
  return value as Ring;
}

/** Outer rings of a GeoJSON Polygon or MultiPolygon; empty when malformed. */
function outerRings(geometry: unknown): Ring[] {
  if (typeof geometry !== 'object' || geometry === null) return [];
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  if (!Array.isArray(coordinates)) return [];
  const polygons: unknown[] =
    type === 'MultiPolygon' ? coordinates : type === 'Polygon' ? [coordinates] : [];
  const rings: Ring[] = [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) continue;
    const ring = toRing(polygon[0]);
    if (ring) rings.push(ring);
  }
  return rings;
}

/** Signed shoelace area (positive = counter-clockwise). */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function centroid(ring: Ring): LonLat | null {
  const area = signedArea(ring);
  if (area === 0) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return { lon: cx / (6 * area), lat: cy / (6 * area) };
}

/** Even-odd ray cast: true when the point is strictly inside the ring. */
export function pointInRing(point: LonLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point.lat !== yj > point.lat) {
      const x = ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
      if (point.lon < x) inside = !inside;
    }
  }
  return inside;
}

/**
 * Interior point by horizontal scanline through the bounding-box middle:
 * the midpoint of the widest inside span. Used when the centroid of a
 * concave lot (L-shape, flag lot) falls outside it.
 */
function scanlinePoint(ring: Ring): LonLat | null {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of ring) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const y = (minY + maxY) / 2;
  const xs: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
  }
  xs.sort((a, b) => a - b);
  let best: LonLat | null = null;
  let widest = 0;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const width = xs[k + 1] - xs[k];
    if (width > widest) {
      widest = width;
      best = { lon: (xs[k] + xs[k + 1]) / 2, lat: y };
    }
  }
  return best;
}

/**
 * A point guaranteed (for well-formed input) to lie inside the largest
 * polygon of a GeoJSON Polygon/MultiPolygon: its centroid when that is
 * inside, otherwise a scanline interior point. Null when the geometry is
 * missing or malformed.
 */
export function parcelInteriorPoint(geometry: unknown): LonLat | null {
  const rings = outerRings(geometry);
  if (rings.length === 0) return null;
  let largest = rings[0];
  for (const ring of rings) {
    if (Math.abs(signedArea(ring)) > Math.abs(signedArea(largest))) largest = ring;
  }
  const c = centroid(largest);
  if (c && pointInRing(c, largest)) return c;
  return scanlinePoint(largest);
}

/** Mean Earth radius in metres (IUGG). */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Great-circle distance in metres between two points (#773). Straight-line
 * only — never a travel time.
 */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * True when the point lies inside a GeoJSON Polygon or MultiPolygon (#774):
 * inside some polygon's outer ring and in none of that polygon's holes.
 * False for missing or malformed geometry.
 */
export function pointInGeometry(point: LonLat, geometry: unknown): boolean {
  if (typeof geometry !== 'object' || geometry === null) return false;
  const { type, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  if (!Array.isArray(coordinates)) return false;
  const polygons: unknown[] =
    type === 'MultiPolygon' ? coordinates : type === 'Polygon' ? [coordinates] : [];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon)) continue;
    const outer = toRing(polygon[0]);
    if (!outer || !pointInRing(point, outer)) continue;
    const inHole = polygon.slice(1).some((hole) => {
      const ring = toRing(hole);
      return ring !== null && pointInRing(point, ring);
    });
    if (!inHole) return true;
  }
  return false;
}
