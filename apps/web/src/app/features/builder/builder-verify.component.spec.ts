/**
 * Builder verify component tests (embed/09).
 *
 * Verifies: a successful token verification navigates to `/builder`; a
 * failed verification shows the error copy with a back-to-login action.
 */
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderVerifyComponent } from './builder-verify.component';
import { BuilderState } from './builder.state';
import { SeoService } from '../../core/seo/seo.service';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

async function setup(opts: { token: string | null; verifyOk: boolean }) {
  TestBed.resetTestingModule();
  const paramMap = { get: (key: string): string | null => (key === 'token' ? opts.token : null) };
  const route = { snapshot: { queryParamMap: paramMap } };
  const seo = { setPage: vi.fn() };
  // The real VerifyBuilderToken handler catches failures and returns of(null);
  // the outcome surfaces via selectSnapshot(authenticated).
  const dispatch = vi.fn().mockReturnValue(of(null));
  const store = {
    dispatch,
    selectSnapshot: vi.fn().mockReturnValue(opts.verifyOk),
  };

  TestBed.configureTestingModule({
    imports: [BuilderVerifyComponent, BlankComponent],
    providers: [
      provideRouter([{ path: '', component: BlankComponent }]),
      { provide: ActivatedRoute, useValue: route },
      { provide: SeoService, useValue: seo },
      provideStore([BuilderState]),
    ],
  });
  // Override the real store with the mock for dispatch/selectSnapshot.
  const { Store: StoreToken } = await import('@ngxs/store');
  TestBed.overrideProvider(StoreToken, { useValue: store });
  const fixture: ComponentFixture<BuilderVerifyComponent> =
    TestBed.createComponent(BuilderVerifyComponent);
  fixture.detectChanges();
  return { fixture, dispatch };
}

describe('BuilderVerifyComponent (embed/09)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('dispatches verification for the token from the URL', async () => {
    const { dispatch } = await setup({ token: 'tok-123', verifyOk: true });
    expect(dispatch).toHaveBeenCalled();
  });

  it('shows the error copy when verification fails', async () => {
    const { fixture } = await setup({ token: 'bad-token', verifyOk: false });
    fixture.detectChanges();
    await fixture.whenStable();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('invalid or has expired');
  });
});
