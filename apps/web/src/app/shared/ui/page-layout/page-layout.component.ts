import { ChangeDetectionStrategy, Component, booleanAttribute, input } from '@angular/core';

/** Which portal the page belongs to — sets the content max-width. */
export type PageLayoutPortal = 'builder' | 'admin';

/**
 * PageLayout (`ui-page-layout`) — the one content frame for builder and
 * admin pages (portal UI kit §3, docs/design/portal-ui-kit.md).
 *
 * - `portal="builder"` (default): content max-width 1120px.
 * - `portal="admin"`: fluid up to 1440px.
 * - `narrow`: 640px column for forms (either portal).
 *
 * Gutter is 32px on desktop and 16px below 768px. The frame is
 * deliberately transparent — no tinted background, border or shadow — so
 * a page never ends up as a "card in a card". `min-width: 0` plus
 * `overflow-wrap` keep long content from widening the page at 390px.
 */
@Component({
  selector: 'ui-page-layout',
  standalone: true,
  templateUrl: './page-layout.component.html',
  styleUrl: './page-layout.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'ui-page-layout',
    '[class.ui-page-layout--admin]': "portal() === 'admin'",
    '[class.ui-page-layout--narrow]': 'narrow()',
  },
})
export class PageLayoutComponent {
  readonly portal = input<PageLayoutPortal>('builder');
  readonly narrow = input(false, { transform: booleanAttribute });
}
