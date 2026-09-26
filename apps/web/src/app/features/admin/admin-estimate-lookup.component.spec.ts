/**
 * Admin estimate-lookup component tests (admin/03 frontend).
 *
 * Verifies: the search entry renders with no detail; a 404 surfaces the
 * exact "no estimate found" copy (AC2); the ops strip shows the cost-data
 * version verbatim and the snapshot timeline newest-first with links
 * (AC4); the narrative renders only when generated (AC5); no editable
 * controls exist (AC3 — read-only view).
 */
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminEstimateDetail } from '@feasly/contracts';
import { AdminEstimateLookupComponent } from './admin-estimate-lookup.component';
import { AdminEstimatesApiService } from './admin-estimates-api.service';
import { SeoService } from '../../core/seo/seo.service';

/** Blank route target. */
@Component({ standalone: true, template: '' })
class BlankComponent {}

const DETAIL: AdminEstimateDetail = {
  id: 'estimate-1',
  projectType: 'new_build',
  inputs: {
    sqft: 2200,
    tier: 'standard',
    garage: 'double',
    basement: 'unfinished',
  },
  outputs: {
    buildRange: { low: 400000, base: 450000, high: 500000 },
    totalRange: { low: 700000, base: 750000, high: 800000 },
    landValue: { value: 300000 },
  },
  rows: [
    { key: 'hard.framing', label: 'Framing', range: { low: 1, base: 2, high: 3 } },
  ],
  costDataVersion: '2026.09.20',
  narrative: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  linkedLeadId: 'lead-9',
  snapshots: [
    { id: 'estimate-2', createdAt: '2026-09-21T10:00:00.000Z' },
    { id: 'estimate-1', createdAt: '2026-09-20T10:00:00.000Z' },
  ],
};

async function setup(options: {
  id?: string;
  detail?: AdminEstimateDetail | null;
  error?: unknown;
} = {}) {
  TestBed.resetTestingModule();
  const api = {
    getEstimate:
      options.error !== undefined
        ? vi.fn().mockReturnValue(throwError(() => options.error))
        : vi.fn().mockReturnValue(of(options.detail ?? DETAIL)),
  };
  const seo = { setPage: vi.fn() };
  // paramMap as a BehaviorSubject so tests can simulate param-only
  // navigation (component reuse) the way the real router does.
  const paramMap$ = new BehaviorSubject(
    convertToParamMap(options.id ? { id: options.id } : {}),
  );
  const route = { paramMap: paramMap$.asObservable() };

  TestBed.configureTestingModule({
    imports: [AdminEstimateLookupComponent, BlankComponent],
    providers: [
      provideRouter([{ path: '', component: BlankComponent }]),
      { provide: AdminEstimatesApiService, useValue: api },
      { provide: SeoService, useValue: seo },
      { provide: ActivatedRoute, useValue: route },
    ],
  });
  const fixture: ComponentFixture<AdminEstimateLookupComponent> =
    TestBed.createComponent(AdminEstimateLookupComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, api, paramMap$ };
}

function textOf(fixture: ComponentFixture<AdminEstimateLookupComponent>): string {
  return fixture.nativeElement.textContent as string;
}

