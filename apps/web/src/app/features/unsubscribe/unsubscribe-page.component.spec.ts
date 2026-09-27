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
 * Unsubscribe preference center: `/unsubscribe/{token}` renders the granular
 * preference page (estimate-emails toggle + calls/messages toggle +
 * unsubscribe-everything) from the backend state machine — loading →
 * preferences → done, or expired | invalid — and never exposes the leadId
 * (no PII in the URL flow). The page is noindexed.
 */
describe('UnsubscribePageComponent', () => {
  let fixture: ComponentFixture<UnsubscribePageComponent>;
  let httpMock: HttpTestingController;
  let api: {
    getUnsubscribeState: ReturnType<typeof vi.fn>;
    saveUnsubscribePreferences: ReturnType<typeof vi.fn>;
  };

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function validState(
    overrides: Partial<Extract<UnsubscribeStateResponse, { valid: true }>> = {},
  ): UnsubscribeStateResponse {
    return {
      valid: true,
      leadId: 'lead-1',
      emailOptedOut: false,
      contactOptedOut: false,
      consentUpdatedAt: new Date().toISOString(),
      alreadyUnsubscribed: false,
      ...overrides,
    };
  }

  async function setup(
    token: string | null,
    state: UnsubscribeStateResponse | { error: { code: string } },
  ): Promise<void> {
    TestBed.resetTestingModule();
    api = {
      getUnsubscribeState: vi.fn(),
      saveUnsubscribePreferences: vi.fn(),
    };
    if ('error' in state) {
      api.getUnsubscribeState.mockReturnValue(throwError(() => state.error));
    } else {
      api.getUnsubscribeState.mockReturnValue(of(state));
    }
    api.saveUnsubscribePreferences.mockReturnValue(
      of({
        unsubscribed: true,
        alreadyUnsubscribed: false,
        emailOptedOut: true,
        contactOptedOut: false,
      } satisfies UnsubscribeResultResponse),
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

  function toggles(): NodeListOf<HTMLInputElement> {
    return (fixture.nativeElement as HTMLElement).querySelectorAll('input.switch');
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
            saveUnsubscribePreferences: vi.fn(),
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

  it('renders the preference toggles for a valid token, both on by default', async () => {
    await setup('tok-123', validState());
    expect(text()).toContain('Email & contact preferences');
    expect(text()).toContain('Estimate update emails');
    expect(text()).toContain('Calls and messages');
    expect(text()).toContain('Unsubscribe from everything');
    const boxes = toggles();
    expect(boxes.length).toBe(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(true);
  });

  it('pre-checks the toggles from the backend opt-out state', async () => {
    await setup(
      'tok-123',
      validState({ emailOptedOut: true, contactOptedOut: true, alreadyUnsubscribed: true }),
    );
    const boxes = toggles();
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(false);
  });

  it('saves the granular preferences and shows the done screen', async () => {
    await setup('tok-123', validState());
    const boxes = toggles();
    // Flip calls/messages off, leave emails on.
    boxes[1].checked = false;
    boxes[1].dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const save = (fixture.nativeElement as HTMLElement).querySelector(
      'button.cta',
    ) as HTMLButtonElement;
    save.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(api.saveUnsubscribePreferences).toHaveBeenCalledWith('tok-123', {
      emailOptOut: false,
      contactOptOut: true,
    });
    expect(text()).toContain('Preferences saved.');
  });

  it('unsubscribe-from-everything flips both toggles off', async () => {
    await setup('tok-123', validState());
    const all = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('Unsubscribe from everything')) as HTMLButtonElement;
    all.click();
    fixture.detectChanges();
    const boxes = toggles();
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(false);
  });

  it('never renders the leadId (no PII in the URL flow)', async () => {
    await setup('tok-123', validState({ leadId: 'lead-SECRET-1' }));
    expect(text()).not.toContain('lead-SECRET-1');
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
    api.getUnsubscribeState.mockReturnValue(of(validState()));
    const retry = (fixture.nativeElement as HTMLElement).querySelector(
      'button.cta',
    ) as HTMLButtonElement;
    retry.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text()).toContain('Email & contact preferences');
  });

  it('sets noindex,nofollow on the page', async () => {
    await setup('tok-123', validState());
    const meta = TestBed.inject(Meta);
    expect(meta.getTag('name="robots"')?.content).toBe('noindex,nofollow');
  });
});
