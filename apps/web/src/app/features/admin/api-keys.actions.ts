import type {
  ApiKeyIssueRequest,
  ApiKeyScope,
} from '@feasly/contracts';
import type { ApiKeyUpdatePatch } from '../../core/api/api.service';

/** Load the key list from the backend. */
export class LoadApiKeys {
  static readonly type = '[ApiKeys] Load';
}

/** Issue a new key. The plaintext is stored once — navigating away clears it. */
export class IssueApiKey {
  static readonly type = '[ApiKeys] Issue';
  constructor(public readonly request: ApiKeyIssueRequest) {}
}

/** Rotate a key (old revoked, new plaintext shown once). */
export class RotateApiKey {
  static readonly type = '[ApiKeys] Rotate';
  constructor(public readonly id: string) {}
}

/** Revoke a key immediately (confirm dialog first in the UI). */
export class RevokeApiKey {
  static readonly type = '[ApiKeys] Revoke';
  constructor(public readonly id: string) {}
}

/** Update a key's scopes and/or rate limit. */
export class UpdateApiKey {
  static readonly type = '[ApiKeys] Update';
  constructor(
    public readonly id: string,
    public readonly patch: ApiKeyUpdatePatch,
  ) {}
}

/** Select a key to view/edit (drives the detail panel + usage). */
export class SelectApiKey {
  static readonly type = '[ApiKeys] Select';
  constructor(public readonly id: string | null) {}
}

/** Clear the once-only plaintext (user navigated away or dismissed). */
export class ClearPlaintext {
  static readonly type = '[ApiKeys] Clear plaintext';
}

/** Load per-day usage for the selected key. */
export class LoadApiKeyUsage {
  static readonly type = '[ApiKeys] Load usage';
  constructor(public readonly id: string) {}
}

/** All available scopes for the scope editor. */
export const API_KEY_SCOPES: readonly ApiKeyScope[] = [
  'property:read',
  'estimate',
  'estimate:read',
  'lead',
  'lead:read',
];
