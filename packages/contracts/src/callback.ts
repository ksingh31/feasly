/**
 * Callback-request contracts. The team inbox address lives server-side;
 * the client never sees it (grep-tested in the UI epic).
 */

export type CallbackWindow = 'morning' | 'afternoon' | 'evening';

export interface CallbackRequest {
  readonly reportToken: string;
  readonly name: string;
  /** Required at the callback step (optional at the lead gate). */
  readonly phone: string;
  readonly window: CallbackWindow;
}

export interface CallbackResponse {
  readonly ok: true;
  readonly window: CallbackWindow;
}
