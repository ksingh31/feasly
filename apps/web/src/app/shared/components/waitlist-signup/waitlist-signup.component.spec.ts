import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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
        provideRouter([]),
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

  const consentBox = (): HTMLInputElement =>
    root().querySelector<HTMLInputElement>('.wl-consent input[type="checkbox"]')!;

  function tickConsent(): void {
    consentBox().click();
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
    tickConsent();
    submit();
    expect(joinWaitlist).toHaveBeenCalledWith({ email: 'me@example.com', topic: 'vancouver', consent: true });
    expect(root().querySelector('.wl-success')?.textContent).toContain('Vancouver');
    expect(root().querySelector('.wl-input')).toBeNull();
  });

  it('renovation variant: no city choice; joins the renovation list', () => {
    fixture.componentInstance.variant.set('renovation');
    fixture.detectChanges();
    expect(root().querySelector('.wl-cities')).toBeNull();
    typeEmail('reno@example.com');
    tickConsent();
    submit();
    expect(joinWaitlist).toHaveBeenCalledWith({ email: 'reno@example.com', topic: 'renovation', consent: true });
  });

  it('CASL: the consent box is unticked by default and shows the approved wording, Privacy Policy linked', () => {
    expect(consentBox().checked).toBe(false);
    const label = root().querySelector<HTMLElement>('.wl-consent')!;
    expect(label.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'I agree to the Privacy Policy and that Feasly may email me when this launches. I can unsubscribe anytime.',
    );
    const link = label.querySelector<HTMLAnchorElement>('a')!;
    expect(link.textContent?.trim()).toBe('Privacy Policy');
    expect(link.getAttribute('href')).toBe('/privacy');
    expect(consentBox().labels?.[0]).toBe(label);
  });

  function pressEnterInEmail(): void {
    emailInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    fixture.detectChanges();
  }

  // #740: both captures (renovation on the scope step, city under the
  // out-of-coverage message) keep submit disabled until consent is ticked.
  describe.each<WaitlistVariant>(['renovation', 'city'])('%s capture: consent gates submit (#740)', (variant) => {
    const topic = variant === 'renovation' ? 'renovation' : 'toronto';

    beforeEach(() => {
      fixture.componentInstance.variant.set(variant);
      fixture.detectChanges();
    });

    it('submit is disabled until the consent box is ticked, and re-disabled when unticked', () => {
      typeEmail('gate@example.com');
      expect(submitButton().disabled).toBe(true);
      submit();
      expect(joinWaitlist).not.toHaveBeenCalled();
      tickConsent();
      expect(submitButton().disabled).toBe(false);
      tickConsent();
      expect(submitButton().disabled).toBe(true);
    });

    it('Enter in the email field does nothing until consent is ticked, then submits', () => {
      typeEmail('enter-gate@example.com');
      pressEnterInEmail();
      expect(joinWaitlist).not.toHaveBeenCalled();
      expect(fixture.componentInstance.outerSubmits).toBe(0);
      tickConsent();
      pressEnterInEmail();
      expect(joinWaitlist).toHaveBeenCalledTimes(1);
      expect(joinWaitlist).toHaveBeenCalledWith({ email: 'enter-gate@example.com', topic, consent: true });
      expect(fixture.componentInstance.outerSubmits).toBe(0);
    });

    it('the disabled button explains why to screen readers; the hint goes once consent is ticked', () => {
      const hintId = submitButton().getAttribute('aria-describedby');
      expect(hintId).toMatch(/^wl-consent-hint-/);
      const hint = root().querySelector<HTMLElement>(`#${hintId}`)!;
      expect(hint.textContent).toContain('tick the box');
      expect(hint.classList).toContain('sr-only');
      expect(root().querySelector('.wl-error')).toBeNull();
      tickConsent();
      expect(submitButton().hasAttribute('aria-describedby')).toBe(false);
      expect(root().querySelector(`#${hintId}`)).toBeNull();
    });

    it('the consent label is tied to its checkbox (for/id and wrapping)', () => {
      const label = root().querySelector<HTMLLabelElement>('.wl-consent')!;
      expect(label.htmlFor).toBe(consentBox().id);
      expect(consentBox().labels?.[0]).toBe(label);
    });
  });

  it('invalid email: inline error, aria-invalid, no API call', () => {
    typeEmail('not-an-email');
    tickConsent();
    submit();
    expect(joinWaitlist).not.toHaveBeenCalled();
    expect(root().querySelector('.wl-error')?.textContent).toContain('valid email');
    expect(emailInput().getAttribute('aria-invalid')).toBe('true');
    expect(emailInput().getAttribute('aria-describedby')).toContain('wl-error-');
  });

  it('Enter in the email field submits the capture, never the surrounding form', () => {
    typeEmail('enter@example.com');
    tickConsent();
    emailInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(joinWaitlist).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.outerSubmits).toBe(0);
  });

  it('shows the sending label and ignores double submits while in flight', () => {
    const pending = new Subject<WaitlistResponse>();
    joinWaitlist.mockReturnValue(pending.asObservable());
    typeEmail('slow@example.com');
    tickConsent();
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
    tickConsent();
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
