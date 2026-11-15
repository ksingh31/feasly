/**
 * Builder Leads home tests (#527).
 *
 * Verifies: the "Needs you" groups (cards, heat pill, age, tel:/mailto:,
 * Record contract for admins), the all-clear and error states, the
 * segmented status filter + search living in the URL, stale-row
 * highlighting, the row → lead quick view (`?open=`), and the pipeline
 * loading / empty / error slots.
 */
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideStore, Store } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BuilderLeadListItem,
  BuilderLeadListResponse,
  BuilderLeadNeedsYouItem,
  BuilderLeadsNeedsYouResponse,
} from '@feasly/contracts';
import { BuilderDashboardComponent } from './builder-dashboard.component';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderState } from './builder.state';
import { BuilderLeadsApiService } from './builder-leads-api.service';
import { BuilderBillingState } from './builder-billing.state';
import { BuilderBillingApiService } from './builder-billing-api.service';
import { BuilderInvoicesState } from './builder-invoices.state';
import { BuilderInvoicesApiService } from './builder-invoices-api.service';
import { BuilderCommentsApiService } from './builder-comments-api.service';

const COPY = DEFAULT_BUILDER_COPY;

function lead(overrides: Partial<BuilderLeadListItem>): BuilderLeadListItem {
  return {
    id: 'lead-a',
    name: 'Jane Homeowner',
    email: 'jane@example.com',
    phone: '403-555-0101',
    timeline: '0–3 months',
    leadScore: 92,
    status: 'new',
    statusUpdatedAt: '2026-11-14T10:00:00.000Z',
    addressKey: '3415 19 St SW',
    projectType: 'new_build',
    createdAt: '2026-11-14T10:00:00.000Z',
    hasInvoice: false,
    invoiceSummary: null,
    commentCount: 0,
    latestComment: null,
    needsRecording: false,
    ...overrides,
  };
}

const JANE = lead({});
const BOB = lead({
  id: 'lead-b',
  name: 'Bob Buyer',
  email: 'bob@example.com',
  phone: null,
  leadScore: 70,
  status: 'contacted',
  statusUpdatedAt: '2026-11-01T10:00:00.000Z',
  addressKey: '88 Elbow Dr SW',
});
const MOE = lead({
  id: 'lead-c',
  name: 'Moe Chan',
  email: 'moe@example.com',
  leadScore: 40,
  status: 'won',
  needsRecording: true,
  statusUpdatedAt: '2026-11-10T10:00:00.000Z',
  addressKey: '9 Crescent Rd NW',
});

const LIST: BuilderLeadListResponse = {
  leads: [JANE, BOB, MOE],
  summary: { total: 3, new: 1, contacted: 1, quoted: 0, won: 1, lost: 0, needsRecording: 1 },
};

function item(l: BuilderLeadListItem, waitingSince = l.statusUpdatedAt): BuilderLeadNeedsYouItem {
  return {
    id: l.id,
    name: l.name,
    email: l.email,
    phone: l.phone,
    timeline: l.timeline,
    leadScore: l.leadScore,
    status: l.status,
    addressKey: l.addressKey,
    createdAt: l.createdAt,
    statusChangedAt: l.statusUpdatedAt,
    waitingSince,
  };
}

const FEED: BuilderLeadsNeedsYouResponse = {
  uncontacted: [item(JANE)],
  stale: [item(BOB)],
  wonWithoutContract: [item(MOE)],
  staleAfterDays: 7,
  counts: { total: 3, new: 1, contacted: 1, quoted: 0, won: 1, lost: 0 },
};

const EMPTY_FEED: BuilderLeadsNeedsYouResponse = {
  ...FEED,
  uncontacted: [],
  stale: [],
  wonWithoutContract: [],
};

@Component({ standalone: true, template: '' })
class BlankComponent {}

interface SetupOptions {
  readonly url?: string;
  readonly list?: BuilderLeadListResponse | 'error' | 'pending';
  readonly feed?: BuilderLeadsNeedsYouResponse | 'error';
  readonly role?: 'builder_admin' | 'builder_member';
}

