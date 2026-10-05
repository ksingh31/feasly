/**
 * Builder dashboard component tests (embed/09 redesign).
 *
 * Verifies: summary totals rendering, lead-card fields, the per-lead
 * status control dispatch, the won-hint report-contract link, and the
 * loading / empty / filter-empty / error states (incl. Retry
 * redispatching LoadBuilderLeads).
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
import { of } from 'rxjs';
import type { BuilderLeadListResponse, Comment } from '@feasly/contracts';
import { BuilderDashboardComponent } from './builder-dashboard.component';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderState } from './builder.state';
import { BuilderBillingState } from './builder-billing.state';
import { BuilderBillingApiService } from './builder-billing-api.service';
import { BuilderInvoicesState } from './builder-invoices.state';
import { BuilderInvoicesApiService } from './builder-invoices-api.service';

/** A minimal full Comment fixture for the expanded-thread flushes. */
function threadComment(overrides: Partial<Comment> = {}): Comment {
  const now = new Date().toISOString();
  return {
    id: 'c1',
    entityType: 'lead',
    entityId: LEAD_ID,
    authorKind: 'builder',
    authorId: 'builder@example.com',
    authorDisplayName: 'A Builder',
    visibility: 'org',
    body: 'A note',
    createdAt: now,
    updatedAt: now,
    edited: false,
    deletedAt: null,
    ...overrides,
  };
}

const LEAD_ID = '11111111-1111-4111-8111-111111111111';

const LEADS_RESPONSE: BuilderLeadListResponse = {
  leads: [
    {
      id: LEAD_ID,
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
      hasInvoice: false,
      invoiceSummary: null,
      commentCount: 2,
      latestComment: {
        body: 'Called — no answer. Left a voicemail.',
        authorDisplayName: 'A Builder',
        authorKind: 'builder',
        createdAt: '2026-09-28T10:00:00.000Z',
      },
    },
  ],
  summary: { total: 1, new: 1, contacted: 0, quoted: 0, won: 0, lost: 0 },
};

// The same lead with zero notes: the section shows the empty-state CTA
// instead of the preview, and the count pill reads 0.
const NO_NOTES_RESPONSE: BuilderLeadListResponse = {
  leads: [
    {
      ...LEADS_RESPONSE.leads[0],
      commentCount: 0,
      latestComment: null,
    },
  ],
  summary: { total: 1, new: 1, contacted: 0, quoted: 0, won: 0, lost: 0 },
};

const RECORDED_LEAD_RESPONSE: BuilderLeadListResponse = {
  leads: [
    {
      ...LEADS_RESPONSE.leads[0],
      status: 'won',
      hasInvoice: true,
      invoiceSummary: {
        id: 'inv-1',
        invoiceNumber: 'INV-0042',
        contractValueCents: 65000000,
        status: 'in_review',
        commissionCents: 650000,
        reviewDueAt: '2026-10-06T23:59:59-06:00',
        paymentMethod: 'card',
      },
    },
  ],
  summary: { total: 1, new: 0, contacted: 0, quoted: 0, won: 1, lost: 0 },
};

const EMPTY_RESPONSE: BuilderLeadListResponse = {
  leads: [],
  summary: { total: 0, new: 0, contacted: 0, quoted: 0, won: 0, lost: 0 },
};

// Won but not yet recorded (no invoice): the card still shows the status
// control so the builder can report the signed contract.
const WON_NO_INVOICE_RESPONSE: BuilderLeadListResponse = {
  leads: [
    {
      ...LEADS_RESPONSE.leads[0],
      status: 'won',
      hasInvoice: false,
      invoiceSummary: null,
    },
  ],
  summary: { total: 1, new: 0, contacted: 0, quoted: 0, won: 1, lost: 0 },
};

