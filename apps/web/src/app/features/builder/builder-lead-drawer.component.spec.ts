/**
 * Builder lead drawer (#528): contact actions, status stepper with
 * one-tap moves that apply immediately with an Undo toast, Won → record
 * contract panel, Lost → reason (saved to notes), activity, and the notes
 * thread with its composer pinned in the drawer footer.
 */
import { InteractivityChecker } from '@angular/cdk/a11y';
import { DIALOG_DATA } from '@angular/cdk/dialog';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuilderLeadListItem, BuilderLeadListResponse, Comment } from '@feasly/contracts';
import { UiDrawerService, UiToastService, type UiToastOptions } from '@app/shared/ui';
import { BuilderLeadDrawerComponent } from './builder-lead-drawer.component';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderState } from './builder.state';
import { BuilderLeadsApiService } from './builder-leads-api.service';
import { BuilderCommentsApiService } from './builder-comments-api.service';
import { LoadBuilderLeads } from './builder.actions';

const COPY = DEFAULT_BUILDER_COPY;
const T = COPY.leadDrawer;

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

function comment(body: string): Comment {
  return {
    id: `c-${body.length}`,
    entityType: 'lead',
    entityId: 'lead-a',
    authorKind: 'builder',
    authorId: 'owner@builder.ca',
    authorDisplayName: 'Owner',
    visibility: 'org',
    body,
    createdAt: '2026-11-15T10:00:00.000Z',
    updatedAt: '2026-11-15T10:00:00.000Z',
    edited: false,
    deletedAt: null,
  };
}

interface SetupOptions {
  readonly lead?: Partial<BuilderLeadListItem>;
  readonly patch?: Subject<{ ok: true }>;
  readonly role?: 'builder_admin' | 'builder_member';
  readonly postFails?: boolean;
}

function configure(options: SetupOptions = {}) {
  let current: BuilderLeadListItem = { ...BASE, ...options.lead };
  const leadsApi = {
    listLeads: vi.fn(() => of(listOf(current))),
    needsYou: vi.fn(() =>
      of({ uncontacted: [], stale: [], wonWithoutContract: [], staleAfterDays: 7, counts: listOf(current).summary }),
    ),
    updateStatus: vi.fn((_id: string, status: BuilderLeadListItem['status']) => {
      // The quiet refresh after a confirmed write reads the server's new status.
      current = { ...current, status };
      return options.patch ? options.patch.asObservable() : of({ ok: true as const });
    }),
  };
  const commentsApi = {
    listComments: vi.fn(() => of({ comments: [] })),
    postComment: vi.fn((_lead: string, body: string) =>
      options.postFails ? throwError(() => ({ code: 'http_500' })) : of(comment(body)),
    ),
    editComment: vi.fn(),
  };
  const toasts = {
    show: vi.fn((_options: UiToastOptions) => ({ id: 1, dismissed: of('manual' as const), dismiss: vi.fn() })),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: BUILDER_COPY, useValue: COPY },
      { provide: DIALOG_DATA, useValue: { leadId: current.id } },
      provideRouter([{ path: '**', children: [] }]),
      provideLocationMocks(),
      provideStore([BuilderState]),
      { provide: BuilderLeadsApiService, useValue: leadsApi },
      { provide: BuilderCommentsApiService, useValue: commentsApi },
      { provide: UiToastService, useValue: toasts },
      // jsdom has no layout: let the CDK focus trap treat everything as focusable.
      {
        provide: InteractivityChecker,
        useValue: { isFocusable: () => true, isTabbable: () => true, isVisible: () => true, isDisabled: () => false },
      },
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
  store.dispatch(new LoadBuilderLeads());
  return { leadsApi, commentsApi, toasts, store };
}

async function setup(options: SetupOptions = {}) {
  const deps = configure(options);
  const fixture = TestBed.createComponent(BuilderLeadDrawerComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  return { ...deps, fixture, el: fixture.nativeElement as HTMLElement };
}

/** Poll (with a deadline) for an async UI state — never a fixed sleep. */
async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    TestBed.tick();
  }
}

const move = (el: HTMLElement, status: string) =>
  el.querySelector(`[data-testid="drawer-move"][data-status="${status}"]`) as HTMLButtonElement;
const moves = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="drawer-move"]')) as HTMLButtonElement[];

