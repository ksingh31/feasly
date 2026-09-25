import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedPublicConfig } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { provideApi } from '../../core/api';
import { providePropertyData } from '../../core/api/property-data.service';
import { EmbedState } from './embed.state';
import { WizardState } from '../wizard';
import type { PropertyRecord } from '@feasly/contracts';
import { EmbedShellComponent } from './embed-shell.component';

/**
 * EMB-01: embed shell — fallback states, branding application, badge
 * presence, chrome absence, and postMessage origin validation.
 */
describe('EmbedShellComponent', () => {
  let httpMock: HttpTestingController;
  let store: Store;
  let config: ConfigService;
  let routerNavigate: ReturnType<typeof vi.fn>;

  const fakeConfig = {
    business_name: 'Elite Craft Builders',
    display_name: 'Elite Craft',
    logo_url: '',
    accent_color: '#a8761a',
    allowed_origins: ['https://example-builder.com'],
    fallback_phone: '(403) 555-0100',
    fallback_email: 'hello@example-builder.com',
    plan: null,
  } as EmbedPublicConfig;

  function setup(queryKey: string | null) {
    TestBed.resetTestingModule();
    routerNavigate = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({
      imports: [EmbedShellComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideStore([EmbedState, WizardState]),
        provideApi(),
        providePropertyData(),
        { provide: Router, useValue: { navigate: routerNavigate } },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: { get: (k: string) => (k === 'key' ? queryKey : null) },
              paramMap: { get: () => null },
            },
          },
        },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    store = TestBed.inject(Store);
    config = TestBed.inject(ConfigService);
    const fixture = TestBed.createComponent(EmbedShellComponent);
    fixture.detectChanges();
    return fixture;
  }

  function flushConfig(fixture: ComponentFixture<EmbedShellComponent>, cfg = fakeConfig) {
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/embed/config'));
    req.flush(cfg);
    fixture.detectChanges();
  }

  const fallbackCopy = () =>
    'This estimator is temporarily unavailable — please contact the builder directly.';

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      // Regular function (not arrow) so `new ResizeObserver()` works.
      vi.fn().mockImplementation(function () {
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    );
  });

  it('shows the exact fallback copy when no tenant key is given', () => {
    const fixture = setup(null);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(fallbackCopy());
    expect(text).toContain(config.get('copy').embed.unavailableHeading);
    // The attribution badge is always present, even in fallback.
    expect(text).toContain(config.get('copy').embed.poweredBy);
    httpMock.expectNone((r) => r.url.endsWith('/api/v1/embed/config'));
  });

  it('shows the exact fallback copy for an unknown tenant key', () => {
    const fixture = setup('nope');
    const req = httpMock.expectOne((r) => r.url.endsWith('/api/v1/embed/config'));
    req.flush({ code: 'UNKNOWN_TENANT', message: 'Unknown tenant' }, { status: 404, statusText: 'NF' });
    fixture.detectChanges();
    expect((fixture.nativeElement.textContent as string)).toContain(fallbackCopy());
  });

  it('renders builder branding with zero Feasly marketing chrome', () => {
    const fixture = setup('elite-craft');
    flushConfig(fixture);
    const el: HTMLElement = fixture.nativeElement;
    // Wordmark fallback (logo_url empty) shows the builder's display name.
    expect(el.querySelector('.embed-wordmark')?.textContent).toContain('Elite Craft');
    // Accent color applied as a CSS custom property on the host.
    expect(el.style.getPropertyValue('--embed-accent')).toBe('#a8761a');
    // No Feasly nav or footer nodes in the embed DOM.
    expect(el.querySelector('app-site-nav')).toBeNull();
    expect(el.querySelector('app-site-footer')).toBeNull();
    // Contact line from the builder config.
    const contact = el.querySelector('.embed-contact')?.textContent ?? '';
    expect(contact).toContain('(403) 555-0100');
    expect(contact).toContain('hello@example-builder.com');
  });

  it('renders the builder logo when logo_url is set', () => {
    const fixture = setup('elite-craft');
    flushConfig(fixture, { ...fakeConfig, logo_url: 'https://example-builder.com/logo.png' });
    const img = fixture.nativeElement.querySelector('.embed-logo') as HTMLImageElement | null;
    expect(img?.getAttribute('src')).toBe('https://example-builder.com/logo.png');
    expect(img?.getAttribute('alt')).toBe('Elite Craft');
    expect(fixture.nativeElement.querySelector('.embed-wordmark')).toBeNull();
  });

  it('keeps the Powered-by badge in the DOM for every state', () => {
    const ready = setup('elite-craft');
    flushConfig(ready);
    expect(ready.nativeElement.querySelector('.embed-badge')).not.toBeNull();

    const failed = setup(null);
    expect(failed.nativeElement.querySelector('.embed-badge')).not.toBeNull();
  });

  it('ignores theme messages from origins outside allowed_origins', () => {
    const fixture = setup('elite-craft');
    flushConfig(fixture);
    const el: HTMLElement = fixture.nativeElement;
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { type: 'feasly:theme', primaryColor: '#ff0000' },
      }),
    );
    fixture.detectChanges();
    expect(el.style.getPropertyValue('--embed-accent')).toBe('#a8761a');
  });

  it('applies theme messages from an allowlisted origin', () => {
    const fixture = setup('elite-craft');
    flushConfig(fixture);
    const el: HTMLElement = fixture.nativeElement;
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://example-builder.com',
        data: { type: 'feasly:theme', primaryColor: '#123456' },
      }),
    );
    fixture.detectChanges();
    expect(el.style.getPropertyValue('--embed-accent')).toBe('#123456');
  });

  it('rejects non-hex theme colors even from allowlisted origins', () => {
    const fixture = setup('elite-craft');
    flushConfig(fixture);
    const el: HTMLElement = fixture.nativeElement;
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://example-builder.com',
        data: { type: 'feasly:theme', primaryColor: 'javascript:alert(1)' },
      }),
    );
    fixture.detectChanges();
    expect(el.style.getPropertyValue('--embed-accent')).toBe('#a8761a');
  });

  it('dispatches the picked property into wizard state on CTA click', () => {
    const fixture = setup('elite-craft');
    flushConfig(fixture);
    const component = fixture.componentInstance;
    const picked = {
      addressKey: '123-test-st-nw',
      address: '123 Test St NW, Calgary, AB',
    } as PropertyRecord;
    component.property.set(picked);
    fixture.nativeElement.querySelector('.embed-cta')?.dispatchEvent(new Event('click'));
    fixture.detectChanges();
    expect(store.selectSnapshot((s) => s.wizard.property)).toEqual(picked);
    expect(routerNavigate).toHaveBeenCalledWith(['/estimate/scope']);
  });
});
