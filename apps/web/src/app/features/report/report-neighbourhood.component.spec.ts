import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { defer, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { AddressSchoolDesignationsResponse, CommunityLivingResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { mockAddressSchoolDesignations, mockCommunityLiving } from '../../core/api/mock-data';
import { ConfigService } from '../../core/config';
import { formatDistanceLabel, ReportNeighbourhoodComponent } from './report-neighbourhood.component';
import { ReportNeighbourhoodState } from './report-neighbourhood.state';

@Component({
  imports: [ReportNeighbourhoodComponent],
  template: `<app-report-neighbourhood [addressKey]="key()" [showFindCommunity]="ownSite()" />`,
})
class HostComponent {
  readonly key = signal<string | null>('calgary-1234-14-st-nw');
  readonly ownSite = signal(true);
}

interface ApiOverrides {
  schools?: () => unknown;
  living?: () => unknown;
}

async function setup(overrides: ApiOverrides = {}, served: Record<string, unknown> = {}, ownSite = true) {
  const api = {
    getAddressSchoolDesignations: vi.fn(
      overrides.schools ?? ((key: string) => defer(() => of(mockAddressSchoolDesignations(key)))),
    ),
    getCommunityLiving: vi.fn(overrides.living ?? ((slug: string) => defer(() => of(mockCommunityLiving(slug))))),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      provideStore([ReportNeighbourhoodState]),
      { provide: API_SERVICE, useValue: api },
    ],
  });
  const httpMock = TestBed.inject(HttpTestingController);
  const pending = TestBed.inject(ConfigService).load();
  httpMock.expectOne('/assets/config/app-config.json').flush(served);
  await pending;
  const fixture: ComponentFixture<HostComponent> = TestBed.createComponent(HostComponent);
  fixture.componentInstance.ownSite.set(ownSite);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

describe('ReportNeighbourhoodComponent (#785)', () => {
  it('renders schools (typically designated + board lookups), living nearby, and the find link', async () => {
    const { el, api } = await setup();
    expect(api.getAddressSchoolDesignations).toHaveBeenCalledWith('calgary-1234-14-st-nw');
    expect(api.getCommunityLiving).toHaveBeenCalledWith('capitol-hill');

    const schools = el.querySelector('section.schools')!;
    expect(schools.querySelector('h2')!.textContent).toContain('Schools for this address');
    expect(schools.textContent).toContain('typically designated');
    expect(schools.textContent).toContain('confirm with the board');
    expect(schools.textContent).toContain('Elementary (K–6)');
    expect(schools.textContent).toContain('Capitol Hill School');
    const lookups = Array.from(schools.querySelectorAll('.nbh-lookups a')).map((a) => a.getAttribute('href'));
    expect(lookups).toEqual(['https://example.com/cbe-school-lookup', 'https://example.com/ccsd-school-lookup']);

    const living = el.querySelector('section.living')!;
    expect(living.querySelector('h2')!.textContent).toContain('Living near this lot');
    expect(living.textContent).toContain('Capitol Hill');
    expect(living.textContent).toContain('Mock Park, about 220 m');
    expect(living.textContent).toContain('Mock Leisure Centre, about 1.4 km');
    expect(living.textContent).toContain('High (16 City trees per hectare)');
    // A category with nothing on file is left out (no empty rows).
    expect(living.textContent).not.toContain('Pools');
    expect(living.textContent).toContain('not travel times');

    const find = el.querySelector('.nbh-find a')!;
    expect(find.textContent).toContain('Find a community');
    expect(find.getAttribute('href')).toBe('/find-a-community');
    // Print: nothing in the block is marked no-print.
    expect(el.querySelector('.no-print')).toBeNull();
  });

  it('hides the Feasly-only "Find a community" link in a builder embed (#918)', async () => {
    const { el } = await setup({}, {}, false);
    // Schools and living still render in the white-label embed…
    expect(el.querySelector('section.schools')).not.toBeNull();
    expect(el.querySelector('section.living')).not.toBeNull();
    // …but the link into Feasly's own discovery flow does not.
    expect(el.querySelector('.nbh-find')).toBeNull();
    expect(el.querySelector('a[href="/find-a-community"]')).toBeNull();
  });

  it('hides the schools section when no designations are on file', async () => {
    const empty: AddressSchoolDesignationsResponse = {
      ...mockAddressSchoolDesignations('k'),
      designations: [],
    };
    const { el } = await setup({ schools: () => of(empty) });
    expect(el.querySelector('section.schools')).toBeNull();
    expect(el.querySelector('section.living')).not.toBeNull();
    expect(el.querySelector('.nbh-find')).not.toBeNull();
  });

  it('hides the living section when no amenity or tree cover is on file', async () => {
    const bare: CommunityLivingResponse = {
      ...mockCommunityLiving('capitol-hill'),
      amenities: mockCommunityLiving('capitol-hill').amenities.map((a) => ({ ...a, nearest: null })),
      treeCover: null,
    };
    const { el } = await setup({ living: () => of(bare) });
    expect(el.querySelector('section.living')).toBeNull();
    expect(el.querySelector('section.schools')).not.toBeNull();
  });

  it('renders nothing (no empty boxes, no link) when both reads fail', async () => {
    const { el, api } = await setup({
      schools: () => throwError(() => ({ code: 'server_error' })),
    });
    expect(api.getCommunityLiving).not.toHaveBeenCalled();
    expect(el.querySelector('section')).toBeNull();
    expect(el.querySelector('.nbh-find')).toBeNull();
  });

  it('renders nothing for an address outside the covered communities', async () => {
    const outside: AddressSchoolDesignationsResponse = {
      ...mockAddressSchoolDesignations('k'),
      designations: [],
      slug: null,
      communityCode: null,
      communityName: null,
    };
    const { el, api } = await setup({ schools: () => of(outside) });
    expect(api.getCommunityLiving).not.toHaveBeenCalled();
    expect(el.textContent?.trim()).toBe('');
  });

  it('copy is config-driven (deploy overrides merge over the defaults)', async () => {
    const { el } = await setup({}, { copy: { reportNeighbourhood: { schoolsTitle: 'Schools nearby' } } });
    expect(el.querySelector('section.schools h2')!.textContent).toContain('Schools nearby');
  });

  it('formats distances for display', () => {
    expect(formatDistanceLabel(349.6)).toBe('350 m');
    expect(formatDistanceLabel(1_000)).toBe('1.0 km');
    expect(formatDistanceLabel(2_460)).toBe('2.5 km');
  });
});
