import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('defaults to development when NODE_ENV is unset', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv)).toMatchObject({
      serviceName: 'feasly-api',
      env: 'development',
    });
  });

  it('accepts a valid NODE_ENV', () => {
    expect(loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).env).toBe(
      'production',
    );
  });

  it('rejects an invalid NODE_ENV naming the variable', () => {
    expect(() => loadConfig({ NODE_ENV: 'bogus' } as NodeJS.ProcessEnv)).toThrow(
      /NODE_ENV/,
    );
  });
});
