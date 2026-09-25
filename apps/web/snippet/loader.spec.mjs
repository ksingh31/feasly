// @vitest-environment jsdom
/**
 * embed/07 — loader.js fixture-page tests.
 *
 * Each test builds a blank fixture page, drops in a <script data-builder>
 * marker tag, then executes the real loader source. Assertions cover the
 * story's acceptance criteria: injection, exact sandbox flags, feasly_rt
 * relay intake + URL stripping, the fallback card, and spoofed-message
 * rejection.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOADER_SRC = readFileSync(join(HERE, 'loader.js'), 'utf8');

const EMBED_ORIGIN = 'https://embed.test';
const TENANT_KEY = 'test-builder-key';
const FALLBACK_COPY =
  'This estimator is temporarily unavailable \u2014 please contact the builder directly.';

function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let value;
      try {
        value = fn();
      } catch (e) {
        reject(e);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(poll, 25);
    })();
  });
}

/**
 * Builds a blank page with the marker <script data-builder> tag, then runs
 * the real loader source. Returns the injected iframe and helpers.
 */
function installLoader({ attrs = {}, query = '', bodyHtml = '' } = {}) {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  window.sessionStorage.clear();
  // Same-origin path-only navigation keeps jsdom happy.
  window.history.replaceState(null, '', '/builder-page' + query);
  if (bodyHtml) document.body.insertAdjacentHTML('beforeend', bodyHtml);

  const marker = document.createElement('script');
  marker.setAttribute('data-builder', TENANT_KEY);
  marker.setAttribute('data-embed-origin', EMBED_ORIGIN);
  for (const [key, value] of Object.entries(attrs)) {
    marker.setAttribute('data-' + key, value);
  }
  document.head.appendChild(marker);

  const injected = document.createElement('script');
  injected.textContent = LOADER_SRC;
  document.body.appendChild(injected);

  const iframe = document.querySelector('iframe[data-feasly-loader]');
  return { marker, iframe };
}

