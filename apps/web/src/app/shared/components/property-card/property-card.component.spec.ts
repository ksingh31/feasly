import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../../core/config';
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

  async function setup(
    source: 'mock' | 'live',
    showLandNote?: boolean,
  ): Promise<ComponentFixture<PropertyCardComponent>> {
    TestBed.resetTestingModule();
    const configStub = {
      get: vi.fn((key: string) => {
        if (key === 'propertyData') return { source };
        if (key === 'copy') return { propertyCard: { freshnessMock }, report: { landLabel, landHouseNote } };
        throw new Error(`unexpected config key ${key}`);
      }),
    };
    TestBed.configureTestingModule({
      imports: [PropertyCardComponent],
      providers: [{ provide: ConfigService, useValue: configStub }],
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

  it('shows the City-assessed freshness line when live City data serves the card', async () => {
    const fixture = await setup('live');
    const text = fixture.nativeElement.querySelector('.pcard-freshness')?.textContent?.trim();
    expect(text).toContain('City-assessed value, 2025');
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
