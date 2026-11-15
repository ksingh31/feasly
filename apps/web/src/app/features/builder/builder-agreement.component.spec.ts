/**
 * Platform agreement screen (#722): renders the served sections with the
 * draft notice, scroll-to-accept (disabled + reason until the end is
 * reached; enabled at once when the text fits), admin vs member views,
 * accept → return to the money page, error copy, and the plain-text
 * download.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgreementStatus } from '@feasly/contracts';
import { SeoService } from '../../core/seo/seo.service';
import { stubObjectUrls } from '../../shared/test-helpers/object-url.stub';
import { BuilderAgreementComponent, agreementPlainText } from './builder-agreement.component';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderOnboardingApiService } from './builder-onboarding-api.service';
import { BuilderChecklistState, BuilderOnboardingState } from './builder-onboarding.state';
import { AGREEMENT_ACCEPTED, AGREEMENT_PENDING, onboardingOf } from './test-helpers/onboarding.fixtures';

const t = DEFAULT_BUILDER_COPY.agreement;

/** Make the agreement text overflow its box (jsdom has no layout). */
function stubOverflow(): () => void {
  const proto = HTMLElement.prototype;
  const originals = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
  };
  const isDoc = (el: HTMLElement) => el.dataset['testid'] === 'agreement-doc';
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isDoc(this) ? 1000 : 0;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isDoc(this) ? 200 : 0;
    },
  });
  return () => {
    for (const [key, desc] of Object.entries(originals)) {
      // The real getters live on Element.prototype: drop the own stub.
      if (desc) Object.defineProperty(proto, key, desc);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  };
}

interface Options {
  readonly agreement?: AgreementStatus;
  readonly accept?: () => ReturnType<BuilderOnboardingApiService['acceptAgreement']>;
  readonly returnUrl?: string;
  readonly loadFails?: boolean;
}

async function setup(options: Options = {}) {
  TestBed.resetTestingModule();
  const api = {
    getAgreement: vi.fn(() =>
      options.loadFails
        ? throwError(() => ({ code: 'http_500' }))
        : of(options.agreement ?? AGREEMENT_PENDING),
    ),
    acceptAgreement: vi.fn(options.accept ?? (() => of(AGREEMENT_ACCEPTED))),
    getOnboarding: vi.fn(() =>
      of(onboardingOf({ agreementAccepted: true, agreement: AGREEMENT_ACCEPTED })),
    ),
  };
  TestBed.configureTestingModule({
    imports: [BuilderAgreementComponent],
    providers: [
      provideRouter([]),
      provideStore([BuilderOnboardingState, BuilderChecklistState]),
      { provide: BuilderOnboardingApiService, useValue: api },
      { provide: BUILDER_COPY, useValue: DEFAULT_BUILDER_COPY },
      { provide: SeoService, useValue: { setPage: vi.fn() } },
      ...(options.returnUrl
        ? [
            {
              provide: ActivatedRoute,
              useValue: { snapshot: { queryParamMap: convertToParamMap({ returnUrl: options.returnUrl }) } },
            },
          ]
        : []),
    ],
  });
  const router = TestBed.inject(Router);
  const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  const fixture: ComponentFixture<BuilderAgreementComponent> = TestBed.createComponent(BuilderAgreementComponent);
  fixture.autoDetectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { fixture, api, el, q, navigate };
}

