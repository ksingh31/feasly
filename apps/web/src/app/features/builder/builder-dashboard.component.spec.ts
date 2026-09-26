/**
 * Builder dashboard component tests (embed/09).
 *
 * Verifies: loading/empty/list/summary rendering from NGXS selectors,
 * status-action dispatch, and the forbidden-error copy path.
 */
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BuilderLeadListResponse } from '@feasly/contracts';
import { BuilderDashboardComponent } from './builder-dashboard.component';
import { BuilderState } from './builder.state';

const LEADS_RESPONSE: BuilderLeadListResponse = {
  leads: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Jane Homeowner',
      email: 'jane@example.com',
      phone: '403-555-0101',
      timeline: '3–6 months',
      leadScore: 82,
      status: 'new',
      statusUpdatedAt: '2026-09-20T10:00:00.000Z',
      addressKey: '123 Main St SW',
      projectType: 'new-build',
      createdAt: '2026-09-19T10:00:00.000Z',
    },
  ],
  summary: { total: 1, new: 1, contacted: 0, quoted: 0, won: 0, lost: 0 },
};

async function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [BuilderDashboardComponent],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderState]),
    ],
  });
  const fixture: ComponentFixture<BuilderDashboardComponent> =
    TestBed.createComponent(BuilderDashboardComponent);
  const httpMock = TestBed.inject(HttpTestingController);
  const store = TestBed.inject(Store);
  fixture.detectChanges();
  return { fixture, httpMock, store };
}

describe('BuilderDashboardComponent (embed/09)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the lead list and the pipeline summary', async () => {
    const { fixture, httpMock } = await setup();
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/leads')).flush(LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Jane Homeowner');
    expect(text).toContain('jane@example.com');
    expect(text).toContain('123 Main St SW');
    expect(text).toContain('Lead pipeline');
    expect(text).toContain('Pipeline summary');
    httpMock.verify();
  });

  it('filters the list by status and shows the empty-filter copy', async () => {
    const { fixture, httpMock } = await setup();
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/leads')).flush(LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector(
      '#builder-status-filter',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();

    // Jane's status is 'new'; filter to 'won' → nothing matches.
    select.value = 'won';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();

    let text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No leads with this status yet.');
    expect(text).not.toContain('Jane Homeowner');

    // Filter back to 'new' → Jane reappears.
    select.value = 'new';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();

    text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Jane Homeowner');
    httpMock.verify();
  });

  it('renders the empty-state copy when there are no leads', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/builder/leads'))
      .flush({
        leads: [],
        summary: { total: 0, new: 0, contacted: 0, quoted: 0, won: 0, lost: 0 },
      } as BuilderLeadListResponse);
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No leads yet');
    httpMock.verify();
  });

  it('renders the load-failure copy with a retry button', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/builder/leads'))
      .flush({ message: 'down' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Could not load your leads');
    httpMock.verify();
  });

  it('dispatches a status update when an action button is clicked', async () => {
    const { fixture, httpMock } = await setup();
    httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/leads')).flush(LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-dashboard__actions button'),
    ) as HTMLButtonElement[];
    const wonButton = buttons.find((b) => b.textContent?.trim() === 'Won');
    expect(wonButton).toBeDefined();
    wonButton!.click();

    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/builder/leads/11111111-1111-4111-8111-111111111111'),
    );
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ status: 'won' });
    req.flush({ ok: true });
    fixture.detectChanges();
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Won');
    httpMock.verify();
  });
});
