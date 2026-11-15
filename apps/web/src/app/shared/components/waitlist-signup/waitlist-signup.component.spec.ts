import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaitlistRequest, WaitlistResponse } from '@feasly/contracts';
import { API_SERVICE, type ApiService } from '../../../core/api';
import { ConfigService } from '../../../core/config';
import { WaitlistSignupComponent, type WaitlistVariant } from './waitlist-signup.component';

/** Host with a surrounding <form>, the way the landing page embeds it. */
@Component({
  standalone: true,
  imports: [WaitlistSignupComponent],
  template: `<form (submit)="outerSubmits = outerSubmits + 1; $event.preventDefault()">
    <app-waitlist-signup [variant]="variant()" [query]="query()" />
  </form>`,
})
class HostComponent {
  readonly variant = signal<WaitlistVariant>('city');
  readonly query = signal('');
  outerSubmits = 0;
}

/**
 * #520 (D-P4): "tell me when it's ready" capture. Covers topic selection,
 * validation, the API call, success/error states, and that Enter never
 * submits the surrounding form.
 */
describe('WaitlistSignupComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let joinWaitlist: ReturnType<typeof vi.fn<(req: WaitlistRequest) => ReturnType<ApiService['joinWaitlist']>>>;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_SERVICE, useValue: { joinWaitlist } as unknown as ApiService },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    http.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    joinWaitlist = vi.fn((req: WaitlistRequest) => of<WaitlistResponse>({ ok: true, topic: req.topic }));
    await setup();
  });

  const root = (): HTMLElement => fixture.nativeElement;
  const emailInput = (): HTMLInputElement => root().querySelector('.wl-input')!;
  const submitButton = (): HTMLButtonElement => root().querySelector('.wl-submit')!;
  const checkedCity = (): string | undefined =>
    root().querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value;

  function typeEmail(value: string): void {
    emailInput().value = value;
    emailInput().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function submit(): void {
    submitButton().click();
    fixture.detectChanges();
  }

  it('city variant: offers Toronto and Vancouver, Toronto first by default', () => {
    const labels = Array.from(root().querySelectorAll('.wl-city')).map((l) => l.textContent?.trim());
    expect(labels).toEqual(['Toronto', 'Vancouver']);
    expect(checkedCity()).toBe('toronto');
    expect(root().querySelector('legend')?.textContent).toContain('Your city');
  });

  it('city variant: preselects the city named in the typed address', () => {
    fixture.componentInstance.query.set('1055 W Georgia St, VANCOUVER BC');
    fixture.detectChanges();
    expect(checkedCity()).toBe('vancouver');
  });

  it('joins the picked city list with a trimmed email', () => {
    root().querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click();
    fixture.detectChanges();
    typeEmail('  me@example.com ');
    submit();
    expect(joinWaitlist).toHaveBeenCalledWith({ email: 'me@example.com', topic: 'vancouver' });
    expect(root().querySelector('.wl-success')?.textContent).toContain('Vancouver');
    expect(root().querySelector('.wl-input')).toBeNull();
  });

  it('renovation variant: no city choice; joins the renovation list', () => {
    fixture.componentInstance.variant.set('renovation');
    fixture.detectChanges();
    expect(root().querySelector('.wl-cities')).toBeNull();
    typeEmail('reno@example.com');
    submit();
    expect(joinWaitlist).toHaveBeenCalledWith({ email: 'reno@example.com', topic: 'renovation' });
  });

  it('invalid email: inline error, aria-invalid, no API call', () => {
    typeEmail('not-an-email');
    submit();
    expect(joinWaitlist).not.toHaveBeenCalled();
    expect(root().querySelector('.wl-error')?.textContent).toContain('valid email');
    expect(emailInput().getAttribute('aria-invalid')).toBe('true');
    expect(emailInput().getAttribute('aria-describedby')).toContain('wl-error-');
  });

  it('Enter in the email field submits the capture, never the surrounding form', () => {
    typeEmail('enter@example.com');
    emailInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(joinWaitlist).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.outerSubmits).toBe(0);
  });

  it('shows the sending label and ignores double submits while in flight', () => {
    const pending = new Subject<WaitlistResponse>();
    joinWaitlist.mockReturnValue(pending.asObservable());
    typeEmail('slow@example.com');
    submit();
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent?.trim()).toBe('Saving…');
    submit();
    expect(joinWaitlist).toHaveBeenCalledTimes(1);
    pending.next({ ok: true, topic: 'toronto' });
    pending.complete();
    fixture.detectChanges();
    expect(root().querySelector('.wl-success')).not.toBeNull();
  });

  it('API failure: honest error, the form stays usable for a retry', () => {
    joinWaitlist.mockReturnValue(throwError(() => new Error('boom')));
    typeEmail('err@example.com');
    submit();
    expect(root().querySelector('.wl-error')?.textContent).toContain('try again');
    expect(submitButton().disabled).toBe(false);
  });

  it('every touch target is a native, labelled control', () => {
    expect(emailInput().labels?.[0]?.textContent).toContain('Email');
    expect(emailInput().type).toBe('email');
    expect(emailInput().autocomplete).toBe('email');
    expect(submitButton().type).toBe('button');
  });
});
