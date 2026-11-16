/**
 * #733 — go-live cost guardrails. Static, no-auth drift guards over the IaC
 * and host.json (the live values are read back with `az` per
 * docs/ops/cost.md):
 *  1. Flex Consumption scale-out is capped (owner decision 2026-11-15: 10).
 *  2. The Log Analytics workspace has a daily cap (owner decision: 0.1 GB)
 *     and an alert fires when it is reached.
 *  3. host.json trims AppTraces volume (no per-invocation Information lines,
 *     no host chatter) while keeping requests, exceptions, error/warn traces
 *     (correlation IDs ride on the pipeline's warn/error lines) and the timer
 *     summaries that prove timers ran.
 *  4. The subscription budget module carries the 50/80/100 % actual and
 *     100 % forecast thresholds.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(__dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(repo, ...p), 'utf8');
const bicep = (p: string) => read('infra', 'bicep', p);

describe('#733 Function App instance cap', () => {
  it('module scale-out uses a bounded param defaulting to 10 (no hardcoded 100)', () => {
    const mod = bicep('modules/function-app.bicep');
    expect(mod).toMatch(/^param maximumInstanceCount int = 10$/m);
    expect(mod).toMatch(/maximumInstanceCount: maximumInstanceCount\b/);
    expect(mod).not.toMatch(/maximumInstanceCount: 100\b/);
  });

  it('main.bicep passes the cap through and no environment raises it above 10', () => {
    const main = bicep('main.bicep');
    expect(main).toMatch(/^param functionMaximumInstanceCount int = 10$/m);
    expect(main).toMatch(/maximumInstanceCount: functionMaximumInstanceCount/);
    for (const env of ['dev', 'staging', 'prod']) {
      const src = bicep(`environments/${env}.bicepparam`);
      const m = src.match(/^param functionMaximumInstanceCount = (\d+)/m);
      if (m) expect(Number(m[1])).toBeLessThanOrEqual(10);
    }
  });
});

describe('#733 Log Analytics daily cap', () => {
  it('workspace declares workspaceCapping.dailyQuotaGb from a 0.1 GB default', () => {
    const mon = bicep('modules/monitoring.bicep');
    expect(mon).toMatch(/^param dailyQuotaGb string = '0\.1'$/m);
    expect(mon).toMatch(/workspaceCapping: \{\s*dailyQuotaGb: json\(dailyQuotaGb\)\s*\}/);
    const main = bicep('main.bicep');
    expect(main).toMatch(/^param logAnalyticsDailyQuotaGb string = '0\.1'$/m);
    expect(main).toMatch(/dailyQuotaGb: logAnalyticsDailyQuotaGb/);
  });

  it('adds no paid scheduled-query alert for the daily cap (free-tier rule)', () => {
    const alerts = bicep('modules/alerts.bicep');
    expect(alerts).not.toMatch(/resource dailyCapAlert /);
    expect(alerts).not.toContain('-law-daily-cap');
  });
});

describe('#733 host.json trims trace volume without losing signal', () => {
  const host = JSON.parse(read('apps', 'api', 'host.json')) as {
    version: string;
    logging: {
      logLevel: Record<string, string>;
      applicationInsights: {
        samplingSettings: { isEnabled: boolean; excludedTypes: string };
      };
    };
  };
  const levels = host.logging.logLevel;

  it('drops host chatter and per-invocation start/finish lines', () => {
    expect(host.version).toBe('2.0');
    expect(levels.default).toBe('Warning');
    expect(levels.Function).toBe('Warning');
  });

  it('keeps requests (5xx alert source) and metrics', () => {
    expect(levels['Host.Results']).toBe('Information');
    expect(levels['Host.Aggregator']).toBe('Information');
  });

  it('keeps every timer summary line (proof a timer ran)', () => {
    const apiDir = join(repo, 'apps', 'api');
    const timers = readdirSync(apiDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(apiDir, d.name, 'function.json')))
      .map((d) => d.name)
      .filter((name) => read('apps', 'api', name, 'function.json').includes('"timerTrigger"'));
    expect(timers.length).toBeGreaterThanOrEqual(7);
    for (const t of timers) {
      expect(levels[`Function.${t}.User`]).toBe('Information');
    }
  });

  it('keeps the real-user monitoring traces (#830 — console.info per beacon item)', () => {
    expect(levels['Function.telemetry.User']).toBe('Information');
  });

  it('never samples requests, exceptions or traces (alerts count them)', () => {
    const s = host.logging.applicationInsights.samplingSettings;
    expect(s.isEnabled).toBe(true);
    const excluded = s.excludedTypes.split(';');
    expect(excluded).toEqual(expect.arrayContaining(['Request', 'Exception', 'Trace']));
  });
});

describe('#733 budget thresholds', () => {
  it('subscription budget module notifies at 50/80/100 % actual and 100 % forecast', () => {
    const mod = bicep('modules/subscription-budget.bicep');
    expect(mod).toMatch(/^targetScope = 'subscription'$/m);
    expect(mod).toMatch(/^param name string = 'feasly-monthly-cap'$/m);
    expect(mod).toMatch(/^param amount int = 10$/m);
    for (const [key, threshold, type] of [
      ['actual50', 50, 'Actual'],
      ['actual80', 80, 'Actual'],
      ['actual100', 100, 'Actual'],
      ['forecast100', 100, 'Forecasted'],
    ] as const) {
      const block = mod.match(new RegExp(`${key}: \\{([\\s\\S]*?)\\}`));
      expect(block, key).toBeTruthy();
      expect(block![1]).toContain(`threshold: ${threshold}\n`);
      expect(block![1]).toContain(`thresholdType: '${type}'`);
      expect(block![1]).toContain('enabled: true');
      expect(block![1]).toContain('contactEmails: contactEmails');
    }
  });

  it('is applied out of band (not wired into the RG-scoped CD template, #637)', () => {
    expect(bicep('main.bicep')).not.toContain('subscription-budget.bicep');
  });
});
