/**
 * View-as banner + ExitViewAs tests (auth/04).
 *
 * Verifies: the /me authorization context populates the view-as banner
 * state (display name + real admin identity), the banner renders "Viewing
 * as X" with an Exit button only while view-as is active, and ExitViewAs
 * calls the backend then re-probes the session so the banner disappears.
 * The banner is display-only — enforcement tests live in the API suite.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../../../core/config/config.service';
import { LoadAdminSession, ExitViewAs } from '../admin-auth.actions';
import { AdminAuthState } from '../admin-auth.state';
import { ViewAsBannerComponent } from './view-as-banner.component';

function meResponse(viewAs: { builderId?: string; userId?: string } | null) {
  return {
    authenticated: true,
    email: 'karan@example.com',
    authContext: {
      userId: 'user-1',
      email: 'karan@example.com',
      name: 'Target Name',
      staffRole: null,
      permissions: ['builder_leads:read'],
      builderId: 'builder-1',
      builderName: 'Elite Craft',
      memberships: [],
      viewAs,
      realUser: viewAs
        ? { email: 'karan@example.com', name: 'Karan' }
        : null,
    },
  };
}

describe('ViewAsBanner (auth/04)', () => {
  let store: Store;
  let httpMock: HttpTestingController;
  let fixture: ComponentFixture<ViewAsBannerComponent>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ViewAsBannerComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([AdminAuthState]),
      ],
    });
    TestBed.inject(ConfigService);
    store = TestBed.inject(Store);
    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ViewAsBannerComponent);
    fixture.detectChanges();
  });

  function loadSessionWith(
    viewAs: { builderId?: string; userId?: string } | null,
  ): void {
    const done = store.dispatch(new LoadAdminSession());
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/admin/auth/me'));
    req.flush(meResponse(viewAs));
    return void done;
  }

  it('hides the banner when view-as is not active', async () => {
    loadSessionWith(null);
    await Promise.resolve();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.view-as-banner'),
    ).toBeNull();
    httpMock.verify();
  });

  it('shows "Viewing as X" with the real admin note while active', async () => {
    loadSessionWith({ builderId: 'builder-1' });
    await Promise.resolve();
    fixture.detectChanges();
    const banner = fixture.nativeElement.querySelector('.view-as-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Viewing as');
    expect(banner.textContent).toContain('Elite Craft');
    expect(banner.textContent).toContain('karan@example.com');
    expect(
      fixture.nativeElement.querySelector('.view-as-banner__exit'),
    ).not.toBeNull();
    httpMock.verify();
  });

  it('ExitViewAs calls the backend then re-probes so the banner clears', async () => {
    loadSessionWith({ builderId: 'builder-1' });
    await Promise.resolve();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.view-as-banner'),
    ).not.toBeNull();

    const done = store.dispatch(new ExitViewAs());
    const exitReq = httpMock.expectOne(
      (r) => r.url.endsWith('/api/v1/admin/view-as') && r.method === 'DELETE',
    );
    exitReq.flush({ active: false });
    const meReq = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/admin/auth/me'),
    );
    meReq.flush(meResponse(null));
    await done;
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.view-as-banner'),
    ).toBeNull();
    httpMock.verify();
  });
});
