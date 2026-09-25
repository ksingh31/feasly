/**
 * Contract registry. The FE0-003 mock-harness conformance test consumes this:
 * every name listed here must have a mock implementation returning exactly the
 * registered shape. Add a contract here when you add one to the barrel.
 */
export const CONTRACTS_VERSION = '0.2.0';

export const CONTRACT_NAMES = [
  'common',
  'property',
  'estimate',
  'lead',
  'magic-link',
  'report',
  'callback',
  'share',
  'events',
  'embed',
  'community',
  'error',
  'unsubscribe',
] as const;

export type ContractName = (typeof CONTRACT_NAMES)[number];
