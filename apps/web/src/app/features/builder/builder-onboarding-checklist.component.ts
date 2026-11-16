import { Component, OnInit, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { BuilderOnboardingStatus } from '@feasly/contracts';
import { BUILDER_COPY } from './builder-copy';
import { fill } from './builder-leads-view';
import { BuilderState } from './builder.state';
import {
  DismissOnboardingStep,
  LoadBuilderOnboarding,
  ONBOARDING_STEP_IDS,
  type OnboardingStepId,
} from './builder-onboarding.actions';
import { BuilderChecklistState, BuilderOnboardingState } from './builder-onboarding.state';
import { AGREEMENT_PATH } from './builder-agreement-gate';

/** Server flag behind each step (all computed server-side). */
const STEP_FLAG: Readonly<Record<OnboardingStepId, keyof BuilderOnboardingStatus>> = {
  agreement: 'agreementAccepted',
  profile: 'profileComplete',
  payment: 'paymentMethodSet',
  embed: 'embedVerified',
  team: 'teamInvited',
};

/**
 * Page that completes a step, when the portal has one. Billing and team
 * pages are admin-only (route-guarded), so members get no link there.
 * Business details and the embed have no builder page yet.
 */
const STEP_LINK: Readonly<Record<OnboardingStepId, { path: string; adminOnly: boolean } | null>> = {
  agreement: { path: AGREEMENT_PATH, adminOnly: false },
  profile: null,
  payment: { path: '/builder/billing', adminOnly: true },
  embed: null,
  team: { path: '/builder/team', adminOnly: true },
};

/** Fallback dismissal bucket before the active org id is known. */
const NO_ORG = '_';

interface ChecklistStepView {
  readonly id: OnboardingStepId;
  readonly title: string;
  readonly body: string;
  readonly done: boolean;
  readonly link: { readonly path: string; readonly label: string } | null;
  readonly dismissLabel: string;
}

/**
 * First-run onboarding checklist on the Leads home (#722): accept the
 * agreement, complete business details, add a payment method, install the
 * embed, invite the team. Each step mirrors its server-computed flag,
 * links to the page that completes it where one exists, and can be hidden
 * once done (persisted per org via BuilderChecklistState). The whole card
 * disappears once the server reports `complete`.
 */
@Component({
  selector: 'app-builder-onboarding-checklist',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './builder-onboarding-checklist.component.html',
  styleUrl: './builder-onboarding-checklist.component.scss',
})
export class BuilderOnboardingChecklistComponent implements OnInit {
  private readonly store = inject(Store);
  protected readonly t = inject(BUILDER_COPY).onboarding;

  private readonly onboarding = this.store.selectSignal(BuilderOnboardingState.onboarding);
  private readonly dismissedByOrg = this.store.selectSignal(BuilderChecklistState.dismissed);
  private readonly orgId = this.store.selectSignal(BuilderState.activeBuilderId);

  private readonly orgKey = computed(() => this.orgId() ?? NO_ORG);

  protected readonly visible = computed(() => {
    const o = this.onboarding();
    return o !== null && !o.complete;
  });

  private readonly allSteps = computed<readonly ChecklistStepView[]>(() => {
    const o = this.onboarding();
    if (!o) return [];
    return ONBOARDING_STEP_IDS.map((id) => {
      const copy = this.t.steps[id];
      const link = STEP_LINK[id];
      const showLink = link !== null && (!link.adminOnly || o.isAdmin) && copy.linkLabel !== '';
      return {
        id,
        title: copy.title,
        body: copy.body,
        done: o[STEP_FLAG[id]] === true,
        link: showLink ? { path: link.path, label: copy.linkLabel } : null,
        dismissLabel: fill(this.t.dismissLabel, { step: copy.title }),
      };
    });
  });

  /** Done steps the builder hid stay hidden; to-do steps always show. */
  protected readonly steps = computed(() => {
    const dismissed = this.dismissedByOrg()[this.orgKey()] ?? [];
    return this.allSteps().filter((s) => !(s.done && dismissed.includes(s.id)));
  });

  protected readonly progress = computed(() => {
    const all = this.allSteps();
    return fill(this.t.progress, { done: all.filter((s) => s.done).length, total: all.length });
  });

  /** Members can't finish admin-only steps — say who does. */
  protected readonly showAdminNote = computed(() => {
    const o = this.onboarding();
    return !!o && !o.isAdmin && (!o.agreementAccepted || !o.paymentMethodSet || !o.teamInvited);
  });

  ngOnInit(): void {
    this.store.dispatch(new LoadBuilderOnboarding());
  }

  protected dismiss(step: ChecklistStepView): void {
    if (!step.done) return;
    this.store.dispatch(new DismissOnboardingStep(this.orgKey(), step.id));
  }
}
