/**
 * Lead quick view (#527): the modal a pipeline row opens. Carries the old
 * lead card's status change (staged + Apply), the #474 lock, the won /
 * recorded links and the notes thread.
 */
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { BuilderLeadListItem, BuilderLeadListResponse } from '@feasly/contracts';
import { BuilderLeadPanelComponent } from './builder-lead-panel.component';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderState } from './builder.state';
import { BuilderLeadsApiService } from './builder-leads-api.service';
import { BuilderCommentsApiService } from './builder-comments-api.service';
import { LoadBuilderLeads } from './builder.actions';

const COPY = DEFAULT_BUILDER_COPY;

const BASE: BuilderLeadListItem = {
  id: 'lead-a',
  name: 'Jane Homeowner',
  email: 'jane@example.com',
  phone: '(403) 555-0101',
  timeline: '0–3 months',
  leadScore: 70,
  status: 'new',
  statusUpdatedAt: '2026-11-14T10:00:00.000Z',
  addressKey: '3415 19 St SW',
  projectType: 'renovation',
  createdAt: '2026-11-12T10:00:00.000Z',
  hasInvoice: false,
  invoiceSummary: null,
  commentCount: 0,
  latestComment: null,
  needsRecording: false,
};

function listOf(lead: BuilderLeadListItem): BuilderLeadListResponse {
  return {
    leads: [lead],
    summary: { total: 1, new: 0, contacted: 0, quoted: 0, won: 0, lost: 0, needsRecording: 0, [lead.status]: 1 },
  };
}

async function setup(
  lead: Partial<BuilderLeadListItem> = {},
  patch?: Subject<{ ok: true }>,
  role: 'builder_admin' | 'builder_member' = 'builder_admin',
) {
  let current: BuilderLeadListItem = { ...BASE, ...lead };
  const leadsApi = {
    listLeads: vi.fn(() => of(listOf(current))),
    needsYou: vi.fn(() => of({ uncontacted: [], stale: [], wonWithoutContract: [], staleAfterDays: 7, counts: listOf(current).summary })),
    updateStatus: vi.fn((_id: string, status: BuilderLeadListItem['status']) => {
      // The quiet refresh after a confirmed write reads the server's new status.
      current = { ...current, status };
      return patch ? patch.asObservable() : of({ ok: true as const });
    }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [BuilderLeadPanelComponent],
    providers: [
      { provide: BUILDER_COPY, useValue: COPY },
      { provide: DIALOG_DATA, useValue: { leadId: current.id } },
      { provide: DialogRef, useValue: { close: vi.fn() } },
      provideRouter([]),
      provideStore([BuilderState]),
      { provide: BuilderLeadsApiService, useValue: leadsApi },
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
        role,
        memberships: [],
        viewAs: null,
        viewAsDisplayName: null,
      },
    },
  });
  store.dispatch(new LoadBuilderLeads());
  const fixture = TestBed.createComponent(BuilderLeadPanelComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, leadsApi, store };
}

const select = (el: HTMLElement) => el.querySelector('[data-testid="panel-status-select"] select') as HTMLSelectElement;
const apply = (el: HTMLElement) => el.querySelector('[data-testid="panel-status-apply"]') as HTMLButtonElement;

describe('BuilderLeadPanelComponent (#527)', () => {
  it('shows the name, chips, contact links and humanised details', async () => {
    const { el } = await setup();
    expect(el.querySelector('.ui-modal__title')?.textContent?.trim()).toBe('Jane Homeowner');
    const chips = Array.from(el.querySelectorAll('.lead-panel__chips ui-status-chip')).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['New', 'Warm · 70']);
    expect(el.querySelector('[data-testid="panel-call"]')?.getAttribute('href')).toBe('tel:4035550101');
    expect(el.querySelector('[data-testid="panel-email"]')?.getAttribute('href')).toBe('mailto:jane@example.com');
    expect(el.textContent).toContain('Renovation');
    expect(el.textContent).toContain('Nov 12, 2026');
  });

  it('stages a status pick without saving; Apply PATCHes and the pick clears', async () => {
    const patch = new Subject<{ ok: true }>();
    const { el, fixture, leadsApi } = await setup({}, patch);
    expect(select(el).value).toBe('new');
    expect(apply(el).disabled).toBe(true);

    select(el).value = 'contacted';
    select(el).dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(leadsApi.updateStatus).not.toHaveBeenCalled();
    expect(apply(el).disabled).toBe(false);

    apply(el).click();
    fixture.detectChanges();
    expect(leadsApi.updateStatus).toHaveBeenCalledWith('lead-a', 'contacted');
    expect(select(el).disabled).toBe(true);

    patch.next({ ok: true });
    patch.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    // Confirmed transition applied locally; chip follows.
    expect(el.querySelector('.lead-panel__chips ui-status-chip')?.textContent?.trim()).toBe('Contacted');
    expect(apply(el).disabled).toBe(true);
  });

  it('shows the honest 403 copy when the update is forbidden', async () => {
    const patch = new Subject<{ ok: true }>();
    const { el, fixture } = await setup({}, patch);
    select(el).value = 'lost';
    select(el).dispatchEvent(new Event('change'));
    fixture.detectChanges();
    apply(el).click();
    patch.error({ code: 'FORBIDDEN' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(COPY.updateForbidden);
    expect(select(el).value).toBe('new');
  });

  it('won without a contract: keeps the status control and links to record it', async () => {
    const { el } = await setup({ status: 'won', needsRecording: true });
    expect(select(el)).not.toBeNull();
    const record = el.querySelector('[data-testid="panel-record"] a') as HTMLAnchorElement;
    expect(record.getAttribute('href')).toBe('/builder/record-contract?lead=lead-a');
  });

  it('won without a contract, member: no record link, shows the admin note', async () => {
    const { el } = await setup({ status: 'won', needsRecording: true }, undefined, 'builder_member');
    const record = el.querySelector('[data-testid="panel-record"]') as HTMLElement;
    expect(record.querySelector('a')).toBeNull();
    expect(record.textContent).toContain(COPY.leadsHome.recordContractMemberNote);
  });

  it('does not show an update error this panel did not cause', async () => {
    const { el, fixture, store } = await setup();
    const snapshot = store.snapshot();
    store.reset({ ...snapshot, builder: { ...snapshot.builder, updateError: 'failed' } });
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('locks the status for a recorded contract and links the invoice (#474)', async () => {
    const { el } = await setup({
      status: 'won',
      hasInvoice: true,
      invoiceSummary: {
        id: 'inv-1',
        invoiceNumber: 'INV-0042',
        contractValueCents: 65000000,
        commissionCents: 650000,
        status: 'in_review',
        reviewDueAt: null,
        paymentMethod: 'card',
      },
    });
    expect(select(el)).toBeNull();
    expect(apply(el)).toBeNull();
    expect(el.textContent).toContain(COPY.leadsStatusLocked);
    const link = el.querySelector('[data-testid="panel-recorded"] a') as HTMLAnchorElement;
    expect(link.textContent).toContain('INV-0042');
    expect(link.getAttribute('href')).toBe('/builder/invoices?invoice=inv-1');
  });

  it('keeps the status control for a non-won lead carrying an invoice (#474)', async () => {
    const { el } = await setup({ status: 'contacted', hasInvoice: true });
    expect(select(el)).not.toBeNull();
  });

  it('renders the notes thread for the lead', async () => {
    const { el } = await setup();
    expect(el.querySelector('app-builder-lead-comments')).not.toBeNull();
  });
});
