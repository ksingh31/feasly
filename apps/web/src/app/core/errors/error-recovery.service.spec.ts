import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorRecoveryService } from './error-recovery.service';

/** HRD-02: the /error page's "Try again" re-fires the captured failed action. */
describe('ErrorRecoveryService', () => {
  let service: ErrorRecoveryService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ErrorRecoveryService);
  });

  it('starts with no captured action', () => {
    expect(service.failedAction()).toBeNull();
    expect(service.retry()).toBe(false);
  });

  it('capture() stores the action and retry() re-fires it exactly once', () => {
    const retry = vi.fn();
    service.capture({ description: 'Re-run the estimate', retry });

    expect(service.failedAction()?.description).toBe('Re-run the estimate');
    expect(service.retry()).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
    // The action is cleared after firing — a second tap does nothing.
    expect(service.retry()).toBe(false);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a new capture overwrites the previous action', () => {
    const first = vi.fn();
    const second = vi.fn();
    service.capture({ description: 'first', retry: first });
    service.capture({ description: 'second', retry: second });

    expect(service.retry()).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clear() forgets the captured action', () => {
    const retry = vi.fn();
    service.capture({ description: 'x', retry });
    service.clear();
    expect(service.retry()).toBe(false);
    expect(retry).not.toHaveBeenCalled();
  });
});
