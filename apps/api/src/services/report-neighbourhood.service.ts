/**
 * Report email "Schools for this address" + "Living near this lot" (#785).
 *
 * Builds the neighbourhood summary the consumer report email renders, from
 * the SAME stored data the web report reads (school designations #775 and
 * community living metrics #777). Both read services serve our own tables
 * only — a send never triggers an outside call.
 *
 * Best-effort by design: the report email must always send, so any failure
 * (unknown address, cache/DB error) yields `undefined` and the email simply
 * leaves the sections out. Empty data hides the matching section (no empty
 * boxes): the summary carries only what is on file.
 */
import type { ReportNeighbourhoodSummary } from './email/templates';
import type { NeighbourhoodReadService } from './neighbourhood-data/neighbourhood-read.service';
import type { SchoolDesignationReadService } from './neighbourhood-data/school-designation-read.service';

export interface ReportNeighbourhoodServiceDeps {
  readonly designations: Pick<SchoolDesignationReadService, 'forAddress'>;
  readonly neighbourhood: Pick<NeighbourhoodReadService, 'getCommunityLivingMetrics'>;
  readonly logWarning?: (message: string) => void;
}

export interface ReportNeighbourhoodService {
  /** Summary for an address; undefined when nothing is on file or a read fails. */
  forAddress(addressKey: string): Promise<ReportNeighbourhoodSummary | undefined>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

export function createReportNeighbourhoodService(
  deps: ReportNeighbourhoodServiceDeps,
): ReportNeighbourhoodService {
  const warn = deps.logWarning ?? ((m: string) => console.warn(m));
  return {
    async forAddress(addressKey) {
      try {
        const schools = await deps.designations.forAddress(addressKey);
        // Slug only — matches the web report (no communityCode fallback).
        const slug = schools.slug ?? null;
        const living = slug ? await deps.neighbourhood.getCommunityLivingMetrics(slug) : null;
        const amenities = (living?.amenities ?? [])
          .filter((a) => a.nearest !== null)
          .map((a) => ({
            label: a.label,
            nearestName: a.nearest!.name,
            distanceM: a.nearest!.distanceM,
          }));
        const treeCover = living?.treeCover
          ? { level: living.treeCover.level, treesPerHa: living.treeCover.treesPerHa }
          : null;
        const summary: ReportNeighbourhoodSummary = {
          communityName: schools.communityName ?? living?.name ?? null,
          schools: schools.designations.map((d) => ({
            boardName: d.boardName,
            gradeBand: d.gradeBand,
            schoolName: d.schoolName,
          })),
          boardLookups: schools.boards.map((b) => ({ name: b.name, lookupUrl: b.lookupUrl })),
          amenities,
          treeCover,
        };
        if (summary.schools.length === 0 && amenities.length === 0 && treeCover === null) {
          return undefined;
        }
        return summary;
      } catch (error) {
        warn(`report-neighbourhood: summary unavailable (${errorName(error)})`);
        return undefined;
      }
    },
  };
}
