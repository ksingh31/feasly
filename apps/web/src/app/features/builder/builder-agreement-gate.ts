import { inject, Injectable, Injector } from '@angular/core';
import { Router, type UrlTree } from '@angular/router';
import { Store } from '@ngxs/store';
import type { AgreementErrorCode } from '@feasly/contracts';
import { MarkBuilderAgreementRequired } from './builder-onboarding.actions';

/** The agreement screen (#722). */
export const AGREEMENT_PATH = '/builder/agreement';
/** Query param carrying where to go back to after accepting. */
export const AGREEMENT_RETURN_PARAM = 'returnUrl';

/**
 * The 409 gate code. Typed against the contract's AgreementErrorCode (a
 * type-only import: the contracts package is CommonJS at runtime).
 */
const AGREEMENT_REQUIRED: AgreementErrorCode = 'AGREEMENT_REQUIRED';

/** True when an API failure is the 409 "accept the agreement first" gate. */
export function isAgreementRequired(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === AGREEMENT_REQUIRED
  );
}

/**
 * Only same-app builder paths are honoured as a return target (no open
 * redirects, no protocol-relative `//host`, never the agreement itself).
 */
export function safeAgreementReturnUrl(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/builder') || raw.startsWith('//')) return null;
  if (raw === AGREEMENT_PATH || raw.startsWith(`${AGREEMENT_PATH}?`)) return null;
  return raw;
}

/** UrlTree to the agreement screen, remembering `returnUrl` when safe. */
export function agreementUrlTree(router: Router, returnUrl: string | null | undefined): UrlTree {
  const safe = safeAgreementReturnUrl(returnUrl);
  return router.createUrlTree([AGREEMENT_PATH], {
    queryParams: safe ? { [AGREEMENT_RETURN_PARAM]: safe } : {},
  });
}

/**
 * Sends a builder to the agreement screen when a money call (record a
 * contract, card setup, payment method) answers 409 AGREEMENT_REQUIRED —
 * the server-side gate is the authority; this only routes the user.
 *
 * Router and Store resolve lazily, on the error path only, so API clients
 * that use this stay constructible without either.
 */
@Injectable({ providedIn: 'root' })
export class BuilderAgreementGate {
  private readonly injector = inject(Injector);

  /** Returns true when the error was the agreement gate (and was handled). */
  handle(err: unknown): boolean {
    if (!isAgreementRequired(err)) return false;
    this.injector.get(Store, null)?.dispatch(new MarkBuilderAgreementRequired());
    const router = this.injector.get(Router);
    void router.navigateByUrl(agreementUrlTree(router, router.url));
    return true;
  }
}
