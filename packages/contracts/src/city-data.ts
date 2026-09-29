/**
 * City-data freshness contract (trust-strip/01).
 *
 * The backend derives this from the City of Calgary Socrata dataset
 * metadata (`rowsUpdatedAt` on the Property Assessment dataset
 * `4bsw-nn7w`); the landing page renders the trust strip as
 * "Refreshed <Month Year>". No accuracy claim is made here — the month
 * comes straight from the dataset publisher's metadata.
 */
export interface CityDataFreshnessResponse {
  /**
   * Month + year the dataset was last refreshed ("September 2026"),
   * or null when the metadata could not be read. The UI falls back to
   * the "Live City data" copy instead of claiming a month.
   */
  readonly refreshedMonth: string | null;
}
