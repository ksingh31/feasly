/**
 * Address helpers (shared).
 *
 * Calgary condo/unit addresses surface in City data in a few shapes:
 * "225 823 5 Av NW" (unit 225 of 823 5 Av NW), "225-823 5 Av NW",
 * "Unit 225, 823 5 Av NW", "#225 823 5 Av NW". When the City record for a
 * unit address is priced, the lot size and assessed land value describe the
 * WHOLE building/parcel — the report says so honestly instead of implying
 * the lot belongs to the unit.
 */

/** True when the address looks like a condo/apartment unit rather than a whole property. */
export function isUnitLikeAddress(address: string): boolean {
  const a = address.trim();
  if (!a) {
    return false;
  }
  return (
    // "225 823 5 Av NW" — leading unit number before the street number.
    /^\d+\s+\d+\s+\S/.test(a) ||
    // "225-823 5 Av NW" — hyphenated unit-street form.
    /^\d+\s*[–—-]\s*\d+\s+\S/.test(a) ||
    // "Unit 225 ...", "Apt 4 ...", "Suite 100 ..."
    /\b(unit|apt|apartment|suite)\s+\w/i.test(a) ||
    // "#225 ..." unit marker.
    /#\s*\w/.test(a)
  );
}
