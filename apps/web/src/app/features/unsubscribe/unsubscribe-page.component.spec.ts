import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { Meta } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { throwError } from 'rxjs';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  UnsubscribeResultResponse,
  UnsubscribeStateResponse,
} from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config';
import { UnsubscribePageComponent } from './unsubscribe-page.component';

/**
 * Unsubscribe center (email/03): the `/unsubscribe/{token}` page renders the
 * confirmation flow from the backend state machine — confirm → done, already,
 * expired, invalid — and never exposes the leadId (no PII in the URL flow).
 * The page is noindexed.
 */
describe('UnsubscribePageComponent', () => {
  let fixture: ComponentFixture<UnsubscribePageComponent>;
  let httpMock: HttpTestingController;
  let api: {
    getUnsubscribeState: ReturnType<typeof vi.fn>;
    confirmUnsubscribe: ReturnType<typeof vi.fn>;
  };

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  async function setup(
    token: string | null,
    state: UnsubscribeStateResponse | { error: { code: string } },
  ): Promise<void> {
    TestBed.resetTestingModule();
    api = {
      getUnsubscribeState: vi.fn(),
      confirmUnsubscribe: vi.fn(),
    };
    if ('error' in state) {
      api.getUnsubscribeState.mockReturnValue(throwError(() => state.error));
    } else {
      api.getUnsubscribeState.mockReturnValue(of(state));
    }
    api.confirmUnsubscribe.mockReturnValue(
      of({ unsubscribed: true, alreadyUnsubscribed: false } satisfies UnsubscribeResultResponse),
    );
    TestBed.configureTestingModule({
      imports: [UnsubscribePageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_SERVICE, useValue: api },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap(token ? { token } : {}) } },
        },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    fixture = TestBed.createComponent(UnsubscribePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('shows a loading state while the token resolves', async () => {
    const { Subject } = await import('rxjs');
    TestBed.resetTestingModule();
    const pending$ = new Subject<UnsubscribeStateResponse>();
    TestBed.configureTestingModule({
      imports: [UnsubscribePageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: API_SERVICE,
          useValue: {
            getUnsubscribeState: vi.fn().mockReturnValue(pending$),
            confirmUnsubscribe: vi.fn(),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ token: 'tok' }) } },
        },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    fixture = TestBed.createComponent(UnsubscribePageComponent);
    fixture.detectChanges();
    expect(text()).toContain('Checking your link');
    pending$.complete();
  });

  it('renders the confirm screen for a valid token', async () => {
    await setup('tok-123', { valid: true, leadId: 'lead-1', alreadyUnsubscribed: false });
    expect(text()).toContain('Unsubscribe from Feasly updates?');
    expect(text()).toContain('Yes, unsubscribe me');
    expect(text()).toContain('Keep me subscribed');
  });

  it('posts the opt-out and shows the story-pinned confirmation', async () => {
    await setup('tok-123', { valid: true, leadId: 'lead-1', alreadyUnsubscribed: false });
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button.cta.danger',
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(api.confirmUnsubscribe).toHaveBeenCalledWith('tok-123');
    expect(text()).toContain('You’ve been unsubscribed from Feasly updates.');
    expect(text()).toContain('Changed your mind?');
  });

  it('never renders the leadId (no PII in the URL flow)', async () => {
    await setup('tok-123', { valid: true, leadId: 'lead-SECRET-1', alreadyUnsubscribed: false });
    expect(text()).not.toContain('lead-SECRET-1');
  });

  it('shows the already-unsubscribed screen without calling POST', async () => {
    await setup('tok-123', { valid: true, leadId: 'lead-1', alreadyUnsubscribed: true });
    expect(text()).toContain('already unsubscribed');
    expect(api.confirmUnsubscribe).not.toHaveBeenCalled();
  });

  it('shows the expired screen with a no-dead-end path', async () => {
    await setup('tok-123', { valid: false, reason: 'expired' });
    expect(text()).toContain('expired');
    expect(text()).toContain('Back to home');
  });

  it('shows the invalid screen for an unknown token', async () => {
    await setup('tok-123', { valid: false, reason: 'invalid' });
    expect(text()).toContain('isn’t valid');
  });

  it('treats a missing token as invalid without calling the API', async () => {
    await setup(null, { valid: false, reason: 'invalid' });
    expect(text()).toContain('isn’t valid');
    expect(api.getUnsubscribeState).not.toHaveBeenCalled();
  });

  it('maps a 403 FORBIDDEN to the invalid screen (no oracle)', async () => {
    await setup('forged', { error: { code: 'FORBIDDEN' } });
    expect(text()).toContain('isn’t valid');
  });

  it('shows the retry screen on transport failure and retries', async () => {
    await setup('tok-123', { error: { code: 'http_0' } });
    expect(text()).toContain('Something went wrong');
    api.getUnsubscribeState.mockReturnValue(
      of({ valid: true, leadId: 'lead-1', alreadyUnsubscribed: false } satisfies UnsubscribeStateResponse),
    );
    const retry = (fixture.nativeElement as HTMLElement).querySelector(
      'button.cta',
    ) as HTMLButtonElement;
    retry.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text()).toContain('Unsubscribe from Feasly updates?');
  });

  it('sets noindex,nofollow on the page', async () => {
    await setup('tok-123', { valid: true, leadId: 'lead-1', alreadyUnsubscribed: false });
    const meta = TestBed.inject(Meta);
    expect(meta.getTag('name="robots"')?.content).toBe('noindex,nofollow');
  });
});
