import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
import { ComparisonState } from './comparison.state';
import type { ComparisonStage } from './comparison.state';
import { ClearComparisonResult, RunComparison } from './comparison.actions';
import {
  SiteFooterComponent,
  SiteNavComponent,
  SqftSliderComponent,
  TierSelectorComponent,
  type TierOption,
} from '../../shared/components';
import { CompareResultsComponent } from './compare-results/compare-results.component';

/**
 * Neighbourhood comparison picker + results (NBH-04 / NBH-03).
 *
 * Three phases on the one route:
 * - `picker`: choose 2–3 communities, sqft, tier (persisted in WizardState).
 * - `analyzing`: honest beat — each stage maps 1:1 onto the ComparisonState
 *   pipeline (validate → fetch stats → calculate). No timers, no theater.
 * - `results`: the side-by-side cards + chart (CompareResultsComponent).
 *
 * "← Edit communities" returns here with `?edit=1`; the persisted inputs
 * stay intact. A stored result (e.g. after a refresh) lands on `results`.
 */
type ComparePhase = 'picker' | 'analyzing' | 'results';

@Component({
  selector: 'app-compare-picker-page',
  standalone: true,
  imports: [
    SiteFooterComponent,
    SiteNavComponent,
    SqftSliderComponent,
    TierSelectorComponent,
    CompareResultsComponent,
  ],
  templateUrl: './compare-picker-page.component.html',
  styleUrl: './compare-picker-page.component.scss',
})
export class ComparePickerPageComponent {
  private readonly store = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
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
  protected readonly reportCopy = this.config.get('copy').report;

  protected readonly phase = signal<ComparePhase>('picker');

  /** Live comparison state from NGXS (persisted). */
  protected readonly comparison = this.store.selectSignal(WizardState.comparison);
  protected readonly compareStatus = this.store.selectSignal(ComparisonState.status);
  protected readonly compareStage = this.store.selectSignal(ComparisonState.stage);

  /** Search box text (local only — not persisted). */
  protected readonly search = signal('');

  /** Inline warning shown when a 4th community is rejected. */
  protected readonly maxWarning = signal(false);

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

  /** Analyzing beat stages — each tied to the real pipeline stage. */
  protected readonly analyzingStages = computed(() => {
    const order: readonly ComparisonStage[] = ['validating', 'fetching', 'calculating'];
    const labels: Record<ComparisonStage, string> = {
      validating: this.copy.analyzingValidate,
      fetching: this.copy.analyzingFetch,
      calculating: this.copy.analyzingCalculate,
    };
    const current = this.compareStage();
    const currentIdx = current ? order.indexOf(current) : -1;
    return order.map((key, i) => ({
      key,
      label: labels[key],
      state: (i < currentIdx ? 'done' : i === currentIdx ? 'active' : 'pending') as
        | 'done'
        | 'active'
        | 'pending',
    }));
  });

  constructor() {
    this.seo.setForRoute('estimate/compare');

    const editRequested = this.route.snapshot.queryParamMap.get('edit') === '1';
    const hasResult = this.store.selectSnapshot(ComparisonState.result) !== null;
    this.phase.set(editRequested || !hasResult ? 'picker' : 'results');

    // "← Edit communities" navigates here with ?edit=1 on the same route —
    // Angular reuses the component, so watch the params.
    this.route.queryParams.pipe(takeUntilDestroyed()).subscribe((params) => {
      if (params['edit'] === '1' && this.phase() === 'results') {
        this.phase.set('picker');
      }
    });

    // The pipeline owns the transition: analyzing → results on ready.
    effect(() => {
      if (this.compareStatus() === 'ready' && this.phase() === 'analyzing') {
        this.phase.set('results');
      }
    });
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
   * CTA (NBH-03): runs the real comparison pipeline. The analyzing phase
   * renders while ComparisonState works; the effect above swaps to the
   * results when the pipeline reports ready.
   */
  startComparison(): void {
    if (!this.canCompare()) {
      return;
    }
    // Drop ?edit=1 so a refresh lands back on the results, not the picker.
    void this.router.navigate(['/estimate/compare'], { replaceUrl: true });
    this.phase.set('analyzing');
    this.store.dispatch(new RunComparison());
  }

  /** Error-state retry: re-runs the pipeline with the same inputs. */
  retryComparison(): void {
    this.phase.set('analyzing');
    this.store.dispatch(new RunComparison());
  }

  /** Back from an error to adjust picks (clears the failed result). */
  backToPicker(): void {
    this.store.dispatch(new ClearComparisonResult());
    this.phase.set('picker');
  }

  private update(inputs: Partial<ComparisonInputs>): void {
    this.store.dispatch(new UpdateComparison(inputs));
  }
}
