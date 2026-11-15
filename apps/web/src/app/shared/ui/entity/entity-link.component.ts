import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

/**
 * EntityLink (portal-ui-kit §3, §5 "Every record reference is an
 * EntityLink"): shows a human label (invoice number, lead name, builder)
 * that opens the record's drawer, with a copy-ID button revealed on hover
 * or keyboard focus. The raw id is never the visible text.
 *
 * The host decides what "open" means (usually `?open=<id>`), so the link
 * stays free of router and store knowledge.
 */
@Component({
  selector: 'ui-entity-link',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './entity-link.component.html',
  styleUrl: './entity-link.component.scss',
})
export class EntityLinkComponent {
  /** Record id; emitted on open and copied by the copy button. */
  readonly entityId = input.required<string>();
  /** Human label shown as the link text. */
  readonly label = input.required<string>();
  /** Record kind for screen readers, e.g. "invoice" → "Copy invoice ID". */
  readonly kind = input<string | undefined>(undefined);
  readonly copyLabel = input('Copy ID');
  readonly copiedLabel = input('ID copied');
  /** Hide the copy button (e.g. inside a dense table cell that has its own). */
  readonly copyable = input(true);

  /** Emits the record id when the link is activated. */
  readonly opened = output<string>();
  /** Emits the record id after it reached the clipboard. */
  readonly copied = output<string>();

  protected readonly justCopied = signal(false);

  protected copyAriaLabel(): string {
    const kind = this.kind();
    return kind ? `${this.copyLabel()} (${kind})` : this.copyLabel();
  }

  protected open(): void {
    this.opened.emit(this.entityId());
  }

  protected copy(): void {
    const id = this.entityId();
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard) {
      return;
    }
    clipboard.writeText(id).then(
      () => {
        this.justCopied.set(true);
        this.copied.emit(id);
      },
      () => this.justCopied.set(false),
    );
  }

  /** The "copied" confirmation clears when the pointer or focus leaves — no timers. */
  protected reset(): void {
    this.justCopied.set(false);
  }
}
