import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { ErrorStateComponent, type ErrorStateKind } from './error-state.component';

@Component({
  standalone: true,
  imports: [ErrorStateComponent],
  template: `
    <ui-error-state
      [kind]="kind()"
      heading="Couldn't load invoices"
      message="Check your connection."
      listLabel="invoices"
      [backLink]="['/admin/invoices']"
      (retry)="retries = retries + 1"
    />
  `,
})
class HostComponent {
  kind = signal<ErrorStateKind>('error');
  retries = 0;
}

function setup(kind: ErrorStateKind) {
  TestBed.configureTestingModule({ imports: [HostComponent], providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.kind.set(kind);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, host: fixture.componentInstance };
}

describe('ErrorStateComponent', () => {
  it('error: renders the error variant with a Retry button that emits retry', () => {
    const { el, host } = setup('error');
    expect(el.querySelector('ui-empty-state')?.classList).toContain('ui-empty-state--error');
    const button = el.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent?.trim()).toBe('Retry');
    button.click();
    expect(host.retries).toBe(1);
    expect(el.querySelector('a')).toBeNull();
  });

  it('not-found: links back to the list and never offers a retry', () => {
    const { el, host } = setup('not-found');
    expect(el.querySelector('ui-empty-state')?.classList).toContain('ui-empty-state--not-found');
    const back = el.querySelector('a')!;
    expect(back.textContent?.replace(/\s+/g, ' ').trim()).toBe('Back to invoices');
    expect(back.getAttribute('href')).toBe('/admin/invoices');
    expect(el.querySelector('button')).toBeNull();
    expect(el.textContent).not.toMatch(/try again|retry/i);
    expect(host.retries).toBe(0);
  });
});
