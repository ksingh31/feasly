/**
 * Forgot-password component tests (auth/02).
 *
 * Verifies: no-oracle success copy (identical for known/unknown emails),
 * the reset request payload, and the transient error path.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AdminAuthApiService } from './admin-auth-api.service';
import { AdminForgotPasswordComponent } from './admin-forgot-password.component';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NO_ORACLE_COPY = 'If an account exists for that email';

async function setup() {
  TestBed.resetTestingModule();
  const api = {
    requestPasswordReset: vi.fn().mockReturnValue(of({ sent: true as const })),
  };
  const seo = { setPage: vi.fn() };
  const config = {
    get: (section: string) =>
      section === 'copy'
        ? {
            admin: {
              auth: {
                forgotPasswordIntro:
                  "Enter your admin email and we'll send you a link to set a new password.",
                forgotPasswordSent: "If an account exists for that email, we've sent a reset link.",
              },
            },
          }
        : {},
  };
  TestBed.configureTestingModule({
    imports: [AdminForgotPasswordComponent],
    providers: [
      provideRouter([]),
      { provide: AdminAuthApiService, useValue: api },
      { provide: SeoService, useValue: seo },
      { provide: ConfigService, useValue: config },
    ],
  });
  const fixture = TestBed.createComponent(AdminForgotPasswordComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, api, seo };
}

function componentApi(
  fixture: import('@angular/core/testing').ComponentFixture<AdminForgotPasswordComponent>,
) {
  return fixture.componentInstance as unknown as {
    form: { controls: { email: { setValue: (v: string) => void } } };
    submit: () => void;
  };
}

describe('AdminForgotPasswordComponent (auth/02)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the reset form', async () => {
    const { fixture } = await setup();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Reset your password');
    expect(text).toContain('Send reset link');
    expect(text).toContain('Back to sign in');
  });

  it('requests a reset and shows the no-oracle success copy', async () => {
    const { fixture, api } = await setup();
    const component = componentApi(fixture);
    component.form.controls.email.setValue('ADMIN@example.com');
    component.submit();
    expect(api.requestPasswordReset).toHaveBeenCalledWith({
      email: 'ADMIN@example.com',
    });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(NO_ORACLE_COPY);
    expect(text).toContain('Back to sign in');
  });

  it('does not request with an invalid form', async () => {
    const { fixture, api } = await setup();
    const component = componentApi(fixture);
    component.form.controls.email.setValue('not-an-email');
    component.submit();
    expect(api.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('shows a retry error on failure', async () => {
    const { fixture, api } = await setup();
    api.requestPasswordReset.mockReturnValue(throwError(() => new Error('boom')));
    const component = componentApi(fixture);
    component.form.controls.email.setValue('admin@example.com');
    component.submit();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Something went wrong. Please try again.');
  });

  it('sets SEO metadata for the forgot-password page', async () => {
    const { seo } = await setup();
    expect(seo.setPage).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/admin/forgot-password' }),
    );
  });
});
