/**
 * Builder onboarding checklist (#722) — GET /api/v1/builder/onboarding.
 *
 * Every flag comes from real state:
 * - `agreementAccepted` — the org accepted the CURRENT agreement version.
 * - `profileComplete` — the builders row has business name, display name,
 *   contact email and contact phone (logo/colour stay optional).
 * - `paymentMethodSet` — commission model: a card on file in Stripe, or a
 *   deliberately chosen manual default method (cheque / e-transfer / bank
 *   draft). Always true under any other billing model (nothing to set up).
 * - `embedVerified` — proxy until #724 adds install verification: a
 *   non-sandbox lead captured through the embed for this builder, or an
 *   `embed_loaded` analytics event with the builder's tenant key.
 * - `teamInvited` — more than one org member, or a pending unexpired
 *   invitation.
 */
import type { BuilderOnboardingStatus } from '@feasly/contracts';
import type { BillingConfig } from '../config';
import type { AuthContext } from './auth-context.service';
import type { BuilderAgreementService } from './builder-agreement.service';
import type { BuilderOnboardingStore } from './builder-agreement.store';
import type { BuilderService } from './builder.service';
import type { CommissionCardService } from './billing/commission-card.service';
import type { CommissionService } from './billing/commission.service';

export interface BuilderOnboardingService {
  getStatus(
    ctx: AuthContext,
    builderId: string,
  ): Promise<BuilderOnboardingStatus>;
}

export interface BuilderOnboardingServiceDeps {
  readonly agreements: BuilderAgreementService;
  readonly store: BuilderOnboardingStore;
  readonly builders: Pick<BuilderService, 'getBuilder'>;
  readonly billing: Pick<BillingConfig, 'model'>;
  readonly commissionCard: Pick<CommissionCardService, 'getCard'>;
  readonly commission: Pick<CommissionService, 'getDefaultPaymentMethod'>;
  readonly clock?: () => Date;
  /** Failure sink for the best-effort Stripe card read. */
  readonly log?: (message: string) => void;
}

function filled(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function createBuilderOnboardingService(
  deps: BuilderOnboardingServiceDeps,
): BuilderOnboardingService {
  const {
    agreements,
    store,
    builders,
    billing,
    commissionCard,
    commission,
    clock = () => new Date(),
    log,
  } = deps;

  async function paymentMethodSet(tenantKey: string): Promise<boolean> {
    // No commission billing → there is no payment method to set up, so the
    // step is satisfied (otherwise the checklist could never complete).
    if (billing.model !== 'commission') return true;
    const defaultMethod = await commission.getDefaultPaymentMethod(tenantKey);
    if (defaultMethod !== 'card') return true;
    try {
      return (await commissionCard.getCard(tenantKey)).hasCard;
    } catch (error) {
      // A Stripe outage must not take the whole checklist down: the step
      // shows as not done and the next load re-checks.
      log?.(
        `onboarding: card lookup failed (${error instanceof Error ? error.name : 'unknown'})`,
      );
      return false;
    }
  }

  return {
    async getStatus(ctx, builderId): Promise<BuilderOnboardingStatus> {
      const builder = await builders.getBuilder(builderId);
      const [agreement, payment, embed, members, pendingInvite] =
        await Promise.all([
          agreements.getStatus(ctx, builderId),
          paymentMethodSet(builder.tenantKey),
          store.hasEmbedSignal(builderId, builder.tenantKey),
          store.countMembers(builderId),
          store.hasPendingInvitation(builderId, clock()),
        ]);
      const profileComplete =
        filled(builder.businessName) &&
        filled(builder.displayName) &&
        filled(builder.email) &&
        filled(builder.phone);
      const teamInvited = members > 1 || pendingInvite;
      const flags = {
        agreementAccepted: agreement.current,
        profileComplete,
        paymentMethodSet: payment,
        embedVerified: embed,
        teamInvited,
      };
      return {
        ...flags,
        complete: Object.values(flags).every(Boolean),
        isAdmin: agreements.isOrgAdmin(ctx, builderId),
        agreement,
      };
    },
  };
}
