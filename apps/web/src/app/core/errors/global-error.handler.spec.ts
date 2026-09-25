import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Component } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorRecoveryService } from './error-recovery.service';
import { GlobalErrorHandler } from './global-error.handler';

@Component({ template: '' })
class StubErrorPageComponent {}

@Component({ template: '' })
class StubHomeComponent {}

/**
 * HRD-02: an uncaught client error routes to the branded /error page (never
 * a blank screen), captures a reload retry, and never exposes the raw error.
 */
describe('GlobalErrorHandler', () => {
  let handler: ErrorHandler;
  let router: Router;
  let recovery: ErrorRecoveryService;

  /** Polls for a terminal router state — navigation is async (no fixed sleeps). */
  async function waitForUrl(url: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (router.url !== url) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${url}; still at ${router.url}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ErrorHandler, useClass: GlobalErrorHandler },
        provideRouter([
          { path: '', component: StubHomeComponent },
          { path: 'error', component: StubErrorPageComponent },
        ]),
      ],
    });
    handler = TestBed.inject(ErrorHandler);
    router = TestBed.inject(Router);
    recovery = TestBed.inject(ErrorRecoveryService);
    await router.navigate(['/']);
  });

  it('routes an uncaught error to /error', async () => {
    handler.handleError(new Error('boom'));
    await waitForUrl('/error');
    expect(router.url).toBe('/error');
  });

  it('captures a retry action so the error page can offer "Try again"', () => {
    handler.handleError(new Error('boom'));
    expect(recovery.failedAction()).not.toBeNull();
    expect(recovery.failedAction()?.description).toContain('Reload');
  });

  it('logs the raw error to the console only — it never reaches the router state', async () => {
    const pii = 'secret-email@example.com';
    handler.handleError(new Error(`failed for ${pii}`));
    await waitForUrl('/error');
    expect(router.url).toBe('/error');
    // The navigation carries no error payload: the URL is clean.
    expect(router.url).not.toContain(pii);
    expect(console.error).toHaveBeenCalled();
  });

  it('does not loop when the error page itself throws', async () => {
    await router.navigate(['/error']);
    const navigate = vi.spyOn(router, 'navigate');
    handler.handleError(new Error('boom on the error page'));
    expect(navigate).not.toHaveBeenCalled();
  });
});
