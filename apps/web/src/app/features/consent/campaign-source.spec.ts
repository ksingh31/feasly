import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { ANALYTICS_SOURCE_FIELD_MAX_LENGTH } from '@feasly/contracts';
import { externalReferrerHost, parseCampaignSource, REFERRAL_MEDIUM } from './campaign-source';
import { CampaignSourceState, CaptureCampaignSource, selectCampaignSource } from './campaign-source.state';

const OWN = 'feasly.ca';

describe('parseCampaignSource (#815)', () => {
  it('reads every utm field', () => {
    const { source } = parseCampaignSource(
      '?utm_source=google&utm_medium=cpc&utm_campaign=test&utm_term=infill+cost&utm_content=ad-1',
      '',
      OWN,
    );
    expect(source).toEqual({
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'test',
      utm_term: 'infill cost',
      utm_content: 'ad-1',
    });
  });

  it('records the click-id parameter name, never its value', () => {
    const { source } = parseCampaignSource('?utm_source=google&gclid=SECRET-CLICK-ID', '', OWN);
    expect(source).toEqual({ utm_source: 'google', click_id_type: 'gclid' });
    expect(JSON.stringify(source)).not.toContain('SECRET');
  });

  it('ignores an empty click-id parameter and unknown ones', () => {
    expect(parseCampaignSource('?gclid=&ttclid=abc', '', OWN).source).toBeNull();
  });

  it('drops values the API would reject (PII charset, over-long)', () => {
    const long = 'a'.repeat(ANALYTICS_SOURCE_FIELD_MAX_LENGTH + 1);
    const { source } = parseCampaignSource(
      `?utm_source=me%40mail.com&utm_campaign=${long}&utm_medium=%24500&utm_content=ok`,
      '',
      OWN,
    );
    expect(source).toEqual({ utm_content: 'ok' });
  });

  it('uses an external referrer host as a referral source when no utm tags', () => {
    const result = parseCampaignSource('', 'https://www.reddit.com/r/Calgary/comments/x?y=1', OWN);
    expect(result.referrerHost).toBe('www.reddit.com');
    expect(result.source).toEqual({ utm_source: 'www.reddit.com', utm_medium: REFERRAL_MEDIUM });
  });

  it('utm tags win over the referrer (which is still recorded)', () => {
    const result = parseCampaignSource('?utm_campaign=spring', 'https://news.example.com/', OWN);
    expect(result.source).toEqual({ utm_campaign: 'spring' });
    expect(result.referrerHost).toBe('news.example.com');
  });

  it('returns no source for a direct visit', () => {
    expect(parseCampaignSource('', '', OWN)).toEqual({ source: null, referrerHost: null });
  });
});

describe('externalReferrerHost (#815)', () => {
  it('ignores our own host, empty and unparsable referrers', () => {
    expect(externalReferrerHost('https://feasly.ca/how-it-works', OWN)).toBeNull();
    expect(externalReferrerHost('', OWN)).toBeNull();
    expect(externalReferrerHost('not a url', OWN)).toBeNull();
  });

  it('keeps only the host (no path or query)', () => {
    expect(externalReferrerHost('https://Google.com/search?q=my+address', OWN)).toBe('google.com');
  });
});

describe('CampaignSourceState (#815)', () => {
  let store: Store;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideStore([CampaignSourceState])] });
    store = TestBed.inject(Store);
  });

  it('keeps the first touch for the session', () => {
    store.dispatch(new CaptureCampaignSource({ source: { utm_source: 'google' }, referrerHost: null }));
    store.dispatch(new CaptureCampaignSource({ source: { utm_source: 'bing' }, referrerHost: 'bing.com' }));
    expect(store.selectSnapshot(CampaignSourceState.source)).toEqual({ utm_source: 'google' });
    expect(store.selectSnapshot(CampaignSourceState.referrerHost)).toBeNull();
  });

  it('a direct first load stays direct', () => {
    store.dispatch(new CaptureCampaignSource({ source: null, referrerHost: null }));
    store.dispatch(new CaptureCampaignSource({ source: { utm_source: 'late' }, referrerHost: null }));
    expect(store.selectSnapshot(selectCampaignSource)).toBeNull();
  });

  it('selectCampaignSource tolerates an unregistered state', () => {
    expect(selectCampaignSource({})).toBeNull();
  });
});
