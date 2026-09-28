/**
 * Builder login component tests (auth/05).
 *
 * Verifies: the builder Entra card (single "Sign in with Microsoft →"
 * button starts the Microsoft-hosted flow via BuilderEntraAuthService),
 * the not-configured copy while the app-config still carries
 * ENTRA_BUILDER_* placeholders, the expired-session copy, and that no
 * magic-link form remains (retired with auth/05).
 */
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderLoginComponent } from './builder-login.component';
import { BuilderEntraAuthService } from './builder-entra-auth.service';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';

const EXPIRED_COPY = 'Your builder session expired. Sign in again to continue.';
const SIGN_IN_LABEL = 'Sign in with Microsoft →';
const INTRO_COPY = 'Sign in with your work email to access your builder portal.';
const NOT_CONFIGURED_COPY =
  'Builder sign-in is not configured yet — please contact us.';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

interface SetupOpts {
  entraConfigured?: boolean;
  expired?: boolean;
}

async function setup(opts: SetupOpts = {}) {
  TestBed.resetTestingModule();
  const entra = {
    isConfigured: () => opts.entraConfigured ?? true,
    startSignIn: vi.fn().mockResolvedValue(undefined),
  };
  const seo = { setPage: vi.fn() };
  const config = {
    get: (section: string) =>
      section === 'copy'
        ? {
            builder: {
              loginHeading: 'Builder sign in',
              loginExpired: EXPIRED_COPY,
              entraSignInLabel: SIGN_IN_LABEL,
              entraSignInIntro: INTRO_COPY,
              entraRedirecting: 'Redirecting to Microsoft sign-in…',
              entraNotConfigured: NOT_CONFIGURED_COPY,
            },
          }
        : {},
  };
  const route = {
    snapshot: {
      queryParamMap: {
        get: (key: string): string | null =>
          key === 'expired' && opts.expired ? '1' : null,
      },
    },
  };

  TestBed.configureTestingModule({
    imports: [BuilderLoginComponent],
    providers: [
      provideRouter([{ path: 'builder', component: BlankComponent }]),
      { provide: BuilderEntraAuthService, useValue: entra },
      { provide: SeoService, useValue: seo },
      { provide: ConfigService, useValue: config },
      { provide: ActivatedRoute, useValue: route },
    ],
  });
  const fixture: ComponentFixture<BuilderLoginComponent> =
    TestBed.createComponent(BuilderLoginComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, entra };
}

describe('BuilderLoginComponent (auth/05)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('shows the exact expired-session copy when ?expired=1', async () => {
    const { fixture } = await setup({ expired: true });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(EXPIRED_COPY);
  });

  it('does not show the expired copy without the query param', async () => {
    const { fixture } = await setup();
    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain(EXPIRED_COPY);
  });

  it('renders the Microsoft sign-in button when Entra is configured', async () => {
    const { fixture } = await setup({ entraConfigured: true });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(SIGN_IN_LABEL);
    expect(text).toContain(INTRO_COPY);
  });

  it('clicking the button starts the Entra sign-in', async () => {
    const { fixture, entra } = await setup({ entraConfigured: true });
    const button = fixture.nativeElement.querySelector(
      '.builder-login__submit',
    ) as HTMLButtonElement;
    button.click();
    await fixture.whenStable();
    expect(entra.startSignIn).toHaveBeenCalled();
  });

  it('shows the not-configured copy when Entra is not configured', async () => {
    const { fixture } = await setup({ entraConfigured: false });
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(NOT_CONFIGURED_COPY);
    expect(
      fixture.nativeElement.querySelector('.builder-login__submit'),
    ).toBeNull();
  });

  it('renders no magic-link form', async () => {
    const { fixture } = await setup();
    expect(fixture.nativeElement.querySelector('form')).toBeNull();
    expect(fixture.nativeElement.querySelector('input[type="email"]')).toBeNull();
  });
});
