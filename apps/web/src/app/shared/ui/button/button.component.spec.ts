import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { UiButtonComponent, UiButtonSize, UiButtonVariant } from './button.component';

/** Issue #496 AC1/AC3: every variant and state, keyboard + focus. */
@Component({
  standalone: true,
  imports: [UiButtonComponent],
  template: `
    <button
      type="button"
      ui-button
      [variant]="variant()"
      [size]="size()"
      [disabled]="disabled()"
      [loading]="loading()"
      (click)="clicks = clicks + 1"
    >
      Save changes
    </button>
    <a ui-button variant="ghost" href="#x" [disabled]="disabled()" (click)="linkClicks = linkClicks + 1">Back</a>
  `,
})
class HostComponent {
  readonly variant = signal<UiButtonVariant>('primary');
  readonly size = signal<UiButtonSize>('md');
  readonly disabled = signal(false);
  readonly loading = signal(false);
  clicks = 0;
  linkClicks = 0;
}

describe('UiButtonComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  const button = (): HTMLButtonElement => fixture.nativeElement.querySelector('button');
  const link = (): HTMLAnchorElement => fixture.nativeElement.querySelector('a');

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('defaults to primary + md, enabled, not busy', () => {
    const el = button();
    expect(el.classList).toContain('ui-button');
    expect(el.classList).toContain('ui-button--primary');
    expect(el.classList).toContain('ui-button--md');
    expect(el.classList).not.toContain('ui-button--disabled');
    expect(el.disabled).toBe(false);
    expect(el.hasAttribute('aria-busy')).toBe(false);
    expect(el.textContent?.trim()).toBe('Save changes');
  });

  const variants: UiButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'danger-secondary'];
  for (const variant of variants) {
    it(`renders the ${variant} variant with exactly one variant class`, () => {
      host.variant.set(variant);
      fixture.detectChanges();
      const variantClasses = Array.from(button().classList).filter((c) =>
        variants.some((v) => c === `ui-button--${v}`),
      );
      expect(variantClasses).toEqual([`ui-button--${variant}`]);
    });
  }

  for (const size of ['sm', 'md'] as const) {
    it(`renders the ${size} size`, () => {
      host.size.set(size);
      fixture.detectChanges();
      expect(button().classList).toContain(`ui-button--${size}`);
    });
  }

  it('disabled: native disabled + disabled class, clicks do nothing', () => {
    host.disabled.set(true);
    fixture.detectChanges();
    expect(button().disabled).toBe(true);
    expect(button().classList).toContain('ui-button--disabled');
    button().click();
    expect(host.clicks).toBe(0);
  });

  it('loading: busy, inert, spinner shown, label kept (width preserved), never styled disabled', () => {
    host.loading.set(true);
    fixture.detectChanges();
    const el = button();
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.disabled).toBe(true);
    expect(el.classList).toContain('ui-button--loading');
    expect(el.classList).not.toContain('ui-button--disabled');
    expect(el.querySelector('.ui-button__spinner')).not.toBeNull();
    expect(el.querySelector('.ui-button__label')?.textContent?.trim()).toBe('Save changes');
    el.click();
    expect(host.clicks).toBe(0);
  });

  it('enabled button is keyboard focusable and activates on click', () => {
    const el = button();
    el.focus();
    expect(document.activeElement).toBe(el);
    el.click();
    expect(host.clicks).toBe(1);
  });

  it('anchor: aria-disabled, removed from tab order, activation swallowed when disabled', () => {
    expect(link().hasAttribute('aria-disabled')).toBe(false);
    expect(link().classList).toContain('ui-button--ghost');
    host.disabled.set(true);
    fixture.detectChanges();
    expect(link().getAttribute('aria-disabled')).toBe('true');
    expect(link().getAttribute('tabindex')).toBe('-1');
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    link().dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(host.linkClicks).toBe(0);
  });
});
