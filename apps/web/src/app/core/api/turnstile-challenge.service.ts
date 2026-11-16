import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { inject, Injectable, PLATFORM_ID } from '@angular/core';
import { defer, from, Observable, switchMap, throwError, timeout } from 'rxjs';
import { ConfigService } from '../config/config.service';

/** The slice of the Turnstile browser API this client uses (explicit render). */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  remove(widgetId: string): void;
}

export interface TurnstileRenderOptions {
  sitekey: string;
  /** 'interaction-only': nothing is shown unless Cloudflare needs a click. */
  appearance: 'interaction-only';
  callback: (token: string) => void;
  'error-callback': () => void;
  'expired-callback': () => void;
  'timeout-callback': () => void;
}

type TurnstileWindow = Window & { turnstile?: TurnstileApi };

/** Marks the on-demand script tag so it is only ever added once. */
const SCRIPT_ATTR = 'data-feasly-turnstile';
/** Host element for the (normally invisible) widget. */
const HOST_CLASS = 'feasly-turnstile-host';

/**
 * Invisible bot challenge (#905). Solves a Cloudflare Turnstile challenge
 * for a site key handed over by a 403 CHALLENGE_REQUIRED response and emits
 * the token once. The Turnstile script is injected on the first call only —
 * normal users, who never get a challenge 403, never load it.
 *
 * The widget renders in managed mode with `appearance: 'interaction-only'`,
 * so it stays invisible unless Cloudflare asks for a click.
 */
@Injectable({ providedIn: 'root' })
export class TurnstileChallengeService {
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly config = inject(ConfigService);
  private scriptLoad: Promise<TurnstileApi> | null = null;

  /** Emits one Turnstile token for `siteKey`, then completes. */
  solve(siteKey: string): Observable<string> {
    if (!isPlatformBrowser(this.platformId) || siteKey.length === 0) {
      return throwError(() => new Error('Bot challenge unavailable'));
    }
    const { timeoutMs } = this.config.get('botChallenge');
    // The token/error arrives from a Turnstile callback, not an HTTP
    // response, so callers must keep view state in signals/NGXS (#905).
    return defer(() => from(this.loadScript())).pipe(
      switchMap((api) => this.renderOnce(api, siteKey)),
      timeout(timeoutMs),
    );
  }

  private renderOnce(api: TurnstileApi, siteKey: string): Observable<string> {
    return new Observable<string>((subscriber) => {
      const host = this.document.createElement('div');
      host.className = HOST_CLASS;
      this.document.body.appendChild(host);
      const fail = (): void => subscriber.error(new Error('Bot challenge failed'));
      let widgetId: string | undefined;
      try {
        widgetId = api.render(host, {
          sitekey: siteKey,
          appearance: 'interaction-only',
          callback: (token) => {
            subscriber.next(token);
            subscriber.complete();
          },
          'error-callback': fail,
          'expired-callback': fail,
          'timeout-callback': fail,
        });
      } catch {
        fail();
      }
      return () => {
        if (widgetId !== undefined) {
          try {
            api.remove(widgetId);
          } catch {
            // Widget already gone; nothing to clean up.
          }
        }
        host.remove();
      };
    });
  }

  private loadScript(): Promise<TurnstileApi> {
    const win = this.document.defaultView as TurnstileWindow | null;
    if (win?.turnstile) return Promise.resolve(win.turnstile);
    if (this.scriptLoad) return this.scriptLoad;
    const src = this.config.get('botChallenge').turnstileScriptUrl;
    this.scriptLoad = new Promise<TurnstileApi>((resolve, reject) => {
      const script = this.document.createElement('script');
      script.src = src;
      script.async = true;
      script.setAttribute(SCRIPT_ATTR, '');
      script.onload = () => {
        const api = (this.document.defaultView as TurnstileWindow | null)?.turnstile;
        if (api) resolve(api);
        else reject(new Error('Turnstile did not initialise'));
      };
      script.onerror = () => reject(new Error('Turnstile script failed to load'));
      this.document.head.appendChild(script);
    }).catch((err: unknown) => {
      // Let a later challenge try again instead of caching the failure.
      this.scriptLoad = null;
      this.document.head.querySelector(`script[${SCRIPT_ATTR}]`)?.remove();
      throw err;
    });
    return this.scriptLoad;
  }
}
