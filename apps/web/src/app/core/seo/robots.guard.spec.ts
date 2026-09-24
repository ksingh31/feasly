import { TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';
import type { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { robotsGuard } from './robots.guard';

/** SEO-01: /estimate/* and other private routes carry noindex,nofollow; other routes remove it. */
describe('robotsGuard', () => {
  function runGuard(data: Record<string, unknown>): boolean | unknown {
    TestBed.resetTestingModule();
    return TestBed.runInInjectionContext(() =>
      robotsGuard(
        { data } as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
      ),
    );
  }

  it('sets robots=noindex when route data opts in', () => {
    expect(runGuard({ noindex: true })).toBe(true);
    expect(TestBed.inject(Meta).getTag('name="robots"')?.content).toBe('noindex,nofollow');
  });

  it('removes the robots tag on ordinary routes', () => {
    runGuard({ noindex: true });
    expect(runGuard({})).toBe(true);
    expect(TestBed.inject(Meta).getTag('name="robots"')).toBeNull();
  });
});
