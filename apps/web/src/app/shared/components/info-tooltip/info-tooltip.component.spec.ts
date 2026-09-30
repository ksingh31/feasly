import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it, vi } from 'vitest';
import { InfoTooltipComponent } from './info-tooltip.component';

const EXPLAINER = 'Every organization needs at least one active administrator.';

@Component({
  standalone: true,
  imports: [InfoTooltipComponent],
  template: `<app-info-tooltip #tip="infoTooltip" [text]="text" [label]="label" />`,
})
class HostComponent {
  text = EXPLAINER;
  label = 'Why is this unavailable?';
}

describe('InfoTooltipComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  function setup(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  }

  function trigger(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('.info-tooltip__trigger');
  }

  function bubble(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.info-tooltip__bubble');
  }

  function component(): InfoTooltipComponent {
    return fixture.debugElement.query(By.directive(InfoTooltipComponent))
      .componentInstance as InfoTooltipComponent;
  }

  /** Opens via click and flushes the deferred positioning pass. */
  async function openViaClick(): Promise<void> {
    trigger().click();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  function stubHoverCapable(capable: boolean): void {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: capable } as MediaQueryList),
    );
  }

  it('renders the trigger with its accessible label and no bubble initially', () => {
    setup();
    expect(trigger().getAttribute('aria-label')).toBe('Why is this unavailable?');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(bubble()).toBeNull();
  });

  it('click toggles the tooltip open and closed', async () => {
    setup();
    await openViaClick();
    expect(bubble()).not.toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    trigger().click();
    fixture.detectChanges();
    expect(bubble()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('the open bubble has role="tooltip", the exact copy, and the exposed id', async () => {
    setup();
    await openViaClick();
    const tip = bubble()!;
    expect(tip.getAttribute('role')).toBe('tooltip');
    expect(tip.textContent?.trim()).toBe(EXPLAINER);
    expect(tip.id).toBe(component().tooltipId());
    expect(tip.id).toMatch(/^info-tooltip-\d+$/);
  });

  it('a parent-provided tooltipId is used for the bubble id', async () => {
    @Component({
      standalone: true,
      imports: [InfoTooltipComponent],
      template: `<app-info-tooltip text="x" tooltipId="parent-tip-1" />`,
    })
    class IdHostComponent {}
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [IdHostComponent] });
    const idFixture = TestBed.createComponent(IdHostComponent);
    idFixture.detectChanges();
    const instance = idFixture.debugElement.query(
      By.directive(InfoTooltipComponent),
    ).componentInstance as InfoTooltipComponent;
    expect(instance.tooltipId()).toBe('parent-tip-1');
  });

  it('each instance gets a unique tooltip id', () => {
    setup();
    @Component({
      standalone: true,
      imports: [InfoTooltipComponent],
      template: `<app-info-tooltip text="one" /><app-info-tooltip text="two" />`,
    })
    class TwoHostComponent {}
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [TwoHostComponent] });
    const two = TestBed.createComponent(TwoHostComponent);
    two.detectChanges();
    const instances = two.debugElement
      .queryAll(By.directive(InfoTooltipComponent))
      .map((d) => d.componentInstance as InfoTooltipComponent);
    expect(instances).toHaveLength(2);
    expect(instances[0]!.tooltipId()).not.toBe(instances[1]!.tooltipId());
  });

  it('Escape dismisses an open tooltip', async () => {
    setup();
    await openViaClick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(bubble()).toBeNull();
  });

  it('an outside tap/click dismisses a pinned tooltip', async () => {
    setup();
    await openViaClick();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(bubble()).toBeNull();
  });

  it('only one tooltip stays open at a time', async () => {
    @Component({
      standalone: true,
      imports: [InfoTooltipComponent],
      template: `<app-info-tooltip text="one" /><app-info-tooltip text="two" />`,
    })
    class TwoHostComponent {}
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [TwoHostComponent] });
    const two = TestBed.createComponent(TwoHostComponent);
    two.detectChanges();
    const triggers = Array.from(
      two.nativeElement.querySelectorAll('.info-tooltip__trigger'),
    ) as HTMLButtonElement[];

    triggers[0]!.click();
    two.detectChanges();
    expect(two.nativeElement.querySelectorAll('.info-tooltip__bubble')).toHaveLength(1);

    // Clicking the second trigger opens it; the document listener then
    // closes the first (element handlers run before document listeners).
    triggers[1]!.click();
    two.detectChanges();
    expect(two.nativeElement.querySelectorAll('.info-tooltip__bubble')).toHaveLength(1);
    expect(
      (two.nativeElement.querySelector('.info-tooltip__bubble') as HTMLElement).textContent?.trim(),
    ).toBe('two');
  });

  it('hover opens and closes on hover-capable desktops', () => {
    setup();
    stubHoverCapable(true);
    const wrapper = fixture.nativeElement.querySelector('.info-tooltip') as HTMLElement;
    wrapper.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture.detectChanges();
    expect(bubble()).not.toBeNull();

    wrapper.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    fixture.detectChanges();
    expect(bubble()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('hover does nothing on touch devices (tap toggles instead)', async () => {
    setup();
    stubHoverCapable(false);
    const wrapper = fixture.nativeElement.querySelector('.info-tooltip') as HTMLElement;
    wrapper.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    fixture.detectChanges();
    expect(bubble()).toBeNull();
    vi.unstubAllGlobals();

    // Tap still toggles.
    await openViaClick();
    expect(bubble()).not.toBeNull();
  });

  it('keyboard focus opens and moving focus away closes', () => {
    setup();
    trigger().focus();
    fixture.detectChanges();
    expect(bubble()).not.toBeNull();

    trigger().blur();
    fixture.detectChanges();
    expect(bubble()).toBeNull();
  });

  it('the bubble is measured and clamped inside the viewport once open', async () => {
    setup();
    await openViaClick();
    const tip = bubble()!;
    // Positioned (visible) after the deferred measurement pass.
    expect(tip.classList.contains('info-tooltip__bubble--positioned')).toBe(true);
    const top = Number.parseFloat(tip.style.top);
    const left = Number.parseFloat(tip.style.left);
    expect(Number.isNaN(top)).toBe(false);
    expect(Number.isNaN(left)).toBe(false);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left).toBeLessThanOrEqual(window.innerWidth - 8);
  });
});
