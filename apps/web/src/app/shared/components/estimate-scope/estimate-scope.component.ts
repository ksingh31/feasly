import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ConfigService } from '../../../core/config/config.service';
import type { EstimateScopeItem } from '../../../core/config/app-config';
import { notIncludedItems } from '../../../core/utils/estimate-scope';

/** Which list(s) a host renders. */
export type EstimateScopePart = 'both' | 'includes' | 'excluded';

/**
 * EstimateScope (#824) — "What this estimate includes" and "Not included".
 *
 * The includes list is `estimateScope.includes`, GENERATED from the cost
 * engine's line items (no hand-written list, so it can't drift). The
 * not-included list is config; an entry whose key the engine now prices is
 * hidden, so a new engine line item (#825) moves from "Not included" to
 * "includes" with no copy change. Shared by the report, the preview and How
 * it works. Display only — no figures, no math.
 */
@Component({
  selector: 'app-estimate-scope',
  standalone: true,
  templateUrl: './estimate-scope.component.html',
  styleUrl: './estimate-scope.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EstimateScopeComponent {
  private readonly config = inject(ConfigService);

  /** Which list(s) to render. Default both. */
  readonly part = input<EstimateScopePart>('both');
  /** Heading level for the list titles (fits the host's outline). */
  readonly headingLevel = input<2 | 3>(3);
  /** Hosts that head the section themselves pass `false`. */
  readonly showTitles = input(true);

  protected readonly copy = this.config.get('copy').estimateScope;

  protected readonly includes = computed<readonly EstimateScopeItem[]>(
    () => this.config.get('estimateScope').includes,
  );

  protected readonly notIncluded = computed<readonly EstimateScopeItem[]>(() =>
    notIncludedItems(this.config.get('estimateScope')),
  );

  protected readonly showIncludes = computed(() => this.part() !== 'excluded' && this.includes().length > 0);
  protected readonly showExcluded = computed(() => this.part() !== 'includes' && this.notIncluded().length > 0);
}
