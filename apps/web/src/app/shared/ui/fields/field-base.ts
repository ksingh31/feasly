import { Directive, booleanAttribute, computed, input, signal } from '@angular/core';
import { ControlValueAccessor } from '@angular/forms';

let uiFieldCounter = 0;

/**
 * Shared plumbing for the portal UI kit fields (§3 "Fields"): label above,
 * hint below, error in `--status-danger-fg`, ids wired for a11y, and the
 * ControlValueAccessor contract so every field works with typed reactive
 * forms (`[formControl]`) as well as signal two-way binding.
 *
 * `T` is the value the field exposes to forms (string, cents, ISO date).
 */
@Directive()
export abstract class UiFieldBase<T> implements ControlValueAccessor {
  /** Visible label rendered above the control. */
  readonly label = input.required<string>();
  /** Optional helper copy rendered below the control. */
  readonly hint = input<string | null>(null);
  /** Error message; when set the control is `aria-invalid` and the hint hides. */
  readonly error = input<string | null>(null);
  readonly required = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Optional explicit id for the control (otherwise generated). */
  readonly fieldId = input<string | null>(null);

  private readonly generatedId = `ui-field-${++uiFieldCounter}`;
  private readonly formDisabled = signal(false);

  readonly controlId = computed(() => this.fieldId() ?? this.generatedId);
  readonly hintId = computed(() => `${this.controlId()}-hint`);
  readonly errorId = computed(() => `${this.controlId()}-error`);
  readonly isDisabled = computed(() => this.disabled() || this.formDisabled());
  readonly describedBy = computed(() => {
    if (this.error()) return this.errorId();
    return this.hint() ? this.hintId() : null;
  });

  protected onChange: (value: T) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  abstract writeValue(value: T | null): void;

  registerOnChange(fn: (value: T) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.formDisabled.set(isDisabled);
  }

  protected markTouched(): void {
    this.onTouched();
  }
}
