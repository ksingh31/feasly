import { EnvironmentProviders, Injectable } from '@angular/core';
import { Action, provideStates, Selector, State, StateContext } from '@ngxs/store';
import type { BuilderLeadListItem } from '@feasly/contracts';
import { BuilderState } from './builder.state';

/**
 * Record a visit to Leads for an org: every lead that arrived up to `at`
 * counts as seen. Dispatched by the builder shell on entering and leaving
 * the Leads page.
 */
export class MarkBuilderLeadsSeen {
  static readonly type = '[BuilderLeadsSeen] Mark seen';
  constructor(
    public readonly builderId: string,
    /** ISO-8601 timestamp of the visit. */
    public readonly at: string,
  ) {}
}

export interface BuilderLeadsSeenStateModel {
  /** Last Leads visit per org id (ISO-8601). Opaque ids only — no PII. */
  lastSeenAt: Record<string, string>;
}

/**
 * Leads unread badge (#864, #725 AC6): where "last visit to Leads" lives.
 *
 * Decision (engineering trade-off, noted on the PR): client storage via the
 * NGXS storage plugin, keyed by org id. It needs no API change and holds no
 * PII (org UUID → timestamp). Trade-off: "last visit" is per browser, not
 * per member across devices — a server timestamp would need a new API field
 * and can follow later without changing the badge UI.
 *
 * Before the first ever visit to Leads (no timestamp) the count is 0, so a
 * fresh browser never shows every historical lead as new.
 */
@State<BuilderLeadsSeenStateModel>({
  name: 'builderLeadsSeen',
  defaults: { lastSeenAt: {} },
})
@Injectable()
export class BuilderLeadsSeenState {
  @Selector()
  static lastSeenAt(state: BuilderLeadsSeenStateModel): Record<string, string> {
    return state.lastSeenAt;
  }

  /** Leads for the active org that arrived after its last Leads visit. */
  @Selector([BuilderLeadsSeenState.lastSeenAt, BuilderState.activeBuilderId, BuilderState.leads])
  static unreadCount(
    lastSeenAt: Record<string, string>,
    builderId: string | null,
    leads: readonly BuilderLeadListItem[],
  ): number {
    return countUnread(leads, builderId ? lastSeenAt[builderId] : undefined);
  }

  @Action(MarkBuilderLeadsSeen)
  markSeen(ctx: StateContext<BuilderLeadsSeenStateModel>, action: MarkBuilderLeadsSeen): void {
    const lastSeenAt = ctx.getState().lastSeenAt;
    const previous = lastSeenAt[action.builderId];
    // Never move backwards (clock skew between tabs).
    if (previous && Date.parse(previous) >= Date.parse(action.at)) return;
    ctx.patchState({ lastSeenAt: { ...lastSeenAt, [action.builderId]: action.at } });
  }
}

/**
 * Lazy provider for the `builder` shell route (app.routes.ts) — keeps the
 * state out of the initial bundle. Persisted via the storage-plugin string
 * key 'builderLeadsSeen' in app.config.ts (must match the state name).
 */
export const builderLeadsSeenStateProvider: EnvironmentProviders = provideStates([
  BuilderLeadsSeenState,
]);

/** Leads created strictly after `lastSeen`; 0 when there was no visit yet. */
export function countUnread(
  leads: readonly Pick<BuilderLeadListItem, 'createdAt'>[],
  lastSeen: string | undefined,
): number {
  if (!lastSeen) return 0;
  const since = Date.parse(lastSeen);
  if (Number.isNaN(since)) return 0;
  return leads.filter((lead) => Date.parse(lead.createdAt) > since).length;
}