afterEach(() => {
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

describe('BuilderLeadDrawerComponent (#528)', () => {
  it('renders the drawer chrome: name, status + heat chips, arrived meta, contact actions', async () => {
    const { el } = await setup();
    expect(el.querySelector('.ui-drawer__title')?.textContent?.trim()).toBe('Jane Homeowner');
    const chips = Array.from(el.querySelectorAll('.ui-drawer__sub ui-status-chip')).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['New', 'Warm · 70']);
    expect(el.querySelector('[data-testid="drawer-arrived"]')?.textContent).toContain('Arrived Nov 12, 2026');
    expect(el.querySelector('[data-testid="drawer-call"]')?.getAttribute('href')).toBe('tel:4035550101');
    expect(el.querySelector('[data-testid="drawer-email"]')?.getAttribute('href')).toBe('mailto:jane@example.com');
    expect(el.textContent).toContain('Renovation');
  });

  it('shows the stepper at the current status and one move button per status', async () => {
    const { el } = await setup({ lead: { status: 'quoted' } });
    const current = el.querySelector('ui-stepper [aria-current="step"]');
    expect(current?.textContent).toContain('Quoted');
    expect(moves(el).map((b) => b.textContent?.trim())).toEqual(['New', 'Contacted', 'Quoted', 'Won', 'Lost']);
    expect(move(el, 'quoted').getAttribute('aria-pressed')).toBe('true');
    expect(move(el, 'won').getAttribute('aria-pressed')).toBe('false');
  });

  it('a move applies immediately and the toast offers Undo (AC2)', async () => {
    const { el, leadsApi, toasts } = await setup();
    move(el, 'contacted').click();
    await until(() => toasts.show.mock.calls.length === 1, 'status toast');
    expect(leadsApi.updateStatus).toHaveBeenCalledWith('lead-a', 'contacted');
    const toast = toasts.show.mock.calls[0][0];
    expect(toast.message).toBe('Marked Contacted');
    expect(toast.undoLabel).toBe(T.undoLabel);
    await until(() => move(el, 'contacted').getAttribute('aria-pressed') === 'true', 'chip follows');
    expect(el.querySelector('.ui-drawer__sub ui-status-chip')?.textContent?.trim()).toBe('Contacted');

    toast.undo?.();
    await until(() => toasts.show.mock.calls.length === 2, 'undo toast');
    expect(leadsApi.updateStatus).toHaveBeenLastCalledWith('lead-a', 'new');
    expect(toasts.show.mock.calls[1][0].message).toBe('Moved back to New');
    expect(toasts.show.mock.calls[1][0].undo).toBeUndefined();
    await until(() => move(el, 'new').getAttribute('aria-pressed') === 'true', 'status restored');
  });

  it('disables the moves while a write is in flight; clicking the current status is a no-op', async () => {
    const patch = new Subject<{ ok: true }>();
    const { el, leadsApi } = await setup({ patch });
    move(el, 'new').click();
    expect(leadsApi.updateStatus).not.toHaveBeenCalled();

    move(el, 'quoted').click();
    TestBed.tick();
    expect(moves(el).every((b) => b.disabled)).toBe(true);
    patch.next({ ok: true });
    patch.complete();
    await until(() => moves(el).every((b) => !b.disabled), 'moves re-enabled');
  });

  it('a failed move shows the honest error inline and no toast', async () => {
    const patch = new Subject<{ ok: true }>();
    const { el, toasts } = await setup({ patch });
    move(el, 'lost').click();
    patch.error({ code: 'FORBIDDEN' });
    await until(() => !!el.querySelector('[role="alert"]'), 'error shown');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(COPY.updateForbidden);
    expect(toasts.show).not.toHaveBeenCalled();
    expect(move(el, 'new').getAttribute('aria-pressed')).toBe('true');
  });

  it('does not show an update error this drawer did not cause', async () => {
    const { el, fixture, store } = await setup();
    const snapshot = store.snapshot();
    store.reset({ ...snapshot, builder: { ...snapshot.builder, updateError: 'failed' } });
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('Won without a contract: record-contract panel with the CTA for admins', async () => {
    const { el } = await setup({ lead: { status: 'won', needsRecording: true } });
    const panel = el.querySelector('[data-testid="drawer-won-panel"]')!;
    expect(panel.textContent).toContain(T.wonPanelHeading);
    expect(panel.querySelector('[data-testid="drawer-record"]')?.getAttribute('href')).toBe(
      '/builder/record-contract?lead=lead-a',
    );
  });

  it('Won without a contract, member: the admin note instead of the CTA', async () => {
    const { el } = await setup({ lead: { status: 'won', needsRecording: true }, role: 'builder_member' });
    const panel = el.querySelector('[data-testid="drawer-won-panel"]')!;
    expect(panel.querySelector('[data-testid="drawer-record"]')).toBeNull();
    expect(panel.textContent).toContain(COPY.leadsHome.recordContractMemberNote);
  });

  it('a move to Won opens the record-contract panel', async () => {
    const { el } = await setup({ lead: { status: 'quoted' } });
    expect(el.querySelector('[data-testid="drawer-won-panel"]')).toBeNull();
    move(el, 'won').click();
    await until(() => !!el.querySelector('[data-testid="drawer-won-panel"]'), 'won panel');
  });

  it('locks the status for a recorded contract and links the invoice (#474)', async () => {
    const { el } = await setup({
      lead: {
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
      },
    });
    expect(moves(el)).toHaveLength(0);
    expect(el.textContent).toContain(COPY.leadsStatusLocked);
    expect(el.querySelector('[data-testid="drawer-won-panel"]')).toBeNull();
    const link = el.querySelector('[data-testid="drawer-recorded"] a') as HTMLAnchorElement;
    expect(link.textContent).toContain('INV-0042');
    expect(link.getAttribute('href')).toBe('/builder/invoices?invoice=inv-1');
  });

  it('keeps the moves for a non-won lead carrying an invoice (#474)', async () => {
    const { el } = await setup({ lead: { status: 'contacted', hasInvoice: true } });
    expect(moves(el)).toHaveLength(5);
  });

  it('Lost: asks for a reason and saves it to the notes thread', async () => {
    const { el, commentsApi } = await setup({ lead: { status: 'lost' } });
    const panel = el.querySelector('[data-testid="drawer-lost-panel"]')!;
    expect(panel.textContent).toContain(T.lostPanelHeading);
    const save = panel.querySelector('[data-testid="drawer-lost-save"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const select = panel.querySelector('select') as HTMLSelectElement;
    select.value = 'Over budget';
    select.dispatchEvent(new Event('change'));
    TestBed.tick();
    expect(save.disabled).toBe(false);
    save.click();
    await until(() => !!el.querySelector('[data-testid="drawer-lost-saved"]'), 'reason saved');
    expect(commentsApi.postComment).toHaveBeenCalledWith('lead-a', 'Lost reason: Over budget');
    expect(el.querySelector('app-builder-lead-comments')?.textContent).toContain('Lost reason: Over budget');
  });

  it('lists activity from the lead: arrival and the latest status change', async () => {
    const { el } = await setup({ lead: { status: 'contacted' } });
    const activity = el.querySelector('[data-testid="drawer-activity"]')!;
    expect(activity.textContent).toContain(T.activityArrived);
    expect(activity.textContent).toContain('Marked Contacted');
  });

  it('a new lead shows only its arrival in the activity', async () => {
    const { el } = await setup();
    const activity = el.querySelector('[data-testid="drawer-activity"]')!;
    expect(activity.textContent).toContain(T.activityArrived);
    expect(activity.textContent).not.toContain('Marked');
  });

  it('pins the notes composer in the drawer footer and hides the inline one (AC3)', async () => {
    const { el, commentsApi } = await setup();
    const composer = el.querySelector('.ui-drawer__footer [data-testid="drawer-composer"]');
    expect(composer).not.toBeNull();
    expect(el.querySelector('.ui-drawer__body .comment-thread__composer')).toBeNull();

    const post = el.querySelector('[data-testid="drawer-post"]') as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    const textarea = composer!.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Called, left a voicemail';
    textarea.dispatchEvent(new Event('input'));
    TestBed.tick();
    expect(post.disabled).toBe(false);
    post.click();
    await until(() => textarea.value === '', 'draft cleared');
    expect(commentsApi.postComment).toHaveBeenCalledWith('lead-a', 'Called, left a voicemail');
    expect(el.querySelector('app-builder-lead-comments')?.textContent).toContain('Called, left a voicemail');
  });

  it('keeps the draft when the post fails', async () => {
    const { el } = await setup({ postFails: true });
    const textarea = el.querySelector('[data-testid="drawer-composer"] textarea') as HTMLTextAreaElement;
    textarea.value = 'Draft note';
    textarea.dispatchEvent(new Event('input'));
    TestBed.tick();
    (el.querySelector('[data-testid="drawer-post"]') as HTMLButtonElement).click();
    await until(() => el.textContent?.includes(COPY.commentsPostFailed) ?? false, 'error shown');
    expect(textarea.value).toBe('Draft note');
  });

  it('opened in the kit drawer: an unsaved note makes Esc ask first (AC1)', async () => {
    configure();
    const router = TestBed.inject(Router);
    router.initialNavigation();
    await router.navigateByUrl('/builder');
    const drawers = TestBed.inject(UiDrawerService);
    const ref = drawers.open(BuilderLeadDrawerComponent, { data: { leadId: 'lead-a' }, urlId: 'lead-a', size: 'lg', discardConfirm: { title: T.discardTitle } });
    await until(() => !!document.querySelector('.ui-drawer textarea'), 'drawer rendered');
    expect(router.url).toBe('/builder?open=lead-a');
    expect(document.activeElement?.classList).toContain('ui-drawer__title');

    const textarea = document.querySelector('.ui-drawer textarea') as HTMLTextAreaElement;
    textarea.value = 'Half-written';
    textarea.dispatchEvent(new Event('input'));
    await until(() => ref.dirty(), 'drawer dirty');

    document
      .querySelector('.ui-drawer')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => document.body.textContent?.includes(T.discardTitle) ?? false, 'discard question');
    ref.close();
  });
});
