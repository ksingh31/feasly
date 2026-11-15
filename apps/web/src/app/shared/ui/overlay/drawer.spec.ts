import { InteractivityChecker } from '@angular/cdk/a11y';
import { DIALOG_DATA } from '@angular/cdk/dialog';
import { OverlayContainer } from '@angular/cdk/overlay';
import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { Component, inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiButtonComponent } from '../button/button.component';
import { UiDrawerComponent } from './drawer.component';
import { UiDrawerRef, UiDrawerService, injectDrawerParam } from './drawer.service';
import { UiModalComponent } from './modal.component';
import { UiModalService } from './modal.service';

/**
 * Issue #499 — Drawer (portal-ui-kit §3).
 * Keyboard path: open → focus on the title → Tab stays inside (trap) →
 * Esc closes (asking first when dirty) → focus back on the trigger.
 * URL: `?open=<id>` is pushed on open, so Back closes the drawer.
 */

/** jsdom has no layout, so the CDK sees nothing as visible: treat enabled controls as tabbable. */
const checkerStub: Partial<InteractivityChecker> = {
  isFocusable: (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
  isTabbable: (el: HTMLElement) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0,
  isVisible: () => true,
  isDisabled: (el: HTMLElement) => !!(el as HTMLButtonElement).disabled,
};

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    TestBed.tick();
  }
}

@Component({
  standalone: true,
  imports: [UiDrawerComponent, UiButtonComponent],
  template: `
    <ui-drawer [heading]="data.name" asForm [dirty]="name() !== data.name" (submitted)="save()">
      <span uiDrawerChip class="chip">Contacted</span>
      <span uiDrawerMeta class="meta">Created Nov 12, 2026</span>
      <label>Name <input class="name" [value]="name()" (input)="name.set($any($event.target).value)" /></label>
      <button uiDrawerFooterStart type="button" ui-button variant="secondary" class="cancel" (click)="ref.requestClose()">
        Cancel
      </button>
      <button uiDrawerFooterEnd type="submit" ui-button class="save">Save</button>
    </ui-drawer>
  `,
})
class LeadDrawerComponent {
  readonly ref = inject<UiDrawerRef<string>>(UiDrawerRef);
  readonly data = inject<{ name: string }>(DIALOG_DATA);
  readonly name = signal(this.data.name);
  save(): void {
    this.ref.close(this.name());
  }
}

@Component({
  standalone: true,
  imports: [UiModalComponent],
  template: `<ui-modal heading="Stacked"><p>On top</p></ui-modal>`,
})
class StackedModalComponent {}

@Component({
  standalone: true,
  template: `<button type="button" class="trigger">Open</button>`,
})
class TriggerHostComponent {
  readonly open = injectDrawerParam();
}

