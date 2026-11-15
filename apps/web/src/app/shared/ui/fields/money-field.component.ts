import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  forwardRef,
  input,
  model,
  viewChild,
} from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import {
  centsToGroupedDollars,
  groupDollarDigits,
  parseCadDollarsToCents,
} from '../../utils/money';
import { UiFieldBase } from './field-base';
import { UiFieldShellComponent } from './field-shell.component';

/**
 * MoneyField — portal UI kit §3. Whole CAD dollars typed with live
 * thousands separators (`inputmode=numeric`); the value is integer cents
 * (the backend's money unit) or null when empty.
 *
 *   <ui-money-field label="Contract value" [(value)]="contractValueCents" />
 *
 * Typing 1250000 shows "1,250,000" and emits 125000000. The caret stays
 * after the same digit as separators are inserted/removed. Input the
 * parser can't represent (too many digits) is rejected, keeping the last
 * good value. Formatting only — no money math happens here.
 *
 * Whole dollars only: a seeded value with a cents part (e.g. 125099) is
 * shown truncated ("1,250") and the next edit emits whole-dollar cents,
 * dropping the 99¢. Seed it with whole-dollar amounts.
 */
@Component({
  selector: 'ui-money-field',
  standalone: true,
  imports: [UiFieldShellComponent],
  templateUrl: './money-field.component.html',
  styleUrl: './money-field.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => UiMoneyFieldComponent), multi: true },
  ],
})
export class UiMoneyFieldComponent extends UiFieldBase<number | null> {
  /** Integer cents, or null when the field is empty. */
  readonly value = model<number | null>(null);
  readonly placeholder = input<string | null>(null);
  /** Currency symbol shown as a non-editable prefix. */
  readonly prefix = input('$');

  protected readonly display = computed(() => centsToGroupedDollars(this.value()));

  private readonly inputEl = viewChild.required<ElementRef<HTMLInputElement>>('control');

  writeValue(value: number | null): void {
    // Whole dollars only — see class docblock for non-whole seeds.
    this.value.set(value ?? null);
  }

  protected onInput(event?: Event): void {
    const el = this.inputEl().nativeElement;
    const raw = el.value;
    const caret = el.selectionStart ?? raw.length;
    let digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, '').length;
    let digits = raw.replace(/\D/g, '');

    // Backspace/Delete that only removed a separator: remove the adjacent
    // digit instead, otherwise the separator reappears and nothing happens.
    const inputType = (event as InputEvent | undefined)?.inputType ?? '';
    const previousDigits = this.display().replace(/\D/g, '');
    if (inputType.startsWith('delete') && digits === previousDigits && digits !== '') {
      const target = inputType === 'deleteContentBackward' ? digitsBeforeCaret - 1 : digitsBeforeCaret;
      if (target >= 0 && target < digits.length) {
        digits = digits.slice(0, target) + digits.slice(target + 1);
        digitsBeforeCaret = target;
      }
    }

    const cents = digits === '' ? null : parseCadDollarsToCents(digits);
    if (digits !== '' && cents === null) {
      // Not representable: restore the last good display.
      el.value = this.display();
      return;
    }

    const formatted = groupDollarDigits(digits);
    el.value = formatted;
    this.restoreCaret(el, formatted, digitsBeforeCaret, digits.length - formatted.replace(/\D/g, '').length);

    if (cents !== this.value()) {
      this.value.set(cents);
      this.onChange(cents);
    }
  }

  /** Put the caret after the same digit it followed before reformatting. */
  private restoreCaret(
    el: HTMLInputElement,
    formatted: string,
    digitsBeforeCaret: number,
    droppedLeading: number,
  ): void {
    let remaining = Math.max(0, digitsBeforeCaret - droppedLeading);
    let pos = 0;
    while (remaining > 0 && pos < formatted.length) {
      if (/\d/.test(formatted[pos]!)) remaining--;
      pos++;
    }
    el.setSelectionRange(pos, pos);
  }
}
