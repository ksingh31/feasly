import { ChangeDetectionStrategy, Component, forwardRef, input, model } from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import { UiFieldBase } from './field-base';
import { UiFieldShellComponent } from './field-shell.component';

export type UiTextFieldType = 'text' | 'email' | 'tel' | 'url' | 'search' | 'password';

/**
 * TextField — portal UI kit §3. Works with `[(value)]` or `[formControl]`.
 *
 *   <ui-text-field label="Company name" hint="Shown on invoices" [(value)]="name" />
 */
@Component({
  selector: 'ui-text-field',
  standalone: true,
  imports: [UiFieldShellComponent],
  templateUrl: './text-field.component.html',
  styleUrl: './text-field.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => UiTextFieldComponent), multi: true },
  ],
})
export class UiTextFieldComponent extends UiFieldBase<string> {
  readonly value = model('');
  readonly type = input<UiTextFieldType>('text');
  readonly placeholder = input<string | null>(null);
  readonly autocomplete = input<string | null>(null);
  readonly inputmode = input<string | null>(null);

  writeValue(value: string | null): void {
    this.value.set(value ?? '');
  }

  protected onInput(raw: string): void {
    this.value.set(raw);
    this.onChange(raw);
  }
}
