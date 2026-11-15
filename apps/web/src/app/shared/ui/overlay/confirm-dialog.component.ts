import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { UiButtonComponent } from '../button/button.component';
import { UiModalComponent } from './modal.component';

export type UiConfirmTone = 'danger' | 'default';

/** `confirm()` options — portal-ui-kit §3 ConfirmDialog. */
export interface UiConfirmOptions {
  /** Names the object: "Deactivate Marco Silva?" */
  title: string;
  /** States the consequence (amount and builder for money actions). */
  body: string;
  /** The confirm button label: "Deactivate". */
  verb: string;
  /** `danger`: Cancel takes default focus and the verb uses the danger variant. */
  tone?: UiConfirmTone;
  /** When set, the verb stays disabled until this exact text is typed. */
  typeToConfirm?: string;
  cancelLabel?: string;
  /** Label lead-in for the type-to-confirm field, before the phrase. */
  typeToConfirmPrompt?: string;
}

/**
 * ConfirmDialog content — open it through `UiConfirmService.confirm()`,
 * never directly. Closes with `true` (confirmed) or `undefined` (Cancel,
 * ×, Esc, scrim).
 */
@Component({
  selector: 'ui-confirm-dialog',
  standalone: true,
  imports: [UiModalComponent, UiButtonComponent],
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiConfirmDialogComponent {
  protected readonly options = inject<UiConfirmOptions>(DIALOG_DATA);
  private readonly ref = inject<DialogRef<boolean>>(DialogRef);

  protected readonly danger = this.options.tone === 'danger';
  protected readonly phrase = this.options.typeToConfirm ?? null;
  protected readonly typed = signal('');
  protected readonly canConfirm = computed(() => this.phrase === null || this.typed().trim() === this.phrase);

  protected confirm(): void {
    if (this.canConfirm()) this.ref.close(true);
  }

  protected cancel(): void {
    this.ref.close();
  }

  protected onInput(event: Event): void {
    this.typed.set((event.target as HTMLInputElement).value);
  }
}
