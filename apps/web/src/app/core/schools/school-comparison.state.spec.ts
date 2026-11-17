import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it } from 'vitest';
import { ClearSchoolComparison, ToggleSchoolComparison } from './school-comparison.actions';
import { SchoolComparisonState } from './school-comparison.state';

describe('SchoolComparisonState (#781)', () => {
  function setup(): Store {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideStore([SchoolComparisonState])] });
    return TestBed.inject(Store);
  }

  it('adds a school, and removes it on a second toggle', () => {
    const store = setup();
    store.dispatch(new ToggleSchoolComparison('a', 4));
    expect(store.selectSnapshot(SchoolComparisonState.schoolIds)).toEqual(['a']);
    store.dispatch(new ToggleSchoolComparison('a', 4));
    expect(store.selectSnapshot(SchoolComparisonState.schoolIds)).toEqual([]);
  });

  it('never grows past the configured max, but still removes when full', () => {
    const store = setup();
    store.dispatch([new ToggleSchoolComparison('a', 2), new ToggleSchoolComparison('b', 2)]);
    store.dispatch(new ToggleSchoolComparison('c', 2));
    expect(store.selectSnapshot(SchoolComparisonState.schoolIds)).toEqual(['a', 'b']);
    store.dispatch(new ToggleSchoolComparison('a', 2));
    expect(store.selectSnapshot(SchoolComparisonState.schoolIds)).toEqual(['b']);
  });

  it('clears the list', () => {
    const store = setup();
    store.dispatch(new ToggleSchoolComparison('a', 4));
    store.dispatch(new ClearSchoolComparison());
    expect(store.selectSnapshot(SchoolComparisonState.schoolIds)).toEqual([]);
  });
});
