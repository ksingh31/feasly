import { describe, expect, it } from 'vitest';
import type { CommissionInvoiceStatus } from '@feasly/contracts';
import { paymentMethodEditable } from './builder-invoice-view';

describe('paymentMethodEditable', () => {
  it.each<[CommissionInvoiceStatus, boolean]>([
    ['draft', true],
    ['in_review', true],
    ['finalized', true],
    ['failed', true],
    // #712: a charge waiting for bank confirmation is in flight — locked.
    ['action_required', false],
    ['paid', false],
    ['void', false],
    ['disputed', false],
  ])('%s → %s', (status, editable) => {
    expect(paymentMethodEditable({ status })).toBe(editable);
  });
});
