import { Component, computed, inject, signal } from '@angular/core';
import { Store } from '@ngxs/store';
import type { FinishTier } from '@feasly/contracts';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { CommunityService, type CommunityDescriptor } from '../../core/community';
import {
  ClearComparison,
  UpdateComparison,
  WizardState,
  type ComparisonInputs,
} from '../wizard';
import {
  SiteFooterComponent,
  SiteNavComponent,
  SqftSliderComponent,
  TierSelectorComponent,
  type TierOption,
} from '../../shared/components';

/**
 * Neighbourhood comparison picker (NBH-04): searchable Calgary community
 * list, pick 2–3, then sqft + finish-tier, then "Compare →".
 *
 * All picker state lives in NGXS (`WizardState.comparison`) and persists via
 * the storage plugin, so a refresh mid-picker restores the selections. The
 * CTA currently swaps to an explicit interim confirmation panel — NBH-03
 * owns the real comparison result pipeline (analyzing beat → comparison UI)
 * and replaces the interim.
 */
@Component({
  selector: 'app-compare-picker-page',
  standalone: true,
  imports: [
    SiteFooterComponent,
    SiteNavComponent,
    SqftSliderComponent,
    TierSelectorComponent,
  ],
  templateUrl: './compare-picker-page.component.html',
  styleUrl: './compare-picker-page.component.scss',
})
export class ComparePickerPageComponent {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly communities = inject(CommunityService);

  /** Max communities the story allows side-by-side. */
  static readonly MAX_COMMUNITIES = 3;
  /** Min communities before the CTA enables. */
  static readonly MIN_COMMUNITIES = 2;

  protected readonly copy = this.config.get('copy').comparison;
  protected readonly wizard = this.config.get('wizard');
  protected readonly scopeCopy = this.config.get('copy').wizard;

  /** Live comparison state from NGXS (persisted). */
  protected readonly comparison = this.store.selectSignal(WizardState.comparison);

  /** Search box text (local only — not persisted). */
  protected readonly search = signal('');

  /** Inline warning shown when a 4th community is rejected. */
  protected readonly maxWarning = signal(false);

  /**
   * Interim confirmation flag (NBH-04 only): after the CTA, the picker swaps
   * to an honest "on its way" panel. NBH-03 replaces this with the real
   * comparison result pipeline (analyzing beat → comparison UI).
   */
  protected readonly submitted = signal(false);

  /** All communities, filtered by the search text (case-insensitive). */
  protected readonly filtered = computed<readonly CommunityDescriptor[]>(() => {
    const q = this.search().trim().toLowerCase();
    const all = this.communities.list();
    if (!q) {
      return all;
    }
    return all.filter((c) => c.name.toLowerCase().includes(q));
  });

  /** Tier options for the shared selector (config-owned copy). */
  protected readonly tierOptions: TierOption[] = this.scopeCopy.scopeTiers.map((t) => ({
    id: t.id as FinishTier,
    name: t.name,
    blurb: t.blurb,
  }));

  protected readonly selectedCount = computed(() => this.comparison().slugs.length);
  protected readonly canCompare = computed(
    () => this.selectedCount() >= ComparePickerPageComponent.MIN_COMMUNITIES,
  );

  constructor() {
    this.seo.setForRoute('estimate/compare');
  }

  /** Display name for a stored slug (falls back to the slug). */
  nameFor(slug: string): string {
    return this.communities.bySlug(slug)?.name ?? slug;
  }

  isSelected(slug: string): boolean {
    return this.comparison().slugs.includes(slug);
  }

  toggleCommunity(slug: string): void {
    // selectSnapshot (not the signal): the signal may lag a synchronous
    // dispatch by a tick, and rapid toggles must read the latest slugs.
    const current = this.store.selectSnapshot(WizardState.comparison).slugs;
    if (current.includes(slug)) {
      this.maxWarning.set(false);
      this.update({ slugs: current.filter((s) => s !== slug) });
      return;
    }
    if (current.length >= ComparePickerPageComponent.MAX_COMMUNITIES) {
      // Fourth selection rejected with the exact story copy.
      this.maxWarning.set(true);
      return;
    }
    this.maxWarning.set(false);
    this.update({ slugs: [...current, slug] });
  }

  onSearchInput(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  onSqftInput(value: number): void {
    this.update({ sqft: value });
  }

  onTierChange(tier: FinishTier): void {
    this.update({ tier });
  }

  clearAll(): void {
    this.store.dispatch(new ClearComparison());
    this.maxWarning.set(false);
    this.search.set('');
  }

  /**
   * CTA: explicit interim transition (NBH-04). Until NBH-03 lands the real
   * comparison result pipeline, the picker swaps to an honest confirmation
   * panel — it never pretends a result already exists.
   */
  startComparison(): void {
    if (!this.canCompare()) {
      return;
    }
    this.submitted.set(true);
  }

  /** Back from the interim panel to adjust picks. */
  backToPicker(): void {
    this.submitted.set(false);
  }

  private update(inputs: Partial<ComparisonInputs>): void {
    this.store.dispatch(new UpdateComparison(inputs));
  }
}
