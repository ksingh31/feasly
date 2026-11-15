import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { InteractivityChecker } from '@angular/cdk/a11y';
import { OverlayContainer } from '@angular/cdk/overlay';
import { Component, inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiButtonComponent } from '../button/button.component';
import { UiConfirmService } from './confirm.service';
import { UiModalComponent } from './modal.component';
import { UiModalService } from './modal.service';
import { UiToastService } from './toast.service';

/**
 * Issue #498 — Modal + ConfirmDialog + Toast (portal-ui-kit §3).
 * Keyboard path: open → focus inside → Tab wraps (trap) → Esc closes →
 * focus returns to the trigger.
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
  imports: [UiModalComponent, UiButtonComponent],
  template: `
    <ui-modal heading="Change rate" asForm (submitted)="submit()">
      <label>Rate <input class="rate" [value]="rate()" (input)="rate.set($any($event.target).value)" /></label>
      <ng-container uiModalFooter>
        <button type="button" ui-button variant="secondary" class="cancel" (click)="ref.close()">Cancel</button>
        <button type="submit" ui-button class="save" [disabled]="!rate()">Save</button>
      </ng-container>
    </ui-modal>
  `,
})
class RateModalComponent {
  readonly ref = inject<DialogRef<string>>(DialogRef);
  readonly data = inject<{ rate: string }>(DIALOG_DATA);
  readonly rate = signal(this.data.rate);
  submit(): void {
    this.ref.close(this.rate());
  }
}

@Component({
  standalone: true,
  template: `<button type="button" class="trigger">Open</button>`,
})
class TriggerHostComponent {}

describe('UI kit overlays', () => {
  let fixture: ComponentFixture<TriggerHostComponent>;
  let container: HTMLElement;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [TriggerHostComponent],
      providers: [{ provide: InteractivityChecker, useValue: checkerStub }],
    });
    fixture = TestBed.createComponent(TriggerHostComponent);
    fixture.autoDetectChanges();
    container = TestBed.inject(OverlayContainer).getContainerElement();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  /** Focus the trigger and open from it, as a click would. */
  function openFromTrigger<T>(open: () => T): T {
    trigger().focus();
    return open();
  }

  describe('UiModalService + ui-modal', () => {
    it('renders a labelled modal dialog with header, body and footer', async () => {
      const modals = TestBed.inject(UiModalService);
      openFromTrigger(() => modals.open(RateModalComponent, { data: { rate: '1' }, size: 'sm' }));
      await until(() => !!q('[role="dialog"] .ui-modal__title'), 'modal rendered');

      const dialog = q('[role="dialog"]')!;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      const title = q('.ui-modal__title')!;
      expect(title.textContent?.trim()).toBe('Change rate');
      expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
      expect(q('.ui-modal__footer .save')).not.toBeNull();
      expect(q('.cdk-overlay-pane')!.classList).toContain('ui-modal-pane--sm');
      expect(q('.ui-modal-scrim')).not.toBeNull();
    });

    it('focuses the first field, traps Tab, closes on Esc and returns focus to the trigger', async () => {
      const modals = TestBed.inject(UiModalService);
      const ref = openFromTrigger(() => modals.open(RateModalComponent, { data: { rate: '1' } }));
      await until(() => document.activeElement === q('.rate'), 'first field focused');

      // The close × is last in tab order, so it never steals initial focus.
      const tabbables = Array.from(container.querySelectorAll<HTMLElement>('.ui-modal input, .ui-modal button'));
      expect(tabbables.at(-1)!.classList).toContain('ui-modal__close');

      // Focus trap: tabbing off the end lands on the trailing anchor → wraps to the first.
      const anchors = container.querySelectorAll<HTMLElement>('.cdk-focus-trap-anchor');
      expect(anchors.length).toBe(2);
      anchors[1].focus();
      expect(document.activeElement).toBe(q('.rate'));
      // …and shift-tabbing off the start wraps to the last (the close ×).
      anchors[0].focus();
      expect(document.activeElement).toBe(q('.ui-modal__close'));

      const closed = vi.fn();
      ref.closed.subscribe(closed);
      pressEscape();
      await until(() => !q('.ui-modal'), 'modal removed');
      expect(closed).toHaveBeenCalledWith(undefined);
      await until(() => document.activeElement === trigger(), 'focus back on trigger');
    });

    it('Enter submits only when the form is valid', async () => {
      const modals = TestBed.inject(UiModalService);
      const ref = modals.open<RateModalComponent, string>(RateModalComponent, { data: { rate: '' } });
      await until(() => !!q('.ui-modal__form'), 'form rendered');
      const result = vi.fn();
      ref.closed.subscribe(result);

      expect(q<HTMLButtonElement>('.save')!.disabled).toBe(true);
      const input = q<HTMLInputElement>('.rate')!;
      input.value = '1.5';
      input.dispatchEvent(new Event('input'));
      await until(() => !q<HTMLButtonElement>('.save')!.disabled, 'save enabled');

      q('.ui-modal__form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await until(() => result.mock.calls.length > 0, 'closed with value');
      expect(result).toHaveBeenCalledWith('1.5');
    });

    it('scrim click closes by default; dismissOnScrim:false keeps one-time-secret modals open', async () => {
      const modals = TestBed.inject(UiModalService);
      const ref = modals.open(RateModalComponent, { data: { rate: '1' }, dismissOnScrim: false });
      await until(() => !!q('.ui-modal-scrim'), 'scrim rendered');
      q('.ui-modal-scrim')!.click();
      TestBed.tick();
      expect(q('.ui-modal')).not.toBeNull();
      // Esc still works.
      pressEscape();
      await until(() => !q('.ui-modal'), 'closed by Esc');
      expect(ref.componentInstance).toBeDefined();

      modals.open(RateModalComponent, { data: { rate: '1' } });
      await until(() => !!q('.ui-modal-scrim'), 'second scrim');
      q('.ui-modal-scrim')!.click();
      await until(() => !q('.ui-modal'), 'closed by scrim');
    });

    it('dismissOnEsc:false ignores Esc', async () => {
      const modals = TestBed.inject(UiModalService);
      const ref = modals.open(RateModalComponent, { data: { rate: '1' }, dismissOnEsc: false });
      await until(() => !!q('.ui-modal'), 'modal rendered');
      pressEscape();
      TestBed.tick();
      expect(q('.ui-modal')).not.toBeNull();
      ref.close();
      await until(() => !q('.ui-modal'), 'closed');
    });

    it('the close × closes the modal', async () => {
      const modals = TestBed.inject(UiModalService);
      modals.open(RateModalComponent, { data: { rate: '1' } });
      await until(() => !!q('.ui-modal__close'), 'close rendered');
      expect(q('.ui-modal__close')!.getAttribute('aria-label')).toBe('Close');
      q('.ui-modal__close')!.click();
      await until(() => !q('.ui-modal'), 'closed');
    });
  });

  describe('UiConfirmService', () => {
    it('danger: alertdialog, Cancel focused, danger verb; Cancel → false and focus returns', async () => {
      const confirms = TestBed.inject(UiConfirmService);
      const answer = vi.fn();
      openFromTrigger(() =>
        confirms
          .confirm({
            title: 'Deactivate Marco Silva?',
            body: 'They lose access to the portal immediately.',
            verb: 'Deactivate',
            tone: 'danger',
          })
          .subscribe(answer),
      );
      await until(() => !!q('[role="alertdialog"]'), 'confirm rendered');

      const dialog = q('[role="alertdialog"]')!;
      expect(q('.ui-modal__title')!.textContent?.trim()).toBe('Deactivate Marco Silva?');
      const describedBy = dialog.getAttribute('aria-describedby')!;
      expect(document.getElementById(describedBy)?.textContent).toContain('lose access');

      const [cancel, verb] = Array.from(container.querySelectorAll<HTMLButtonElement>('.ui-modal__footer button'));
      expect(verb.textContent?.trim()).toBe('Deactivate');
      expect(verb.classList).toContain('ui-button--danger');
      await until(() => document.activeElement === cancel, 'Cancel focused');

      cancel.click();
      await until(() => answer.mock.calls.length > 0, 'answered');
      expect(answer).toHaveBeenCalledWith(false);
      await until(() => document.activeElement === trigger(), 'focus back on trigger');
    });

    it('default tone: primary verb has focus; confirming emits true and completes', async () => {
      const confirms = TestBed.inject(UiConfirmService);
      const answer = vi.fn();
      const complete = vi.fn();
      confirms
        .confirm({ title: 'Mark INV-1042 paid?', body: '$19,800 from Elite Craft Builders.', verb: 'Mark paid' })
        .subscribe({ next: answer, complete });
      await until(() => !!q('[role="alertdialog"]'), 'confirm rendered');

      const verb = container.querySelectorAll<HTMLButtonElement>('.ui-modal__footer button')[1];
      expect(verb.classList).toContain('ui-button--primary');
      await until(() => document.activeElement === verb, 'verb focused');
      verb.click();
      await until(() => complete.mock.calls.length > 0, 'completed');
      expect(answer).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('Esc answers false', async () => {
      const confirms = TestBed.inject(UiConfirmService);
      const answer = vi.fn();
      confirms.confirm({ title: 'Revoke key?', body: 'Calls using it fail.', verb: 'Revoke', tone: 'danger' }).subscribe(answer);
      await until(() => !!q('[role="alertdialog"]'), 'confirm rendered');
      pressEscape();
      await until(() => answer.mock.calls.length > 0, 'answered');
      expect(answer).toHaveBeenCalledWith(false);
    });

    it('a late subscriber still gets the answer', async () => {
      const confirms = TestBed.inject(UiConfirmService);
      const answer$ = confirms.confirm({ title: 'Rotate secret?', body: 'The old one stops working.', verb: 'Rotate' });
      await until(() => !!q('[role="alertdialog"]'), 'confirm rendered');
      container.querySelectorAll<HTMLButtonElement>('.ui-modal__footer button')[1].click();
      await until(() => !q('.ui-modal'), 'closed');
      const answer = vi.fn();
      answer$.subscribe(answer);
      expect(answer).toHaveBeenCalledWith(true);
    });

    it('type-to-confirm: the verb stays disabled until the exact phrase is typed', async () => {
      const confirms = TestBed.inject(UiConfirmService);
      const answer = vi.fn();
      confirms
        .confirm({
          title: 'Delete Elite Craft Builders?',
          body: 'Their leads and invoices are removed.',
          verb: 'Delete',
          tone: 'danger',
          typeToConfirm: 'elite-craft',
        })
        .subscribe(answer);
      await until(() => !!q('.confirm__input'), 'type field rendered');

      expect(q('.confirm__type')!.textContent).toContain('elite-craft');
      const input = q<HTMLInputElement>('.confirm__input')!;
      const verb = container.querySelectorAll<HTMLButtonElement>('.ui-modal__footer button')[1];
      const form = q('.ui-modal__form')!;
      expect(verb.disabled).toBe(true);

      input.value = 'elite';
      input.dispatchEvent(new Event('input'));
      TestBed.tick();
      expect(verb.disabled).toBe(true);
      // Enter with the wrong phrase does nothing.
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      TestBed.tick();
      expect(answer).not.toHaveBeenCalled();

      input.value = 'Elite-Craft';
      input.dispatchEvent(new Event('input'));
      TestBed.tick();
      expect(verb.disabled).toBe(true); // case-sensitive

      input.value = 'elite-craft';
      input.dispatchEvent(new Event('input'));
      await until(() => !verb.disabled, 'verb enabled');
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      await until(() => answer.mock.calls.length > 0, 'answered');
      expect(answer).toHaveBeenCalledWith(true);
    });
  });

  describe('UiToastService', () => {
    function toasts(): HTMLElement[] {
      return Array.from(container.querySelectorAll<HTMLElement>('.ui-toast'));
    }

    it('shows in a polite live region and auto-dismisses after timings.toastDurationMs (5s)', () => {
      vi.useFakeTimers();
      const service = TestBed.inject(UiToastService);
      const reason = vi.fn();
      service.show({ message: 'Lead marked Contacted' }).dismissed.subscribe(reason);
      TestBed.tick();

      const region = q('.ui-toasts')!;
      expect(region.getAttribute('role')).toBe('status');
      expect(region.getAttribute('aria-live')).toBe('polite');
      expect(toasts()).toHaveLength(1);
      expect(toasts()[0].textContent).toContain('Lead marked Contacted');
      expect(toasts()[0].classList).toContain('ui-toast--success');

      vi.advanceTimersByTime(4999);
      expect(reason).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      TestBed.tick();
      expect(reason).toHaveBeenCalledWith('timeout');
      expect(toasts()).toHaveLength(0);
      // The overlay exists only while a toast is showing.
      expect(q('.ui-toast-pane')).toBeNull();
    });

    it('Undo runs the callback and closes the toast', () => {
      vi.useFakeTimers();
      const service = TestBed.inject(UiToastService);
      const undo = vi.fn();
      const reason = vi.fn();
      service.show({ message: 'Role changed to Admin', undo }).dismissed.subscribe(reason);
      TestBed.tick();

      const button = q<HTMLButtonElement>('.ui-toast__undo')!;
      expect(button.textContent?.trim()).toBe('Undo');
      button.click();
      TestBed.tick();
      expect(undo).toHaveBeenCalledOnce();
      expect(reason).toHaveBeenCalledWith('undo');
      expect(toasts()).toHaveLength(0);
    });

    it('no Undo button without an undo callback; × dismisses', () => {
      vi.useFakeTimers();
      const service = TestBed.inject(UiToastService);
      const reason = vi.fn();
      service.show({ message: 'Saved', tone: 'info' }).dismissed.subscribe(reason);
      TestBed.tick();
      expect(q('.ui-toast__undo')).toBeNull();
      q<HTMLButtonElement>('.ui-toast__close')!.click();
      TestBed.tick();
      expect(reason).toHaveBeenCalledWith('close');
    });

    it('hover / focus pauses the timer; leaving restarts the full delay', () => {
      vi.useFakeTimers();
      const service = TestBed.inject(UiToastService);
      const reason = vi.fn();
      service.show({ message: 'Lead marked Won', undo: () => undefined }).dismissed.subscribe(reason);
      TestBed.tick();

      vi.advanceTimersByTime(4000);
      toasts()[0].dispatchEvent(new Event('focusin'));
      vi.advanceTimersByTime(10_000);
      expect(reason).not.toHaveBeenCalled();

      toasts()[0].dispatchEvent(new Event('focusout'));
      vi.advanceTimersByTime(4999);
      expect(reason).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(reason).toHaveBeenCalledWith('timeout');
    });

    it('keeps at most three toasts, dropping the oldest', () => {
      vi.useFakeTimers();
      const service = TestBed.inject(UiToastService);
      const first = vi.fn();
      service.show({ message: 'one' }).dismissed.subscribe(first);
      service.show({ message: 'two' });
      service.show({ message: 'three' });
      service.show({ message: 'four' });
      TestBed.tick();
      expect(toasts().map((t) => t.querySelector('.ui-toast__message')!.textContent)).toEqual(['two', 'three', 'four']);
      expect(first).toHaveBeenCalledWith('manual');
    });

    it('ref.dismiss() closes early and clears its timer', () => {
      vi.useFakeTimers();
      const service = TestBed.inject(UiToastService);
      const ref = service.show({ message: 'Copied', durationMs: 1000 });
      TestBed.tick();
      ref.dismiss();
      TestBed.tick();
      expect(toasts()).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
