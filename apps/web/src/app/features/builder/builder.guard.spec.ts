/**
 * Builder guard tests (embed/09).
 *
 * Verifies: authenticated sessions pass, unauthenticated sessions redirect
 * to `/builder/login`, and expired sessions redirect with `?expired=1`.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideStore } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Observable } from 'rxjs';
import type { UrlTree } from '@angular/router';
import type { BuilderAuthMeResponse } from '@feasly/contracts';
import { builderGuard } from './builder.guard';
import { BuilderState } from './builder.state';

const SESSION: BuilderAuthMeResponse = {
  authenticated: true,
  email: 'builder@example.com',
  tenantKey: 'elite-craft',
};

async function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderState]),
    ],
  });
  return {
    httpMock: TestBed.inject(HttpTestingController),
  };
}

function runGuard(): Promise<boolean | UrlTree> {
  return new Promise((resolve) => {
    TestBed.runInInjectionContext(() => {
      (builderGuard as unknown as () => Observable<boolean | UrlTree>)
        .call(null)
        .subscribe((r) => resolve(r));
    });
  });
}

describe('builderGuard (embed/09)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('allows navigation when the session is valid', async () => {
    const { httpMock } = await setup();
    const pending = runGuard();
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/auth/me')).flush(SESSION);
    expect(await pending).toBe(true);
    httpMock.verify();
  });

  it('redirects to /builder/login when there is no session', async () => {
    const { httpMock } = await setup();
    const pending = runGuard();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/builder/auth/me'))
      .flush({ code: 'UNAUTHENTICATED' }, { status: 401, statusText: 'Unauthorized' });
    const result = await pending;
    expect(String(result)).toContain('/builder/login');
    expect(String(result)).not.toContain('expired');
    httpMock.verify();
  });

  it('redirects to /builder/login?expired=1 on an expired session', async () => {
    const { httpMock } = await setup();
    const pending = runGuard();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/builder/auth/me'))
      .flush({ code: 'SESSION_EXPIRED' }, { status: 401, statusText: 'Unauthorized' });
    const result = await pending;
    expect(String(result)).toContain('/builder/login');
    expect(String(result)).toContain('expired');
    httpMock.verify();
  });
});
