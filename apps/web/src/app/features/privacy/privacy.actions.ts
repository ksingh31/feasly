/**
 * Privacy self-service actions (#706). The magic-link token is passed in per
 * action and never stored in this state — ReportState keeps it memory-only.
 */

/** Router `state` flag set by the in-page "Yes, delete my data" button (#706). */
export const PRIVACY_CONFIRMED_STATE = 'privacyConfirmed';

export class DownloadMyData {
  static readonly type = '[Privacy] Download my data';
  constructor(public readonly reportToken: string) {}
}

export class RequestErasure {
  static readonly type = '[Privacy] Request erasure';
  constructor(public readonly reportToken: string) {}
}

/** Drops the pending request from the page (server-side it stays pending, unconfirmed). */
export class CancelErasure {
  static readonly type = '[Privacy] Cancel erasure';
}

export class ConfirmErasure {
  static readonly type = '[Privacy] Confirm erasure';
  constructor(
    public readonly reportToken: string,
    public readonly requestId: string,
  ) {}
}

/** Sends a fresh magic link (identical response for known and unknown emails). */
export class SendPrivacyLink {
  static readonly type = '[Privacy] Send link';
  constructor(public readonly email: string) {}
}

/** Resets every status — used when a privacy page mounts. */
export class ResetPrivacy {
  static readonly type = '[Privacy] Reset';
}
