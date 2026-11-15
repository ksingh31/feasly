import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { signal } from '@angular/core';
import { ConfigService } from '../../../core/config';
import { DataFreshnessService, type DataFreshness } from '../../../core/data-freshness';
import { DEFAULT_APP_CONFIG } from '../../../core/config/app-config.defaults';
import { PropertyCardComponent } from './property-card.component';

/**
 * QA P0: the freshness line must never present mock values as City records.
 */
describe('PropertyCardComponent freshness line', () => {
  const fakeProperty = {
    addressKey: 'calgary-918-16-ave-nw',
    address: '918 16 Ave NW, Calgary, AB',
    community: 'Capitol Hill',
    lotSqft: 5200,
    zoning: 'R-CG',
    assessedValue: 729000,
    assessmentYear: 2025,
    yearBuilt: 1978,
    dataAsOf: '2025-07-01',
    stale: false,
  } as PropertyRecord;

  const freshnessMock = 'Sample data for illustration — live City records coming soon';

  const landLabel = 'City-assessed property value (land + existing home)';
  const landHouseNote = 'Includes the current house; teardown value may differ.';

  const dataFreshness = DEFAULT_APP_CONFIG.copy.dataFreshness;

  let load: ReturnType<typeof vi.fn>;

  async function setup(
    source: 'mock' | 'live',
    showLandNote?: boolean,
    freshness: DataFreshness = { refreshedMonth: 'November 2026', rollYear: 2026 },
  ): Promise<ComponentFixture<PropertyCardComponent>> {
    TestBed.resetTestingModule();
    const configStub = {
      get: vi.fn((key: string) => {
        if (key === 'propertyData') return { source };
        if (key === 'copy') {
          return { propertyCard: { freshnessMock }, report: { landLabel, landHouseNote }, dataFreshness };
        }
        throw new Error(`unexpected config key ${key}`);
      }),
    };
    load = vi.fn();
    const freshnessStub = { freshness: signal(freshness).asReadonly(), load };
    TestBed.configureTestingModule({
      imports: [PropertyCardComponent],
      providers: [
        { provide: ConfigService, useValue: configStub },
        { provide: DataFreshnessService, useValue: freshnessStub },
      ],
    });
    const fixture = TestBed.createComponent(PropertyCardComponent);
    fixture.componentRef.setInput('property', fakeProperty);
    if (showLandNote !== undefined) fixture.componentRef.setInput('showLandNote', showLandNote);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the sample-data disclaimer while the mock property harness serves the data', async () => {
    const fixture = await setup('mock');
    const text = fixture.nativeElement.querySelector('.pcard-freshness')?.textContent?.trim();
    expect(text).toBe(freshnessMock);
  });

  // #513 (consumer review S9): one freshness story — the same line as the
  // landing trust strip, built from the property's roll year + the shared
  // dataset check month.
  it('shows the shared "<year> assessment roll (City of Calgary) · checked <Mon Year>" line', async () => {
    const fixture = await setup('live');
    const text = fixture.nativeElement.querySelector('.pcard-freshness')?.textContent?.trim();
    expect(text).toBe('2025 assessment roll (City of Calgary) · checked Nov 2026');
    expect(text).not.toContain('data as of');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('drops the checked claim while the dataset check month is unknown', async () => {
    const fixture = await setup('live', undefined, { refreshedMonth: null, rollYear: null });
    const text = fixture.nativeElement.querySelector('.pcard-freshness')?.textContent?.trim();
    expect(text).toBe('2025 assessment roll (City of Calgary)');
  });

  // #505 (consumer review M2): the assessed figure covers land + the house.
  it('labels the assessed figure honestly and shows the existing-home note', async () => {
    const fixture = await setup('live');
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.pcard-facts dt')?.textContent?.trim()).toBe(landLabel);
    expect(el.querySelector('.pcard-land-note')?.textContent?.trim()).toBe(landHouseNote);
  });

  it('hides the teardown note when showLandNote is false (renovations)', async () => {
    const fixture = await setup('live', false);
    expect(fixture.nativeElement.querySelector('.pcard-land-note')).toBeNull();
  });
});