function readyFrom(iframe) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'feasly:ready' },
      origin: 'null',
      source: iframe.contentWindow,
    }),
  );
}

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('embed loader (embed/07)', () => {
  it('injects the iframe pointing at /embed/{tenantKey} on the embed origin', () => {
    const { iframe } = installLoader();
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute('src')).toBe(`${EMBED_ORIGIN}/embed/${TENANT_KEY}`);
  });

  it('sets the exact sandbox flags (no allow-same-origin, no allow-top-navigation)', () => {
    const { iframe } = installLoader();
    const sandbox = iframe.getAttribute('sandbox') ?? '';
    expect(sandbox).toBe('allow-scripts allow-forms allow-popups');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-top-navigation');
  });

  it('consumes ?feasly_rt= into sessionStorage and strips it from the visible URL', () => {
    installLoader({ query: '?feasly_rt=RELAY123&utm_source=x' });
    expect(window.sessionStorage.getItem('feasly_relay_code')).toBe('RELAY123');
    expect(window.location.search).not.toContain('feasly_rt');
    expect(window.location.search).toContain('utm_source=x');
  });

  it('re-posts the stashed relay code from sessionStorage on feasly:ready', () => {
    const { iframe } = installLoader({ query: '?feasly_rt=RELAY123' });
    const postMessage = vi.fn();
    iframe.contentWindow.postMessage = postMessage;
    readyFrom(iframe);
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'feasly:relay', code: 'RELAY123' },
      '*',
    );
  });

  it('clears the relay code after FEASLY_AUTH_OK so it is not re-posted', () => {
    const { iframe } = installLoader({ query: '?feasly_rt=RELAY123' });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'FEASLY_AUTH_OK', estimateId: 'e1', leadScore: 80 },
        origin: 'null',
        source: iframe.contentWindow,
      }),
    );
    expect(window.sessionStorage.getItem('feasly_relay_code')).toBeNull();
  });

  it('shows the exact fallback copy when the iframe never signals ready', async () => {
    installLoader({ attrs: { timeout: '60' } });
    const card = await waitFor(() => document.querySelector('[data-feasly-fallback]'));
    expect(card.textContent).toContain(FALLBACK_COPY);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('applies feasly:resize heights from the iframe and clamps absurd values', () => {
    const { iframe } = installLoader();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'feasly:resize', height: 900 },
        origin: 'null',
        source: iframe.contentWindow,
      }),
    );
    expect(iframe.style.height).toBe('900px');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'feasly:resize', height: 99999 },
        origin: 'null',
        source: iframe.contentWindow,
      }),
    );
    expect(iframe.style.height).toBe('4000px');
  });

  it('ignores spoofed messages from any window other than the iframe', () => {
    const { iframe } = installLoader({ query: '?feasly_rt=RELAY123' });
    const postMessage = vi.fn();
    iframe.contentWindow.postMessage = postMessage;

    // Spoof: correct shape, wrong source (the page itself).
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'feasly:ready' },
        origin: EMBED_ORIGIN,
        source: window,
      }),
    );
    expect(postMessage).not.toHaveBeenCalled();

    // Spoof: a second, attacker-controlled iframe on the same page.
    const evil = document.createElement('iframe');
    document.body.appendChild(evil);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'feasly:resize', height: 5 },
        origin: 'null',
        source: evil.contentWindow,
      }),
    );
    expect(iframe.style.height).not.toBe('5px');

    // The real iframe still works afterwards.
    readyFrom(iframe);
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'feasly:relay', code: 'RELAY123' },
      '*',
    );
  });

  it('re-dispatches estimate-start as a DOM CustomEvent for builder analytics', () => {
    const { iframe } = installLoader();
    const seen = [];
    iframe.parentElement.addEventListener('feasly:estimate-start', (e) => seen.push(e.detail));
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'feasly:estimate-start', addressKey: 'k1', address: '1 Main St' },
        origin: 'null',
        source: iframe.contentWindow,
      }),
    );
    expect(seen).toEqual([{ addressKey: 'k1', address: '1 Main St' }]);
  });

  it('re-dispatches lead-created with only estimateId + leadScore (zero PII)', () => {
    const { iframe } = installLoader();
    const seen = [];
    iframe.parentElement.addEventListener('feasly:lead-created', (e) => seen.push(e.detail));
    window.dispatchEvent(
      new MessageEvent('message', {
        // Even if the iframe sent PII (it must not), the loader strips it.
        data: {
          type: 'feasly:lead-created',
          estimateId: 'est_123',
          leadScore: 82,
          email: 'attacker@evil.test',
          name: 'Mallory',
        },
        origin: 'null',
        source: iframe.contentWindow,
      }),
    );
    expect(seen).toEqual([{ estimateId: 'est_123', leadScore: 82 }]);
    expect(JSON.stringify(seen[0])).not.toContain('attacker@evil.test');
    expect(JSON.stringify(seen[0])).not.toContain('Mallory');
  });

  it('re-dispatches lead-created without leadScore when the backend omits it', () => {
    const { iframe } = installLoader();
    const seen = [];
    iframe.parentElement.addEventListener('feasly:lead-created', (e) => seen.push(e.detail));
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'feasly:lead-created', estimateId: 'est_456' },
        origin: 'null',
        source: iframe.contentWindow,
      }),
    );
    expect(seen).toEqual([{ estimateId: 'est_456' }]);
  });

  it('ignores spoofed lead-created from a non-iframe source', () => {
    const { iframe } = installLoader();
    const seen = [];
    iframe.parentElement.addEventListener('feasly:lead-created', (e) => seen.push(e.detail));
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'feasly:lead-created', estimateId: 'est_spoof', leadScore: 100 },
        origin: 'null',
        source: window,
      }),
    );
    expect(seen).toEqual([]);
  });

  it('renders into the data-target container when specified', () => {
    const { iframe } = installLoader({
      attrs: { target: '#slot' },
      bodyHtml: '<div id="slot"></div>',
    });
    expect(iframe).not.toBeNull();
    expect(document.querySelector('#slot iframe')).toBe(iframe);
  });

  it('never leaves a blank area when the tenant key is missing', () => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    const marker = document.createElement('script');
    marker.setAttribute('data-embed-origin', EMBED_ORIGIN);
    document.head.appendChild(marker);
    const injected = document.createElement('script');
    injected.textContent = LOADER_SRC;
    document.body.appendChild(injected);
    const card = document.querySelector('[data-feasly-fallback]');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain(FALLBACK_COPY);
  });
});
