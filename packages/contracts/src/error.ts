/**
 * Standard error envelope. `retryable` drives whether the UI shows a Retry button.
 */
export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}
