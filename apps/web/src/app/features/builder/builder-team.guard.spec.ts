/**
 * Builder team guard specs (auth/05).
 *
 * - builder_admin → allowed.
 * - builder_member → redirected to `/builder`.
 * - Unknown session → probes the session first, then decides.
 */
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { builderTeamGuard } from './builder-team.guard';
import { BuilderState } from './builder.state';
import { LoadBuilderSession } from './builder.actions';

function setup(opts: { isAdmin: boolean; sessionLoaded: boolean; probeAdmin?: boolean }) {
  TestBed.resetTestingModule();
  const dispatched: unknown[] = [];
  const store = {
    selectSnapshot: vi.fn((selector: unknown) => {
      if (selector === BuilderState.isBuilderAdmin) {
        // After the probe dispatch, flip to the probed value.
        return dispatched.length > 0 && opts.probeAdmin !== undefined
          ? opts.probeAdmin
          : opts.isAdmin;
      }
      if (selector === BuilderState.sessionLoaded) return opts.sessionLoaded;
      return undefined;
    }),
    dispatch: vi.fn((action: unknown) => {
      dispatched.push(action);
      return of(null);
    }),
  };
  const router = {
    createUrlTree: vi.fn((commands: string[]) => ({ redirectTo: commands })),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: Store, useValue: store },
      { provide: Router, useValue: router },
    ],
  });
  return { store, router, dispatched };
}

function runGuard() {
  return TestBed.runInInjectionContext(() => builderTeamGuard({} as never, {} as never));
}

describe('builderTeamGuard (auth/05)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('allows a builder_admin', () => {
    setup({ isAdmin: true, sessionLoaded: true });
    expect(runGuard()).toBe(true);
  });

  it('redirects a builder_member to /builder', () => {
    const { router } = setup({ isAdmin: false, sessionLoaded: true });
    const result = runGuard() as { redirectTo: string[] };
    expect(router.createUrlTree).toHaveBeenCalledWith(['/builder']);
    expect(result.redirectTo).toEqual(['/builder']);
  });

  it('probes an unknown session before deciding (admin)', async () => {
    const { dispatched } = setup({
      isAdmin: false,
      sessionLoaded: false,
      probeAdmin: true,
    });
    const result$ = runGuard() as import('rxjs').Observable<unknown>;
    const result = await result$.toPromise();
    expect(dispatched.some((a) => a instanceof LoadBuilderSession)).toBe(true);
    expect(result).toBe(true);
  });

  it('probes an unknown session before deciding (non-admin redirects)', async () => {
    const { router, dispatched } = setup({
      isAdmin: false,
      sessionLoaded: false,
      probeAdmin: false,
    });
    const result$ = runGuard() as import('rxjs').Observable<unknown>;
    await result$.toPromise();
    expect(dispatched.some((a) => a instanceof LoadBuilderSession)).toBe(true);
    expect(router.createUrlTree).toHaveBeenCalledWith(['/builder']);
  });
});
