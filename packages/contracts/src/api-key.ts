/**
 * API key contracts (api-mcp/01).
 *
 * Admin-only lifecycle: the plaintext key is returned EXACTLY once at
 * issuance/rotation (`ApiKeyIssuedResponse.key`); every other surface
 * shows only the masked `keyPrefix` (`feasly_live_…abcd`).
 */

export type ApiKeyScope =
  | 'property:read'
  | 'estimate'
  | 'estimate:read'
  | 'lead'
  | 'lead:read';

export interface ApiKeyIssueRequest {
  readonly name: string;
  readonly tenant_id?: string;
  readonly scopes?: readonly ApiKeyScope[];
  readonly rate_limit?: number;
  readonly sandbox?: boolean;
}

export interface ApiKeyRecordResponse {
  readonly id: string;
  readonly name: string;
  readonly tenant_id: string | null;
  /** Masked display form — never the full key. */
  readonly key_prefix: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly rate_limit_per_min: number;
  readonly sandbox: boolean;
  readonly revoked_at: string | null;
  readonly last_used_at: string | null;
  readonly created_at: string;
}

export interface ApiKeyIssuedResponse {
  readonly key: ApiKeyRecordResponse;
  /** Plaintext — present ONLY in the issuance/rotation response. */
  readonly plaintext: string;
}

export interface ApiKeyListResponse {
  readonly keys: readonly ApiKeyRecordResponse[];
}
