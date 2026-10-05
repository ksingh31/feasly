import { describe, expect, it } from 'vitest';
import { pastOrPresentDatetime } from '../src/lib/zod-datetime';

/**
 * QA 2026-10-04 (P5/P6): payment/contract dates record things that already
 * happened — the route schemas reject future datetimes. `nowMs` is
 * injected so the tests pin the clock instead of racing it.
 */
describe('pastOrPresentDatetime', () => {
  const NOW = new Date('2026-10-04T12:00:00.000Z').getTime();

  it('accepts a past datetime with an explicit offset', () => {
    const schema = pastOrPresentDatetime('paidAt', NOW);
    expect(
      schema.safeParse('2026-10-03T23:59:59-06:00').success,
    ).toBe(true);
  });

  it('accepts the exact now instant (inclusive)', () => {
    const schema = pastOrPresentDatetime('paidAt', NOW);
    expect(schema.safeParse('2026-10-04T12:00:00.000Z').success).toBe(true);
  });

  it('rejects a future datetime, naming the field', () => {
    const schema = pastOrPresentDatetime('contractSignedAt', NOW);
    const result = schema.safeParse('2026-10-05T00:00:01.000Z');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'contractSignedAt must not be in the future.',
      );
    }
  });

  it('still rejects malformed datetimes and missing offsets', () => {
    const schema = pastOrPresentDatetime('paidAt', NOW);
    expect(schema.safeParse('next Tuesday').success).toBe(false);
    expect(schema.safeParse('2026-10-03T12:00:00').success).toBe(false);
  });
});
