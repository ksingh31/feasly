/**
 * @feasly/contracts — frozen UI/API data-transfer contracts (FE0-001).
 *
 * Shapes only: no logic, no math, no secrets. The Angular client imports types
 * from here; the mock harness (FE0-003) and the real backend both implement them.
 * See CHANGELOG.md for the contract-change policy.
 */
export * from './common';
export * from './property';
export * from './estimate';
export * from './lead';
export * from './magic-link';
export * from './report';
export * from './callback';
export * from './share';
export * from './events';
export * from './embed';
export * from './community';
export * from './error';
export * from './registry';
export * from './privacy';
export * from './unsubscribe';
export * from './api-key';
export * from './billing';
export * from './admin-auth';
export * from './builder';
export * from './admin-leads';
export * from './admin-estimates';
export * from './admin-calibration';
export * from './admin-sheets';
