import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** One breadcrumb. The last crumb is the current page and is never a link. */
export interface Breadcrumb {
  readonly label: string;
  /** Router link for ancestor crumbs; ignored on the last (current) crumb. */
  readonly link?: string | readonly unknown[];
}

/**
 * PageHeader (`ui-page-header`) — portal UI kit §3.
 *
 * Optional breadcrumbs, exactly one H1 (`--type-product-h1`), an optional
 * single-line description, and actions on the right (1 primary + ≤2
 * secondary + overflow) projected via `[uiPageHeaderActions]`:
 *
 * ```html
 * <ui-page-header heading="Leads" description="Everyone who asked for a quote.">
 *   <div uiPageHeaderActions>…buttons…</div>
 * </ui-page-header>
 * ```
 *
 * On narrow screens the actions wrap under the title instead of squeezing
 * it, so the header never widens the page at 390px.
 */
@Component({
  selector: 'ui-page-header',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './page-header.component.html',
  styleUrl: './page-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ui-page-header' },
})
export class PageHeaderComponent {
  /** The page's H1 text. */
  readonly heading = input.required<string>();
  /** One short line under the title. */
  readonly description = input<string | null>(null);
  readonly breadcrumbs = input<readonly Breadcrumb[]>([]);
  /** Accessible name for the breadcrumb landmark. */
  readonly breadcrumbLabel = input('Breadcrumb');
  /** id on the H1 — lets a page or drawer point `aria-labelledby` at it. */
  readonly headingId = input<string | null>(null);
}
