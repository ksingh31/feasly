/**
 * Builder-config schema validation tests (EMB-02).
 *
 * Covers: the valid Elite config passes; the three broken fixtures from
 * the story (bad hex, non-https origin, missing required field) fail
 * loudly with the file + field named; low-contrast accents warn but pass;
 * http localhost is allowed in dev only.
 */
import { describe, expect, it } from 'vitest';
import {
  validateBuilderConfigs,
  type BuilderConfigSource,
} from '../src/services/builder-config/builder-config.schema';

const VALID = {
  tenant_key: 'elite-craft-builders',
  business_name: 'Elite Craft Builders',
  display_name: 'Elite Craft Builders',
  logo_url: '',
  accent_color: '#1a365d',
  allowed_origins: ['https://elitecraftbuilders.com'],
  fallback_phone: '',
  fallback_email: '',
  plan: null,
};

function source(file: string, data: unknown): BuilderConfigSource {
  return { file, data };
}

describe('validateBuilderConfigs', () => {
  it('accepts a valid config', () => {
    const warnings: string[] = [];
    const configs = validateBuilderConfigs([source('elite.json', VALID)], {
      isDev: false,
      onWarning: (w) => warnings.push(w),
    });
    expect(Object.keys(configs)).toEqual(['elite-craft-builders']);
    expect(warnings).toEqual([]);
  });

  it('rejects a bad hex with file + field named', () => {
    expect(() =>
      validateBuilderConfigs(
        [source('broken.json', { ...VALID, accent_color: 'brass' })],
        { isDev: false },
      ),
    ).toThrow('invalid builder config "broken.json": field "accent_color"');
  });

  it('rejects a non-https origin with file + field named', () => {
    expect(() =>
      validateBuilderConfigs(
        [
          source('broken.json', {
            ...VALID,
            allowed_origins: ['http://elitecraftbuilders.com'],
          }),
        ],
        { isDev: false },
      ),
    ).toThrow('invalid builder config "broken.json": field "allowed_origins"');
  });

  it('rejects a missing required field with file + field named', () => {
    const { business_name: _omitted, ...withoutName } = VALID;
    expect(() =>
      validateBuilderConfigs([source('broken.json', withoutName)], {
        isDev: false,
      }),
    ).toThrow('invalid builder config "broken.json": field "business_name"');
  });

  it('rejects invalid JSON-shaped input naming the file', () => {
    expect(() =>
      validateBuilderConfigs([source('broken.json', 42)], { isDev: false }),
    ).toThrow('invalid builder config "broken.json"');
  });

  it('rejects duplicate tenant keys across files', () => {
    expect(() =>
      validateBuilderConfigs(
        [source('a.json', VALID), source('b.json', VALID)],
        { isDev: false },
      ),
    ).toThrow(
      'invalid builder config "b.json": duplicate tenant_key "elite-craft-builders"',
    );
  });

  it('warns (not fails) on low-contrast accent colors', () => {
    const warnings: string[] = [];
    const configs = validateBuilderConfigs(
      [source('elite.json', { ...VALID, accent_color: '#B08D57' })],
      { isDev: false, onWarning: (w) => warnings.push(w) },
    );
    expect(configs['elite-craft-builders']).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('elite.json');
    expect(warnings[0]).toContain('#B08D57');
    expect(warnings[0]).toContain('4.5:1');
  });

  it('allows http localhost origins in dev only', () => {
    const withLocalhost = {
      ...VALID,
      allowed_origins: ['http://localhost:4200'],
    };
    expect(() =>
      validateBuilderConfigs([source('dev.json', withLocalhost)], {
        isDev: false,
      }),
    ).toThrow('field "allowed_origins"');
    const configs = validateBuilderConfigs([source('dev.json', withLocalhost)], {
      isDev: true,
    });
    expect(configs['elite-craft-builders']).toBeDefined();
  });

  it('rejects origins with paths, even https', () => {
    expect(() =>
      validateBuilderConfigs(
        [
          source('broken.json', {
            ...VALID,
            allowed_origins: ['https://elitecraftbuilders.com/embed'],
          }),
        ],
        { isDev: false },
      ),
    ).toThrow('field "allowed_origins"');
  });
});
