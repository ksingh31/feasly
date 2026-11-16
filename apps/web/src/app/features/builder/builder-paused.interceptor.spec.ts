/**
 * #861: builderPausedInterceptor flags a 403 BUILDER_PAUSED on builder
 * portal calls (only those) and passes the error through unchanged.
 */
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderAccountPaused } from './builder.actions';
import { builderPausedInterceptor } from './builder-paused.interceptor';

describe('builderPausedInterceptor (#861)', () => {
  let http: HttpClient;
  let mock: HttpTestingController;
  let store: { dispatch: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    TestBed.resetTestingModule();
    store = { dispatch: vi.fn(() => of(undefined)) };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([builderPausedInterceptor])),
        provideHttpClientTesting(),
        { provide: Store, useValue: store },
      ],
    });
    http = TestBed.inject(HttpClient);
    mock = TestBed.inject(HttpTestingController);
  });

  function fail(url: string, status: number, body: object): unknown {
    let error: unknown;
    http.get(url).subscribe({ error: (e: unknown) => (error = e) });
    mock.expectOne(url).flush(body, { status, statusText: 'x' });
    return error;
  }

  it('dispatches BuilderAccountPaused with the server message on 403 BUILDER_PAUSED', () => {
    const error = fail('https://api.example/api/v1/builder/leads/l1/status', 403, {
      code: 'BUILDER_PAUSED',
      message: 'This builder account is paused. Contact Feasly to restore access.',
    });
    expect(error).toBeTruthy();
    expect(store.dispatch).toHaveBeenCalledTimes(1);
    const action = store.dispatch.mock.calls[0][0] as BuilderAccountPaused;
    expect(action).toBeInstanceOf(BuilderAccountPaused);
    expect(action.message).toBe('This builder account is paused. Contact Feasly to restore access.');
  });

  it('ignores other 403s, other statuses and non-builder paths', () => {
    fail('https://api.example/api/v1/builder/leads', 403, { code: 'FORBIDDEN', message: 'No' });
    fail('https://api.example/api/v1/builder/leads', 500, { code: 'BUILDER_PAUSED' });
    fail('https://api.example/api/v1/admin/builders', 403, { code: 'BUILDER_PAUSED' });
    expect(store.dispatch).not.toHaveBeenCalled();
  });
});
