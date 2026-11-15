import { ChangeDetectionStrategy, Component, forwardRef, input, model } from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import { UiFieldBase } from './field-base';
import { UiFieldShellComponent } from './field-shell.component';

/**
 * DateField — portal UI kit §3. Native date picker; the value is an ISO
 * calendar date (`YYYY-MM-DD`) or null when empty.
 *
 *   <ui-date-field label="Contract signed" [max]="today" [(value)]="signedOn" />
 */
@Component({
  selector: 'ui-date-field',
  standalone: true,
  imports: [UiFieldShellComponent],
  templateUrl: './date-field.component.html',
  styleUrl: './date-field.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => UiDateFieldComponent), multi: true },
  ],
})
export class UiDateFieldComponent extends UiFieldBase<string | null> {
  readonly value = model<string | null>(null);
  /** Earliest selectable ISO date. */
  readonly min = input<string | null>(null);
  /** Latest selectable ISO date. */
  readonly max = input<string | null>(null);

  writeValue(value: string | null): void {
    this.value.set(value || null);
  }

  protected onInput(raw: string): void {
    const next = raw || null;
    this.value.set(next);
    this.onChange(next);
  }
}
