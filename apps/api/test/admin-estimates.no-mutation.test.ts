/**
 * admin/03 — no-mutation guard (AC3).
 *
 * The estimate lookup is read-only by design. This test pins the Function
 * binding so a future edit cannot silently open a mutation path: only GET
 * (and CORS preflight OPTIONS) may reach the adapter. PUT/PATCH/DELETE get
 * no binding and therefore 404 at the Functions host.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('admin/03 estimate lookup — no mutation path (AC3)', () => {
  it('binds only GET and OPTIONS on the estimate lookup trigger', () => {
    const functionJson = JSON.parse(
      readFileSync(
        join(__dirname, '..', 'admin-estimates-get', 'function.json'),
        'utf8',
      ),
    );
    const trigger = functionJson.bindings.find(
      (b: { type: string }) => b.type === 'httpTrigger',
    );
    expect(trigger).toBeDefined();
    expect(trigger.route).toBe('v1/admin/estimates/{id}');
    expect([...trigger.methods].sort()).toEqual(['get', 'options']);
  });

  it('defines no mutation handler in the adapter source', () => {
    const source = readFileSync(
      join(__dirname, '..', 'src', 'functions', 'admin-estimates-get.ts'),
      'utf8',
    );
    for (const name of ['PutHandler', 'PatchHandler', 'DeleteHandler', 'PostHandler']) {
      expect(source).not.toContain(name);
    }
    expect(source).toContain('adminEstimatesGetHandler');
  });
});
