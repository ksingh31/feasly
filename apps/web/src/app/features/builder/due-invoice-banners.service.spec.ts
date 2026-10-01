/**
 * Due-invoice banner session-state service tests.
 *
 * The dismissal contract: everything lives in memory in this service.
 * No storage plugin, no localStorage, no backend call — so a refresh
 * (a new service instance) always starts with an empty dismissal set and
 * the banners come back.
 */
import { describe, expect, it } from 'vitest';
import { DueInvoiceBannersService } from './due-invoice-banners.service';

describe('DueInvoiceBannersService', () => {
  it('starts with nothing dismissed, nothing open, stack expanded', () => {
    const service = new DueInvoiceBannersService();
    expect(service.isDismissed('inv-1')).toBe(false);
    expect(service.isOpen('inv-1')).toBe(false);
    expect(service.stackCollapsed()).toBe(false);
  });

  it('dismisses one invoice and closes it if open', () => {
    const service = new DueInvoiceBannersService();
    service.toggleOpen('inv-1');
    expect(service.isOpen('inv-1')).toBe(true);
    service.dismiss('inv-1');
    expect(service.isDismissed('inv-1')).toBe(true);
    expect(service.isOpen('inv-1')).toBe(false);
    expect(service.isDismissed('inv-2')).toBe(false);
  });

  it('dismissAll dismisses every given id', () => {
    const service = new DueInvoiceBannersService();
    service.dismissAll(['inv-1', 'inv-2']);
    expect(service.isDismissed('inv-1')).toBe(true);
    expect(service.isDismissed('inv-2')).toBe(true);
    expect(service.isDismissed('inv-3')).toBe(false);
  });

  it('toggles banner expansion', () => {
    const service = new DueInvoiceBannersService();
    service.toggleOpen('inv-1');
    expect(service.isOpen('inv-1')).toBe(true);
    service.toggleOpen('inv-1');
    expect(service.isOpen('inv-1')).toBe(false);
  });

  it('folds and unfolds the stack', () => {
    const service = new DueInvoiceBannersService();
    service.setStackCollapsed(true);
    expect(service.stackCollapsed()).toBe(true);
    service.setStackCollapsed(false);
    expect(service.stackCollapsed()).toBe(false);
  });

  it('holds no state across instances (a refresh brings banners back)', () => {
    const first = new DueInvoiceBannersService();
    first.dismiss('inv-1');
    first.setStackCollapsed(true);
    expect(first.isDismissed('inv-1')).toBe(true);

    // A new instance (page refresh) starts clean — nothing persisted.
    const second = new DueInvoiceBannersService();
    expect(second.isDismissed('inv-1')).toBe(false);
    expect(second.stackCollapsed()).toBe(false);
  });
});
