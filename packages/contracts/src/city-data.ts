/**
 * City-data freshness contract (trust-strip/01).
 *
 * The backend derives this from the City of Calgary Socrata dataset
 * metadata (`rowsUpdatedAt` on the Property Assessment dataset
 * `4bsw-nn7w`) plus the dataset's latest `roll_year`; the web app renders
 * one freshness line from it everywhere ("2026 assessment roll (City of
 * Calgary) · checked Nov 2026", #513). No accuracy claim is made here — the month
 * comes straight from the dataset publisher's metadata.
 */
export interface CityDataFreshnessResponse {
  /**
   * Month + year the dataset was last refreshed ("September 2026"),
   * or null when the metadata could not be read. The UI falls back to
   * the "Live City data" copy instead of claiming a month.
   */
  readonly refreshedMonth: string | null;
  /**
   * Latest assessment roll year in the dataset (e.g. 2026), or null when it
   * could not be read. Optional on the wire for deploy skew (an older API
   * omits it); the UI treats missing like null (#513).
   */
  readonly rollYear?: number | null;
}
