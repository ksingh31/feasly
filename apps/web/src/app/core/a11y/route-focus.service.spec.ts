import { ApplicationRef, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAIN_CONTENT_ID, RouteFocusService } from './route-focus.service';

@Component({ template: '', standalone: true })
class DummyComponent {}

/**
 * #832: after a client-side navigation that changes the path, focus moves
 * to the page's <main id="main-content" tabindex="-1"> so screen readers
 * announce the new step — but never on first load, never for query-only
 * changes, and never over a control the page focused itself.
 */
describe('RouteFocusService', () => {
  let router: Router;
  let main: HTMLElement;

  async function go(url: string): Promise<void> {
    await router.navigateByUrl(url);
    TestBed.inject(ApplicationRef).tick();
  }

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [DummyComponent],
      providers: [
        provideRouter([
          { path: '', component: DummyComponent },
          { path: 'estimate/scope', component: DummyComponent },
          { path: 'estimate/gate', component: DummyComponent },
        ]),
      ],
    });
    // Start from a clean focus state: the DOM is shared with other spec
    // files in the worker, so something else may still hold focus (#946).
    (document.activeElement as HTMLElement | null)?.blur();
    main = document.createElement('main');
    main.id = MAIN_CONTENT_ID;
    main.tabIndex = -1;
    document.body.appendChild(main);
    router = TestBed.inject(Router);
    TestBed.inject(RouteFocusService).start();
  });

  afterEach(() => {
    main.remove();
    document.querySelectorAll('[data-test-focus]').forEach((el) => el.remove());
  });

  it('leaves focus alone on the first navigation (initial load)', async () => {
    await go('/');
    expect(document.activeElement).toBe(document.body);
  });

  it('focuses <main> after a navigation that changes the path', async () => {
    await go('/');
    await go('/estimate/scope');
    expect(document.activeElement).toBe(main);
  });

  it('does nothing for a query-only change (drawers use ?open=)', async () => {
    await go('/estimate/scope');
    await go('/estimate/scope?open=lead-1');
    expect(document.activeElement).toBe(document.body);
  });

  it('does not steal focus from a control the new page focused', async () => {
    await go('/');
    const input = document.createElement('input');
    input.setAttribute('data-test-focus', '');
    document.body.appendChild(input);
    input.focus();
    await go('/estimate/gate');
    expect(document.activeElement).toBe(input);
  });

  it('is idempotent: start() twice still focuses once per navigation', async () => {
    TestBed.inject(RouteFocusService).start();
    await go('/');
    await go('/estimate/gate');
    expect(document.activeElement).toBe(main);
  });
});
