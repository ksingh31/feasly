/**
 * Admin login component tests (admin/01).
 *
 * Verifies: the expired-session query param shows the exact story copy,
 * successful submit shows the "check your email" message, and the form
 * validates email input.
 */
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminLoginComponent } from './admin-login.component';
import { AdminAuthApiService } from './admin-auth-api.service';
import { SeoService } from '../../core/seo/seo.service';

const EXPIRED_COPY =
  'Your admin session expired. Enter your email for a fresh sign-in link.';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

async function setup(queryParams: Record<string, string> = {}) {
  TestBed.resetTestingModule();
  const api = {
    requestMagicLink: vi.fn().mockReturnValue(of({ sent: true as const })),
  };
  const seo = { setPage: vi.fn() };
  const paramMap = {
    get: (key: string): string | null => queryParams[key] ?? null,
  };
  const route = { snapshot: { queryParamMap: paramMap } };

  TestBed.configureTestingModule({
    imports: [AdminLoginComponent, BlankComponent],
    providers: [
      provideRouter([{ path: '', component: BlankComponent }]),
      { provide: AdminAuthApiService, useValue: api },
      { provide: SeoService, useValue: seo },
      { provide: ActivatedRoute, useValue: route },
    ],
  });
  const fixture: ComponentFixture<AdminLoginComponent> =
    TestBed.createComponent(AdminLoginComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, api, seo };
}

describe('AdminLoginComponent (admin/01)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('shows the exact expired-session copy when ?expired=1', async () => {
    const { fixture } = await setup({ expired: '1' });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(EXPIRED_COPY);
  });

  it('does not show the expired copy without the query param', async () => {
    const { fixture } = await setup();
    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain(EXPIRED_COPY);
  });

  it('successful submit shows "Check your email"', async () => {
    const { fixture, api } = await setup();
    const component = fixture.componentInstance as unknown as {
      form: { controls: { email: { setValue: (v: string) => void } } };
      submit: () => void;
    };
    component.form.controls.email.setValue('admin@example.com');
    component.submit();
    expect(api.requestMagicLink).toHaveBeenCalledWith({
      email: 'admin@example.com',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Check your email for your sign-in link.');
  });

  it('does not submit an invalid email', async () => {
    const { fixture, api } = await setup();
    const component = fixture.componentInstance as unknown as {
      form: { controls: { email: { setValue: (v: string) => void } } };
      submit: () => void;
    };
    component.form.controls.email.setValue('not-an-email');
    component.submit();
    expect(api.requestMagicLink).not.toHaveBeenCalled();
  });

  it('sets SEO metadata for the login page', async () => {
    const { seo } = await setup();
    expect(seo.setPage).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/admin/login' }),
    );
  });
});
