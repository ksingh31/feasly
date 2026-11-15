import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { EmptyStateComponent, type EmptyStateVariant, type UiLink } from './empty-state.component';

@Component({
  standalone: true,
  imports: [EmptyStateComponent],
  template: `
    <ui-empty-state
      [variant]="variant()"
      heading="Nothing here"
      [message]="message()"
      [actionLabel]="actionLabel()"
      [actionLink]="actionLink()"
      [listLabel]="listLabel()"
      [backLink]="backLink()"
      (action)="actions = actions + 1"
    />
  `,
})
class HostComponent {
  variant = signal<EmptyStateVariant>('zero-data');
  message = signal<string | null>('One supporting line.');
  actionLabel = signal<string | null>(null);
  actionLink = signal<UiLink | null>(null);
  listLabel = signal<string | null>(null);
  backLink = signal<UiLink | null>(null);
  actions = 0;
}

function setup(init?: (host: HostComponent) => void) {
  TestBed.configureTestingModule({ imports: [HostComponent], providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(HostComponent);
  init?.(fixture.componentInstance);
  fixture.detectChanges();
  const root = (): HTMLElement => fixture.nativeElement.querySelector('ui-empty-state');
  return { fixture, root, host: fixture.componentInstance };
}

describe('EmptyStateComponent', () => {
  const variants: EmptyStateVariant[] = ['zero-data', 'no-results', 'all-clear', 'error', 'not-found'];

  it.each(variants)('renders icon, title and message for %s', (variant) => {
    const { root } = setup((h) => h.variant.set(variant));
    expect(root().classList).toContain(`ui-empty-state--${variant}`);
    expect(root().classList).toContain('ui-empty-state');
    const icon = root().querySelector('.ui-empty-state__icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelector('svg path, svg circle')).not.toBeNull();
    expect(root().querySelector('h2')?.textContent).toBe('Nothing here');
    expect(root().querySelector('.ui-empty-state__message')?.textContent).toBe('One supporting line.');
  });

  it('omits the message line when none is given', () => {
    const { root } = setup((h) => h.message.set(null));
    expect(root().querySelector('.ui-empty-state__message')).toBeNull();
  });

  it('renders no action for zero-data without an action label', () => {
    const { root } = setup();
    expect(root().querySelector('.ui-empty-state__action')).toBeNull();
  });

  it('renders an action button that emits for zero-data/no-results/all-clear', () => {
    for (const variant of ['zero-data', 'no-results', 'all-clear'] as const) {
      TestBed.resetTestingModule();
      const { root, host } = setup((h) => {
        h.variant.set(variant);
        h.actionLabel.set('Clear filters');
      });
      const button = root().querySelector<HTMLButtonElement>('button.ui-empty-state__action')!;
      expect(button.textContent?.trim()).toBe('Clear filters');
      expect(button.type).toBe('button');
      button.click();
      expect(host.actions).toBe(1);
    }
  });

  it('renders the action as a link when actionLink is set', () => {
    const { root } = setup((h) => {
      h.actionLabel.set('Invite a teammate');
      h.actionLink.set('/builder/team');
    });
    const link = root().querySelector('a.ui-empty-state__action');
    expect(link?.getAttribute('href')).toBe('/builder/team');
    expect(root().querySelector('button')).toBeNull();
  });

  it('error: always offers Retry, announced as an alert', () => {
    const { root, host } = setup((h) => h.variant.set('error'));
    expect(root().getAttribute('role')).toBe('alert');
    const button = root().querySelector<HTMLButtonElement>('button.ui-empty-state__action')!;
    expect(button.textContent?.trim()).toBe('Retry');
    button.click();
    expect(host.actions).toBe(1);
  });

  it('error: uses a custom retry label', () => {
    const { root } = setup((h) => {
      h.variant.set('error');
      h.actionLabel.set('Reload invoices');
    });
    expect(root().querySelector('button')?.textContent?.trim()).toBe('Reload invoices');
  });

  it('non-error variants carry no alert role', () => {
    const { root } = setup();
    expect(root().getAttribute('role')).toBeNull();
  });

  describe('not-found', () => {
    it('links back to the list — "Back to {list}"', () => {
      const { root } = setup((h) => {
        h.variant.set('not-found');
        h.listLabel.set('leads');
        h.backLink.set(['/builder', 'leads']);
      });
      const back = root().querySelector('a.ui-empty-state__back')!;
      expect(back.textContent?.replace(/\s+/g, ' ').trim()).toBe('Back to leads');
      expect(back.getAttribute('href')).toBe('/builder/leads');
    });

    it('never renders a button or "Try again", even with an action label', () => {
      const { root, host } = setup((h) => {
        h.variant.set('not-found');
        h.actionLabel.set('Try again');
        h.listLabel.set('invoices');
        h.backLink.set('/admin/invoices');
      });
      expect(root().querySelector('button')).toBeNull();
      expect(root().textContent).not.toMatch(/try again|retry/i);
      expect(host.actions).toBe(0);
    });

    it('renders no action when the list link is missing (never a retry fallback)', () => {
      const { root } = setup((h) => h.variant.set('not-found'));
      expect(root().querySelector('.ui-empty-state__action')).toBeNull();
    });
  });
});
