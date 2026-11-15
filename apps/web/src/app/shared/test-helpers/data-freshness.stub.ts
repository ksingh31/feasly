import { signal, type Provider } from '@angular/core';
import { DataFreshnessService, type DataFreshness } from '../../core/data-freshness';

/**
 * Test-only DataFreshnessService stub (#513) for specs that render the
 * property card without wiring API_SERVICE. Never hits the network.
 */
export function provideDataFreshnessStub(
  freshness: DataFreshness = { refreshedMonth: null, rollYear: null },
): Provider {
  return {
    provide: DataFreshnessService,
    useValue: { freshness: signal(freshness).asReadonly(), load: () => undefined },
  };
}
