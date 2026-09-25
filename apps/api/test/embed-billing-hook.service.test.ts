/**
 * Embed billing hook tests (embed/04).
 *
 * Covers: recordBillableEvent writes exactly one billing_events row per call
 * (AC1), returns the not-enabled payload, supports both event types, and the
 * hook never touches Stripe (AC2 — grep test below).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createEmbedBillingHookService,
  type EmbedBillingHookService,
} from '../src/services/billing/embed-billing-hook.service';
import {
  createBillingAuditService,
  type BillingAuditService,
} from '../src/services/billing/billing-audit.service';
import { billingEvents } from '../src/db/schema';
import { createTestDb, type TestDb } from './pglite-db';

let idCounter = 5000;
function nextId(): string {
  return `00000000-0000-4000-8000-${(++idCounter).toString(16).padStart(12, '0')}`;
}

let testDb: TestDb;
let hook: EmbedBillingHookService;

beforeAll(async () => {
  testDb = await createTestDb();
  const audit: BillingAuditService = createBillingAuditService({
    db: testDb.db,
    newId: nextId,
  });
  hook = createEmbedBillingHookService({ audit });
}, 60000);

afterAll(async () => {
  await testDb.close();
});

describe('recordBillableEvent', () => {
  it('writes exactly one billing_events row and returns billed:false', async () => {
    const result = await hook.recordBillableEvent('acme-builders', 'lead_created');

    expect(result).toEqual({ billed: false, reason: 'billing_not_enabled' });

    const rows = await testDb.db.select().from(billingEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenantKey).toBe('acme-builders');
    expect(rows[0].eventType).toBe('embed.lead_created');
    expect(rows[0].entityType).toBe('embed_billing_hook');
    expect(rows[0].payload).toMatchObject({
      event: 'lead_created',
      billed: false,
      reason: 'billing_not_enabled',
    });
  });

  it('supports lead_won and writes a second row', async () => {
    const result = await hook.recordBillableEvent('acme-builders', 'lead_won');

    expect(result).toEqual({ billed: false, reason: 'billing_not_enabled' });

    const rows = await testDb.db.select().from(billingEvents);
    expect(rows).toHaveLength(2);
    expect(rows[1].eventType).toBe('embed.lead_won');
    expect(rows[1].payload).toMatchObject({ event: 'lead_won' });
  });

  it('isolates tenants: rows carry the calling tenant key', async () => {
    await hook.recordBillableEvent('other-builder', 'lead_created');

    const rows = await testDb.db.select().from(billingEvents);
    expect(rows).toHaveLength(3);
    expect(rows[2].tenantKey).toBe('other-builder');
  });
});

describe('no Stripe in the embed hook (AC2)', () => {
  const HOOK_FILE = join(
    __dirname,
    '..',
    'src',
    'services',
    'billing',
    'embed-billing-hook.service.ts',
  );

  /** Strip comments so doc mentions ("never touches Stripe") don't trip the grep. */
  function codeOnly(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  it('the hook source has no stripe import or usage', () => {
    const src = codeOnly(readFileSync(HOOK_FILE, 'utf8'));
    expect(src.toLowerCase()).not.toContain('stripe');
  });

  it('the hook imports only the audit service (no charge code)', () => {
    const src = readFileSync(HOOK_FILE, 'utf8');
    const imports = src
      .split('\n')
      .filter((l) => l.startsWith('import '))
      .join('\n');
    expect(imports).toContain('billing-audit.service');
    expect(imports).not.toContain('stripe.service');
    expect(imports).not.toContain('commission.service');
    expect(imports).not.toContain('flat-plan.service');
  });

  it('no stripe references in any billing-hook-adjacent file', () => {
    const dir = join(__dirname, '..', 'src', 'services', 'billing');
    const hookFiles = readdirSync(dir).filter((f) =>
      f.includes('embed-billing-hook'),
    );
    expect(hookFiles.length).toBeGreaterThan(0);
    for (const f of hookFiles) {
      const src = codeOnly(readFileSync(join(dir, f), 'utf8'));
      expect(src.toLowerCase()).not.toContain('stripe');
    }
  });
});
