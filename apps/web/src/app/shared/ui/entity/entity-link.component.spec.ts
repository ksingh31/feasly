import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityLinkComponent } from './entity-link.component';

const ID = '3f2c9a4e-1b7d-4c8e-9f00-aa11bb22cc33';

@Component({
  standalone: true,
  imports: [EntityLinkComponent],
  template: `<ui-entity-link
    [entityId]="id"
    label="INV-2026-0042"
    kind="invoice"
    [copyable]="copyable()"
    (opened)="opened.push($event)"
    (copied)="copied.push($event)"
  />`,
})
class HostComponent {
  readonly id = ID;
  readonly copyable = signal(true);
  readonly opened: string[] = [];
  readonly copied: string[] = [];
}

describe('EntityLinkComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  function setup(): HostComponent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function el<T extends HTMLElement>(selector: string): T {
    return fixture.nativeElement.querySelector(selector) as T;
  }

  it('shows the human label, never the raw id', () => {
    setup();
    expect(el('.entity-link__label').textContent?.trim()).toBe('INV-2026-0042');
    expect(fixture.nativeElement.textContent).not.toContain(ID);
  });

  it('emits the id when activated', () => {
    const host = setup();
    el<HTMLButtonElement>('.entity-link__label').click();
    expect(host.opened).toEqual([ID]);
  });

  it('copies the id and announces it, then resets when focus leaves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = setup();
    const copy = el<HTMLButtonElement>('.entity-link__copy');
    expect(copy.getAttribute('aria-label')).toBe('Copy ID (invoice)');

    copy.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(host.copied).toEqual([ID]);
    expect(el('[aria-live]').textContent).toBe('ID copied');
    expect(copy.classList).toContain('entity-link__copy--done');

    el('.entity-link').dispatchEvent(new FocusEvent('focusout'));
    fixture.detectChanges();
    expect(el('[aria-live]').textContent).toBe('');
  });

  it('does not announce when the clipboard rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const host = setup();
    el<HTMLButtonElement>('.entity-link__copy').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(host.copied).toEqual([]);
    expect(el('[aria-live]').textContent).toBe('');
  });

  it('can hide the copy button', () => {
    const host = setup();
    host.copyable.set(false);
    fixture.detectChanges();
    expect(el('.entity-link__copy')).toBeNull();
  });
});
