import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../config/config.service';
import { BackendPropertyDataService } from './backend-property-data.service';
import { CalgaryAssessmentService } from './calgary-assessment.service';
import { MockPropertyDataService } from './mock-property-data.service';
import { PROPERTY_DATA_SERVICE, providePropertyData } from './property-data.service';

/**
 * Proves the wiring (FE1-002): `providePropertyData()` selects the property
 * backend from `propertyData.source` — live City API by default, the mock
 * harness or our own /api/v1 routes on request.
 */
describe('providePropertyData', () => {
  let httpMock: HttpTestingController;

  async function wireWith(source: string) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), providePropertyData()],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({ propertyData: { source } });
    await pending;
    return TestBed.inject(PROPERTY_DATA_SERVICE);
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it("provides the live City of Calgary client for source 'live'", async () => {
    expect(await wireWith('live')).toBeInstanceOf(CalgaryAssessmentService);
  });

  it("provides the mock harness for source 'mock'", async () => {
    expect(await wireWith('mock')).toBeInstanceOf(MockPropertyDataService);
  });

  it("provides the backend client for source 'backend'", async () => {
    expect(await wireWith('backend')).toBeInstanceOf(BackendPropertyDataService);
  });

  it('defaults to the live client when source is unknown', async () => {
    expect(await wireWith('nope')).toBeInstanceOf(CalgaryAssessmentService);
  });
});