async function setup(options: SetupOptions = {}) {
  const list = options.list ?? LIST;
  const feed = options.feed ?? FEED;
  const pending = new Subject<BuilderLeadListResponse>();
  const leadsApi = {
    listLeads: vi.fn(() => {
      if (list === 'pending') return pending.asObservable();
      if (list === 'error') return throwError(() => new Error('down'));
      return of(list);
    }),
    needsYou: vi.fn(() =>
      feed === 'error' ? throwError(() => new Error('down')) : of(feed),
    ),
    updateStatus: vi.fn(() => of({ ok: true as const })),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: BUILDER_COPY, useValue: COPY },
      provideRouter([
        { path: 'builder', component: BuilderDashboardComponent },
        { path: 'builder/record-contract', component: BlankComponent },
        { path: 'builder/invoices', component: BlankComponent },
      ]),
      provideStore([BuilderState, BuilderBillingState, BuilderInvoicesState]),
      { provide: BuilderLeadsApiService, useValue: leadsApi },
      {
        provide: BuilderInvoicesApiService,
        useValue: { listInvoices: () => of({ invoices: [], total: 0, page: 1, pageSize: 20 }) },
      },
      { provide: BuilderBillingApiService, useValue: { getCard: () => of({ hasCard: false }) } },
      { provide: BuilderCommentsApiService, useValue: { listComments: () => of({ comments: [] }) } },
    ],
  });

  const store = TestBed.inject(Store);
  const snapshot = store.snapshot();
  store.reset({
    ...snapshot,
    builder: {
      ...snapshot.builder,
      session: {
        authenticated: true,
        email: 'owner@builder.ca',
        name: null,
        builderId: 'elite-craft',
        builderName: 'Elite Craft',
        role: options.role ?? 'builder_admin',
        memberships: [],
        viewAs: null,
        viewAsDisplayName: null,
      },
    },
  });

  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(options.url ?? '/builder');
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
  const router = TestBed.inject(Router);
  const el = harness.routeNativeElement as HTMLElement;
  return { harness, el, router, store, leadsApi, pending };
}