describe('AdminEstimateLookupComponent (admin/03)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the search entry with no detail when no :id is present', async () => {
    const { fixture, api } = await setup();
    expect(api.getEstimate).not.toHaveBeenCalled();
    expect(textOf(fixture)).toContain(
      'Paste an estimate ID to see exactly what the homeowner saw',
    );
    expect(textOf(fixture)).not.toContain('Ops');
  });

  it('shows the exact not-found copy for ESTIMATE_NOT_FOUND (AC2)', async () => {
    const { fixture } = await setup({
      id: 'missing-id',
      error: { code: 'ESTIMATE_NOT_FOUND', message: 'No estimate.', retryable: false },
    });
    expect(textOf(fixture)).toContain('No estimate found for ID');
    expect(textOf(fixture)).toContain('missing-id');
  });

  it('shows a retryable error for transient failures', async () => {
    const { fixture } = await setup({
      id: 'estimate-1',
      error: { code: 'http_500', message: 'Server error.', retryable: true },
    });
    expect(textOf(fixture)).toContain('Something went wrong');
    expect(textOf(fixture)).toContain('Retry');
  });

  it('renders the ops strip with the version verbatim and snapshot timeline (AC4)', async () => {
    const { fixture } = await setup({ id: 'estimate-1' });
    const text = textOf(fixture);
    expect(text).toContain('2026.09.20');
    expect(text).toContain('lead-9');
    // Snapshot timeline: newest first, each linking to its own lookup.
    const links = Array.from(
      fixture.nativeElement.querySelectorAll('.timeline a'),
    ).map((a) => (a as HTMLAnchorElement).getAttribute('href'));
    expect(links).toEqual(['/admin/estimates/estimate-2', '/admin/estimates/estimate-1']);
    // The current estimate is marked.
    expect(text).toContain('current');
  });

  it('renders hero totals and input rows like the consumer report', async () => {
    const { fixture } = await setup({ id: 'estimate-1' });
    const text = textOf(fixture);
    expect(text).toContain('$750,000');
    expect(text).toContain('2,200 sq ft');
    expect(text).toContain('Standard');
  });

  it('omits the narrative section when no narrative was generated (AC5)', async () => {
    const { fixture } = await setup({ id: 'estimate-1' });
    expect(textOf(fixture)).not.toContain('AI summary');
  });

  it('renders the narrative when one was generated (AC5)', async () => {
    const { fixture } = await setup({
      id: 'estimate-1',
      detail: { ...DETAIL, narrative: 'A solid infill opportunity.' },
    });
    const text = textOf(fixture);
    expect(text).toContain('AI summary');
    expect(text).toContain('A solid infill opportunity.');
  });

  it('has no editable controls — the view is read-only (AC3)', async () => {
    const { fixture } = await setup({ id: 'estimate-1' });
    const el = fixture.nativeElement as HTMLElement;
    // The only form on the page is the search box; the detail itself has
    // no inputs, textareas, selects, or contenteditable regions.
    const detailInputs = el.querySelectorAll(
      '.card input, .card textarea, .card select, .card [contenteditable="true"]',
    );
    expect(detailInputs.length).toBe(0);
  });

  it('reloads the estimate when the :id param changes (component reuse)', async () => {
    const second: AdminEstimateDetail = {
      ...DETAIL,
      id: 'estimate-2',
      costDataVersion: '2026.09.21',
    };
    const { fixture, api, paramMap$ } = await setup({ id: 'estimate-1' });
    expect(api.getEstimate).toHaveBeenLastCalledWith('estimate-1');

    // Swap the mock to return the second estimate, then simulate a
    // param-only navigation (router reuses the component instance).
    api.getEstimate.mockImplementation((id: string) =>
      of(id === 'estimate-2' ? second : DETAIL),
    );
    paramMap$.next(convertToParamMap({ id: 'estimate-2' }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.getEstimate).toHaveBeenLastCalledWith('estimate-2');
    expect(textOf(fixture)).toContain('2026.09.21');
  });

  it('renders reno inputs with reno wording', async () => {
    const { fixture } = await setup({
      id: 'reno-1',
      detail: {
        ...DETAIL,
        id: 'reno-1',
        projectType: 'renovation',
        inputs: {
          projectType: 'renovation',
          renoType: 'addition',
          renoSqft: 400,
          tier: 'premium',
          underpinning: false,
        } as unknown as AdminEstimateDetail['inputs'],
      },
    });
    const text = textOf(fixture);
    expect(text).toContain('Addition');
    expect(text).toContain('400 sq ft');
    expect(text).toContain('Premium');
  });
});