async function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [BuilderDashboardComponent],
    providers: [
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      // The dashboard's due-invoice banners read the invoices and billing
      // states; the APIs behind them are stubbed so the banner loads never
      // hit HttpTestingController (its verify() would flag them).
      provideStore([BuilderState, BuilderBillingState, BuilderInvoicesState]),
      {
        provide: BuilderInvoicesApiService,
        useValue: {
          listInvoices: () =>
            of({ invoices: [], total: 0, page: 1, pageSize: 20 }),
        },
      },
      {
        provide: BuilderBillingApiService,
        useValue: { getCard: () => of({ hasCard: false }) },
      },
    ],
  });
  const fixture: ComponentFixture<BuilderDashboardComponent> =
    TestBed.createComponent(BuilderDashboardComponent);
  const httpMock = TestBed.inject(HttpTestingController);
  const store = TestBed.inject(Store);
  fixture.detectChanges();
  return { fixture, httpMock, store };
}

function loadLeads(httpMock: HttpTestingController, body: BuilderLeadListResponse) {
  httpMock.expectOne((r) => r.url.endsWith('/api/v1/builder/leads')).flush(body);
}

describe('BuilderDashboardComponent (embed/09 redesign)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders the summary totals with counts per status', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const totals = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-pipeline__total'),
    ) as HTMLElement[];
    // Total + the five pipeline statuses.
    expect(totals).toHaveLength(6);
    const counts = totals.map(
      (t) => t.querySelector('.builder-pipeline__total-count')?.textContent?.trim(),
    );
    expect(counts[0]).toBe('1'); // total
    expect(counts[1]).toBe('1'); // new
    expect(counts[2]).toBe('0'); // contacted
    const labels = totals.map(
      (t) => t.querySelector('.builder-pipeline__total-label')?.textContent?.trim(),
    );
    expect(labels[0]).toBe('Total leads');
    expect(labels[1]).toBe('New');
    httpMock.verify();
  });

  it('renders the due-invoice banners region above the pipeline heading', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, EMPTY_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const banners = fixture.nativeElement.querySelector(
      'app-due-invoice-banners',
    ) as HTMLElement;
    const heading = fixture.nativeElement.querySelector(
      '#builder-dashboard-heading',
    ) as HTMLElement;
    expect(banners).toBeTruthy();
    expect(heading).toBeTruthy();
    // Banners sit above the page heading in document order.
    expect(
      banners.compareDocumentPosition(heading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    httpMock.verify();
  });

  it('renders lead rows with name, address, contact, timeline, score, badge and dates', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const card = fixture.nativeElement.querySelector('.builder-lead-card') as HTMLElement;
    expect(card).toBeTruthy();
    const text = card.textContent as string;
    expect(text).toContain('Jane Homeowner');
    expect(text).toContain('jane@example.com');
    expect(text).toContain('123 Main St SW');
    expect(text).toContain('403-555-0101');
    expect(text).toContain('3–6 months');
    expect(text).toContain('82');
    expect(text).toContain('new-build');
    expect(text).toContain('2026-09-20'); // statusUpdatedAt, en-CA
    expect(text).toContain('2026-09-19'); // createdAt, en-CA

    const badge = card.querySelector('.builder-lead-card__badge--new') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent?.trim()).toBe('New');

    const avatar = card.querySelector('.builder-lead-card__avatar') as HTMLElement;
    expect(avatar.textContent?.trim()).toBe('JH');
    httpMock.verify();
  });

  it('stages a status change without saving; Apply dispatches the PATCH', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector(
      '.builder-lead-card__status select',
    ) as HTMLSelectElement;
    const apply = fixture.nativeElement.querySelector(
      '.builder-lead-card__apply',
    ) as HTMLButtonElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('new');
    // No staged change yet: Apply is disabled.
    expect(apply.disabled).toBe(true);

    select.value = 'won';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    // Selection alone saves nothing: no PATCH, badge still New.
    httpMock.expectNone((r) =>
      r.url.endsWith(`/api/v1/builder/leads/${LEAD_ID}`),
    );
    let badge = fixture.nativeElement.querySelector(
      '.builder-lead-card__badge--new',
    ) as HTMLElement;
    expect(badge?.textContent?.trim()).toBe('New');
    expect(apply.disabled).toBe(false);

    apply.click();
    const req = httpMock.expectOne((r) =>
      r.url.endsWith(`/api/v1/builder/leads/${LEAD_ID}`),
    );
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ status: 'won' });
    req.flush({ ok: true });
    fixture.detectChanges();
    await fixture.whenStable();

    // The confirmed transition applies locally: badge flips to Won and the
    // record-contract CTA appears, carrying the lead id to the record page.
    badge = fixture.nativeElement.querySelector(
      '.builder-lead-card__badge--won',
    ) as HTMLElement;
    expect(badge?.textContent?.trim()).toBe('Won');
    const hint = fixture.nativeElement.querySelector(
      '.builder-lead-card__won',
    ) as HTMLElement;
    expect(hint?.textContent).toContain('Signed a contract with this lead?');
    expect(hint?.textContent).toContain('Record the signed contract');
    const link = hint.querySelector('a');
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toContain('/builder/record-contract');
    expect(link?.getAttribute('href')).toContain(LEAD_ID);
    httpMock.verify();
  });

  it('reverts the staged select to the store value when the PATCH fails', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector(
      '.builder-lead-card__status select',
    ) as HTMLSelectElement;
    const apply = fixture.nativeElement.querySelector(
      '.builder-lead-card__apply',
    ) as HTMLButtonElement;
    select.value = 'won';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    apply.click();

    const req = httpMock.expectOne((r) =>
      r.url.endsWith(`/api/v1/builder/leads/${LEAD_ID}`),
    );
    req.flush(
      { code: 'LEAD_STATUS_FAILED', message: 'Update failed.', retryable: false },
      { status: 400, statusText: 'Bad Request' },
    );
    fixture.detectChanges();
    await fixture.whenStable();

    // Badge never moved; the staged pick is discarded so the select
    // renders the store value — the two can never disagree.
    const badge = fixture.nativeElement.querySelector(
      '.builder-lead-card__badge--new',
    ) as HTMLElement;
    expect(badge?.textContent?.trim()).toBe('New');
    expect(select.value).toBe('new');
    httpMock.verify();
  });

  it('shows the recorded state with an invoice link for a recorded won lead', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, RECORDED_LEAD_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const card = fixture.nativeElement.querySelector(
      '.builder-lead-card',
    ) as HTMLElement;
    const text = card.textContent as string;
    expect(text).toContain('Contract recorded');
    // The lead card shows the invoice number…
    expect(text).toContain('View invoice INV-0042');
    expect(text).not.toContain('Record the signed contract');
    // …and deep-links to the invoice detail (?invoice=<id>).
    const link = card.querySelector(
      '.builder-lead-card__won--recorded a',
    ) as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/builder/invoices?invoice=inv-1');
    httpMock.verify();
  });

  it('locks the status control for a recorded lead: no select, no Apply', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, RECORDED_LEAD_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const card = fixture.nativeElement.querySelector(
      '.builder-lead-card',
    ) as HTMLElement;
    expect(card.querySelector('.builder-lead-card__status')).toBeNull();
    expect(card.querySelector('.builder-lead-card__apply')).toBeNull();
    expect(card.textContent).toContain('Status locked — contract recorded');
    // The badge is read-only: Won, with no way to flip it back.
    const badge = card.querySelector(
      '.builder-lead-card__badge--won',
    ) as HTMLElement;
    expect(badge?.textContent?.trim()).toBe('Won');
    httpMock.verify();
  });

  it('syncs the status select with the stored status for a won lead without an invoice', async () => {
    // Regression: [value] on the select never took effect inside the @for
    // (the binding runs before the options exist on first render), so a
    // Won lead showed "New" selected. The selection now lives on the
    // options via [selected], which is order-safe.
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, WON_NO_INVOICE_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector(
      '.builder-lead-card',
    ) as HTMLElement;
    const badge = card.querySelector(
      '.builder-lead-card__badge--won',
    ) as HTMLElement;
    expect(badge?.textContent?.trim()).toBe('Won');

    const select = card.querySelector(
      '.builder-lead-card__status select',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('won');
    const selected = select.querySelector(
      'option:checked',
    ) as HTMLOptionElement;
    expect(selected?.textContent?.trim()).toBe('Won');

    // No staged change yet: Apply is disabled.
    const apply = card.querySelector(
      '.builder-lead-card__apply',
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    httpMock.verify();
  });

  it('clicking a summary total filters the list to that status', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const totals = Array.from(
      fixture.nativeElement.querySelectorAll('.builder-pipeline__total'),
    ) as HTMLButtonElement[];
    // Jane is 'new'; click the "Won" total (index 4).
    totals[4].click();
    fixture.detectChanges();
    await fixture.whenStable();

    let text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No leads with this status');
    expect(text).not.toContain('Jane Homeowner');

    // Clicking the same total again clears the filter.
    totals[4].click();
    fixture.detectChanges();
    await fixture.whenStable();

    text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Jane Homeowner');
    httpMock.verify();
  });

  it('filters the list via the status select and shows the filter-empty copy', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector(
      '#builder-status-filter',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();

    select.value = 'won';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();

    let text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No leads with this status');
    expect(text).toContain('Clear filter');
    expect(text).not.toContain('Jane Homeowner');

    // Clear filter restores the list.
    const clear = fixture.nativeElement.querySelector(
      '.builder-pipeline__empty button',
    ) as HTMLButtonElement;
    clear.click();
    fixture.detectChanges();
    await fixture.whenStable();

    text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Jane Homeowner');
    httpMock.verify();
  });

  it('renders loading skeletons while the leads load', async () => {
    const { fixture, httpMock } = await setup();
    // The initial dispatch is still in flight: skeletons, not the list.
    const skeletons = fixture.nativeElement.querySelectorAll(
      '.builder-pipeline__skeleton',
    );
    expect(skeletons.length).toBeGreaterThan(0);
    const status = fixture.nativeElement.querySelector(
      '.builder-pipeline__loading[role="status"]',
    );
    expect(status).toBeTruthy();
    expect(status.textContent).toContain('Loading your leads…');

    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(
      fixture.nativeElement.querySelectorAll('.builder-pipeline__skeleton').length,
    ).toBe(0);
    httpMock.verify();
  });

  it('renders the empty-state copy with guidance when there are no leads', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, EMPTY_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const empty = fixture.nativeElement.querySelector(
      '.builder-pipeline__empty',
    ) as HTMLElement;
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain('No leads yet');
    expect(empty.textContent).toContain(
      'Matched homeowners will appear here as soon as they submit an estimate request.',
    );
    expect(
      fixture.nativeElement.querySelectorAll('.builder-lead-card').length,
    ).toBe(0);
    httpMock.verify();
  });

  it('renders the error state with a Retry button that redispatches the load', async () => {
    const { fixture, httpMock } = await setup();
    httpMock
      .expectOne((r) => r.url.endsWith('/api/v1/builder/leads'))
      .flush({ message: 'down' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    await fixture.whenStable();

    const error = fixture.nativeElement.querySelector(
      '.builder-pipeline__error',
    ) as HTMLElement;
    expect(error).toBeTruthy();
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain("Couldn't load your leads");
    expect(error.textContent).toContain('Could not load your leads. Please try again.');

    const retry = error.querySelector('button') as HTMLButtonElement;
    expect(retry.textContent?.trim()).toBe('Retry');
    retry.click();

    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(
      fixture.nativeElement.querySelectorAll('.builder-lead-card').length,
    ).toBe(1);
    expect(fixture.nativeElement.querySelector('.builder-pipeline__error')).toBeNull();
    httpMock.verify();
  });

  it('renders the honest 403 copy when a status update is forbidden', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const select = fixture.nativeElement.querySelector(
      '.builder-lead-card__status select',
    ) as HTMLSelectElement;
    const apply = fixture.nativeElement.querySelector(
      '.builder-lead-card__apply',
    ) as HTMLButtonElement;
    select.value = 'lost';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    apply.click();

    const req = httpMock.expectOne((r) =>
      r.url.endsWith('/api/v1/builder/leads/11111111-1111-4111-8111-111111111111'),
    );
    req.flush({ code: 'FORBIDDEN' }, { status: 403, statusText: 'Forbidden' });
    fixture.detectChanges();
    await fixture.whenStable();

    const banner = fixture.nativeElement.querySelector(
      '.builder-pipeline__banner',
    ) as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain(
      'That lead belongs to another builder — its status was not changed.',
    );
    httpMock.verify();
  });

  it('shows the notes section collapsed by default with a live count badge', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const section = fixture.nativeElement.querySelector(
      '.builder-lead-card__notes-section',
    ) as HTMLElement;
    expect(section).toBeTruthy();
    expect(section.getAttribute('aria-label')).toContain('Notes');

    const header = section.querySelector(
      '.builder-lead-card__notes-header',
    ) as HTMLButtonElement;
    expect(header).toBeTruthy();
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(
      header.querySelector('.builder-lead-card__notes-title')?.textContent?.trim(),
    ).toBe('Notes');
    expect(
      header.querySelector('.builder-lead-card__notes-count')?.textContent?.trim(),
    ).toBe('2');

    // Collapsed: the thread is not mounted yet.
    expect(section.querySelector('app-builder-lead-comments')).toBeNull();
    httpMock.verify();
  });

  it('renders the latest-note preview when collapsed', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const preview = fixture.nativeElement.querySelector(
      '.builder-lead-card__notes-preview',
    ) as HTMLElement;
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('A Builder');
    expect(preview.textContent).toContain('Called — no answer. Left a voicemail.');
    httpMock.verify();
  });

  it('shows the empty-state CTA for a lead with no notes; clicking expands the thread', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, NO_NOTES_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const section = fixture.nativeElement.querySelector(
      '.builder-lead-card__notes-section',
    ) as HTMLElement;
    // The count pill reads 0 and the empty state replaces the preview.
    expect(
      section.querySelector('.builder-lead-card__notes-count')?.textContent?.trim(),
    ).toBe('0');
    expect(section.querySelector('.builder-lead-card__notes-preview')).toBeNull();

    const cta = section.querySelector(
      '.builder-lead-card__notes-cta',
    ) as HTMLButtonElement;
    expect(cta).toBeTruthy();
    expect(cta.textContent?.trim()).toBe('Add the first note');

    cta.click();
    fixture.detectChanges();

    const header = section.querySelector(
      '.builder-lead-card__notes-header',
    ) as HTMLButtonElement;
    expect(header.getAttribute('aria-expanded')).toBe('true');

    // The expanded thread loads the comments for the lead.
    const req = httpMock.expectOne((r) =>
      r.url.endsWith(`/api/v1/builder/leads/${LEAD_ID}/comments`),
    );
    req.flush({ comments: [] });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(section.querySelector('app-builder-lead-comments')).toBeTruthy();
    httpMock.verify();
  });

  it('updates the badge and preview live when the thread publishes comments', async () => {
    const { fixture, httpMock } = await setup();
    loadLeads(httpMock, LEADS_RESPONSE);
    fixture.detectChanges();
    await fixture.whenStable();

    const section = fixture.nativeElement.querySelector(
      '.builder-lead-card__notes-section',
    ) as HTMLElement;
    const header = section.querySelector(
      '.builder-lead-card__notes-header',
    ) as HTMLButtonElement;

    // Expand; the thread publishes its loaded comments (now 3, one new).
    header.click();
    fixture.detectChanges();
    const req = httpMock.expectOne((r) =>
      r.url.endsWith(`/api/v1/builder/leads/${LEAD_ID}/comments`),
    );
    const now = new Date().toISOString();
    req.flush({
      comments: [
        threadComment({ id: 'c1', body: 'Older note', createdAt: '2026-09-27T10:00:00.000Z' }),
        threadComment({ id: 'c2', body: 'Called — no answer. Left a voicemail.', createdAt: '2026-09-28T10:00:00.000Z' }),
        threadComment({ id: 'c3', body: 'They called back — quoting next week.', createdAt: now }),
      ],
    });
    fixture.detectChanges();
    await fixture.whenStable();

    // The badge updates while still expanded; the preview updates on collapse.
    expect(
      section.querySelector('.builder-lead-card__notes-count')?.textContent?.trim(),
    ).toBe('3');

    header.click();
    fixture.detectChanges();

    const preview = section.querySelector(
      '.builder-lead-card__notes-preview',
    ) as HTMLElement;
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('They called back — quoting next week.');
    httpMock.verify();
  });
});
