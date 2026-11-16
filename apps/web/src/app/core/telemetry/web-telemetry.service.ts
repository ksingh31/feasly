import { DestroyRef, inject, Injectable, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, Router } from '@angular/router';
import { fromEvent, merge } from 'rxjs';
import type { Metric } from 'web-vitals';
import type {
  WebErrorItem,
  WebTelemetryBatch,
  WebTelemetryItem,
  WebVitalName,
} from '@feasly/contracts';
import { ConfigService } from '../config/config.service';

/** The vitals the issue asks for (#830); web-vitals' other metrics are dropped. */
const VITALS: ReadonlySet<string> = new Set<WebVitalName>(['LCP', 'INP', 'CLS', 'TTFB']);

/** Loads web-vitals lazily so it never lands in the initial bundle. Swappable in specs. */
export type WebVitalsLoader = () => Promise<
  Pick<typeof import('web-vitals'), 'onLCP' | 'onINP' | 'onCLS' | 'onTTFB'>
>;

const loadWebVitals: WebVitalsLoader = () => import('web-vitals');

/**
 * Real-user monitoring (#830): Core Web Vitals (LCP, INP, CLS, TTFB) and
 * uncaught JS errors, batched and sent with `navigator.sendBeacon` to
 * `POST /api/v1/telemetry`, which writes App Insights traces.
 *
 * - Sampled per page load (`telemetry.sampleRate`); off when disabled, in
 *   mock-API mode, during prerender/SSR, without `sendBeacon`, or in an
 *   automated browser (`navigator.webdriver`, #957).
 * - No PII: `page` is the Angular route PATTERN (`/report/:token`), never the
 *   concrete URL; script sources keep only their path; messages are
 *   truncated (the API also scrubs emails + query strings). No ids, no
 *   storage, no cookies of its own.
 * - Errors arrive from both the window listeners and `GlobalErrorHandler`
 *   (Angular forwards window errors to its ErrorHandler too), so each error
 *   object is reported once (WeakSet dedupe) and capped per page load.
 * - Flushes when the page is hidden (after web-vitals has reported CLS/INP —
 *   its window capture listener runs before our bubble listener) or when a
 *   batch fills. The body is `text/plain` JSON: a CORS-safelisted type, so
 *   the cross-origin beacon needs no preflight.
 */
