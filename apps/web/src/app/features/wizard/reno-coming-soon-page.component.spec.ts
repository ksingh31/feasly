import { Component } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import { ChooseProjectType, WizardState } from '../wizard';
import { RenoComingSoonPageComponent } from './reno-coming-soon-page.component';

/** Blank route target for navigation assertions. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

/**
 * Renovation coming-soon page (Karan 2026-09-27): reno is out of launch
 * scope, so reno users land here instead of the analyzing pipeline — a
 * designed page, never a spinner and never a generic error.
 */
describe('RenoComingSoonPageComponent', () => {
  let fixture: ComponentFixture<RenoComingSoonPageComponent>;
  let store: Store;
  let router: Router;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [RenoComingSoonPageComponent, BlankComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: '', component: BlankComponent },
          { path: 'estimate/scope', component: BlankComponent },
          { path: 'estimate/reno-scope', component: BlankComponent },
        ]),
        provideStore([WizardState]),
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    store = TestBed.inject(Store);
    router = TestBed.inject(Router);
    fixture = TestBed.createComponent(RenoComingSoonPageComponent);
    fixture.detectChanges();
  }

  beforeEach(setup);

  it('renders the coming-soon heading and body — no spinner, no error card', () => {
    const text = fixture.nativeElement.textContent ?? '';
    expect(text).toContain('Renovations are coming soon');
    expect(fixture.nativeElement.querySelectorAll('.stage').length).toBe(0);
    expect(fixture.nativeElement.querySelector('.error-card')).toBeNull();
    expect(fixture.nativeElement.querySelector('.soon-card')).not.toBeNull();
  });

  it('back link returns to the reno scope step', () => {
    const back = fixture.nativeElement.querySelector('a.back') as HTMLAnchorElement;
    expect(back.getAttribute('routerLink')).toBe('/estimate/reno-scope');
  });

  it('new-build CTA flips the wizard to new-build and continues to scope', async () => {
    store.dispatch([new ChooseProjectType('renovation')]);
    (fixture.nativeElement.querySelector('button.cta') as HTMLButtonElement).click();
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
    const deadline = Date.now() + 5000;
    for (;;) {
      if (router.url === '/estimate/scope') break;
      if (Date.now() > deadline) throw new Error('timed out waiting for /estimate/scope');
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(router.url).toBe('/estimate/scope');
  });
});
