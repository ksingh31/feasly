import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { EnvironmentProviders, Provider } from '@angular/core';
import { provideStore } from '@ngxs/store';
import { vi } from 'vitest';
import { API_SERVICE } from '../../../core/api/api.service';
import { ConfigService } from '../../../core/config';
import { ReportState } from '../../report/report.state';
import { LeadState } from '../../wizard/lead.state';
import { WizardState } from '../../wizard/wizard.state';
import { PrivacyFileService } from '../privacy-file.service';
import { PrivacyState } from '../privacy.state';

/** Spec-only helpers for the privacy feature (#706). */
export interface PrivacyApiMock {
  exportPrivacyData: ReturnType<typeof vi.fn>;
  requestErasure: ReturnType<typeof vi.fn>;
  confirmErasure: ReturnType<typeof vi.fn>;
  reissueMagicLink: ReturnType<typeof vi.fn>;
}

export function privacyApiMock(): PrivacyApiMock {
  return {
    exportPrivacyData: vi.fn(),
    requestErasure: vi.fn(),
    confirmErasure: vi.fn(),
    reissueMagicLink: vi.fn(),
  };
}

export async function configurePrivacyTestBed(opts: {
  api: PrivacyApiMock;
  files: { saveJson: ReturnType<typeof vi.fn> };
  imports?: unknown[];
  providers?: Array<Provider | EnvironmentProviders>;
  /** Served-config override (deep-merged over the defaults). */
  config?: Record<string, unknown>;
}): Promise<void> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: (opts.imports ?? []) as never[],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([PrivacyState, ReportState, LeadState, WizardState]),
      { provide: API_SERVICE, useValue: opts.api },
      { provide: PrivacyFileService, useValue: opts.files },
      ...(opts.providers ?? []),
    ],
  });
  const httpMock = TestBed.inject(HttpTestingController);
  const pending = TestBed.inject(ConfigService).load();
  httpMock.expectOne('/assets/config/app-config.json').flush(opts.config ?? {});
  await pending;
}
