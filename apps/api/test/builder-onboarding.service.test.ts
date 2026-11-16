/**
 * Builder onboarding checklist service (#722) — every dependency faked at
 * its interface. Each flag must follow real state.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgreementStatus, Builder } from '@feasly/contracts';
import { createBuilderOnboardingService } from '../src/services/builder-onboarding.service';
import type { BuilderAgreementService } from '../src/services/builder-agreement.service';
import type { BuilderOnboardingStore } from '../src/services/builder-agreement.store';
import type { AuthContext } from '../src/services/auth-context.service';

const BUILDER_ID = '11111111-1111-4111-8111-111111111111';
const CTX = { userId: 'u-1' } as unknown as AuthContext;

function builder(overrides: Partial<Builder> = {}): Builder {
  return {
    id: BUILDER_ID,
    tenantKey: 'elite-craft',
    businessName: 'Elite Craft Builders Ltd.',
    displayName: 'Elite Craft',
    email: 'hello@elite.example',
    phone: '403-555-0100',
    logoUrl: null,
    accentColor: null,
    allowedOrigins: [],
    plan: 'commission',
    status: 'active',
    settings: {},
    commissionRatePercent: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function make(opts: {
  builder?: Builder;
  accepted?: boolean;
  isAdmin?: boolean;
  model?: 'commission' | 'flat';
  defaultMethod?: 'card' | 'cheque';
  hasCard?: boolean;
  cardThrows?: boolean;
  embed?: boolean;
  members?: number;
  pendingInvite?: boolean;
} = {}) {
  const agreement = {
    version: 'v1',
    current: opts.accepted ?? false,
  } as AgreementStatus;
  const agreements = {
    getStatus: vi.fn(async () => agreement),
    isOrgAdmin: vi.fn(() => opts.isAdmin ?? true),
  } as unknown as BuilderAgreementService;
  const store: BuilderOnboardingStore = {
    countMembers: vi.fn(async () => opts.members ?? 1),
    hasPendingInvitation: vi.fn(async () => opts.pendingInvite ?? false),
    hasEmbedSignal: vi.fn(async () => opts.embed ?? false),
  };
  const getCard = vi.fn(async () => {
    if (opts.cardThrows) throw new Error('stripe down');
    return { hasCard: opts.hasCard ?? false };
  });
  const log = vi.fn();
  const service = createBuilderOnboardingService({
    agreements,
    store,
    builders: { getBuilder: vi.fn(async () => opts.builder ?? builder()) },
    billing: { model: opts.model ?? 'commission' },
    commissionCard: { getCard },
    commission: {
      getDefaultPaymentMethod: vi.fn(async () => opts.defaultMethod ?? 'card'),
    },
    log,
  });
  return { service, store, getCard, log, agreement };
}

describe('builder onboarding service (#722)', () => {
  it('a fresh org: only the profile step is done', async () => {
    const { service, agreement, store } = make();
    const status = await service.getStatus(CTX, BUILDER_ID);
    expect(status).toEqual({
      agreementAccepted: false,
      profileComplete: true,
      paymentMethodSet: false,
      embedVerified: false,
      teamInvited: false,
      complete: false,
      isAdmin: true,
      agreement,
    });
    expect(store.hasEmbedSignal).toHaveBeenCalledWith(BUILDER_ID, 'elite-craft');
  });

  it('every step done → complete', async () => {
    const { service } = make({
      accepted: true,
      hasCard: true,
      embed: true,
      members: 2,
    });
    const status = await service.getStatus(CTX, BUILDER_ID);
    expect(status.complete).toBe(true);
  });

  it('profile incomplete when contact email or phone is missing/blank', async () => {
    for (const b of [builder({ email: null }), builder({ phone: '  ' })]) {
      const { service } = make({ builder: b });
      expect((await service.getStatus(CTX, BUILDER_ID)).profileComplete).toBe(false);
    }
  });

  it('payment: card on file, or a chosen manual method; satisfied under flat (nothing to set up)', async () => {
    expect(
      (await make({ hasCard: true }).service.getStatus(CTX, BUILDER_ID)).paymentMethodSet,
    ).toBe(true);
    const manual = make({ defaultMethod: 'cheque' });
    expect((await manual.service.getStatus(CTX, BUILDER_ID)).paymentMethodSet).toBe(true);
    expect(manual.getCard).not.toHaveBeenCalled();
    const flat = make({ model: 'flat', hasCard: true });
    expect((await flat.service.getStatus(CTX, BUILDER_ID)).paymentMethodSet).toBe(true);
  });

  it('a Stripe failure shows the payment step as not done instead of failing', async () => {
    const { service, log } = make({ cardThrows: true });
    expect((await service.getStatus(CTX, BUILDER_ID)).paymentMethodSet).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('team invited: more than one member, or a pending invitation', async () => {
    expect((await make({ members: 2 }).service.getStatus(CTX, BUILDER_ID)).teamInvited).toBe(true);
    expect(
      (await make({ pendingInvite: true }).service.getStatus(CTX, BUILDER_ID)).teamInvited,
    ).toBe(true);
  });

  it('isAdmin comes from the agreement service rule', async () => {
    const { service } = make({ isAdmin: false });
    expect((await service.getStatus(CTX, BUILDER_ID)).isAdmin).toBe(false);
  });
});
