import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

/** One row of the Technical IDs section. */
export interface TechnicalId {
  readonly label: string;
  readonly value: string;
}

/**
 * Technical IDs (portal-ui-kit §5: "no raw UUIDs outside a collapsed
 * Technical IDs section"). A native `<details>` disclosure, closed by
 * default, listing raw identifiers with a copy button each — for support
 * staff who need to quote an id, out of everyone else's way.
 */
@Component({
  selector: 'ui-technical-ids',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './technical-ids.component.html',
  styleUrl: './technical-ids.component.scss',
})
export class TechnicalIdsComponent {
  readonly ids = input.required<readonly TechnicalId[]>();
  readonly summary = input('Technical IDs');
  readonly copyLabel = input('Copy ID');
  readonly copiedLabel = input('ID copied');

  /** Label of the row whose id just reached the clipboard. */
  protected readonly copied = signal<string | null>(null);

  protected copy(row: TechnicalId): void {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) return;
    clipboard.writeText(row.value).then(
      () => this.copied.set(row.label),
      () => this.copied.set(null),
    );
  }

  /** Clears the confirmation when focus/pointer leaves — no timers. */
  protected reset(): void {
    this.copied.set(null);
  }
}