@Injectable({ providedIn: 'root' })
export class WebTelemetryService {
  private readonly config = inject(ConfigService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Overridable in specs; production loads the lazy chunk. */
  loader: WebVitalsLoader = loadWebVitals;
  /** Overridable in specs for deterministic sampling. */
  random: () => number = Math.random;
  /**
   * #957: automated browsers (Lighthouse/PSI, Playwright, WebDriver crawlers)
   * report `navigator.webdriver === true`. They aren't real users, and a
   * sampled-in Lighthouse run would count the lazy web-vitals chunk against
   * the script-size budget. Overridable in specs.
   */
  isAutomated: () => boolean = () => typeof navigator !== 'undefined' && navigator.webdriver === true;

  private active = false;
  private queue: WebTelemetryItem[] = [];
  private errorCount = 0;
  private readonly seen = new WeakSet<object>();
  private lastPrimitive: unknown = undefined;

  /** Whether this page load was sampled in and is reporting. */
  get isActive(): boolean {
    return this.active;
  }

  /** Decide sampling and start listening. Idempotent; never throws. */
  start(): void {
    if (this.active || !this.isBrowser) return;
    const cfg = this.config.get('telemetry');
    if (!cfg.enabled || this.config.get('api').useMockApi) return;
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    if (this.isAutomated()) return;
    if (this.random() >= cfg.sampleRate) return;
    this.active = true;

    fromEvent<ErrorEvent>(window, 'error')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e) => this.recordErrorEvent(e));
    fromEvent<PromiseRejectionEvent>(window, 'unhandledrejection')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e) => this.record(e.reason, 'unhandledrejection'));

    this.loader()
      .then(({ onLCP, onINP, onCLS, onTTFB }) => {
        const report = (m: Metric): void => this.recordVital(m);
        onLCP(report);
        onINP(report);
        onCLS(report);
        onTTFB(report);
      })
      .catch(() => undefined)
      // Registered after web-vitals so its hidden-page reports land first.
      .finally(() => this.listenForPageHide());
  }

  /** Called by GlobalErrorHandler for errors Angular catches. No-op when inactive. */
  recordError(error: unknown): void {
    this.record(error, 'error');
  }

  /** Send everything queued now (page hide). */
  flush(): void {
    const { maxBatchItems } = this.config.get('telemetry');
    const { baseUrl } = this.config.get('api');
    const url = `${baseUrl}/api/v1/telemetry`;
    while (this.queue.length > 0) {
      const batch: WebTelemetryBatch = { items: this.queue.splice(0, maxBatchItems) };
      try {
        navigator.sendBeacon(
          url,
          new Blob([JSON.stringify(batch)], { type: 'text/plain' }),
        );
      } catch {
        // Monitoring must never break the product.
      }
    }
  }

  private listenForPageHide(): void {
    merge(fromEvent(window, 'visibilitychange'), fromEvent(window, 'pagehide'))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e) => {
        if (e.type === 'pagehide' || document.visibilityState === 'hidden') this.flush();
      });
  }

  private recordVital(metric: Metric): void {
    if (!VITALS.has(metric.name)) return;
    this.enqueue({
      type: 'vital',
      name: metric.name as WebVitalName,
      value: metric.value,
      rating: metric.rating,
      page: this.pagePattern(),
    });
  }

  private recordErrorEvent(e: ErrorEvent): void {
    this.record(e.error ?? e.message, 'error', e);
  }

  private record(error: unknown, kind: WebErrorItem['kind'], event?: ErrorEvent): void {
    if (!this.active || this.isDuplicate(error)) return;
    const cfg = this.config.get('telemetry');
    if (this.errorCount >= cfg.maxErrorsPerSession) return;
    this.errorCount++;
    const source = event?.filename ? scriptPath(event.filename) : undefined;
    this.enqueue({
      type: 'error',
      kind,
      message: describe(error).slice(0, cfg.maxMessageLength),
      ...(source ? { source } : {}),
      ...(event?.lineno ? { line: event.lineno } : {}),
      ...(event?.colno ? { column: event.colno } : {}),
      page: this.pagePattern(),
    });
  }

  private isDuplicate(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
      if (this.seen.has(error)) return true;
      this.seen.add(error);
      return false;
    }
    if (error === this.lastPrimitive) return true;
    this.lastPrimitive = error;
    return false;
  }

  private enqueue(item: WebTelemetryItem): void {
    this.queue.push(item);
    if (this.queue.length >= this.config.get('telemetry').maxBatchItems) this.flush();
  }

  /** Route pattern of the current page, e.g. `/report/:token`. */
  private pagePattern(): string {
    const segments: string[] = [];
    let node: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
    while (node) {
      const path = node.routeConfig?.path;
      if (path) segments.push(path);
      node = node.firstChild;
    }
    return `/${segments.join('/')}`;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return scrubUrls(`${error.name}: ${error.message}`);
  if (typeof error === 'string') return scrubUrls(error);
  // Angular's HttpErrorResponse (and similar) isn't an Error but carries a
  // string `message` — which embeds the request URL, so URLs are scrubbed.
  if (typeof error === 'object' && error !== null) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (typeof message === 'string') {
      return scrubUrls(typeof name === 'string' && name ? `${name}: ${message}` : message);
    }
  }
  return Object.prototype.toString.call(error);
}

// Trailing punctuation (`url: 500 …`) is left outside the match.
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]*[^\s'"<>.,:;)]/gi;
/**
 * Token-like path segment (ids, magic tokens, UUIDs): contains a digit, or
 * mixes upper- and lower-case. API paths are lower-case kebab words.
 */
const TOKEN_SEGMENT = /^(?=.*\d)[A-Za-z0-9_.~-]{6,}$|^(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9_~-]{6,}$/;

/**
 * Replaces every URL in `text` with its path only — no origin, query or
 * fragment — and masks token-like path segments as `:id`, so a report
 * token in a failed request's URL never leaves the browser.
 */
export function scrubUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (raw) => {
    let path: string;
    try {
      path = new URL(raw).pathname;
    } catch {
      return '[url]';
    }
    return path
      .split('/')
      .map((seg) => (TOKEN_SEGMENT.test(seg) ? ':id' : seg))
      .join('/');
  });
}

/** Script path only — no origin, query or fragment. */
function scriptPath(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}
