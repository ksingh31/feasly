import { Injectable } from '@angular/core';
import type { CommunityIndexEntry, CommunityIndexFile } from '@feasly/contracts';
import { toDisplayName } from '../../shared/utils/community-name';
import indexData from '../../../content/data/community-index.json';

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
 * Community side of the site search (#783). Reads the community index that
 * is bundled at build time (the same file the communities hub renders), so
 * suggesting a community never makes a network call.
 */
@Injectable({ providedIn: 'root' })
export class CommunitySearchService {
  private readonly communities = establishedCommunities((indexData as CommunityIndexFile).communities);

  /** Up to `limit` established communities matching `query`, best first. */
  search(query: string, limit: number): CommunitySuggestion[] {
    return matchCommunities(query, this.communities, limit);
  }
}
