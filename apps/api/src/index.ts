/**
 * @feasly/api — public surface. Tests and (from BE-3) the Azure Functions
 * trigger adapters import from here, never from deep paths.
 */
export * from './config';
export * from './composition';
export * from './services';
export * from './routes';
export * as db from './db';
export * as middleware from './middleware';
export * as lib from './lib';
