import { ChangeDetectionStrategy, Component, computed, forwardRef, input, model } from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import { UiFieldBase } from './field-base';
import { UiFieldShellComponent } from './field-shell.component';

export interface UiSelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * Select — portal UI kit §3. Native `<select>` (keyboard + screen readers
 * for free) with the native arrow replaced by exactly one chevron.
 * Value is the selected option's `value`, or null for the placeholder.
 * Without a placeholder, a null (or unknown) value renders blank rather
 * than letting the browser show the first option the model never chose.
 *
 *   <ui-select label="Status" placeholder="Any status" [options]="opts" [(value)]="status" />
 */
@Component({
  selector: 'ui-select',
  standalone: true,
  imports: [UiFieldShellComponent],
  templateUrl: './select.component.html',
  styleUrl: './select.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => UiSelectComponent), multi: true },
  ],
})
export class UiSelectComponent extends UiFieldBase<string | null> {
  readonly value = model<string | null>(null);
  readonly options = input.required<readonly UiSelectOption[]>();
  /** Optional empty first option (value null). */
  readonly placeholder = input<string | null>(null);

  /** True when the current value matches one of the options. */
  protected readonly hasSelection = computed(() => {
    const v = this.value();
    return v !== null && this.options().some((o) => o.value === v);
  });

  writeValue(value: string | null): void {
    this.value.set(value ?? null);
  }

  protected onSelect(raw: string): void {
    const next = raw === '' ? null : raw;
    this.value.set(next);
    this.onChange(next);
  }
}
