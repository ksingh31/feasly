import { Injectable } from '@angular/core';
import { Action, Selector, State, StateContext } from '@ngxs/store';
import type { AnalyticsSource } from '@feasly/contracts';
import type { CapturedCampaignSource } from './campaign-source';

/** Records the session's first-touch campaign attribution (#815). */
export class CaptureCampaignSource {
  static readonly type = '[CampaignSource] Capture';
  constructor(public readonly captured: CapturedCampaignSource) {}
}

export interface CampaignSourceStateModel {
  /** True once the first load of this session was read (first touch wins). */
  captured: boolean;
  source: AnalyticsSource | null;
  referrerHost: string | null;
}

/** The storage-plugin key for this state (mirrors the @State name). */
export const CampaignSourceStateName = 'campaignSource';

/**
 * Session-scoped campaign attribution (#815). Persisted to sessionStorage
 * (storage plugin, explicit engine in app.config.ts) so a reload in the
 * same tab keeps the first-touch source while a new visit starts fresh.
 * Nothing here leaves the browser unless analytics consent is granted —
 * AnalyticsService and the gate submit check consent before attaching it.
 */
@State<CampaignSourceStateModel>({
  name: CampaignSourceStateName,
  defaults: { captured: false, source: null, referrerHost: null },
})
@Injectable()
export class CampaignSourceState {
  @Selector()
  static source(state: CampaignSourceStateModel): AnalyticsSource | null {
    return state.source;
  }

  @Selector()
  static referrerHost(state: CampaignSourceStateModel): string | null {
    return state.referrerHost;
  }

  @Action(CaptureCampaignSource)
  capture(ctx: StateContext<CampaignSourceStateModel>, action: CaptureCampaignSource): void {
    // First touch wins for the session: later loads never overwrite it.
    if (ctx.getState().captured) return;
    ctx.setState({
      captured: true,
      source: action.captured.source,
      referrerHost: action.captured.referrerHost,
    });
  }
}

/**
 * Plain root selector for the session source. Tolerates the state not being
 * registered (feature specs that only provide ConsentState), so analytics
 * can never throw because attribution is missing.
 */
export function selectCampaignSource(root: {
  readonly [CampaignSourceStateName]?: CampaignSourceStateModel;
}): AnalyticsSource | null {
  return root[CampaignSourceStateName]?.source ?? null;
}
