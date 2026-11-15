import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type UiRowAction, UiRowActionsComponent } from './row-actions.component';

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
  imports: [UiRowActionsComponent],
  template: `<ui-row-actions [actions]="actions()" label="Actions for Marco" (selected)="picked.push($event)" />`,
})
class HostComponent {
  readonly actions = signal<UiRowAction[]>([
    { id: 'edit', label: 'Edit' },
    { id: 'deactivate', label: 'Deactivate', tone: 'danger', disabled: true, hint: 'Last admin.' },
    { id: 'delete', label: 'Delete', tone: 'danger' },
  ]);
  readonly picked: string[] = [];
}

/** #542 — RowActions: a ⋮ trigger with a CDK menu of row actions. */
describe('UI kit RowActions', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => (el.innerHTML = ''));
  });

  function trigger(): HTMLButtonElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector('.row-actions__trigger');
  }

  function items(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.row-actions__item'));
  }

  it('renders a named ⋮ trigger that opens a menu of the actions', () => {
    const t = trigger()!;
    expect(t.getAttribute('aria-label')).toBe('Actions for Marco');
    expect(t.getAttribute('aria-haspopup')).toBe('menu');
    expect(items().length).toBe(0);

    t.click();
    fixture.detectChanges();
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(items().map((i) => i.querySelector('.row-actions__label')!.textContent!.trim())).toEqual([
      'Edit',
      'Deactivate',
      'Delete',
    ]);
    expect(items()[2]!.classList).toContain('row-actions__item--danger');
  });

  it('marks disabled items and links their hint for screen readers', () => {
    trigger()!.click();
    fixture.detectChanges();
    const deactivate = items()[1]!;
    expect(deactivate.getAttribute('aria-disabled')).toBe('true');
    const hint = document.getElementById(deactivate.getAttribute('aria-describedby')!);
    expect(hint!.textContent!.trim()).toBe('Last admin.');
  });

  it('emits the chosen id after the menu closes, never for disabled items', async () => {
    trigger()!.click();
    fixture.detectChanges();
    items()[1]!.click();
    fixture.detectChanges();
    await Promise.resolve();
    expect(fixture.componentInstance.picked).toEqual([]);

    if (items().length === 0) {
      trigger()!.click();
      fixture.detectChanges();
    }
    items()[2]!.click();
    fixture.detectChanges();
    await until(() => fixture.componentInstance.picked.length === 1, 'selected emitted');
    expect(fixture.componentInstance.picked).toEqual(['delete']);
    expect(items().length).toBe(0);
    expect(document.activeElement).toBe(trigger());
  });

  it('renders nothing when there are no actions', () => {
    fixture.componentInstance.actions.set([]);
    fixture.detectChanges();
    expect(trigger()).toBeNull();
  });
});
