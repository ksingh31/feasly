import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { isServerPlatform } from './platform';

describe('isServerPlatform', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is true on the server platform', () => {
    TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: 'server' }] });
    expect(TestBed.runInInjectionContext(() => isServerPlatform())).toBe(true);
  });

  it('is false in the browser', () => {
    TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: 'browser' }] });
    expect(TestBed.runInInjectionContext(() => isServerPlatform())).toBe(false);
  });
});
