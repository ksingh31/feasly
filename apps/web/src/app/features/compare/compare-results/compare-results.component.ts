import { Component, inject } from '@angular/core';
import { NgStyle } from '@angular/common';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import type { ComparisonRowSet, CostRange, FinishTier } from '@feasly/contracts';
import { ConfigService } from '../../../core/config/config.service';
import { CommunityService } from '../../../core/community/community.service';
import type { CommunityStats } from '../../../core/api/api.service';
import { TierSelectorComponent } from '../../../shared/components';
import type { TierOption } from '../../../shared/components';
import { ComparisonState } from '../comparison.state';
import { ReviseComparisonTier } from '../comparison.actions';
import { WizardState } from '../../wizard/wizard.state';

/**
 * Comparison results (NBH-03): side-by-side community cards + total-range
 * bar chart.
 *
 * Pre-gate the build/total figures and the chart are locked: the locked
 * slots render CSS-only skeleton bars (`aria-hidden`) plus the accessible
 * "Available after email verification" note — real numbers never enter the
 * DOM until the lead gate converts. Land ranges and the City-assessed
 * values are always visible (per the API's visibility hints).
 *
 * Exactly one card carries the "Lowest land cost" badge, driven by the
 * API's `lowestLand` flag (ties broken server-side by input order).
 *
 * Post-gate the tier what-if re-runs every row-set inline via
 * ReviseComparisonTier.
 */
@Component({
  selector: 'app-compare-results',
  standalone: true,
  imports: [NgStyle, TierSelectorComponent],
  templateUrl: './compare-results.component.html',
  styleUrl: './compare-results.component.scss',
})
export class CompareResultsComponent {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly config = inject(ConfigService);
  private readonly communities = inject(CommunityService);

  protected readonly copy = this.config.get('copy').comparison;
  protected readonly wizardCopy = this.config.get('wizard');

  protected readonly result = this.store.selectSignal(ComparisonState.result);
  protected readonly stats = this.store.selectSignal(ComparisonState.stats);
  protected readonly unlocked = this.store.selectSignal(ComparisonState.unlocked);
  protected readonly comparison = this.store.selectSignal(WizardState.comparison);

  protected readonly tierOptions: readonly TierOption[] = [
    { id: 'standard', name: 'Standard', blurb: 'Quality essentials' },
    { id: 'premium', name: 'Premium', blurb: 'Upgraded finishes' },
    { id: 'luxury', name: 'Luxury', blurb: 'Top-tier everything' },
  ];

  /** "2 Calgary communities · 2,200 sq ft · Premium" — no dollar figures. */
  protected subheading(): string {
    const inputs = this.comparison();
    const count = this.result()?.rowSets.length ?? inputs.slugs.length;
    const tierName =
      this.tierOptions.find((o) => o.id === inputs.tier)?.name ?? inputs.tier;
    return this.copy.resultsSubheading
      .replace('{count}', `${count} Calgary communities`)
      .replace('{sqft}', `${inputs.sqft.toLocaleString('en-CA')} sq ft`)
      .replace('{tier}', `${tierName} finish`);
  }

  protected statsFor(slug: string): CommunityStats | undefined {
    return this.stats()[slug];
  }

  /**
   * Display name: the community descriptor is the canonical UI source;
   * falls back to the stats wire name, then the slug.
   */
  protected displayName(slug: string): string {
    return (
      this.communities.bySlug(slug)?.name ?? this.statsFor(slug)?.name ?? slug
    );
  }

  protected formatMoney(value: number): string {
    return `$${Math.round(value).toLocaleString('en-CA')}`;
  }

  protected formatRange(range: CostRange): string {
    return this.formatMoney(range.low) + ' – ' + this.formatMoney(range.high);
  }

  /**
   * Bar geometry as percentages of the widest total-high across row-sets.
   * Only rendered post-gate — pre-gate the chart shows skeleton bars.
   */
  protected barStyle(rowSet: ComparisonRowSet): Record<string, string> {
    const rowSets = this.result()?.rowSets ?? [];
    const maxHigh = Math.max(...rowSets.map((r) => r.total.high), 1);
    const left = (rowSet.total.low / maxHigh) * 100;
    const width = Math.max(((rowSet.total.high - rowSet.total.low) / maxHigh) * 100, 2);
    return { left: `${left.toFixed(2)}%`, width: `${width.toFixed(2)}%` };
  }

  protected onTierChange(tier: FinishTier): void {
    this.store.dispatch(new ReviseComparisonTier(tier));
  }

  protected unlock(): void {
    void this.router.navigate(['/estimate/gate'], { queryParams: { flow: 'comparison' } });
  }

  protected edit(): void {
    // The picker page reads the phase from ComparisonState: clearing the
    // result returns to the picker with the persisted inputs intact.
    void this.router.navigate(['/estimate/compare'], { queryParams: { edit: '1' } });
  }
}
