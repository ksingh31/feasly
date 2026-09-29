/**
 * Regression test for the `builder/invoices` route-level DI wiring.
 *
 * The invoices route registers its state via NGXS `lazyProvider`, which
 * instantiates the state in a child *environment* injector — one that
 * cannot see component-level providers (e.g. the builder shell's). When
 * `builderInvoicesStateProvider` omitted BUILDER_COPY, the state's
 * `inject(BUILDER_COPY)` threw NullInjectorError at navigation time and
 * the invoices tab landed on the global error page ("Something went wrong
 * on our end.") — reported live 2026-09-29.
 *
 * This test mirrors the route wiring: only `builderInvoicesStateProvider`
 * (plus the store) is registered. If the provider ever stops carrying
 * BUILDER_COPY, `TestBed.inject(Store)` throws, failing the test.
 */
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../core/config/config.service';
import {
  BuilderInvoicesState,
  builderInvoicesStateProvider,
} from './builder-invoices.state';

describe('builderInvoicesStateProvider', () => {
  it('provides BUILDER_COPY alongside the state (route-level DI)', () => {
    TestBed.configureTestingModule({
      providers: [
        provideStore([]),
        provideHttpClient(),
        {
          provide: ConfigService,
          useValue: { getServedBuilderCopy: () => null },
        },
        builderInvoicesStateProvider,
      ],
    });

    // Instantiating the store pulls the lazy state in; without BUILDER_COPY
    // in the provider this throws NullInjectorError. ngxsOnInit also reads
    // copy.invoicesPageSize, proving the injected copy is the real default.
    const store = TestBed.inject(Store);
    expect(store.selectSnapshot(BuilderInvoicesState.invoices)).toEqual([]);
    expect(store.selectSnapshot(BuilderInvoicesState.pageSize)).toBe(10);
  });
});
