/**
 * Schools directory source attributions (#774) — pure constants.
 *
 * Shared by the refresh-side builder and the request-side read service, so
 * the read path never imports provider code. Pure — no I/O.
 */
import type { SchoolSourceId } from '@feasly/contracts';

/** Sources and the notice each requires wherever its data is shown. */
export const SCHOOL_SOURCE_ATTRIBUTIONS: Readonly<
  Record<SchoolSourceId, { readonly label: string; readonly licence: string; readonly url: string }>
> = {
  'calgary-open-data': {
    label: 'City of Calgary Open Data — Schools; Community District Boundaries',
    licence: 'Open Government Licence – City of Calgary',
    url: 'https://data.calgary.ca',
  },
  'alberta-authority-list': {
    label: 'Alberta Education — school authority list',
    licence: 'Open Government Licence – Alberta',
    url: 'https://www.alberta.ca/school-authorities',
  },
  openstreetmap: {
    label: '© OpenStreetMap contributors',
    licence: 'Open Database License (ODbL)',
    url: 'https://www.openstreetmap.org/copyright',
  },
};

/**
 * A school website as an absolute http(s) URL, or null. A bare host
 * ("school.ca") is read as https.
 */
export function websiteUrlOrNull(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
