import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { beforeEach, describe, expect, it } from 'vitest';
import { UiDateFieldComponent } from './date-field.component';
import { UiMoneyFieldComponent } from './money-field.component';
import { UiSelectComponent, UiSelectOption } from './select.component';
import { UiTextFieldComponent } from './text-field.component';

/** Issue #496: TextField, Select, MoneyField, DateField. */

function typeInto(el: HTMLInputElement, value: string, caret = value.length): void {
  el.value = value;
  if (el.type === 'text') el.setSelectionRange(caret, caret);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('UiTextFieldComponent', () => {
  @Component({
    standalone: true,
    imports: [UiTextFieldComponent, ReactiveFormsModule],
    template: `
      <ui-text-field
        label="Company name"
        [hint]="hint()"
        [error]="error()"
        required
        [(value)]="name"
      />
      <ui-text-field label="Email" type="email" [formControl]="email" />
    `,
  })
  class Host {
    readonly hint = signal<string | null>('Shown on invoices');
    readonly error = signal<string | null>(null);
    readonly name = signal('Elite');
    readonly email = new FormControl('a@b.ca', { nonNullable: true });
  }

  let fixture: ComponentFixture<Host>;
  const inputs = (): HTMLInputElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('input'));

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [Host] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  it('label above is linked to the control; hint below is the description', () => {
    const input = inputs()[0]!;
    const label: HTMLLabelElement = fixture.nativeElement.querySelector('label');
    expect(label.textContent).toContain('Company name');
    expect(label.htmlFor).toBe(input.id);
    expect(input.required).toBe(true);
    const hint = fixture.nativeElement.querySelector('.ui-field__hint') as HTMLElement;
    expect(hint.textContent?.trim()).toBe('Shown on invoices');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('error replaces the hint, sets aria-invalid and is the description', () => {
    fixture.componentInstance.error.set('Enter a company name');
    fixture.detectChanges();
    const input = inputs()[0]!;
    const error = fixture.nativeElement.querySelector('.ui-field__error') as HTMLElement;
    expect(error.textContent?.trim()).toBe('Enter a company name');
    expect(fixture.nativeElement.querySelector('.ui-field__hint')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
  });

  it('two-way binds via [(value)]', () => {
    expect(inputs()[0]!.value).toBe('Elite');
    typeInto(inputs()[0]!, 'Elite Craft');
    expect(fixture.componentInstance.name()).toBe('Elite Craft');
  });

  it('works with a typed FormControl, including disabled', () => {
    const email = inputs()[1]!;
    expect(email.type).toBe('email');
    expect(email.value).toBe('a@b.ca');
    typeInto(email, 'x@y.ca');
    expect(fixture.componentInstance.email.value).toBe('x@y.ca');
    fixture.componentInstance.email.setValue('z@z.ca');
    fixture.detectChanges();
    expect(email.value).toBe('z@z.ca');
    fixture.componentInstance.email.disable();
    fixture.detectChanges();
    expect(email.disabled).toBe(true);
  });

  it('gives each field a unique id', () => {
    const [a, b] = inputs();
    expect(a!.id).not.toBe(b!.id);
  });
});

describe('UiSelectComponent', () => {
  const OPTIONS: UiSelectOption[] = [
    { value: 'new', label: 'New' },
    { value: 'won', label: 'Won' },
    { value: 'lost', label: 'Lost', disabled: true },
  ];

  @Component({
    standalone: true,
    imports: [UiSelectComponent],
    template: `<ui-select label="Status" placeholder="Any status" [options]="options" [(value)]="status" />`,
  })
  class Host {
    readonly options = OPTIONS;
    readonly status = signal<string | null>('won');
  }

  let fixture: ComponentFixture<Host>;
  const select = (): HTMLSelectElement => fixture.nativeElement.querySelector('select');

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [Host] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  it('renders the placeholder plus options and selects the bound value', () => {
    const opts = Array.from(select().options).map((o) => o.textContent?.trim());
    expect(opts).toEqual(['Any status', 'New', 'Won', 'Lost']);
    expect(select().value).toBe('won');
    expect(select().options[3]!.disabled).toBe(true);
  });

  it('emits the chosen value, and null for the placeholder', () => {
    select().value = 'new';
    select().dispatchEvent(new Event('change'));
    expect(fixture.componentInstance.status()).toBe('new');
    select().value = '';
    select().dispatchEvent(new Event('change'));
    expect(fixture.componentInstance.status()).toBeNull();
  });
});

describe('UiSelectComponent without a placeholder', () => {
  @Component({
    standalone: true,
    imports: [UiSelectComponent],
    template: `<ui-select label="Status" [options]="options" [(value)]="status" />`,
  })
  class Host {
    readonly options: UiSelectOption[] = [
      { value: 'new', label: 'New' },
      { value: 'won', label: 'Won' },
    ];
    readonly status = signal<string | null>(null);
  }

  it('shows blank (not the first option) while the value is null', () => {
    TestBed.configureTestingModule({ imports: [Host] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]!.hidden).toBe(true);

    fixture.componentInstance.status.set('won');
    fixture.detectChanges();
    expect(select.value).toBe('won');
  });
});

describe('UiMoneyFieldComponent', () => {
  @Component({
    standalone: true,
    imports: [UiMoneyFieldComponent, ReactiveFormsModule],
    template: `
      <ui-money-field label="Contract value" [(value)]="cents" />
      <ui-money-field label="Budget" [formControl]="budget" />
    `,
  })
  class Host {
    readonly cents = signal<number | null>(null);
    readonly budget = new FormControl<number | null>(65000000);
  }

  let fixture: ComponentFixture<Host>;
  const inputs = (): HTMLInputElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('input'));

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [Host] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  it('is a numeric text input', () => {
    expect(inputs()[0]!.getAttribute('inputmode')).toBe('numeric');
    expect(inputs()[0]!.type).toBe('text');
  });

  it('AC2: formats 1250000 → 1,250,000 and emits cents', () => {
    const input = inputs()[0]!;
    typeInto(input, '1250000');
    fixture.detectChanges();
    expect(input.value).toBe('1,250,000');
    expect(fixture.componentInstance.cents()).toBe(125000000);
  });

  it('reformats live on every keystroke', () => {
    const input = inputs()[0]!;
    const seen: string[] = [];
    let typed = '';
    for (const ch of '1250000') {
      typed = input.value + ch;
      typeInto(input, typed);
      fixture.detectChanges();
      seen.push(input.value);
    }
    expect(seen).toEqual(['1', '12', '125', '1,250', '12,500', '125,000', '1,250,000']);
  });

  it('keeps the caret after the same digit when separators move', () => {
    const input = inputs()[0]!;
    typeInto(input, '125000');
    fixture.detectChanges();
    expect(input.value).toBe('125,000');
    // Insert "9" after "12" → "1295,000" with the caret after the 9.
    typeInto(input, '1295,000', 4);
    fixture.detectChanges();
    expect(input.value).toBe('1,295,000');
    expect(input.selectionStart).toBe(5);
  });

  it('backspace over a separator deletes the digit before it', () => {
    const input = inputs()[0]!;
    typeInto(input, '1250000');
    fixture.detectChanges();
    // "1,|250,000" + Backspace → browser removes the comma: "1250,000", caret 1.
    input.value = '1250,000';
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    fixture.detectChanges();
    expect(input.value).toBe('250,000');
    expect(input.selectionStart).toBe(0);
    expect(fixture.componentInstance.cents()).toBe(25000000);
  });

  it('strips non-digits and leading zeros; empty emits null', () => {
    const input = inputs()[0]!;
    typeInto(input, '00$4a2');
    fixture.detectChanges();
    expect(input.value).toBe('42');
    expect(fixture.componentInstance.cents()).toBe(4200);
    typeInto(input, '');
    fixture.detectChanges();
    expect(input.value).toBe('');
    expect(fixture.componentInstance.cents()).toBeNull();
  });

  it('drops a pasted decimal part instead of reading cents as dollars', () => {
    const input = inputs()[0]!;
    typeInto(input, '1,250,000.00');
    fixture.detectChanges();
    expect(input.value).toBe('1,250,000');
    expect(fixture.componentInstance.cents()).toBe(125000000);
    typeInto(input, '$1,250.50');
    fixture.detectChanges();
    expect(input.value).toBe('1,250');
    expect(fixture.componentInstance.cents()).toBe(125000);
  });

  it('ignores a typed "." and keeps the caret at the end', () => {
    const input = inputs()[0]!;
    typeInto(input, '1250');
    fixture.detectChanges();
    typeInto(input, '1,250.');
    fixture.detectChanges();
    expect(input.value).toBe('1,250');
    expect(input.selectionStart).toBe(5);
    expect(fixture.componentInstance.cents()).toBe(125000);
  });

  it('rejects input too long to represent and keeps the last good value', () => {
    const input = inputs()[0]!;
    typeInto(input, '999999999999');
    fixture.detectChanges();
    expect(input.value).toBe('999,999,999,999');
    typeInto(input, '999,999,999,9999');
    fixture.detectChanges();
    expect(input.value).toBe('999,999,999,999');
    expect(fixture.componentInstance.cents()).toBe(99999999999900);
  });

  it('displays a FormControl value (cents) and writes cents back', () => {
    const budget = inputs()[1]!;
    expect(budget.value).toBe('650,000');
    typeInto(budget, '700000');
    expect(fixture.componentInstance.budget.value).toBe(70000000);
    fixture.componentInstance.budget.setValue(null);
    fixture.detectChanges();
    expect(budget.value).toBe('');
  });
});

describe('UiDateFieldComponent', () => {
  @Component({
    standalone: true,
    imports: [UiDateFieldComponent],
    template: `<ui-date-field label="Contract signed" max="2026-12-31" [(value)]="date" />`,
  })
  class Host {
    readonly date = signal<string | null>('2026-11-12');
  }

  let fixture: ComponentFixture<Host>;
  const input = (): HTMLInputElement => fixture.nativeElement.querySelector('input');

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [Host] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  it('is a native date input bound to an ISO date', () => {
    expect(input().type).toBe('date');
    expect(input().value).toBe('2026-11-12');
    expect(input().getAttribute('max')).toBe('2026-12-31');
  });

  it('emits the ISO date, and null when cleared', () => {
    typeInto(input(), '2026-11-20');
    expect(fixture.componentInstance.date()).toBe('2026-11-20');
    typeInto(input(), '');
    expect(fixture.componentInstance.date()).toBeNull();
  });
});