describe('UI kit Drawer', () => {
  let fixture: ComponentFixture<TriggerHostComponent>;
  let container: HTMLElement;
  let router: Router;
  let location: Location;
  let drawers: UiDrawerService;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [TriggerHostComponent],
      providers: [
        { provide: InteractivityChecker, useValue: checkerStub },
        provideRouter([{ path: '**', children: [] }]),
        provideLocationMocks(),
      ],
    });
    router = TestBed.inject(Router);
    location = TestBed.inject(Location);
    drawers = TestBed.inject(UiDrawerService);
    // Starts the router's popstate listener, so location.back() navigates.
    router.initialNavigation();
    await router.navigateByUrl('/admin/leads?status=new');
    fixture = TestBed.createComponent(TriggerHostComponent);
    fixture.autoDetectChanges();
    container = TestBed.inject(OverlayContainer).getContainerElement();
  });

  afterEach(() => {
    fixture.destroy();
  });

  function trigger(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('.trigger') as HTMLButtonElement;
  }

  function q<T extends HTMLElement = HTMLElement>(selector: string): T | null {
    return container.querySelector<T>(selector);
  }

  function pressEscape(): void {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
  }

  function openLead(name = 'Marco Silva', urlId?: string): UiDrawerRef<string, LeadDrawerComponent> {
    trigger().focus();
    return drawers.open<LeadDrawerComponent, string>(LeadDrawerComponent, { data: { name }, urlId });
  }

  async function makeDirty(): Promise<void> {
    const input = q<HTMLInputElement>('.name')!;
    input.value = 'Marco S.';
    input.dispatchEvent(new Event('input'));
    TestBed.tick();
  }

  function confirmButtons(): { keep: HTMLButtonElement; discard: HTMLButtonElement } {
    const [keep, discard] = Array.from(container.querySelectorAll<HTMLButtonElement>('.ui-modal__footer button'));
    return { keep, discard };
  }

  it('renders a labelled modal panel: sticky header with chip + meta, body, footer, scrim', async () => {
    openLead();
    await until(() => !!q('[role="dialog"] .ui-drawer__title'), 'drawer rendered');

    const dialog = q('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = q('.ui-drawer__title')!;
    expect(title.textContent?.trim()).toBe('Marco Silva');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(q('.ui-drawer__sub .chip')).not.toBeNull();
    expect(q('.ui-drawer__sub .meta')).not.toBeNull();
    expect(q('.ui-drawer__footer-start .cancel')).not.toBeNull();
    expect(q('.ui-drawer__footer-end .save')).not.toBeNull();
    expect(q('.cdk-overlay-pane')!.classList).toContain('ui-drawer-pane--md');
    expect(q('.ui-drawer-scrim')).not.toBeNull();
  });

  it('size option sets the pane class', async () => {
    drawers.open(LeadDrawerComponent, { data: { name: 'A' }, size: 'lg' });
    await until(() => !!q('.ui-drawer'), 'drawer rendered');
    expect(q('.cdk-overlay-pane')!.classList).toContain('ui-drawer-pane--lg');
  });

  it('keyboard path: focus on the title, Tab trapped, Esc closes, focus back on the trigger', async () => {
    const ref = openLead();
    await until(() => document.activeElement === q('.ui-drawer__title'), 'title focused');

    const anchors = container.querySelectorAll<HTMLElement>('.cdk-focus-trap-anchor');
    expect(anchors.length).toBe(2);
    anchors[1].focus();
    expect(container.querySelector('.ui-drawer')!.contains(document.activeElement)).toBe(true);
    anchors[0].focus();
    expect(container.querySelector('.ui-drawer')!.contains(document.activeElement)).toBe(true);

    const closed = vi.fn();
    ref.closed.subscribe(closed);
    pressEscape();
    await until(() => !q('.ui-drawer'), 'drawer removed');
    expect(closed).toHaveBeenCalledWith(undefined);
    await until(() => document.activeElement === trigger(), 'focus back on trigger');
  });

  it('× and the scrim close a clean drawer', async () => {
    openLead();
    await until(() => !!q('.ui-drawer__close'), 'close rendered');
    expect(q('.ui-drawer__close')!.getAttribute('aria-label')).toBe('Close');
    q('.ui-drawer__close')!.click();
    await until(() => !q('.ui-drawer'), 'closed by ×');

    openLead();
    await until(() => !!q('.ui-drawer-scrim'), 'scrim rendered');
    q('.ui-drawer-scrim')!.click();
    await until(() => !q('.ui-drawer'), 'closed by scrim');
  });

  it('dirty: Esc asks first; Keep editing keeps the drawer, Discard closes it', async () => {
    const ref = openLead();
    await until(() => !!q('.name'), 'drawer rendered');
    await makeDirty();
    expect(ref.dirty()).toBe(true);

    pressEscape();
    await until(() => !!q('[role="alertdialog"]'), 'discard question shown');
    expect(q('[role="alertdialog"] .ui-modal__title')!.textContent?.trim()).toBe('Discard your changes?');
    const { keep, discard } = confirmButtons();
    expect(keep.textContent?.trim()).toBe('Keep editing');
    expect(discard.textContent?.trim()).toBe('Discard');
    // Danger tone: the safe choice has default focus.
    await until(() => document.activeElement === keep, 'Keep editing focused');

    keep.click();
    await until(() => !q('[role="alertdialog"]'), 'question closed');
    expect(q('.ui-drawer')).not.toBeNull();
    expect(q<HTMLInputElement>('.name')!.value).toBe('Marco S.');

    q('.ui-drawer__close')!.click();
    await until(() => !!q('[role="alertdialog"]'), 'asked again from ×');
    confirmButtons().discard.click();
    await until(() => !q('.ui-drawer'), 'drawer discarded');
  });

  it('dirty: the scrim and a Cancel button ask first too', async () => {
    openLead();
    await until(() => !!q('.name'), 'drawer rendered');
    await makeDirty();

    q('.ui-drawer-scrim')!.click();
    await until(() => !!q('[role="alertdialog"]'), 'asked from scrim');
    confirmButtons().keep.click();
    await until(() => !q('[role="alertdialog"]'), 'question closed');

    q('.cancel')!.click();
    await until(() => !!q('[role="alertdialog"]'), 'asked from Cancel');
    confirmButtons().discard.click();
    await until(() => !q('.ui-drawer'), 'drawer discarded');
  });

  it('ref.close(result) skips the guard (after a save)', async () => {
    const ref = openLead();
    await until(() => !!q('.name'), 'drawer rendered');
    await makeDirty();
    const result = vi.fn();
    ref.closed.subscribe(result);
    q('.ui-drawer__form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await until(() => !q('.ui-drawer'), 'closed on save');
    expect(q('[role="alertdialog"]')).toBeNull();
    expect(result).toHaveBeenCalledWith('Marco S.');
  });

  describe('URL sync (?open=<id>)', () => {
    it('opening pushes ?open=<id> (keeping other params) and Back closes the drawer', async () => {
      openLead('Marco Silva', 'lead-42');
      await until(() => router.url === '/admin/leads?status=new&open=lead-42', 'open param pushed');
      expect(fixture.componentInstance.open()).toBe('lead-42');
      await until(() => !!q('.ui-drawer'), 'drawer rendered');

      location.back();
      await until(() => !q('.ui-drawer'), 'closed by Back');
      expect(router.url).toBe('/admin/leads?status=new');
      expect(fixture.componentInstance.open()).toBeNull();
      await until(() => document.activeElement === trigger(), 'focus back on trigger');
    });

    it('closing from the UI pops the history entry it pushed', async () => {
      openLead('Marco Silva', 'lead-42');
      await until(() => router.url.includes('open=lead-42') && !!q('.ui-drawer'), 'open');
      const backSpy = vi.spyOn(location, 'back');
      pressEscape();
      await until(() => !q('.ui-drawer'), 'closed');
      expect(backSpy).toHaveBeenCalledOnce();
      await until(() => router.url === '/admin/leads?status=new', 'param gone');
    });

    it('a deep link opens without a new entry and closing strips the param in place', async () => {
      await router.navigateByUrl('/admin/leads?open=lead-7');
      const backSpy = vi.spyOn(location, 'back');
      openLead('Dana Lee', 'lead-7');
      await until(() => !!q('.ui-drawer__close'), 'drawer rendered');
      expect(router.url).toBe('/admin/leads?open=lead-7');

      q('.ui-drawer__close')!.click();
      await until(() => router.url === '/admin/leads', 'param stripped');
      expect(backSpy).not.toHaveBeenCalled();
      expect(q('.ui-drawer')).toBeNull();
    });

    it('dirty + Back asks first; Keep editing restores the URL and keeps the drawer', async () => {
      openLead('Marco Silva', 'lead-42');
      await until(() => router.url.includes('open=lead-42') && !!q('.name'), 'open');
      await makeDirty();

      location.back();
      await until(() => !!q('[role="alertdialog"]'), 'asked on Back');
      confirmButtons().keep.click();
      await until(() => router.url === '/admin/leads?status=new&open=lead-42', 'URL restored');
      expect(q('.ui-drawer')).not.toBeNull();
      expect(q<HTMLInputElement>('.name')!.value).toBe('Marco S.');

      location.back();
      await until(() => !!q('[role="alertdialog"]'), 'asked on Back again');
      confirmButtons().discard.click();
      await until(() => !q('.ui-drawer'), 'discarded');
      expect(router.url).toBe('/admin/leads?status=new');
    });

    it('other query-param changes (filters) keep the drawer open', async () => {
      openLead('Marco Silva', 'lead-42');
      await until(() => router.url.includes('open=lead-42') && !!q('.ui-drawer'), 'open');
      await router.navigate([], { queryParams: { status: 'won' }, queryParamsHandling: 'merge', replaceUrl: true });
      TestBed.tick();
      expect(router.url).toBe('/admin/leads?status=won&open=lead-42');
      expect(q('.ui-drawer')).not.toBeNull();
    });
  });

  describe('one drawer at a time', () => {
    it('opening the same urlId again returns the open drawer', async () => {
      const first = openLead('Marco Silva', 'lead-42');
      await until(() => !!q('.ui-drawer'), 'open');
      const again = drawers.open(LeadDrawerComponent, { data: { name: 'Marco Silva' }, urlId: 'lead-42' });
      expect(again).toBe(first);
      expect(container.querySelectorAll('.ui-drawer')).toHaveLength(1);
    });

    it('opening another drawer replaces the current one and swaps the URL in place', async () => {
      const first = openLead('Marco Silva', 'lead-42');
      await until(() => router.url.includes('open=lead-42') && !!q('.ui-drawer'), 'first open');
      const firstClosed = vi.fn();
      first.closed.subscribe(firstClosed);

      drawers.open(LeadDrawerComponent, { data: { name: 'Dana Lee' }, urlId: 'lead-7' });
      await until(() => q('.ui-drawer__title')?.textContent?.trim() === 'Dana Lee', 'second shown');
      expect(container.querySelectorAll('.ui-drawer')).toHaveLength(1);
      expect(firstClosed).toHaveBeenCalledWith(undefined);
      await until(() => router.url === '/admin/leads?status=new&open=lead-7', 'URL swapped');

      // The swap reused the entry, so one Back returns to the list.
      location.back();
      await until(() => !q('.ui-drawer'), 'closed by Back');
      expect(router.url).toBe('/admin/leads?status=new');
    });

    it('a dirty drawer asks before being replaced; Keep editing cancels the new one', async () => {
      openLead('Marco Silva');
      await until(() => !!q('.name'), 'first open');
      await makeDirty();

      const second = drawers.open(LeadDrawerComponent, { data: { name: 'Dana Lee' } });
      const secondClosed = vi.fn();
      second.closed.subscribe(secondClosed);
      await until(() => !!q('[role="alertdialog"]'), 'asked');
      confirmButtons().keep.click();
      await until(() => secondClosed.mock.calls.length > 0, 'second abandoned');
      expect(q('.ui-drawer__title')!.textContent?.trim()).toBe('Marco Silva');
      expect(drawers.openDrawer?.componentInstance).toBeInstanceOf(LeadDrawerComponent);
    });

    it('a modal stacks on top; Esc closes only the modal', async () => {
      openLead();
      await until(() => !!q('.ui-drawer'), 'drawer open');
      TestBed.inject(UiModalService).open(StackedModalComponent);
      await until(() => !!q('.ui-modal'), 'modal open');
      expect(q('.ui-drawer')).not.toBeNull();

      pressEscape();
      await until(() => !q('.ui-modal'), 'modal closed');
      expect(q('.ui-drawer')).not.toBeNull();
      pressEscape();
      await until(() => !q('.ui-drawer'), 'drawer closed');
    });
  });
});
