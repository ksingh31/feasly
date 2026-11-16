import { DOCUMENT } from '@angular/common';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../config/config.service';
import { DEFAULT_APP_CONFIG } from '../config/app-config.defaults';
import { TurnstileChallengeService } from './turnstile-challenge.service';
import type { TurnstileApi, TurnstileRenderOptions } from './turnstile-challenge.service';

type TurnstileWindow = Window & { turnstile?: TurnstileApi };

/** #905: the Turnstile script loads on demand only, and each solve cleans up. */
describe('TurnstileChallengeService (#905)', () => {
  const SCRIPT = 'script[data-feasly-turnstile]';
  let doc: Document;
  let win: TurnstileWindow;
  let lastOptions: TurnstileRenderOptions | undefined;
  let fake: { render: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };

  function setup(platform: 'browser' | 'server' = 'browser'): TurnstileChallengeService {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: platform },
        { provide: ConfigService, useValue: { get: (k: 'botChallenge') => DEFAULT_APP_CONFIG[k] } },
      ],
    });
    doc = TestBed.inject(DOCUMENT);
    win = doc.defaultView as TurnstileWindow;
    return TestBed.inject(TurnstileChallengeService);
  }

  /** Simulates the injected script finishing its load. */
  function loadScript(): void {
    const script = doc.head.querySelector<HTMLScriptElement>(SCRIPT);
    expect(script).not.toBeNull();
    win.turnstile = fake as unknown as TurnstileApi;
    script?.onload?.(new Event('load'));
  }

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(() => {
    lastOptions = undefined;
    fake = {
      render: vi.fn((_el: HTMLElement, options: TurnstileRenderOptions) => {
        lastOptions = options;
        return 'widget-1';
      }),
      remove: vi.fn(),
    };
  });

  afterEach(() => {
    doc.head.querySelectorAll(SCRIPT).forEach((s) => s.remove());
    doc.querySelectorAll('.feasly-turnstile-host').forEach((h) => h.remove());
    delete win.turnstile;
  });

  it('does not load the script until a challenge is solved (normal path)', () => {
    setup();
    expect(doc.head.querySelector(SCRIPT)).toBeNull();
  });

  it('loads the configured script once, renders invisibly with the given site key, emits the token, and cleans up', async () => {
    const service = setup();
    const token = firstValueFrom(service.solve('key-from-403'));
    const script = doc.head.querySelector<HTMLScriptElement>(SCRIPT);
    expect(script?.src).toBe(DEFAULT_APP_CONFIG.botChallenge.turnstileScriptUrl);
    loadScript();
    await settle();

    expect(fake.render).toHaveBeenCalledTimes(1);
    expect(lastOptions?.sitekey).toBe('key-from-403');
    expect(lastOptions?.appearance).toBe('interaction-only');
    expect(doc.querySelector('.feasly-turnstile-host')).not.toBeNull();

    lastOptions?.callback('tok');
    await expect(token).resolves.toBe('tok');
    expect(fake.remove).toHaveBeenCalledWith('widget-1');
    expect(doc.querySelector('.feasly-turnstile-host')).toBeNull();

    // A later challenge reuses the loaded API — no second script tag.
    const again = firstValueFrom(service.solve('key-from-403'));
    await settle();
    expect(doc.head.querySelectorAll(SCRIPT)).toHaveLength(1);
    lastOptions?.callback('tok-2');
    await expect(again).resolves.toBe('tok-2');
  });

  it('errors when the widget reports an error', async () => {
    const service = setup();
    const token = firstValueFrom(service.solve('k'));
    loadScript();
    await settle();
    lastOptions?.['error-callback']();
    await expect(token).rejects.toThrow();
    expect(doc.querySelector('.feasly-turnstile-host')).toBeNull();
  });

  it('errors when the script fails to load, and a later solve tries again', async () => {
    const service = setup();
    const first = firstValueFrom(service.solve('k'));
    doc.head.querySelector<HTMLScriptElement>(SCRIPT)?.onerror?.(new Event('error'));
    await expect(first).rejects.toThrow();
    expect(doc.head.querySelector(SCRIPT)).toBeNull();

    const second = firstValueFrom(service.solve('k'));
    loadScript();
    await settle();
    lastOptions?.callback('tok');
    await expect(second).resolves.toBe('tok');
  });

  it('errors without touching the DOM on the server or with an empty site key', async () => {
    const server = setup('server');
    await expect(firstValueFrom(server.solve('k'))).rejects.toThrow();
    await expect(firstValueFrom(server.solve(''))).rejects.toThrow();
    expect(doc.head.querySelector(SCRIPT)).toBeNull();
  });
});
