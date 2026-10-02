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
import { of } from 'rxjs';
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

describe('BuilderInvoicesState actionable invoices', () => {
  async function setupActionable() {
    TestBed.resetTestingModule();
    const calls: string[] = [];
    const apiStub = {
      listInvoices: () => of({ invoices: [], total: null, page: 1, pageSize: 10 }),
      listActionableInvoices: () => {
        calls.push('actionable');
        return of([
          { id: 'a1', status: 'failed', paymentMethod: 'card' },
          { id: 'a2', status: 'in_review', paymentMethod: 'card' },
        ]);
      },
      setInvoicePaymentMethod: (id: string, method: string) =>
        of({ id, status: 'failed', paymentMethod: method }),
    };
    TestBed.configureTestingModule({
      providers: [
        provideStore([]),
        provideHttpClient(),
        {
          provide: ConfigService,
          useValue: { getServedBuilderCopy: () => null },
        },
        builderInvoicesStateProvider,
        {
          provide: (await import('./builder-invoices-api.service'))
            .BuilderInvoicesApiService,
          useValue: apiStub,
        },
      ],
    });
    const store = TestBed.inject(Store);
    return { store, calls };
  }

  it('LoadActionableInvoices fetches every actionable invoice via the dedicated query', async () => {
    const { store, calls } = await setupActionable();
    const { LoadActionableInvoices } = await import(
      './builder-invoices.actions'
    );
    store.dispatch(new LoadActionableInvoices());
    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toEqual(['actionable']);
    expect(
      store.selectSnapshot(BuilderInvoicesState.actionableInvoices),
    ).toHaveLength(2);
    expect(store.selectSnapshot(BuilderInvoicesState.actionableStatus)).toBe(
      'ready',
    );
  });

  it('UpdateInvoicePaymentMethod keeps the actionable list in sync', async () => {
    const { store } = await setupActionable();
    const { LoadActionableInvoices, UpdateInvoicePaymentMethod } =
      await import('./builder-invoices.actions');
    store.dispatch(new LoadActionableInvoices());
    await new Promise((r) => setTimeout(r, 50));

    store.dispatch(new UpdateInvoicePaymentMethod('a1', 'cheque'));
    await new Promise((r) => setTimeout(r, 50));

    const updated = store
      .selectSnapshot(BuilderInvoicesState.actionableInvoices)
      .find((i) => i.id === 'a1');
    expect(updated?.paymentMethod).toBe('cheque');
  });
});

describe('BuilderInvoicesState invoice-number filter', () => {
  async function setup() {
    TestBed.resetTestingModule();
    const calls: Array<{ page: number; invoiceNumber?: string }> = [];
    const apiStub = {
      listInvoices: (page: number, _pageSize: number, invoiceNumber?: string) => {
        calls.push({ page, invoiceNumber });
        return of({ invoices: [], total: null, page, pageSize: 10 });
      },
    };
    TestBed.configureTestingModule({
      providers: [
        provideStore([]),
        provideHttpClient(),
        {
          provide: ConfigService,
          useValue: { getServedBuilderCopy: () => null },
        },
        builderInvoicesStateProvider,
        {
          provide: (await import('./builder-invoices-api.service'))
            .BuilderInvoicesApiService,
          useValue: apiStub,
        },
      ],
    });
    const store = TestBed.inject(Store);
    return { store, calls };
  }

  it('sends no invoice-number param without a filter', async () => {
    const { store, calls } = await setup();
    store.dispatch(new (await import('./builder-invoices.actions')).LoadInvoices(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ page: 1, invoiceNumber: undefined });
  });

  it('SetInvoiceNumberFilter commits the filter and reloads page 1 with it', async () => {
    const { store, calls } = await setup();
    const { SetInvoiceNumberFilter } = await import('./builder-invoices.actions');
    store.dispatch(new SetInvoiceNumberFilter('INV-0042'));
    await new Promise((r) => setTimeout(r, 50));

    expect(store.selectSnapshot(BuilderInvoicesState.invoiceNumberFilter)).toBe(
      'INV-0042',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ page: 1, invoiceNumber: 'INV-0042' });
  });

  it('trims the filter and ignores a no-op set', async () => {
    const { store, calls } = await setup();
    const { SetInvoiceNumberFilter } = await import('./builder-invoices.actions');
    store.dispatch(new SetInvoiceNumberFilter('  inv-42  '));
    await new Promise((r) => setTimeout(r, 50));
    expect(store.selectSnapshot(BuilderInvoicesState.invoiceNumberFilter)).toBe(
      'inv-42',
    );

    store.dispatch(new SetInvoiceNumberFilter('inv-42'));
    await new Promise((r) => setTimeout(r, 50));
    // No reload for an unchanged filter.
    expect(calls).toHaveLength(1);
  });

  it('clearing the filter reloads without the param', async () => {
    const { store, calls } = await setup();
    const { SetInvoiceNumberFilter } = await import('./builder-invoices.actions');
    store.dispatch(new SetInvoiceNumberFilter('INV-0042'));
    await new Promise((r) => setTimeout(r, 50));
    store.dispatch(new SetInvoiceNumberFilter(''));
    await new Promise((r) => setTimeout(r, 50));

    expect(store.selectSnapshot(BuilderInvoicesState.invoiceNumberFilter)).toBe('');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ page: 1, invoiceNumber: undefined });
  });
});
