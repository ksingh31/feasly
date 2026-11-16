import { Injectable } from '@angular/core';
import type { CommunityIndexEntry, CommunityIndexFile } from '@feasly/contracts';
import { toDisplayName } from '../../shared/utils/community-name';

/** One community suggestion in the site search (#783). */
export interface CommunitySuggestion {
  readonly slug: string;
  /** Display name ("Altadore", "McKenzie Towne"). */
  readonly name: string;
}

/** Lower-cases and collapses everything but letters/digits to single spaces. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Ranks communities whose name contains the query (#783). Names that start
 * with the query come first, then names with a word starting with it, then
 * any other match; ties sort alphabetically. Empty queries match nothing.
 * Pure — no Angular, no I/O.
 */
export function matchCommunities(
  query: string,
  communities: readonly CommunitySuggestion[],
  limit: number,
): CommunitySuggestion[] {
  const needle = normalize(query);
  if (!needle || limit <= 0) return [];
  const ranked: { rank: number; community: CommunitySuggestion }[] = [];
  for (const community of communities) {
    const haystack = normalize(community.name);
    const at = haystack.indexOf(needle);
    if (at < 0) continue;
    const rank = at === 0 ? 0 : haystack.includes(` ${needle}`) ? 1 : 2;
    ranked.push({ rank, community });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.community.name.localeCompare(b.community.name, 'en-CA'))
    .slice(0, limit)
    .map((r) => r.community);
}

/** Established (infill) communities only (#690 rule), as display suggestions. */
export function establishedCommunities(entries: readonly CommunityIndexEntry[]): CommunitySuggestion[] {
  return entries
    .filter((entry) => entry.group === 'established')
    .map((entry) => ({ slug: entry.slug, name: toDisplayName(entry.name) }));
}

/**
 * Community side of the site search (#783). The community index (the same
 * file the communities hub renders) is loaded with a dynamic import the
 * first time it is needed, so it stays out of the initial bundle and out of
 * the builder embed, which never turns community search on. Vite emits it
 * as its own static chunk — no API call.
 */
@Injectable({ providedIn: 'root' })
export class CommunitySearchService {
  private communities: Promise<CommunitySuggestion[]> | null = null;

  /** Loads (once) and caches the established-community list. */
  load(): Promise<CommunitySuggestion[]> {
    this.communities ??= import('../../../content/data/community-index.json').then(
      (mod) => establishedCommunities(((mod.default ?? mod) as CommunityIndexFile).communities),
      (error: unknown) => {
        // Let a later search retry the chunk (e.g. after a flaky network).
        this.communities = null;
        throw error;
      },
    );
    return this.communities;
  }

  /**
   * Up to `limit` established communities matching `query`, best first.
   * Resolves to no matches when the index cannot be loaded — the address
   * side of the search keeps working.
   */
  async search(query: string, limit: number): Promise<CommunitySuggestion[]> {
    try {
      return matchCommunities(query, await this.load(), limit);
    } catch {
      return [];
    }
  }
}
