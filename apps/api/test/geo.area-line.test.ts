/** Pure geometry helpers added for amenities (#777). */
import { describe, expect, it } from 'vitest';
import { lineRepresentativePoint, polygonAreaM2 } from '../src/lib/geo';

describe('polygonAreaM2', () => {
  it('approximates a ~1 km x ~1.11 km box and subtracts holes', () => {
    const outer = [[-114.1055, 51.0087], [-114.0911, 51.0087], [-114.0911, 51.0187], [-114.1055, 51.0187], [-114.1055, 51.0087]];
    const hole = [[-114.1, 51.01], [-114.099, 51.01], [-114.099, 51.011], [-114.1, 51.011], [-114.1, 51.01]];
    const solid = polygonAreaM2({ type: 'Polygon', coordinates: [outer] });
    // 0.0144° lng * 69.97 km/° ≈ 1.008 km; 0.01° lat ≈ 1.112 km.
    expect(solid / 1e6).toBeCloseTo(1.008 * 1.112, 1);
    const holed = polygonAreaM2({ type: 'MultiPolygon', coordinates: [[outer, hole]] });
    expect(holed).toBeLessThan(solid);
    expect(holed).toBeGreaterThan(solid * 0.9);
  });

  it('is 0 for missing or non-polygon geometry', () => {
    expect(polygonAreaM2(null)).toBe(0);
    expect(polygonAreaM2({ type: 'Point', coordinates: [1, 2] })).toBe(0);
  });
});

describe('lineRepresentativePoint', () => {
  it('picks the middle vertex of the longest part', () => {
    expect(
      lineRepresentativePoint({
        type: 'MultiLineString',
        coordinates: [
          [[0, 0], [1, 1]],
          [[10, 10], [11, 11], [12, 12]],
        ],
      }),
    ).toEqual({ lon: 11, lat: 11 });
    expect(lineRepresentativePoint({ type: 'LineString', coordinates: [[5, 6]] })).toEqual({ lon: 5, lat: 6 });
  });

  it('is null for malformed input', () => {
    expect(lineRepresentativePoint({ type: 'LineString', coordinates: [] })).toBeNull();
    expect(lineRepresentativePoint('x')).toBeNull();
  });
});
