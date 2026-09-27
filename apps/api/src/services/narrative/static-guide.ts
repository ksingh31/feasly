/**
 * Static "Building in Calgary" guide (BE-9, final fallback tier).
 *
 * When every narrative model fails — chain exhausted, or the output fails
 * validation after the repair retry — the narrative service returns this
 * hard-coded guide instead of a 502 dead-end. It is NEVER presented as AI
 * prose: the response carries `narrativeSource: 'static-guide'` and the
 * frontend labels it accordingly.
 *
 * Content rules (pinned by test):
 * - NO dollar figures (bypasses `validateNarrative`, nothing to validate).
 * - NO fake personalization ("in your neighbourhood") — it is generic.
 * - NO invented facts — every claim is true at this level of generality.
 * - The verbatim compliance footer is still appended via
 *   `ensureNarrativeFooter`.
 *
 * The guide is never persisted: the next visit retries the AI chain.
 */
import { ensureNarrativeFooter } from '@feasly/cost-engine';

/** The guide paragraphs, in display order. */
export const STATIC_GUIDE_PARAGRAPHS: readonly string[] = [
  'Building in Calgary means building for winter. Foundations here must extend below the frost line, and your builder will plan excavation, concrete work, and backfilling around freeze–thaw cycles. Ask how your builder sequences winter work — it is one of the biggest schedule variables on a Calgary project.',
  'Most new homes in Calgary need development and building permits from the City of Calgary before construction starts. Timelines vary by community and application type, so confirm the current process and expected review times with the City or your builder early — permits waiting in queue are a common cause of delayed starts.',
  'Where you build shapes the project. Infill lots in established neighbourhoods can come with older servicing, tighter access for equipment, and neighbour considerations during construction. Greenfield lots in new communities may still be waiting on grading, roads, or shallow utilities. Walk the lot with your builder before you commit to a design.',
  'Soil and grading deserve attention up front. Much of Calgary sits on clay-heavy soils that expand and contract with moisture, which affects foundation design and drainage planning. A geotechnical report for your specific lot takes the guesswork out of foundation design.',
];

/**
 * Build the full static-guide narrative: paragraphs joined as prose, plus
 * the verbatim compliance footer (exactly once).
 */
export function buildStaticGuideNarrative(): string {
  return ensureNarrativeFooter(STATIC_GUIDE_PARAGRAPHS.join('\n\n'));
}
