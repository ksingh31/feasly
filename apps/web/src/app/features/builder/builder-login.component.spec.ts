/**
 * Builder login component tests (embed/09).
 *
 * Mirrors the admin/01 login spec: the expired-session query param shows the
 * exact copy, successful submit shows the "check your email" message, and the
 * form validates email input.
 */
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderLoginComponent } from './builder-login.component';
import { BuilderAuthApiService } from './builder-auth-api.service';
import { SeoService } from '../../core/seo/seo.service';

const EXPIRED_COPY =
  'Your builder session expired. Enter your email for a fresh sign-in link.';

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
    imports: [BuilderLoginComponent, BlankComponent],
    providers: [
      provideRouter([{ path: '', component: BlankComponent }]),
      { provide: BuilderAuthApiService, useValue: api },
      { provide: SeoService, useValue: seo },
      { provide: ActivatedRoute, useValue: route },
    ],
  });
  const fixture: ComponentFixture<BuilderLoginComponent> =
    TestBed.createComponent(BuilderLoginComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, api, seo };
}

describe('BuilderLoginComponent (embed/09)', () => {
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
    component.form.controls.email.setValue('builder@example.com');
    component.submit();
    expect(api.requestMagicLink).toHaveBeenCalledWith({
      email: 'builder@example.com',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Check your email for your sign-in link.');
  });

  it('rejects an invalid email without calling the API', async () => {
    const { fixture, api } = await setup();
    const component = fixture.componentInstance as unknown as {
      form: { controls: { email: { setValue: (v: string) => void } } };
      submit: () => void;
    };
    component.form.controls.email.setValue('not-an-email');
    component.submit();
    expect(api.requestMagicLink).not.toHaveBeenCalled();
  });
});
