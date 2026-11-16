/**
 * Leads unread badge state (#864, #725 AC6): last Leads visit per org,
 * unread = leads created after it; 0 before the first visit.
 */
import { TestBed } from '@angular/core/testing';
import { Store, provideStore } from '@ngxs/store';
import { describe, expect, it } from 'vitest';
import type { BuilderLeadListItem } from '@feasly/contracts';
import {
  BuilderLeadsSeenState,
  MarkBuilderLeadsSeen,
  countUnread,
} from './builder-leads-seen.state';
import { BuilderState } from './builder.state';
import type { BuilderSessionIdentity } from './builder-auth.contracts';

const lead = (id: string, createdAt: string) =>
  ({ id, createdAt }) as unknown as BuilderLeadListItem;

const SESSION: BuilderSessionIdentity = {
  authenticated: true,
  email: 'b@example.com',
  name: null,
  builderId: 'org-1',
  builderName: 'Acme',
  role: 'builder_member',
  memberships: [],
  viewAs: null,
  viewAsDisplayName: null,
  realEmail: null,
};

function setup(): Store {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideStore([BuilderState, BuilderLeadsSeenState])],
  });
  const store = TestBed.inject(Store);
  store.reset({
    ...store.snapshot(),
    builder: {
      ...store.snapshot().builder,
      session: SESSION,
      leads: [
        lead('a', '2026-11-10T10:00:00Z'),
        lead('b', '2026-11-15T10:00:00Z'),
        lead('c', '2026-11-16T10:00:00Z'),
      ],
    },
  });
  return store;
}

describe('countUnread', () => {
  const leads = [lead('a', '2026-11-10T10:00:00Z'), lead('b', '2026-11-16T10:00:00Z')];

  it('is 0 before the first visit', () => {
    expect(countUnread(leads, undefined)).toBe(0);
  });

  it('counts leads created strictly after the last visit', () => {
    expect(countUnread(leads, '2026-11-10T10:00:00Z')).toBe(1);
    expect(countUnread(leads, '2026-11-01T00:00:00Z')).toBe(2);
    expect(countUnread(leads, '2026-11-16T10:00:00Z')).toBe(0);
  });

  it('ignores an unreadable timestamp', () => {
    expect(countUnread(leads, 'nope')).toBe(0);
  });
});

describe('BuilderLeadsSeenState', () => {
  it('shows 0 until Leads was visited, then counts newer leads for the active org', () => {
    const store = setup();
    expect(store.selectSnapshot(BuilderLeadsSeenState.unreadCount)).toBe(0);
    store.dispatch(new MarkBuilderLeadsSeen('org-1', '2026-11-12T00:00:00Z'));
    expect(store.selectSnapshot(BuilderLeadsSeenState.unreadCount)).toBe(2);
    // Another org's visit doesn't affect this org.
    store.dispatch(new MarkBuilderLeadsSeen('org-2', '2026-11-20T00:00:00Z'));
    expect(store.selectSnapshot(BuilderLeadsSeenState.unreadCount)).toBe(2);
  });

  it('clears on visit', () => {
    const store = setup();
    store.dispatch(new MarkBuilderLeadsSeen('org-1', '2026-11-12T00:00:00Z'));
    store.dispatch(new MarkBuilderLeadsSeen('org-1', '2026-11-16T12:00:00Z'));
    expect(store.selectSnapshot(BuilderLeadsSeenState.unreadCount)).toBe(0);
  });

  it('never moves the last visit backwards', () => {
    const store = setup();
    store.dispatch(new MarkBuilderLeadsSeen('org-1', '2026-11-16T12:00:00Z'));
    store.dispatch(new MarkBuilderLeadsSeen('org-1', '2026-11-01T00:00:00Z'));
    expect(store.selectSnapshot(BuilderLeadsSeenState.lastSeenAt)['org-1']).toBe(
      '2026-11-16T12:00:00Z',
    );
  });
});
