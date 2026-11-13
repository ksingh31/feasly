import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideStore, Store } from '@ngxs/store';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerShareVerifyResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config';
import { reportEstimateGuard } from '../report/report-estimate.guard';
import { ReportState } from '../report/report.state';
import { WizardState } from '../wizard/wizard.state';
import { MagicLinkPageComponent } from './magic-link-page.component';

@Component({ standalone: true, template: '<p>report</p>' })
class ReportStubComponent {}

@Component({ standalone: true, template: '<p>home</p>' })
class HomeStubComponent {}

/**
 * Issue #484 (P0): `/r/:token` opened in a brand-new browser — the email
 * read on a phone — has none of the original browser's localStorage, so no
 * WizardState.property. The verified token alone must land on the report
 * instead of the guard silently bouncing to `/`. Owner and partner-share
 * links run through the same router path and loader.
 */
describe('/r/:token in a fresh browser context (issue #484)', () => {
  let router: Router;
  let store: Store;
  let api: {
    verifyMagicLink: ReturnType<typeof vi.fn>;
    verifyPartnerShare: ReturnType<typeof vi.fn>;
  };

  async function setup(partner: PartnerShareVerifyResponse | null): Promise<void> {
    TestBed.resetTestingModule();
    api = {
      verifyMagicLink: vi
        .fn()
        .mockReturnValue(
          of(
            partner
              ? { valid: false, reason: 'invalid', reissueAllowed: true }
              : { valid: true, reportToken: 'rep-fresh', estimateId: 'est-1', leadId: 'lead-1' },
          ),
        ),
      verifyPartnerShare: vi.fn().mockReturnValue(of(partner ?? { valid: false, reason: 'invalid' })),
    };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // Fresh context: empty wizard + report slices, no storage plugin.
        provideStore([WizardState, ReportState]),
        provideRouter([
          { path: '', component: HomeStubComponent },
          { path: 'estimate/report', component: ReportStubComponent, canActivate: [reportEstimateGuard] },
          { path: 'r/:token', component: MagicLinkPageComponent },
        ]),
        { provide: API_SERVICE, useValue: api },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    router = TestBed.inject(Router);
    store = TestBed.inject(Store);
  }

  /** Polls until the router settles on the expected URL — never a fixed sleep. */
  async function pollUrl(expected: string): Promise<void> {
    const deadline = Date.now() + 4000;
    while (router.url !== expected) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${expected}; at ${router.url}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('owner magic link lands on the report, not the home page', async () => {
    await setup(null);
    expect(store.selectSnapshot(WizardState.property)).toBeNull();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/r/tok-email');
    await pollUrl('/estimate/report');
    expect(store.selectSnapshot(ReportState.reportToken)).toBe('rep-fresh');
    expect(store.selectSnapshot(ReportState.partnerView)).toBe(false);
  });

  it('partner-share link lands on the report in partner view via the same path', async () => {
    await setup({
      valid: true,
      reportToken: 'tok-partner',
      estimateId: 'est-1',
      partnerEmail: 'partner@example.com',
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/r/tok-partner');
    await pollUrl('/estimate/report');
    expect(store.selectSnapshot(ReportState.reportToken)).toBe('tok-partner');
    expect(store.selectSnapshot(ReportState.partnerView)).toBe(true);
  });
});
