/**
 * Issue #797 (#731 F-5): the SWA CSP no longer allows 'unsafe-eval'. NGXS
 * only stays eval-free when the root store runs with
 * `compatibility.strictContentSecurityPolicy` — otherwise it compiles state
 * getters with `new Function(...)` and every page throws EvalError.
 */
import { Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NgxsConfig, Selector, State, Store, provideStates, provideStore } from '@ngxs/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NGXS_STORE_OPTIONS } from './app.config';

interface NestedModel {
  inner: { value: number };
}

@State<NestedModel>({ name: 'cspProbe', defaults: { inner: { value: 7 } } })
@Injectable()
class CspProbeState {
  @Selector()
  static value(state: NestedModel): number {
    return state.inner.value;
  }
}

@State<{ ready: boolean }>({ name: 'cspLazyProbe', defaults: { ready: true } })
@Injectable()
class CspLazyProbeState {
  @Selector()
  static ready(state: { ready: boolean }): boolean {
    return state.ready;
  }
}

/**
 * Simulates a CSP without 'unsafe-eval': any runtime code compilation throws.
 * Production is AOT-compiled, so only library code (NGXS) could hit this.
 */
function forbidEval(): void {
  const blocked = function blockedFunction(): never {
    throw new EvalError("Refused to evaluate a string as JavaScript: 'unsafe-eval' is not allowed");
  };
  vi.stubGlobal('Function', blocked);
  vi.stubGlobal('eval', blocked);
}

describe('appConfig NGXS options (#797)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('enables strictContentSecurityPolicy on the root store', () => {
    expect(NGXS_STORE_OPTIONS.compatibility?.strictContentSecurityPolicy).toBe(true);
    TestBed.configureTestingModule({ providers: [provideStore([CspProbeState], NGXS_STORE_OPTIONS)] });
    expect(TestBed.inject(NgxsConfig).compatibility.strictContentSecurityPolicy).toBe(true);
  });

  it('control: default NGXS options compile getters and fail without eval', () => {
    TestBed.configureTestingModule({ providers: [provideStore([CspProbeState])] });
    const store = TestBed.inject(Store);
    forbidEval(); // after TestBed's own JIT compile, which needs Function
    expect(() => store.selectSnapshot(CspProbeState.value)).toThrow(EvalError);
  });

  it('selects root and lazily-provided state without compiling code at runtime', () => {
    TestBed.configureTestingModule({
      providers: [provideStore([CspProbeState], NGXS_STORE_OPTIONS), provideStates([CspLazyProbeState])],
    });
    const store = TestBed.inject(Store);
    forbidEval(); // after TestBed's own JIT compile, which needs Function
    expect(store.selectSnapshot(CspProbeState.value)).toBe(7);
    expect(store.selectSnapshot(CspLazyProbeState.ready)).toBe(true);
    expect(store.selectSnapshot((s: { cspProbe: NestedModel }) => s.cspProbe.inner.value)).toBe(7);
  });
});
