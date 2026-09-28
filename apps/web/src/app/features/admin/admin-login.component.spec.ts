/**
 * Admin login component specs (auth/02).
 *
 * Verifies: the branded Entra card (single "Sign in →" button starts the
 * Microsoft-hosted flow via AdminEntraAuthService), the not-configured
 * copy while the app-config still carries ENTRA_* placeholders, the
 * expired-session copy, and that no magic-link fallback remains (retired
 * 2026-09-28 — Karan).
 */
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminLoginComponent } from './admin-login.component';
import { AdminEntraAuthService } from './admin-entra-auth.service';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';

const EXPIRED_COPY = 'Your admin session expired. Sign in again.';
const SIGN_IN_LABEL = 'Sign in →';
const INTRO_COPY = 'Sign in with your Feasly admin account to continue.';
const NOT_CONFIGURED_COPY = 'Sign-in is not set up yet. Contact support.';

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
            admin: {
              auth: {
                loginExpired: EXPIRED_COPY,
                entraSignInLabel: SIGN_IN_LABEL,
                entraSignInIntro: INTRO_COPY,
                entraIncomplete: "Sign-in didn't complete — try again.",
                entraStateMismatch: "Sign-in didn't complete — try again.",
                entraTransient: 'Something went wrong. Please try again.',
                entraNotConfigured: NOT_CONFIGURED_COPY,
              },
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
    imports: [AdminLoginComponent],
    providers: [
      provideRouter([{ path: 'admin', component: BlankComponent }]),
      { provide: AdminEntraAuthService, useValue: entra },
      { provide: SeoService, useValue: seo },
      { provide: ConfigService, useValue: config },
      { provide: ActivatedRoute, useValue: route },
    ],
  });
  const fixture: ComponentFixture<AdminLoginComponent> =
    TestBed.createComponent(AdminLoginComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, entra };
}

function textOf(fixture: ComponentFixture<AdminLoginComponent>): string {
  return fixture.nativeElement.textContent as string;
}

describe('AdminLoginComponent (Entra)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the branded card with the Entra sign-in button', async () => {
    const { fixture } = await setup();
    const text = textOf(fixture);
    expect(text).toContain('Admin portal');
    expect(text).toContain('Welcome back');
    expect(text).toContain(INTRO_COPY);
    expect(text).toContain(SIGN_IN_LABEL);
    expect(text).not.toContain('Password');
  });

  it('starts the Microsoft-hosted flow when the button is clicked', async () => {
    const { fixture, entra } = await setup();
    const button = fixture.nativeElement.querySelector(
      '.admin-login__submit',
    ) as HTMLButtonElement;
    button.click();
    await fixture.whenStable();
    expect(entra.startSignIn).toHaveBeenCalledTimes(1);
  });

  it('disables the button while the redirect is starting', async () => {
    const { fixture, entra } = await setup();
    let resolveStart!: () => void;
    entra.startSignIn.mockImplementation(
      () => new Promise<void>((resolve) => (resolveStart = resolve)),
    );
    const button = fixture.nativeElement.querySelector(
      '.admin-login__submit',
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    resolveStart();
    await fixture.whenStable();
  });

  it('shows the not-configured copy instead of the button when Entra is unconfigured', async () => {
    const { fixture } = await setup({ entraConfigured: false });
    const text = textOf(fixture);
    expect(text).toContain(NOT_CONFIGURED_COPY);
    expect(
      fixture.nativeElement.querySelector('.admin-login__submit'),
    ).toBeNull();
  });

  it('shows the expired-session notice on ?expired=1', async () => {
    const { fixture } = await setup({ expired: true });
    expect(textOf(fixture)).toContain(EXPIRED_COPY);
  });

  it('offers no magic-link fallback (retired 2026-09-28)', async () => {
    const { fixture } = await setup();
    const text = textOf(fixture);
    expect(text).not.toContain('Use a sign-in link instead');
    expect(text).not.toContain('Send sign-in link');
    expect(
      fixture.nativeElement.querySelector('input[type="email"]'),
    ).toBeNull();
    expect(
      fixture.nativeElement.querySelector('.admin-login__alt'),
    ).toBeNull();
  });
});
