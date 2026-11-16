import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_URL } from './config-url.token';
import { ConfigService } from './config.service';
import { mergeLazyCopy } from './lazy-copy';
import { DEFAULT_ZONING_GUIDE_COPY } from './zoning-guide-copy.defaults';
import { injectZoningGuideCopy } from './zoning-guide-copy';

/** #980: lazy copy sections keep honoring deploy overrides from app-config.json. */
describe('mergeLazyCopy', () => {
  let service: ConfigService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(ConfigService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  async function load(json: unknown): Promise<void> {
    const pending = service.load();
    httpMock.expectOne(TestBed.inject(CONFIG_URL)).flush(json as object);
    await pending;
  }

  it('returns the compiled defaults before any config is served', () => {
    expect(mergeLazyCopy(service, { title: 'Default' }, ['marketing', 'x'])).toEqual({ title: 'Default' });
  });

  it('merges served overrides at copy.<path> and drops unknown keys', async () => {
    await load({ copy: { marketing: { x: { title: 'Served', bogus: 'ignored' } } } });
    expect(mergeLazyCopy(service, { title: 'Default', sub: 'Kept' }, ['marketing', 'x'])).toEqual({
      title: 'Served',
      sub: 'Kept',
    });
  });

  it('ignores a non-object at the path', async () => {
    await load({ copy: { marketing: 'nope' } });
    expect(service.getServedCopy(['marketing', 'x'])).toBeNull();
    expect(mergeLazyCopy(service, { title: 'Default' }, ['marketing', 'x'])).toEqual({ title: 'Default' });
  });

  it('never mutates the compiled defaults', async () => {
    const defaults = { title: 'Default' };
    await load({ copy: { admin: { title: 'Served' } } });
    mergeLazyCopy(service, defaults, ['admin']);
    expect(defaults.title).toBe('Default');
  });

  it('injectZoningGuideCopy applies a served copy.marketing.zoningGuide override', async () => {
    await load({ copy: { marketing: { zoningGuide: { title: 'Override title' } } } });
    const copy = TestBed.runInInjectionContext(() => injectZoningGuideCopy());
    expect(copy.title).toBe('Override title');
    expect(copy.zones).toEqual(DEFAULT_ZONING_GUIDE_COPY.zones);
  });
});