describe('BuilderAgreementComponent (#722)', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('renders the served sections, version and the draft notice', async () => {
    const { el, q } = await setup();
    expect(el.textContent).toContain('Platform Agreement');
    expect(el.textContent).toContain('Version v2');
    expect(q('agreement-doc')?.textContent).toContain('Commission');
    expect(q('agreement-doc')?.textContent).toContain('Second.');
    expect(q('agreement-draft')?.textContent).toContain(t.draftNotice);
    expect(q('agreement-doc')?.getAttribute('aria-label')).toBe(t.documentLabel);
  });

  it('hides the draft notice once the text is approved', async () => {
    const approved: AgreementStatus = {
      ...AGREEMENT_PENDING,
      document: { ...AGREEMENT_PENDING.document, status: 'approved' },
    };
    const { q } = await setup({ agreement: approved });
    expect(q('agreement-draft')).toBeNull();
  });

  it('keeps Accept disabled with the reason until the reader scrolls to the end', async () => {
    restore = stubOverflow();
    const { q, fixture } = await setup();
    const button = q('agreement-accept') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('builder-agreement-scroll-hint');
    expect(q('agreement-scroll-hint')?.textContent).toContain(t.scrollHint);

    const doc = q('agreement-doc')!;
    Object.defineProperty(doc, 'scrollTop', { configurable: true, value: 400 });
    doc.dispatchEvent(new Event('scroll'));
    await fixture.whenStable();
    expect(button.disabled).toBe(true);

    Object.defineProperty(doc, 'scrollTop', { configurable: true, value: 800 });
    doc.dispatchEvent(new Event('scroll'));
    await fixture.whenStable();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-describedby')).toBeNull();
    expect(q('agreement-scroll-hint')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain(t.scrollDone);
  });

  it('enables Accept straight away when the text does not overflow', async () => {
    const { q } = await setup();
    expect((q('agreement-accept') as HTMLButtonElement).disabled).toBe(false);
  });

  it('accepts the served version and returns to the money page', async () => {
    const { q, api, navigate, fixture } = await setup({ returnUrl: '/builder/billing' });
    q('agreement-accept')!.click();
    await fixture.whenStable();
    expect(api.acceptAgreement).toHaveBeenCalledWith('v2');
    expect(navigate).toHaveBeenCalledWith('/builder/billing');
  });

  it('ignores an unsafe return url and shows the accepted state instead', async () => {
    const { q, navigate, fixture } = await setup({ returnUrl: '//evil.example' });
    q('agreement-accept')!.click();
    await fixture.whenStable();
    expect(navigate).not.toHaveBeenCalled();
    expect(q('agreement-accepted')?.textContent).toContain('Dana Admin');
    expect(q('agreement-accept')).toBeNull();
  });

  it('shows members the ask-your-admin note and no Accept button', async () => {
    const { q } = await setup({ agreement: { ...AGREEMENT_PENDING, canAccept: false } });
    expect(q('agreement-member')?.textContent).toContain('Ask your admin to accept the agreement');
    expect(q('agreement-accept')).toBeNull();
    expect(q('agreement-download')).not.toBeNull();
  });

  it('shows who accepted and when, with Continue', async () => {
    const { q, navigate } = await setup({ agreement: AGREEMENT_ACCEPTED });
    expect(q('agreement-accepted')?.textContent).toContain('Dana Admin');
    expect(q('agreement-accept')).toBeNull();
    q('agreement-continue')!.click();
    expect(navigate).toHaveBeenCalledWith('/builder');
  });

  it('shows the version-changed message when the version moved', async () => {
    const { q, fixture } = await setup({
      accept: () => throwError(() => ({ code: 'AGREEMENT_VERSION_MISMATCH' })),
    });
    q('agreement-accept')!.click();
    await fixture.whenStable();
    expect(q('agreement-error')?.textContent).toContain(t.versionChanged);
  });

  it('offers a retry when the agreement cannot load', async () => {
    const { el, api } = await setup({ loadFails: true });
    expect(el.textContent).toContain(t.loadError);
    expect(api.getAgreement).toHaveBeenCalledTimes(1);
  });

  it('downloads a plain-text copy of the served text', async () => {
    const urls = stubObjectUrls();
    try {
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      const { q } = await setup();
      q('agreement-download')!.click();
      expect(urls.createObjectURL).toHaveBeenCalledTimes(1);
      const blob = urls.createObjectURL.mock.calls[0]![0] as Blob;
      expect(blob.type).toContain('text/plain');
      const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
      expect(anchor.download).toBe('feasly-platform-agreement-v2.txt');
      expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
      click.mockRestore();
    } finally {
      urls.restore();
    }
  });

  it('builds the plain text from the sections verbatim', () => {
    const text = agreementPlainText(AGREEMENT_PENDING.document, 'Version v2', t.downloadDraftLine);
    expect(text).toBe(
      ['Platform Agreement', 'Version v2', t.downloadDraftLine, '', 'Commission', '', 'First.', '', 'Second.', ''].join('\n'),
    );
  });
});
