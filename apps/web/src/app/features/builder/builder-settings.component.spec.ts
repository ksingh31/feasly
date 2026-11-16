/**
 * Builder Settings page (#871).
 *
 * AC1: owner edits save and show a toast; members see read-only fields.
 * AC2: Copy snippet works; install status shows per origin.
 * Plus tabs (WAI-ARIA keyboard), Help tab content from the API, the
 * "Request a change" dialog wiring, and load-error retry.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Store, provideStore } from '@ngxs/store';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuilderEmbedResponse, BuilderProfileResponse } from '@feasly/contracts';
import { UiModalService, UiToastService } from '@app/shared/ui';
import { BuilderSettingsComponent, originInstallState } from './builder-settings.component';
import { BuilderSettingsState } from './builder-settings.state';
import { BuilderSettingsApiService } from './builder-settings-api.service';
import { BuilderAccountClosureModalComponent } from './builder-account-closure-modal.component';
import { BuilderOriginRequestModalComponent } from './builder-origin-request-modal.component';
import { BuilderState } from './builder.state';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { ConfigService } from '../../core/config/config.service';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';

const COPY = DEFAULT_BUILDER_COPY.settings;

const PROFILE: BuilderProfileResponse = {
  profile: {
    tenantKey: 'elite-craft',
    businessName: 'Elite Craft Builders Ltd.',
    displayName: 'Elite Craft',
    contactEmail: 'hello@elitecraft.example',
    contactPhone: null,
    logoUrl: null,
    accentColor: '#c8a24b',
    updatedAt: '2026-11-16T00:00:00Z',
  },
  canEdit: true,
  support: { channel: 'email', email: 'support@feasly.example', responseTime: 'within 1 business day' },
};

const EMBED: BuilderEmbedResponse = {
  tenantKey: 'elite-craft',
  loaderUrl: 'https://feasly.example/embed/v1/loader.js',
  snippet: '<script src="https://feasly.example/embed/v1/loader.js" data-key="elite-craft"></script>',
  origins: [
    { origin: 'https://www.elitecraft.example', lastSeenAt: '2026-11-15T12:00:00Z', loadedRecently: true },
    { origin: 'https://old.elitecraft.example', lastSeenAt: '2026-09-01T12:00:00Z', loadedRecently: false },
    { origin: 'https://new.elitecraft.example', lastSeenAt: null, loadedRecently: false },
  ],
  liveWindowDays: 7,
  lastSeenAt: '2026-11-15T12:00:00Z',
  openRequests: [
    {
      id: 'r1',
      status: 'open',
      add: ['https://staging.elitecraft.example'],
      remove: [],
      note: null,
      createdAt: '2026-11-15T00:00:00Z',
    },
  ],
};

interface SetupOptions {
  profile?: BuilderProfileResponse;
  profileError?: boolean;
  tab?: string;
  updateProfile?: ReturnType<typeof vi.fn>;
}

async function setup(opts: SetupOptions = {}) {
  TestBed.resetTestingModule();
  const api = {
    getProfile: vi
      .fn()
      .mockReturnValue(
        opts.profileError
          ? throwError(() => ({ message: 'boom' }))
          : of(opts.profile ?? PROFILE),
      ),
    updateProfile:
      opts.updateProfile ??
      vi.fn().mockImplementation((body: object) =>
        of({ ...PROFILE, profile: { ...PROFILE.profile, ...body } }),
      ),
    getEmbed: vi.fn().mockReturnValue(of(EMBED)),
    requestOriginChange: vi.fn(),
  };
  const toasts = { show: vi.fn() };
  const closed = new Subject<unknown>();
  const modals = { open: vi.fn().mockReturnValue({ closed }) };
  TestBed.configureTestingModule({
    imports: [BuilderSettingsComponent],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideStore([BuilderSettingsState, BuilderState]),
      { provide: BuilderSettingsApiService, useValue: api },
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
      {
        provide: ConfigService,
        useValue: {
          get: (s: keyof typeof DEFAULT_APP_CONFIG) => DEFAULT_APP_CONFIG[s],
          getServedBuilderCopy: () => null,
        },
      },
      { provide: UiToastService, useValue: toasts },
      { provide: UiModalService, useValue: modals },
    ],
  });
  if (opts.tab) {
    const { Router } = await import('@angular/router');
    await TestBed.inject(Router).navigateByUrl(`/?tab=${opts.tab}`);
  }
  const fixture: ComponentFixture<BuilderSettingsComponent> =
    TestBed.createComponent(BuilderSettingsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, api, toasts, modals, closed, store: TestBed.inject(Store) };
}

function input(el: HTMLElement, testId: string): HTMLInputElement {
  return el.querySelector(`[data-testid="${testId}"] input`) as HTMLInputElement;
}

function type(control: HTMLInputElement, value: string): void {
  control.value = value;
  control.dispatchEvent(new Event('input'));
  control.dispatchEvent(new Event('blur'));
}

function click(el: HTMLElement, testId: string): void {
  (el.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click();
}

describe('BuilderSettingsComponent (#871)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders three tabs, Profile selected by default', async () => {
    const { el } = await setup();
    const tabs = Array.from(el.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent?.trim())).toEqual([
      COPY.tabProfile,
      COPY.tabEmbed,
      COPY.tabHelp,
    ]);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(el.querySelector('[data-testid="panel-profile"]')).not.toBeNull();
  });

  it('opens the tab named in ?tab=', async () => {
    const { el } = await setup({ tab: 'help' });
    expect(el.querySelector('[data-testid="panel-help"]')).not.toBeNull();
  });

  it('moves between tabs with the arrow keys', async () => {
    const { el, fixture } = await setup();
    const list = el.querySelector('[role="tablist"]') as HTMLElement;
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="panel-embed"]')).not.toBeNull();
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="panel-help"]')).not.toBeNull();
  });

  describe('Profile & branding', () => {
    it('fills the form from the profile, editable for owners', async () => {
      const { el } = await setup();
      expect(input(el, 'field-displayName').value).toBe('Elite Craft');
      expect(input(el, 'field-displayName').disabled).toBe(false);
      expect(input(el, 'field-accentColor').value).toBe('#c8a24b');
      expect(el.querySelector('[data-testid="save"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="read-only-note"]')).toBeNull();
    });

    it('AC1: owner edits save and show a toast', async () => {
      const { el, fixture, api, toasts } = await setup();
      type(input(el, 'field-displayName'), 'Elite Craft Homes');
      type(input(el, 'field-logoUrl'), '');
      type(input(el, 'field-accentColor'), '#112233');
      fixture.detectChanges();
      click(el, 'save');
      fixture.detectChanges();
      expect(api.updateProfile).toHaveBeenCalledWith({
        displayName: 'Elite Craft Homes',
        contactEmail: 'hello@elitecraft.example',
        contactPhone: null,
        logoUrl: null,
        accentColor: '#112233',
        billingAddress: null,
      });
      expect(toasts.show).toHaveBeenCalledWith({ message: COPY.savedToast });
    });

    it('#881: an owner adds a billing address; a bad postal code is explained first', async () => {
      const { el, fixture, api } = await setup();
      type(input(el, 'field-billingLine1'), '100 8 Ave SW');
      type(input(el, 'field-billingCity'), 'Calgary');
      const province = el.querySelector('[data-testid="field-billingProvince"] select') as HTMLSelectElement;
      province.value = 'AB';
      province.dispatchEvent(new Event('change'));
      type(input(el, 'field-billingPostalCode'), '90210');
      fixture.detectChanges();
      click(el, 'save');
      fixture.detectChanges();
      expect(api.updateProfile).not.toHaveBeenCalled();
      expect(el.textContent).toContain(COPY.errorPostalCode);

      type(input(el, 'field-billingPostalCode'), 't2p 1j9');
      fixture.detectChanges();
      click(el, 'save');
      fixture.detectChanges();
      expect(api.updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          billingAddress: {
            line1: '100 8 Ave SW',
            line2: null,
            city: 'Calgary',
            province: 'AB',
            postalCode: 't2p 1j9',
            country: 'CA',
          },
        }),
      );
    });

    it('#881: a partial billing address needs the rest before saving', async () => {
      const { el, fixture, api } = await setup();
      type(input(el, 'field-billingCity'), 'Calgary');
      fixture.detectChanges();
      click(el, 'save');
      fixture.detectChanges();
      expect(api.updateProfile).not.toHaveBeenCalled();
      expect(el.textContent).toContain(COPY.errorRequired);
    });

    it('#881: prefills a saved billing address', async () => {
      const { el } = await setup({
        profile: {
          ...PROFILE,
          profile: {
            ...PROFILE.profile,
            billingAddress: {
              line1: '100 8 Ave SW',
              line2: 'Suite 400',
              city: 'Calgary',
              province: 'AB',
              postalCode: 'T2P 1J9',
              country: 'CA',
            },
          },
        },
      });
      expect(input(el, 'field-billingLine2').value).toBe('Suite 400');
      expect(input(el, 'field-billingPostalCode').value).toBe('T2P 1J9');
    });

    it('blocks an invalid save with field errors', async () => {
      const { el, fixture, api } = await setup();
      type(input(el, 'field-logoUrl'), 'http://insecure.example/logo.png');
      type(input(el, 'field-accentColor'), 'gold');
      fixture.detectChanges();
      click(el, 'save');
      fixture.detectChanges();
      expect(api.updateProfile).not.toHaveBeenCalled();
      expect(el.textContent).toContain(COPY.errorHttps);
      expect(el.textContent).toContain(COPY.errorHex);
    });

    it('shows the API message inline and no toast when the save fails', async () => {
      const updateProfile = vi.fn().mockReturnValue(throwError(() => ({ message: 'Phone looks wrong.' })));
      const { el, fixture, toasts } = await setup({ updateProfile });
      type(input(el, 'field-contactPhone'), '12');
      fixture.detectChanges();
      click(el, 'save');
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="save-error"]')?.textContent).toContain('Phone looks wrong.');
      expect(toasts.show).not.toHaveBeenCalled();
    });

    it('AC1: members see read-only fields and no save button', async () => {
      const { el } = await setup({ profile: { ...PROFILE, canEdit: false } });
      for (const id of ['field-displayName', 'field-contactEmail', 'field-logoUrl', 'field-accentColor']) {
        expect(input(el, id).disabled).toBe(true);
      }
      expect(el.querySelector('[data-testid="save"]')).toBeNull();
      expect(el.querySelector('[data-testid="read-only-note"]')?.textContent).toContain(
        COPY.profileReadOnlyNote,
      );
    });

    it('previews the accent colour and logo', async () => {
      const { el, fixture } = await setup();
      const swatch = el.querySelector('[data-testid="accent-swatch"]') as HTMLElement;
      expect(swatch.style.background).not.toBe('');
      expect(el.querySelector('[data-testid="logo-preview"]')?.textContent).toContain(COPY.previewLogoNone);
      type(input(el, 'field-logoUrl'), 'https://cdn.example/logo.png');
      fixture.detectChanges();
      const img = el.querySelector('[data-testid="logo-preview"] img') as HTMLImageElement;
      expect(img.getAttribute('src')).toBe('https://cdn.example/logo.png');
      img.dispatchEvent(new Event('error'));
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="logo-preview"]')?.textContent).toContain(
        COPY.previewLogoBroken,
      );
    });

    it('offers retry when the profile fails to load', async () => {
      const { el, api } = await setup({ profileError: true });
      expect(el.textContent).toContain(COPY.profileLoadError);
      api.getProfile.mockReturnValue(of(PROFILE));
      (el.querySelector('ui-error-state button') as HTMLButtonElement).click();
      expect(api.getProfile).toHaveBeenCalledTimes(2);
    });
  });

  describe('Embed', () => {
    it('shows the snippet and AC2: install status per origin', async () => {
      const { el } = await setup({ tab: 'embed' });
      expect(el.querySelector('[data-testid="snippet"]')?.textContent).toBe(EMBED.snippet);
      const rows = Array.from(el.querySelectorAll<HTMLElement>('li[data-origin]'));
      expect(rows.map((r) => [r.dataset['origin'], r.dataset['state']])).toEqual([
        ['https://www.elitecraft.example', 'live'],
        ['https://old.elitecraft.example', 'stale'],
        ['https://new.elitecraft.example', 'never'],
      ]);
      expect(rows[0].textContent).toContain(COPY.originLive);
      expect(rows[1].textContent).toContain(COPY.originStale);
      expect(rows[2].textContent).toContain(COPY.originNever);
      expect(el.textContent).toContain('last 7 days');
      expect(el.querySelector('[data-testid="open-requests"]')?.textContent).toContain(
        'https://staging.elitecraft.example',
      );
    });

    it('AC2: Copy snippet writes it to the clipboard and toasts', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      const { el, toasts } = await setup({ tab: 'embed' });
      click(el, 'copy-snippet');
      await Promise.resolve();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith(EMBED.snippet);
      expect(toasts.show).toHaveBeenCalledWith({ message: COPY.copiedToast });
      vi.unstubAllGlobals();
    });

    it('warns when the clipboard refuses', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('denied'));
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      const { el, toasts } = await setup({ tab: 'embed' });
      click(el, 'copy-snippet');
      await Promise.resolve();
      await Promise.resolve();
      expect(toasts.show).toHaveBeenCalledWith({ message: COPY.copyFailedToast, tone: 'warning' });
      vi.unstubAllGlobals();
    });

    it('opens the Request a change dialog and toasts the outcome', async () => {
      const { el, modals, closed, toasts } = await setup({ tab: 'embed' });
      click(el, 'request-change');
      expect(modals.open).toHaveBeenCalledWith(
        BuilderOriginRequestModalComponent,
        expect.objectContaining({ data: { origins: EMBED.origins.map((o) => o.origin) } }),
      );
      closed.next('created');
      expect(toasts.show).toHaveBeenCalledWith({ message: COPY.requestCreatedToast });
    });

    it('members get no Request a change button, only a note', async () => {
      const { el } = await setup({ tab: 'embed', profile: { ...PROFILE, canEdit: false } });
      expect(el.querySelector('[data-testid="request-change"]')).toBeNull();
      expect(el.textContent).toContain(COPY.requestChangeOwnerOnly);
    });
  });

  describe('Help', () => {
    it('shows the support email and response time from the API, plus guide links', async () => {
      const { el } = await setup({ tab: 'help' });
      const email = el.querySelector('[data-testid="support-email"]') as HTMLAnchorElement;
      expect(email.textContent).toBe('support@feasly.example');
      expect(email.getAttribute('href')).toBe('mailto:support@feasly.example');
      expect(el.querySelector('[data-testid="response-time"]')?.textContent).toBe(
        'We reply within 1 business day.',
      );
      const links = Array.from(el.querySelectorAll('.settings__links a')).map((a) =>
        a.getAttribute('href'),
      );
      expect(links).toEqual(COPY.helpLinks.map((l) => l.href));
    });

    it('#861: owners can ask to close the account; the outcome is toasted', async () => {
      const { el, modals, closed, toasts } = await setup({ tab: 'help' });
      expect(el.querySelector('[data-testid="close-account"] h2')?.textContent).toBe(COPY.closeHeading);
      click(el, 'close-account-request');
      expect(modals.open).toHaveBeenCalledWith(BuilderAccountClosureModalComponent, expect.any(Object));
      closed.next('duplicate');
      expect(toasts.show).toHaveBeenCalledWith({ message: COPY.closeDuplicateToast, tone: 'info' });
    });

    it('#861: members see the owner-only note, no close button', async () => {
      const { el } = await setup({ tab: 'help', profile: { ...PROFILE, canEdit: false } });
      expect(el.querySelector('[data-testid="close-account-request"]')).toBeNull();
      expect(el.textContent).toContain(COPY.closeOwnerOnly);
    });
  });
});

describe('originInstallState', () => {
  it('buckets live / stale / never', () => {
    expect(originInstallState({ origin: 'a', lastSeenAt: 'x', loadedRecently: true })).toBe('live');
    expect(originInstallState({ origin: 'a', lastSeenAt: 'x', loadedRecently: false })).toBe('stale');
    expect(originInstallState({ origin: 'a', lastSeenAt: null, loadedRecently: false })).toBe('never');
  });
});