async function settle(harness: RouterTestingHarness): Promise<void> {
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

const tableRows = (el: HTMLElement): HTMLTableRowElement[] =>
  Array.from(el.querySelectorAll('tbody tr'));
const rowNames = (el: HTMLElement): string[] =>
  tableRows(el).map((r) => r.querySelector('.lead-cell__name')?.textContent?.trim() ?? '');

afterEach(() => {
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

describe('BuilderDashboardComponent — Leads home (#527)', () => {
  it('loads the pipeline and the needs-you feed on init', async () => {
    const { leadsApi } = await setup();
    expect(leadsApi.listLeads).toHaveBeenCalledTimes(1);
    expect(leadsApi.needsYou).toHaveBeenCalledTimes(1);
  });

  it('renders the due-invoice banners above the page heading', async () => {
    const { el } = await setup();
    const banners = el.querySelector('app-due-invoice-banners')!;
    const heading = el.querySelector('#builder-dashboard-heading')!;
    expect(heading.textContent?.trim()).toBe(COPY.leadsHome.heading);
    expect(banners.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe('Needs you', () => {
    it('renders the three server groups first, each with its cards and count', async () => {
      const { el } = await setup();
      const needs = el.querySelector('[data-testid="needs-you"]')!;
      const pipeline = el.querySelector('[data-testid="pipeline"]')!;
      expect(needs.compareDocumentPosition(pipeline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(needs.querySelector('h2')?.textContent).toContain('3');

      const groups = Array.from(needs.querySelectorAll('.needs-group')) as HTMLElement[];
      expect(groups.map((g) => g.dataset['group'])).toEqual(['uncontacted', 'stale', 'wonWithoutContract']);
      expect(groups[1].querySelector('h3')?.textContent).toContain('No update in 7+ days');
      expect(groups[0].querySelector('.needs-card__name')?.textContent?.trim()).toBe('Jane Homeowner');
    });

    it('shows a heat pill, status chip, details and age on each card', async () => {
      const { el } = await setup();
      const card = el.querySelector('[data-group="uncontacted"] [data-testid="needs-card"]')!;
      const chips = Array.from(card.querySelectorAll('ui-status-chip')).map((c) => c.textContent?.trim());
      expect(chips).toEqual(['Hot · 92', 'New']);
      expect(card.querySelector('.needs-card__meta')?.textContent).toContain('Timeline 0–3 months');
      expect(card.querySelector('.needs-card__meta')?.textContent).toContain('3415 19 St SW');
      const age = card.querySelector('.needs-card__age')!;
      expect(age.textContent).toContain('Arrived');
      expect(age.querySelector('time')?.getAttribute('datetime')).toBe(JANE.statusUpdatedAt);
    });

    it('Call / Email are tel: / mailto: links with accessible names (AC2)', async () => {
      const { el } = await setup();
      const jane = el.querySelector('[data-group="uncontacted"] [data-testid="needs-card"]')!;
      const call = jane.querySelector('[data-testid="needs-call"]') as HTMLAnchorElement;
      const email = jane.querySelector('[data-testid="needs-email"]') as HTMLAnchorElement;
      expect(call.getAttribute('href')).toBe('tel:4035550101');
      expect(call.getAttribute('aria-label')).toBe('Call Jane Homeowner');
      expect(call.classList).toContain('contact-link');
      expect(email.getAttribute('href')).toBe('mailto:jane@example.com');
      expect(email.getAttribute('aria-label')).toBe('Email Jane Homeowner');
      // No phone → no Call link, Email still there.
      const bob = el.querySelector('[data-group="stale"] [data-testid="needs-card"]')!;
      expect(bob.querySelector('[data-testid="needs-call"]')).toBeNull();
      expect(bob.querySelector('[data-testid="needs-email"]')).not.toBeNull();
    });

    it('offers Record contract on won-without-contract cards for admins', async () => {
      const { el } = await setup();
      const won = el.querySelector('[data-group="wonWithoutContract"] [data-testid="needs-card"]')!;
      const record = won.querySelector('[data-testid="needs-record"]') as HTMLAnchorElement;
      expect(record.textContent?.trim()).toBe(COPY.leadsHome.recordContractCta);
      expect(record.getAttribute('href')).toBe('/builder/record-contract?lead=lead-c');
      expect(el.querySelectorAll('[data-testid="needs-record"]')).toHaveLength(1);
    });

    it('tells members an admin records the contract instead', async () => {
      const { el } = await setup({ role: 'builder_member' });
      const won = el.querySelector('[data-group="wonWithoutContract"] [data-testid="needs-card"]')!;
      expect(won.querySelector('[data-testid="needs-record"]')).toBeNull();
      expect(won.textContent).toContain(COPY.leadsHome.recordContractMemberNote);
    });

    it('shows the all-clear state when nothing needs the builder', async () => {
      const { el } = await setup({ feed: EMPTY_FEED });
      const needs = el.querySelector('[data-testid="needs-you"]')!;
      expect(needs.querySelector('ui-empty-state')?.textContent).toContain(COPY.leadsHome.allClearHeading);
      expect(needs.querySelectorAll('[data-testid="needs-card"]')).toHaveLength(0);
    });

    it('keeps the pipeline usable when the feed fails', async () => {
      const { el } = await setup({ feed: 'error' });
      expect(el.querySelector('[data-testid="needs-you"]')?.textContent).toContain(COPY.leadsHome.needsYouError);
      expect(rowNames(el)).toHaveLength(3);
    });

    it('a card name opens the lead quick view', async () => {
      const { el, harness, router } = await setup();
      (el.querySelector('.needs-card__name') as HTMLButtonElement).click();
      await settle(harness);
      expect(router.url).toContain('open=lead-a');
      expect(document.querySelector('app-builder-lead-panel')).not.toBeNull();
    });
  });

  describe('Pipeline', () => {
    it('renders the segmented status filter with counts', async () => {
      const { el } = await setup();
      const segments = Array.from(el.querySelectorAll('[data-testid="status-segment"]')) as HTMLElement[];
      expect(segments.map((s) => s.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
        'All 3',
        'New 1',
        'Contacted 1',
        'Quoted 0',
        'Won 1',
        'Lost 0',
      ]);
      expect(segments[0].getAttribute('aria-pressed')).toBe('true');
    });

    it('defaults to most recent activity first', async () => {
      const { el } = await setup();
      expect(rowNames(el)).toEqual(['Jane Homeowner', 'Moe Chan', 'Bob Buyer']);
    });

    it('a status segment filters rows and writes ?status= to the URL (AC3)', async () => {
      const { el, harness, router } = await setup();
      (el.querySelector('[data-status="won"]') as HTMLButtonElement).click();
      await settle(harness);
      expect(router.url).toContain('status=won');
      expect(rowNames(el)).toEqual(['Moe Chan']);
      expect(el.querySelector('[data-status="won"]')?.getAttribute('aria-pressed')).toBe('true');

      (el.querySelector('[data-status="all"]') as HTMLButtonElement).click();
      await settle(harness);
      expect(router.url).not.toContain('status=');
      expect(rowNames(el)).toHaveLength(3);
    });

    it('restores status + search from the URL on load (AC3)', async () => {
      const { el } = await setup({ url: '/builder?status=contacted&q=elbow' });
      expect(rowNames(el)).toEqual(['Bob Buyer']);
      expect(el.querySelector('[data-status="contacted"]')?.getAttribute('aria-pressed')).toBe('true');
      expect((el.querySelector('ui-filter-bar input') as HTMLInputElement).value).toBe('elbow');
    });

    it('ignores an unknown ?status= value', async () => {
      const { el } = await setup({ url: '/builder?status=bogus' });
      expect(rowNames(el)).toHaveLength(3);
      expect(el.querySelector('[data-status="all"]')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('shows no-results with Clear filters when nothing matches', async () => {
      const { el, harness, router } = await setup({ url: '/builder?q=nobody' });
      const empty = el.querySelector('[data-testid="pipeline"] ui-empty-state')!;
      expect(empty.textContent).toContain(COPY.leadsHome.noResultsHeading);
      (empty.querySelector('button') as HTMLButtonElement).click();
      await settle(harness);
      expect(router.url).not.toContain('q=');
      expect(rowNames(el)).toHaveLength(3);
    });

    it('highlights and labels stale rows from the server feed', async () => {
      const { el } = await setup();
      const rows = tableRows(el);
      const bob = rows.find((r) => r.textContent?.includes('Bob Buyer'))!;
      const jane = rows.find((r) => r.textContent?.includes('Jane Homeowner'))!;
      expect(bob.classList).toContain('ui-dt__row--flagged');
      expect(bob.querySelector('[data-testid="stale-tag"]')?.textContent?.trim()).toBe('Stale');
      expect(jane.classList).not.toContain('ui-dt__row--flagged');
      expect(jane.querySelector('[data-testid="stale-tag"]')).toBeNull();
    });

    it('rows carry heat pills, humanised details and tel:/mailto: actions', async () => {
      const { el } = await setup();
      const jane = tableRows(el)[0];
      expect(jane.querySelector('.lead-cell ui-status-chip')?.textContent?.trim()).toBe('Hot · 92');
      expect(jane.textContent).toContain('Timeline 0–3 months · New build · 3415 19 St SW');
      expect(jane.querySelector('[data-testid="row-call"]')?.getAttribute('href')).toBe('tel:4035550101');
      expect(jane.querySelector('[data-testid="row-email"]')?.getAttribute('href')).toBe('mailto:jane@example.com');
    });

    it('clicking a row opens the quick view via ?open=; closing clears it', async () => {
      const { el, harness, router } = await setup();
      tableRows(el)[0].click();
      await settle(harness);
      expect(router.url).toContain('open=lead-a');
      expect(document.querySelector('app-builder-lead-panel')).not.toBeNull();
      expect(tableRows(el)[0].classList).toContain('ui-dt__row--open');

      (document.querySelector('.ui-modal__close') as HTMLButtonElement).click();
      await settle(harness);
      expect(router.url).not.toContain('open=');
    });

    it('opens the quick view from a deep link and drops an unknown ?open= id', async () => {
      const first = await setup({ url: '/builder?open=lead-b' });
      expect(document.querySelector('app-builder-lead-panel')?.textContent).toContain('Bob Buyer');
      document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());

      const second = await setup({ url: '/builder?open=nope' });
      await settle(second.harness);
      expect(second.router.url).not.toContain('open=');
      expect(first).toBeTruthy();
    });

    it('shows the loading skeleton while the pipeline loads', async () => {
      const { el } = await setup({ list: 'pending' });
      expect(el.querySelector('[data-testid="pipeline"] ui-skeleton')).not.toBeNull();
    });

    it('shows the zero-data state when there are no leads', async () => {
      const { el } = await setup({
        list: { leads: [], summary: { ...LIST.summary, total: 0, new: 0, contacted: 0, won: 0, needsRecording: 0 } },
        feed: EMPTY_FEED,
      });
      const empty = el.querySelector('[data-testid="pipeline"] ui-empty-state')!;
      expect(empty.textContent).toContain(COPY.leadsEmptyHeading);
    });

    it('shows the error state; Retry reloads leads and the feed', async () => {
      const { el, harness, leadsApi } = await setup({ list: 'error' });
      const error = el.querySelector('[data-testid="pipeline"] ui-error-state')!;
      expect(error.textContent).toContain(COPY.leadsErrorHeading);
      (error.querySelector('button') as HTMLButtonElement).click();
      await settle(harness);
      expect(leadsApi.listLeads).toHaveBeenCalledTimes(2);
      expect(leadsApi.needsYou).toHaveBeenCalledTimes(2);
    });
  });

  it('flags a non-won lead carrying an invoice in the console once (#474)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await setup({
      list: { ...LIST, leads: [lead({ hasInvoice: true, status: 'contacted' }), MOE] },
    });
    const calls = warn.mock.calls.filter((c) => String(c[0]).includes('non-won lead has invoice'));
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ leadId: 'lead-a', status: 'contacted' });
    warn.mockRestore();
  });
});
